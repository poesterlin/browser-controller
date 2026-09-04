import { describe, expect, test } from 'bun:test';
import { DomSnapshotHistory } from './dom-diff.js';

describe('DOM snapshot history', () => {
  test('establishes a baseline and reports compact line changes', () => {
    const history = new DomSnapshotHistory();
    expect(history.record({ format: 'clean_html', html: '<main>one</main>' }, true).diff)
      .toEqual({ added: [], removed: [], changed: false, baseline: true });
    expect(history.record({ format: 'clean_html', html: '<main>two</main>' }, true).diff)
      .toEqual({
        added: ['<main>two</main>'],
        removed: ['<main>one</main>'],
        changed: true,
        baseline: false,
      });
  });

  test('updates history even when diff output is not requested', () => {
    const history = new DomSnapshotHistory();
    history.record({ format: 'clean_html', html: 'before' });
    expect(history.record({ format: 'clean_html', html: 'after' }, true).diff?.baseline).toBe(false);
  });

  test('keeps unrelated snapshot shapes in separate histories', () => {
    const history = new DomSnapshotHistory();
    history.record({ format: 'interactive', items: [] }, false, 'interactive:page');
    expect(history.record({ format: 'clean_html', html: '<main />' }, true, 'clean:main').diff)
      .toEqual({ added: [], removed: [], changed: false, baseline: true });
  });
});
