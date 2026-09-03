import { describe, expect, test } from 'bun:test';
import { withTimeout } from '../extension/async.js';

describe('extension async deadlines', () => {
  test('returns completed work', async () => {
    expect(await withTimeout(Promise.resolve('done'), 50, 'timed_out')).toBe('done');
  });

  test('rejects work that never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 5, 'timed_out')).rejects.toThrow('timed_out');
  });
});
