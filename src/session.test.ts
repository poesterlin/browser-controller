import { describe, expect, test } from 'bun:test';
import { QueuedSession, SessionError } from './session.js';
import type { BrowserSession } from './session.js';

const fake = (): BrowserSession => ({
  capabilities: () => [],
  navigate: async () => {},
    screenshot: async () => ({ data: '', mimeType: 'image/png', width: 0, height: 0 }),
    scrape: async () => ({ files: [], url: '', title: null, capturedAt: '', bytes: 0, routes: 0 }),
  dom: async () => ({ format: 'clean_html', html: '' }),
  click: async () => {},
  press: async () => {},
    fill: async () => {},
    select: async () => {},
  wait: async () => ({}),
  evaluate: async () => ({ value: null }),
  close: async () => {},
});
describe('session queue', () => {
  test('runs accepted work FIFO', async () => {
    const order: string[] = [];
    const s = new QueuedSession('id', undefined, fake());
    s.start();
    const a = s.execute(async () => {
      order.push('a');
    });
    const b = s.execute(async () => {
      order.push('b');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
    await s.close();
  });
  test('starts command timeout at dequeue', async () => {
    const s = new QueuedSession('id', undefined, fake());
    s.start();
    let release!: () => void;
    const blocker = s.execute(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const queued = s.execute(async () => {}, 10);
    await new Promise((r) => setTimeout(r, 30));
    release();
    await blocker;
    await expect(queued).resolves.toBeUndefined();
    await s.close();
  });
  test('does not run queued work after close', async () => {
    const s = new QueuedSession('id', undefined, fake());
    s.start();
    await s.close();
    await expect(s.execute(async () => {})).rejects.toBeInstanceOf(SessionError);
  });
});
