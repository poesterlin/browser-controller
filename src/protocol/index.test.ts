import { describe, expect, test } from 'bun:test';
import { validateEnvelope, PROTOCOL_VERSION } from './index.js';

describe('protocol validation', () => {
  test('accepts additive fields and preserves the command', () => {
    const result = validateEnvelope({
      version: PROTOCOL_VERSION,
      id: 'opaque',
      kind: 'command',
      command: { type: 'dom', session: 's', future: true },
    });
    expect(result.ok).toBe(true);
  });
  test('rejects unknown commands and versions', () => {
    expect(
      validateEnvelope({
        version: 99,
        id: 'x',
        kind: 'command',
        command: { type: 'dom', session: 's' },
      }),
    ).toMatchObject({ code: 'unsupported_version' });
    expect(
      validateEnvelope({ version: 1, id: 'x', kind: 'command', command: { type: 'explode' } }),
    ).toMatchObject({ code: 'invalid_request' });
    expect(
      validateEnvelope({
        version: 1,
        id: 'label-fill',
        kind: 'command',
        command: {
          type: 'fill',
          session: 's',
          locator: { by: 'label', value: 'Email' },
          text: 'person@example.com',
        },
      }).ok,
    ).toBe(true);
    expect(
      validateEnvelope({
        version: 1,
        id: 'ambiguous-wait',
        kind: 'command',
        command: {
          type: 'wait',
          session: 's',
          locator: { by: 'text', value: 'Saved' },
          url: 'https://example.com/',
        },
      }),
    ).toMatchObject({ code: 'invalid_request' });
    expect(
      validateEnvelope({
        version: 1,
        id: 'count-wait',
        kind: 'command',
        command: { type: 'wait', session: 's', selector: '.result', count: 3 },
      }).ok,
    ).toBe(true);
    expect(
      validateEnvelope({
        version: 1,
        id: 'ambiguous-predicate',
        kind: 'command',
        command: { type: 'wait', session: 's', selector: '.result', count: 3, changes: true },
      }),
    ).toMatchObject({ code: 'invalid_request' });
  });
  test('requires non-empty correlation IDs', () => {
    expect(validateEnvelope({ version: 1, id: '', kind: 'hello', token: 'x' })).toMatchObject({
      code: 'invalid_request',
    });
  });
  test('validates fill, wait, and DOM limits', () => {
    expect(
      validateEnvelope({
        version: 1,
        id: 'fill',
        kind: 'command',
        command: { type: 'fill', session: 's', selector: '#name', text: '' },
      }).ok,
    ).toBe(true);
    expect(
      validateEnvelope({
        version: 1,
        id: 'wait',
        kind: 'command',
        command: { type: 'wait', session: 's', selector: '#ready', state: 'visible', timeout: 5000 },
      }).ok,
    ).toBe(true);
    expect(
      validateEnvelope({
        version: 1,
        id: 'ambiguous',
        kind: 'command',
        command: { type: 'wait', session: 's', selector: '#ready', text: 'ready' },
      }),
    ).toMatchObject({ code: 'invalid_request' });
    expect(
      validateEnvelope({
        version: 1,
        id: 'large-dom',
        kind: 'command',
        command: { type: 'dom', session: 's', maxChars: 1_000_001 },
      }),
    ).toMatchObject({ code: 'invalid_request' });
  });
  test('validates semantic locators', () => {
    expect(
      validateEnvelope({
        version: 1,
        id: 'role',
        kind: 'command',
        command: {
          type: 'click',
          session: 's',
          locator: { by: 'role', value: 'button', name: 'Save', exact: true },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateEnvelope({
        version: 1,
        id: 'bad-name',
        kind: 'command',
        command: {
          type: 'click',
          session: 's',
          locator: { by: 'label', value: 'Email', name: 'invalid' },
        },
      }),
    ).toMatchObject({ code: 'invalid_request' });
    expect(
      validateEnvelope({
        version: 1,
        id: 'scoped',
        kind: 'command',
        command: {
          type: 'click',
          session: 's',
          locator: { by: 'role', value: 'button', name: 'Edit' },
          within: { by: 'text', value: 'Hardware-Basteln', exact: true },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateEnvelope({
        version: 1,
        id: 'page',
        kind: 'command',
        command: { type: 'dom', session: 's', format: 'summary', offset: 10, limit: 25 },
      }).ok,
    ).toBe(true);
  });
  test('accepts status and validates navigation timeout', () => {
    expect(
      validateEnvelope({
        version: 1,
        id: 'status',
        kind: 'command',
        command: { type: 'status' },
      }).ok,
    ).toBe(true);
    expect(
      validateEnvelope({
        version: 1,
        id: 'navigate',
        kind: 'command',
        command: { type: 'navigate', session: 'last', url: 'https://example.com', timeout: 0 },
      }),
    ).toMatchObject({ code: 'invalid_request' });
  });
  test('validates active waits, selection, indexing, and summary limits', () => {
    expect(
      validateEnvelope({
        version: 1,
        id: 'active',
        kind: 'command',
        command: { type: 'wait', session: 's', tabActive: true, timeout: 5000 },
      }).ok,
    ).toBe(true);
    expect(
      validateEnvelope({
        version: 1,
        id: 'select',
        kind: 'command',
        command: {
          type: 'select',
          session: 's',
          locator: { by: 'label', value: 'Kind' },
          value: 'atom',
          nth: 0,
        },
      }).ok,
    ).toBe(true);
    expect(
      validateEnvelope({
        version: 1,
        id: 'bad-select',
        kind: 'command',
        command: {
          type: 'select',
          session: 's',
          locator: { by: 'label', value: 'Kind' },
          value: 'atom',
          optionText: 'Atom',
        },
      }),
    ).toMatchObject({ code: 'invalid_request' });
    expect(
      validateEnvelope({
        version: 1,
        id: 'bad-limit',
        kind: 'command',
        command: { type: 'dom', session: 's', format: 'summary', itemLimit: 501 },
      }),
    ).toMatchObject({ code: 'invalid_request' });
  });
  test('accepts URL globs and navigation-aware clicks', () => {
    expect(
      validateEnvelope({
        version: 1,
        id: 'glob',
        kind: 'command',
        command: { type: 'wait', session: 's', urlGlob: '**/karriere/**', timeout: 5000 },
      }).ok,
    ).toBe(true);
    expect(
      validateEnvelope({
        version: 1,
        id: 'click-navigation',
        kind: 'command',
        command: {
          type: 'click',
          session: 's',
          locator: { by: 'role', value: 'button', name: 'Submit' },
          waitNavigation: true,
          timeout: 5000,
        },
      }).ok,
    ).toBe(true);
  });
  test('validates bounded page scrapes', () => {
    expect(
      validateEnvelope({
        version: 1,
        id: 'scrape',
        kind: 'command',
        command: {
          type: 'scrape',
          session: 's',
          url: 'https://example.com/',
          maxRoutes: 20,
          maxBytes: 50_000_000,
          maxDuration: 120_000,
          dedicatedWindow: true,
        },
      }).ok,
    ).toBe(true);
    expect(
      validateEnvelope({
        version: 1,
        id: 'unbounded-scrape',
        kind: 'command',
        command: { type: 'scrape', session: 's', maxRoutes: 51 },
      }),
    ).toMatchObject({ code: 'invalid_request' });
    expect(
      validateEnvelope({
        version: 1,
        id: 'invalid-dedicated-window',
        kind: 'command',
        command: { type: 'scrape', session: 's', dedicatedWindow: 'yes' },
      }),
    ).toMatchObject({ code: 'invalid_request' });
  });
});
