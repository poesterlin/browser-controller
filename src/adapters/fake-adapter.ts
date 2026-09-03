// Fake adapter: exercises the supervisor's pairing/session/adapter protocol
// without a browser. Run a supervisor, then: bun scripts/fake-adapter.ts
import { WebSocket } from 'ws';
import { readDiscovery } from '../supervisor/discovery.js';

function assert(option: any): asserts option {
  if (!option) {
    throw new Error("assertion failed");
  }
}

const d = await readDiscovery();
assert(d);
const c = new WebSocket(d.url);
await new Promise((r) => c.on('open', r));
c.send(JSON.stringify({ version: 1, id: 'h', kind: 'hello', token: d.token }));
let helloDone = new Promise((r) =>
  c.on('message', function f(raw) {
    const m = JSON.parse(raw.toString());
    if (m.id === 'h') {
      c.off('message', f);
      r(m);
    }
  }),
);
await helloDone;

c.send(
  JSON.stringify({ version: 1, id: 'p', kind: 'command', command: { type: 'extension_pair' } }),
);
const p = await new Promise<any>((r) =>
  c.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id === 'p') r(m.result);
  }),
);

const e = new WebSocket(p.endpoint);
e.on('open', () =>
  e.send(
    JSON.stringify({
      version: 1,
      id: 'eh',
      kind: 'hello',
      role: 'extension',
      token: p.code,
      adapterId: p.adapterId,
    }),
  ),
);
e.on('close', (code, reason) => console.log('EXT closed', code, reason.toString()));
e.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  console.log('EXT got:', JSON.stringify(m).slice(0, 120));
  if (m.id) {
    console.log('FAKE replied to', m.id);
    e.send(JSON.stringify({ reply: m.id, ok: true, result: 'pong' }));
  }
});

const connected = new Promise<any>((r) =>
  c.on('message', function f(raw) {
    const m = JSON.parse(raw.toString());
    if (m.event === 'adapter_connected') {
      c.off('message', f);
      r(m);
    }
  }),
);
console.log('connected:', JSON.stringify(await connected));

c.send(JSON.stringify({ version: 1, id: 's', kind: 'command', command: { type: 'start' } }));
const s = await new Promise<any>((r) =>
  c.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id === 's') r(m);
  }),
);
console.log('start:', JSON.stringify(s));

c.send(
  JSON.stringify({
    version: 1,
    id: 'e2',
    kind: 'command',
    command: { type: 'evaluate', session: s.result?.id, expression: '1+1' },
  }),
);
const r = await new Promise<any>((res) =>
  c.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id === 'e2') res(m);
  }),
);
console.log('evaluate:', JSON.stringify(r));
process.exit(0);
