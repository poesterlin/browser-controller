import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  hashToken,
  readAdapterCredentials,
  writeAdapterCredentials,
  writeDiscovery,
  removeDiscovery,
  token,
} from './discovery.js';
import {
  validateEnvelope,
  success,
  failure,
  PROTOCOL_VERSION,
  type Command,
  type Response,
} from '../protocol/index.js';
import type { BrowserSession } from '../session.js';
import { QueuedSession, SessionError } from '../session.js';
import { DomSnapshotHistory } from '../dom-diff.js';

type Socket = WebSocket & {
  role?: 'controller' | 'extension';
  adapterId?: string;
  commandResults?: Map<string, Promise<Response>>;
};
const capabilities = [
  'navigate',
  'dom',
  'click',
  'fill',
  'type',
  'select',
  'scroll',
  'bounds',
  'highlight',
  'drag',
  'activate',
  'wait',
  'evaluate',
  'press',
  'screenshot.viewport',
  'screenshot.fullPage',
  'screenshot.element',
  'scrape.snapshot',
] as const;
export class Supervisor {
  readonly token = token();
  readonly sessions = new Map<string, QueuedSession>();
  private server: WebSocketServer;
  private http: Server;
  private controllers = new Set<Socket>();
  private adapters = new Map<string, Socket>();
  private pairing = new Map<string, { expires: number; adapterId: string }>();
  private adapterTokens = new Map<string, string>();
  private adapterTokensReady = readAdapterCredentials().then((credentials) => {
    this.adapterTokens = new Map(Object.entries(credentials));
  });
  private tokenWrite = Promise.resolve();
  private closing = false;
  constructor(public readonly port = 47921) {
    this.http = createServer((req, res) => {
      if (req.url?.startsWith('/pair')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Browser Controller pairing</title><h1>Browser Controller</h1><p>Pairing extension&hellip;</p><script>window.postMessage({type:'browser-controller-pair',endpoint:${JSON.stringify(`ws://127.0.0.1:${port}`)},code:new URLSearchParams(location.search).get('code'),adapterId:new URLSearchParams(location.search).get('adapter')},'*');</script>`,
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.server = new WebSocketServer({ server: this.http });
    this.server.on('connection', (s) => this.connection(s as Socket));
    this.http.listen(port, '127.0.0.1', () => this.ready());
  }
  private async ready() {
    const address = this.server.address();
    const p = typeof address === 'object' && address ? address.port : this.port;
    await writeDiscovery({
      url: `ws://127.0.0.1:${p}`,
      pid: process.pid,
      token: this.token,
      version: PROTOCOL_VERSION,
    });
  }
  private connection(s: Socket) {
    const deadline = setTimeout(() => s.close(), 5000);
    s.once('message', async (raw) => {
      clearTimeout(deadline);
      let input: unknown;
      try {
        input = JSON.parse(raw.toString());
      } catch {
        s.close();
        return;
      }
      const v = validateEnvelope(input);
      if (!v.ok || v.value.kind !== 'hello') {
        s.close();
        return;
      }
      if (v.value.role === 'extension') {
        await this.adapterTokensReady;
        let adapterId: string | null = null;
        let issued: string | undefined;
        const stored = v.value.adapterId ? this.adapterTokens.get(v.value.adapterId) : undefined;
        if (v.value.adapterToken && stored === hashToken(v.value.adapterToken) && v.value.adapterId)
          adapterId = v.value.adapterId;
        else {
          const pair = this.pairing.get(v.value.token ?? '');
          if (!pair || pair.expires < Date.now() || pair.adapterId !== v.value.adapterId) {
            s.close();
            return;
          }
          this.pairing.delete(v.value.token!);
          adapterId = pair.adapterId;
          issued = randomBytes(32).toString('hex');
          this.adapterTokens.set(adapterId, hashToken(issued));
          this.tokenWrite = this.tokenWrite.then(() =>
            writeAdapterCredentials(Object.fromEntries(this.adapterTokens)),
          );
          await this.tokenWrite;
        }
        s.role = 'extension';
        s.adapterId = adapterId;
        this.adapters.set(adapterId, s);
        for (const controller of this.controllers)
          controller.send(JSON.stringify({ event: 'adapter_connected', adapterId }));
        s.on('close', () => {
          if (this.adapters.get(adapterId!) === s) this.adapters.delete(adapterId!);
          for (const session of this.sessions.values()) {
            const ref = (session.adapter as any).ref;
            if (ref?.current === s) {
              ref.current = null;
              session.disconnect();
            }
          }
        });
        for (const session of this.sessions.values()) {
          const ref = (session.adapter as any).ref;
          if (ref?.adapterId === adapterId && ref.current !== s) {
            ref.current = s;
            ref.attach(s);
            (session as any).socket = s;
            try {
              await bindExtension(s, session.id);
              session.reconnect();
            } catch {
              ref.current = null;
              session.disconnect();
            }
          }
        }
        s.send(
          JSON.stringify(
            success(v.value.id, { authenticated: true, adapterId, adapterToken: issued }),
          ),
        );
        return;
      }
      if (v.value.token !== this.token) {
        s.send(JSON.stringify(failure(v.value.id, 'authentication_failed', 'invalid token')));
        s.close();
        return;
      }
      s.role = 'controller';
      s.commandResults = new Map();
      this.controllers.add(s);
      s.on('message', (m) => this.command(s, m.toString()));
      s.on('close', () => this.controllers.delete(s));
      s.send(JSON.stringify(success(v.value.id, { authenticated: true })));
    });
  }
  private async command(s: Socket, raw: string) {
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return;
    }
    const v = validateEnvelope(input);
    if (!v.ok) {
      s.send(
        JSON.stringify(
          failure(isObj(input) && typeof input.id === 'string' ? input.id : '-', v.code, v.message),
        ),
      );
      return;
    }
    if (v.value.kind !== 'command' || !v.value.command) return;
    const prior = s.commandResults?.get(v.value.id);
    if (prior) {
      await sendControllerResponse(s, await prior);
      return;
    }
    const result = this.dispatch(v.value.id, v.value.command);
    s.commandResults?.set(v.value.id, result);
    if ((s.commandResults?.size ?? 0) > 1_000)
      s.commandResults?.delete(s.commandResults.keys().next().value!);
    await sendControllerResponse(s, await result);
  }
  private async connectedAdapter(adapterId?: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (adapterId) {
        const socket = this.adapters.get(adapterId);
        if (socket?.readyState === WebSocket.OPEN) return [adapterId, socket] as const;
      } else {
        const available = [...this.adapters.entries()].find(
          ([, socket]) => socket.readyState === WebSocket.OPEN,
        );
        if (available) return available as [string, Socket];
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }
  private async startSession(adapter?: string, name?: string) {
    const connected = await this.connectedAdapter(adapter);
    if (!connected)
      throw new SessionError(
        'adapter_unavailable',
        adapter
          ? `extension did not reconnect within 10 seconds: ${adapter}`
          : 'no extension connected within 10 seconds; run browserctl extension pair',
      );
    const [adapterId, socket] = connected;
    let existing = [...this.sessions.values()].find(
      (candidate) =>
        (candidate.adapter as any).ref?.adapterId === adapterId &&
        candidate.state !== 'exited' &&
        candidate.state !== 'removed',
    );
    if (existing) {
      const ref = (existing.adapter as any).ref;
      if (ref.current !== socket) {
        ref.current = socket;
        ref.attach(socket);
        (existing as any).socket = socket;
      }
      await bindExtension(socket, existing.id);
      existing.reconnect();
      return { session: existing, adapterId, existing: true };
    }
    for (const [sessionId, session] of this.sessions)
      if (session.state === 'exited' || session.state === 'removed') this.sessions.delete(sessionId);
    const sessionId = randomUUID();
    await bindExtension(socket, sessionId);
    existing = new QueuedSession(sessionId, name, makeExtensionSession(socket, sessionId));
    (existing as any).socket = socket;
    (existing.adapter as any).ref.adapterId = adapterId;
    this.sessions.set(sessionId, existing);
    existing.start();
    return { session: existing, adapterId, existing: false };
  }
  private async dispatch(id: string, c: Command) {
    try {
      if (c.type === 'list')
        return success(
          id,
          [...this.sessions.values()].map((s) => ({ id: s.id, name: s.name, state: s.state })),
        );
      if (c.type === 'status') {
        await this.adapterTokensReady;
        const adapterIds = new Set([...this.adapterTokens.keys(), ...this.adapters.keys()]);
        const extensions = await Promise.all(
          [...adapterIds].map(async (adapterId) => {
            const socket = this.adapters.get(adapterId);
            if (!socket || socket.readyState !== WebSocket.OPEN)
              return { id: adapterId, state: 'disconnected' };
            try {
              return {
                id: adapterId,
                state: 'connected',
                ...(await requestExtension(socket, 'status', {}, 1_500)),
              };
            } catch (error) {
              return { id: adapterId, state: 'connected', error: (error as Error).message };
            }
          }),
        );
        const needsPairing =
          extensions.length === 0 ||
          !extensions.some(
            (extension) =>
              extension.state === 'connected' &&
              'tabAvailable' in extension &&
              extension.tabAvailable,
          );
        return success(id, {
          supervisor: { state: 'running', pid: process.pid, port: this.port },
          extensions,
          sessions: [...this.sessions.values()].map((session) => ({
            id: session.id,
            name: session.name ?? null,
            state: session.state,
            expiresAt: new Date(session.deadlineAt).toISOString(),
          })),
          recovery: needsPairing ? 'run browserctl extension pair' : null,
        });
      }
      if (c.type === 'extension_pair') {
        const code = randomBytes(4).toString('hex');
        const adapterId = randomUUID();
        this.pairing.set(code, { expires: Date.now() + 300000, adapterId });
        const d = await import('./discovery.js').then((x) => x.readDiscovery());
        return success(id, { code, adapterId, endpoint: d?.url, expiresIn: 300 });
      }
      if (c.type === 'start') {
        const { session, adapterId, existing } = await this.startSession(c.adapter, c.name);
        return success(id, {
          id: session.id,
          name: session.name,
          capabilities: [...capabilities],
          adapter: adapterId,
          existing,
        });
      }
      let s =
        c.session === 'last' ? [...this.sessions.values()].at(-1) : this.sessions.get(c.session);
      if (c.session === 'last' && (!s || s.state !== 'running')) {
        const adapterId = s ? (s.adapter as any).ref?.adapterId : undefined;
        s = (await this.startSession(adapterId)).session;
      }
      if (!s) return failure(id, 'session_not_found', 'session not found');
      if (c.type === 'close') {
        await s.close(c.reason ?? 'closed');
        this.sessions.delete(s.id);
        return success(id, { action: 'closed', session: s.id });
      }
      const required =
        c.type === 'scrape'
          ? 'scrape.snapshot'
          : c.type === 'screenshot'
          ? c.fullPage
            ? 'screenshot.fullPage'
            : c.selector
              ? 'screenshot.element'
              : 'screenshot.viewport'
          : c.type;
      if (!s.adapter.capabilities().includes(required as never))
        return failure(id, 'capability_unavailable', `capability unavailable: ${required}`);
      const result = await s.execute(async () => {
        switch (c.type) {
          case 'navigate':
            return {
              action: 'navigated',
              requestedUrl: c.url,
              ...((await s.adapter.navigate(c.url, c.timeout)) as object | undefined),
            };
          case 'dom':
            return finishAction(s, c, await s.adapter.dom({
              locator: c.locator ?? (c.selector ? { by: 'css', value: c.selector } : undefined),
              maxChars: c.maxChars,
              format: c.format,
              textChars: c.textChars,
              depth: c.depth,
              offset: c.offset,
              limit: c.limit,
              within: c.within,
              nth: c.nth,
              itemLimit: c.itemLimit,
              diff: c.diff,
            }));
          case 'screenshot':
            return s.adapter.screenshot({ fullPage: c.fullPage, selector: c.selector, waitForActive: c.waitForActive });
          case 'scrape':
            return s.adapter.scrape({
              url: c.url,
              timeout: c.timeout,
              maxBytes: c.maxBytes,
              maxRoutes: c.maxRoutes,
              maxDuration: c.maxDuration,
              dedicatedWindow: c.dedicatedWindow,
            });
          case 'click':
            {
              const locator = c.locator ?? (c.selector ? { by: 'css' as const, value: c.selector } : undefined);
              const clickResult = await s.adapter.click(locator, c.within, c.nth, {
                waitNavigation: c.waitNavigation,
                timeout: c.timeout,
                button: c.button,
                double: c.double,
                modifiers: c.modifiers,
                offsetX: c.offsetX,
                offsetY: c.offsetY,
                holdMs: c.holdMs,
                x: c.x,
                y: c.y,
              });
              return finishAction(s, c, { action: 'clicked', ...(locator ? { locator } : { x: c.x, y: c.y }), ...(c.within ? { within: c.within } : {}), ...(c.nth !== undefined ? { nth: c.nth } : {}), ...((clickResult as object) ?? {}) });
            }
          case 'press':
            {
              const locator = c.locator ?? (c.selector ? { by: 'css' as const, value: c.selector } : undefined);
              await s.adapter.press(locator, c.key, c.within, c.nth);
              return finishAction(s, c, { action: 'pressed', ...(locator ? { locator } : {}), key: c.key, ...(c.within ? { within: c.within } : {}) });
            }
          case 'fill':
            {
              const locator = c.locator ?? { by: 'css' as const, value: c.selector! };
              const fillResult = (await s.adapter.fill(locator, c.text, c.within, c.nth)) as
                | { ok?: boolean; valueLength?: number; verified?: boolean }
                | string
                | undefined;
              return finishAction(s, c, {
                action: 'filled',
                locator,
                ...(c.within ? { within: c.within } : {}),
                valueLength: c.text.length,
                ...(typeof fillResult === 'object' && fillResult?.verified !== undefined
                  ? { verified: fillResult.verified }
                  : {}),
              });
            }
          case 'type':
            {
              const locator = c.locator ?? { by: 'css' as const, value: c.selector! };
              const typeResult = await s.adapter.type(locator, c.text, {
                within: c.within,
                nth: c.nth,
                delay: c.delay,
                clear: c.clear,
                submit: c.submit,
              });
              return finishAction(s, c, { action: 'typed', locator, characters: c.text.length, ...((typeResult as object) ?? {}) });
            }
          case 'select':
            {
              const locator = c.locator ?? { by: 'css' as const, value: c.selector! };
              const selectResult = await s.adapter.select(locator, {
                value: c.value,
                optionText: c.optionText,
                values: c.values,
                within: c.within,
                nth: c.nth,
              });
              return finishAction(s, c, {
                action: 'selected',
                locator,
                ...(isObj(selectResult) ? selectResult : {}),
              });
            }
          case 'scroll':
            return finishAction(s, c, await s.adapter.scroll(c) as object);
          case 'bounds':
            return s.adapter.bounds(c.locator, c.within, c.nth);
          case 'highlight':
            return s.adapter.highlight(c.locator, c.within, c.nth, c.duration);
          case 'drag':
            return finishAction(s, c, {
              action: 'dragged',
              ...((await s.adapter.drag(c.from, {
                to: c.to,
                fromNth: c.fromNth,
                toNth: c.toNth,
                toX: c.toX,
                toY: c.toY,
              })) as object),
            });
          case 'activate':
            return s.adapter.activate();
          case 'wait':
            {
              const waitResult = await s.adapter.wait({
              ...c,
              locator:
                c.locator ??
                (c.selector
                  ? { by: 'css', value: c.selector }
                  : c.text
                    ? { by: 'text', value: c.text }
                    : undefined),
              });
              if (
                !waitResult ||
                typeof waitResult !== 'object' ||
                (waitResult as { action?: string }).action !== 'matched'
              )
                throw new SessionError('timeout', 'wait condition was not met', waitResult);
              return waitResult;
            }
          case 'evaluate':
            return s.adapter.evaluate(c.expression);
        }
        return undefined;
      },
      c.type === 'scrape'
        ? (c.maxDuration ?? 120_000) + 75_000
        : c.type === 'type'
          ? Math.min(120_000, c.text.length * (c.delay ?? 0) + 10_000)
        : c.type === 'drag'
          ? 30_000
        : c.type === 'wait' || c.type === 'navigate'
        ? (c.timeout ?? 10_000) + 1_000
        : c.type === 'click'
          ? (c.timeout ?? 10_000) + 1_000
        : c.type === 'screenshot' && (c.fullPage || c.selector)
          ? 120_000 + (c.waitForActive ?? 0)
          : c.type === 'screenshot' && c.waitForActive
            ? c.waitForActive + 5_000
          : 10_000);
      return success(id, result);
    } catch (e) {
      const x = e as SessionError;
      return failure(id, x.code ?? 'adapter_error', x.message ?? 'adapter error', x.details);
    }
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    for (const s of this.sessions.values()) await s.close('supervisor shutdown');
    this.sessions.clear();
    for (const socket of [...this.controllers, ...this.adapters.values()]) socket.close();
    await removeDiscovery(process.pid);
    await new Promise<void>((r) => this.server.close(() => this.http.close(() => r())));
  }
}
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

async function finishAction(
  session: QueuedSession,
  command: { screenshotAfter?: boolean; intent?: string },
  result: object,
) {
  return {
    ...result,
    ...(command.intent ? { intent: command.intent } : {}),
    ...(command.screenshotAfter ? { screenshot: await session.adapter.screenshot({}) } : {}),
  };
}

function sendSocket(socket: Socket, value: unknown) {
  return new Promise<void>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) return resolve();
    socket.send(JSON.stringify(value), (error) => (error ? reject(error) : resolve()));
  });
}

async function sendControllerResponse(socket: Socket, response: Response) {
  if (response.ok && isObj(response.result) && Array.isArray(response.result.chunks)) {
    const { chunks, ...result } = response.result;
    for (let index = 0; index < chunks.length; index += 1)
      await sendSocket(socket, {
        version: PROTOCOL_VERSION,
        id: response.id,
        ok: true,
        event: 'artifact_chunk',
        index,
        data: chunks[index],
      });
    await sendSocket(socket, { ...response, result: { ...result, chunks: chunks.length } });
    return;
  }
  await sendSocket(socket, response);
}

function bindExtension(socket: Socket, session: string) {
  return requestExtension(socket, 'bind', { session }, 3_000);
}

function requestExtension<T = any>(
  socket: Socket,
  kind: string,
  payload: object,
  timeoutMs: number,
) {
  return new Promise<T>((resolve, reject) => {
    const id = `${kind}-${randomUUID()}`;
    const finish = (error?: SessionError, result?: T) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      if (error) reject(error);
      else resolve(result!);
    };
    const onMessage = (raw: unknown) => {
      try {
        const message = JSON.parse(String(raw));
        if (message.reply !== id) return;
        if (message.ok) finish(undefined, message.result);
        else
          finish(
            new SessionError(
              message.error?.code ?? 'extension_error',
              message.error?.message ?? `extension ${kind} request failed`,
            ),
          );
      } catch {}
    };
    const timer = setTimeout(
      () =>
        finish(
          new SessionError(
            'extension_timeout',
            `extension did not answer ${kind} within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ kind, id, ...payload }));
  });
}

function makeExtensionSession(
  socket: Socket,
  session: string,
): BrowserSession & {
  ref: { current: Socket | null; adapterId: string };
} {
  let n = 0;
  const domHistory = new DomSnapshotHistory();
  let handler: ((raw: unknown) => void) | null = null;
  const attach = (sock: Socket) => {
    if (handler) sock.on('message', handler);
  };
  const ref = { current: socket as Socket | null, adapterId: '', attach };
  const pending = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    chunks: string[];
  }>();
  handler = (raw: unknown) => {
    try {
      const m = JSON.parse(String(raw));
      if (m.reply && pending.has(m.reply)) {
        const p = pending.get(m.reply)!;
        if (m.event === 'artifact_chunk') {
          if (m.index !== p.chunks.length || typeof m.data !== 'string') {
            pending.delete(m.reply);
            p.reject(new SessionError('artifact_transport_error', 'invalid artifact chunk sequence'));
          } else p.chunks.push(m.data);
          return;
        }
        pending.delete(m.reply);
        if (m.ok) {
          if (typeof m.result?.chunks === 'number' && m.result.chunks !== p.chunks.length)
            p.reject(new SessionError('artifact_transport_error', 'incomplete artifact transfer'));
          else p.resolve(p.chunks.length ? { ...m.result, chunks: p.chunks } : m.result);
        }
        else
          p.reject(
            new SessionError(
              m.error?.code ?? 'adapter_error',
              m.error?.message ?? 'extension error',
            ),
          );
      }
    } catch {}
  };
  attach(socket);
  const call = (type: string, payload: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++n;
      pending.set(id, { resolve, reject, chunks: [] });
      // The adapter may be mid-reconnect (token refresh, worker restart).
      // Wait briefly for the socket to come back before giving up.
      const start = Date.now();
      const trySend = () => {
        if (ref.current?.readyState === 1) {
          ref.current.send(JSON.stringify({ kind: 'command', id, session, type, ...payload }));
          return;
        }
        if (Date.now() - start < 4000) return void setTimeout(trySend, 100);
        pending.delete(id);
        reject(new SessionError('adapter_disconnected', 'adapter is disconnected'));
      };
      trySend();
    });
  return {
    capabilities: () => [...capabilities],
    navigate: (u, timeout) => call('navigate', { url: u, timeout }),
    screenshot: (o) => call('screenshot', o),
    scrape: (o) => call('scrape', o),
    dom: async (o) => domHistory.record(
      await call('dom', o),
      o.diff,
      JSON.stringify({
        format: o.format ?? 'clean_html',
        locator: o.locator ?? o.selector,
        within: o.within,
        nth: o.nth,
        offset: o.offset,
        limit: o.limit,
      }),
    ),
    click: (locator, within, nth, options) => call('click', { locator, within, nth, ...options }),
    press: (locator, key, within, nth) => call('press', { locator, key, within, nth }),
    fill: (locator, text, within, nth) => call('fill', { locator, text, within, nth }),
    type: (locator, text, options) => call('type', { locator, text, ...options }),
    select: (locator, options) => call('select', { locator, ...options }),
    scroll: (options) => call('scroll', options),
    bounds: (locator, within, nth) => call('bounds', { locator, within, nth }),
    highlight: (locator, within, nth, duration) => call('highlight', { locator, within, nth, duration }),
    drag: (from, options) => call('drag', { from, ...options }),
    activate: () => call('activate', {}),
    wait: (options) => call('wait', options),
    evaluate: (expression) => call('evaluate', { expression }),
    close: (reason) => call('close', { reason }),
    ref,
  };
}
