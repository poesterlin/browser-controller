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
});
