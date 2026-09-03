import { describe, expect, test } from 'bun:test';
import { selectControlTab } from '../extension/control-tab.js';

describe('extension control tab selection', () => {
  test('selects only the explicitly paired tab, never another active tab', () => {
    const tabs = [
      { id: 41, url: 'https://work.example/', active: true },
      { id: 17, url: 'https://paired.example/', active: false },
    ];

    expect(selectControlTab(tabs, 17)).toEqual(tabs[1]);
    expect(selectControlTab(tabs, 99)).toBeNull();
    expect(selectControlTab(tabs, null)).toBeNull();
  });
});
