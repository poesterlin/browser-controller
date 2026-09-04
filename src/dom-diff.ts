import type { DomResult } from './protocol/index.js';

function lines(result: DomResult) {
  const content = result.html ?? JSON.stringify(result.node ?? result.items ?? null, null, 2);
  return content.split('\n').map((line) => line.trim()).filter(Boolean);
}

export class DomSnapshotHistory {
  private previous?: Set<string>;

  record(result: DomResult, includeDiff = false): DomResult {
    const current = new Set(lines(result));
    const previous = this.previous;
    this.previous = current;
    if (!includeDiff) return result;
    if (!previous)
      return { ...result, diff: { added: [], removed: [], changed: false, baseline: true } };
    const added = [...current].filter((line) => !previous.has(line)).slice(0, 200);
    const removed = [...previous].filter((line) => !current.has(line)).slice(0, 200);
    return {
      ...result,
      diff: { added, removed, changed: added.length > 0 || removed.length > 0, baseline: false },
    };
  }
}
