import { describe, expect, test } from 'bun:test';
import { CommandCache } from '../extension/command-cache.js';

describe('extension command cache', () => {
  test('runs duplicate command IDs at most once', async () => {
    const cache = new CommandCache();
    let executions = 0;
    const operation = async () => {
      executions += 1;
      await Promise.resolve();
      return { ok: true };
    };

    const [first, duplicate] = await Promise.all([
      cache.run('session:1', operation),
      cache.run('session:1', operation),
    ]);

    expect(first).toEqual({ ok: true });
    expect(duplicate).toEqual(first);
    expect(executions).toBe(1);
  });
});
