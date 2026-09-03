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
});
