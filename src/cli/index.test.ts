import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function listeningServer() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return server;
    } catch (error) {
      lastError = error;
      server.close();
    }
  }
  throw lastError;
}

describe('CLI transport', () => {
  test('reports an unavailable supervisor without an unhandled WebSocket error', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'browserctl-cli-test-'));
    const runtime = path.join(temp, 'browser-controller');
    await fs.mkdir(runtime, { recursive: true });
    cleanups.push(() => fs.rm(temp, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(runtime, 'connection.json'),
      JSON.stringify({
        url: 'ws://127.0.0.1:1',
        pid: process.pid,
        token: 'a'.repeat(64),
        version: 1,
      }),
    );

    const child = spawn(process.execPath, [path.join(import.meta.dir, 'index.ts'), 'list'], {
      env: { ...process.env, XDG_RUNTIME_DIR: temp },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));

    expect(exitCode).toBe(1);
    expect(stderr.trim()).toBe(
      'Error [cli_error]: supervisor_unavailable: supervisor is unavailable',
    );
  });

  test('sends one semantic-locator command for one invocation', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'browserctl-cli-test-'));
    const runtime = path.join(temp, 'browser-controller');
    await fs.mkdir(runtime, { recursive: true });
    const token = 'a'.repeat(64);
    const http = await listeningServer();
    const server = new WebSocketServer({ server: http });
    cleanups.push(
      () =>
        new Promise<void>((resolve) =>
          server.close(() => http.close(() => resolve())),
        ),
      () => fs.rm(temp, { recursive: true, force: true }),
    );
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    await fs.writeFile(
      path.join(runtime, 'connection.json'),
      JSON.stringify({ url: `ws://127.0.0.1:${address.port}`, pid: process.pid, token, version: 1 }),
    );

    let commands = 0;
    let receivedCommand: unknown;
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.kind === 'hello')
          socket.send(JSON.stringify({ version: 1, id: message.id, ok: true, result: {} }));
        else if (message.kind === 'command') {
          commands += 1;
          receivedCommand = message.command;
          socket.send(
            JSON.stringify({
              version: 1,
              id: message.id,
              ok: true,
              result: { action: 'clicked' },
            }),
          );
        }
      });
    });

    const child = spawn(
      process.execPath,
      [
        path.join(import.meta.dir, 'index.ts'),
        'click',
        '--role',
        'button',
        '--name',
        'Add Bookmark',
        '--exact',
        '--within-role',
        'article',
        '--within-name',
        'Bookmarks',
        '--within-exact',
        '--json',
      ],
      {
      env: { ...process.env, XDG_RUNTIME_DIR: temp },
      stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect({ exitCode, stderr, stdout: stdout.trim(), commands, receivedCommand }).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: '{"ok":true,"result":{"action":"clicked"}}',
      commands: 1,
      receivedCommand: {
        type: 'click',
        session: 'last',
        locator: { by: 'role', value: 'button', name: 'Add Bookmark', exact: true },
        within: { by: 'role', value: 'article', name: 'Bookmarks', exact: true },
      },
    });
  });

  test('shows command help without connecting to a supervisor', async () => {
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dir, 'index.ts'), 'fill', '--help'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));

    expect(exitCode).toBe(0);
    expect(stdout).toContain('fill LOCATOR --value VALUE');
    expect(stdout).toContain('--text TEXT');
  });

  test('pairs, starts a session, and retries when the extension is unavailable', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'browserctl-cli-test-'));
    const runtime = path.join(temp, 'browser-controller');
    await fs.mkdir(runtime, { recursive: true });
    const token = 'a'.repeat(64);
    const http = await listeningServer();
    const server = new WebSocketServer({ server: http });
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => http.close(() => resolve()))),
      () => fs.rm(temp, { recursive: true, force: true }),
    );
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    await fs.writeFile(
      path.join(runtime, 'connection.json'),
      JSON.stringify({ url: `ws://127.0.0.1:${address.port}`, pid: process.pid, token, version: 1 }),
    );
    const commandTypes: string[] = [];
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.kind === 'hello')
          return socket.send(JSON.stringify({ version: 1, id: message.id, ok: true, result: {} }));
        if (message.kind !== 'command') return;
        commandTypes.push(message.command.type);
        if (commandTypes.length === 1)
          return socket.send(JSON.stringify({
            version: 1,
            id: message.id,
            ok: false,
            error: { code: 'adapter_unavailable', message: 'no extension connected' },
          }));
        if (message.command.type === 'extension_pair') {
          socket.send(JSON.stringify({
            version: 1,
            id: message.id,
            ok: true,
            result: {
              endpoint: `ws://127.0.0.1:${address.port}`,
              code: 'pair-code',
              adapterId: 'adapter-1',
            },
          }));
          return socket.send(JSON.stringify({ event: 'adapter_connected', adapterId: 'adapter-1' }));
        }
        if (message.command.type === 'start')
          return socket.send(JSON.stringify({
            version: 1,
            id: message.id,
            ok: true,
            result: { id: 'session-1', adapter: 'adapter-1' },
          }));
        socket.send(JSON.stringify({
          version: 1,
          id: message.id,
          ok: true,
          result: { action: 'clicked' },
        }));
      });
    });

    const child = spawn(
      process.execPath,
      [path.join(import.meta.dir, 'index.ts'), 'click', '--role', 'button', '--name', 'Continue', '--json'],
      {
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: temp,
          BROWSER_CONTROLLER_DISABLE_OPEN: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));

    expect(exitCode).toBe(0);
    expect(commandTypes).toEqual(['click', 'extension_pair', 'start', 'click']);
    expect(JSON.parse(stdout)).toEqual({ ok: true, result: { action: 'clicked' } });
  });

  test('writes a scrape archive returned by the extension', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'browserctl-cli-test-'));
    const runtime = path.join(temp, 'browser-controller');
    const output = path.join(temp, 'capture.zip');
    await fs.mkdir(runtime, { recursive: true });
    const token = 'a'.repeat(64);
    const archive = Buffer.from('finished archive');
    const http = await listeningServer();
    const server = new WebSocketServer({ server: http });
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => http.close(() => resolve()))),
      () => fs.rm(temp, { recursive: true, force: true }),
    );
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    await fs.writeFile(
      path.join(runtime, 'connection.json'),
      JSON.stringify({ url: `ws://127.0.0.1:${address.port}`, pid: process.pid, token, version: 1 }),
    );
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.kind === 'hello')
          socket.send(JSON.stringify({ version: 1, id: message.id, ok: true, result: {} }));
        else if (message.kind === 'command')
          {
            socket.send(JSON.stringify({
              version: 1,
              id: message.id,
              ok: true,
              event: 'artifact_chunk',
              index: 0,
              data: archive.toString('base64'),
            }));
            socket.send(JSON.stringify({
              version: 1,
              id: message.id,
              ok: true,
              result: {
                chunks: 1,
                mimeType: 'application/zip',
                routes: 3,
                skippedRoutes: 1,
                deadlineReached: false,
              },
            }));
          }
      });
    });

    const child = spawn(
      process.execPath,
      [path.join(import.meta.dir, 'index.ts'), 'scrape', '--output', output, '--json'],
      { env: { ...process.env, XDG_RUNTIME_DIR: temp }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));

    expect(exitCode).toBe(0);
    expect(await fs.readFile(output)).toEqual(archive);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      result: {
        action: 'scrape-saved',
        output,
        bytes: archive.length,
        routes: 3,
        skippedRoutes: 1,
        deadlineReached: false,
      },
    });
  });

  test('writes a scroll GIF returned by the extension', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'browserctl-cli-test-'));
    const runtime = path.join(temp, 'browser-controller');
    const output = path.join(temp, 'page-scroll.gif');
    await fs.mkdir(runtime, { recursive: true });
    const token = 'a'.repeat(64);
    const gif = Buffer.from('GIF89a-scroll-frames');
    const http = await listeningServer();
    const server = new WebSocketServer({ server: http });
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => http.close(() => resolve()))),
      () => fs.rm(temp, { recursive: true, force: true }),
    );
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    await fs.writeFile(
      path.join(runtime, 'connection.json'),
      JSON.stringify({ url: `ws://127.0.0.1:${address.port}`, pid: process.pid, token, version: 1 }),
    );
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.kind === 'hello')
          socket.send(JSON.stringify({ version: 1, id: message.id, ok: true, result: {} }));
        else if (message.kind === 'command')
          {
            socket.send(JSON.stringify({
              version: 1,
              id: message.id,
              ok: true,
              event: 'artifact_chunk',
              index: 0,
              data: gif.toString('base64'),
            }));
            socket.send(JSON.stringify({
              version: 1,
              id: message.id,
              ok: true,
              result: {
                chunks: 1,
                mimeType: 'image/gif',
                width: 1200,
                height: 800,
                frames: 42,
                pixelsScrolled: 3360,
                durationMs: 2100,
              },
            }));
          }
      });
    });

    const child = spawn(
      process.execPath,
      [
        path.join(import.meta.dir, 'index.ts'),
        'scrollgif',
        '--output', output,
        '--fps', '20',
        '--duration-ms', '2100',
        '--dedicated-window',
        '--json',
      ],
      { env: { ...process.env, XDG_RUNTIME_DIR: temp }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));

    expect(exitCode).toBe(0);
    expect(await fs.readFile(output)).toEqual(gif);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      result: {
        action: 'scrollgif-saved',
        output,
        container: 'gif',
        encoder: 'gif89a',
        bytes: gif.length,
        frames: 42,
        width: 1200,
        height: 800,
        pixelsScrolled: 3360,
        durationMs: 2100,
      },
    });
  });

  test('parses scroll, real type, and coordinate click actions', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'browserctl-cli-test-'));
    const runtime = path.join(temp, 'browser-controller');
    await fs.mkdir(runtime, { recursive: true });
    const token = 'a'.repeat(64);
    const http = await listeningServer();
    const server = new WebSocketServer({ server: http });
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => http.close(() => resolve()))),
      () => fs.rm(temp, { recursive: true, force: true }),
    );
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    await fs.writeFile(
      path.join(runtime, 'connection.json'),
      JSON.stringify({ url: `ws://127.0.0.1:${address.port}`, pid: process.pid, token, version: 1 }),
    );
    const commands: unknown[] = [];
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === 'hello')
        return socket.send(JSON.stringify({ version: 1, id: message.id, ok: true, result: {} }));
      commands.push(message.command);
      if (message.command.type === 'scrollgif') {
        socket.send(JSON.stringify({
          version: 1,
          id: message.id,
          ok: true,
          event: 'artifact_chunk',
          index: 0,
          data: Buffer.from('GIF89a').toString('base64'),
        }));
        return socket.send(JSON.stringify({
          version: 1,
          id: message.id,
          ok: true,
          result: {
            chunks: 1,
            mimeType: 'image/gif',
            width: 100,
            height: 80,
            frames: 2,
            pixelsScrolled: 160,
            durationMs: 100,
          },
        }));
      }
      socket.send(JSON.stringify({ version: 1, id: message.id, ok: true, result: { action: message.command.type } }));
    }));
    const invocations = [
      ['scroll', '--text', 'More', '--into-view', '--json'],
      ['type', '--label', 'Search', '--value', 'kebap', '--clear', '--delay', '25', '--submit', '--json'],
      ['click', '--at', '120,240', '--button', 'right', '--json'],
      ['scrollgif', '--fps', '25', '--step', '40', '--selector', '.feed', '--json'],
    ];
    for (const invocationArgs of invocations) {
      const child = spawn(process.execPath, [path.join(import.meta.dir, 'index.ts'), ...invocationArgs], {
        env: { ...process.env, XDG_RUNTIME_DIR: temp },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      expect(await new Promise<number | null>((resolve) => child.once('close', resolve))).toBe(0);
    }
    expect(commands).toEqual([
      { type: 'scroll', session: 'last', locator: { by: 'text', value: 'More', exact: false }, intoView: true },
      { type: 'type', session: 'last', locator: { by: 'label', value: 'Search', exact: false }, text: 'kebap', delay: 25, clear: true, submit: true },
      { type: 'click', session: 'last', button: 'right', x: 120, y: 240 },
      { type: 'scrollgif', session: 'last', selector: '.feed', format: 'video', fps: 25, step: 40, dedicatedWindow: false },
    ]);
  });
});
