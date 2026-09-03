export const PROTOCOL_VERSION = 1;
export type Capability =
  | 'navigate'
  | 'dom'
  | 'click'
  | 'fill'
  | 'type'
  | 'wait'
  | 'evaluate'
  | 'press'
  | 'screenshot.viewport'
  | 'screenshot.fullPage'
  | 'screenshot.element';
export type Locator =
  | { by: 'css'; value: string }
  | { by: 'role'; value: string; name?: string; exact?: boolean }
  | { by: 'label'; value: string; exact?: boolean }
  | { by: 'text'; value: string; exact?: boolean };
export type Command =
  | { type: 'start'; name?: string; adapter?: string }
  | { type: 'extension_pair' }
  | { type: 'list' }
  | { type: 'status' }
  | { type: 'navigate'; session: string; url: string; timeout?: number }
  | { type: 'screenshot'; session: string; fullPage?: boolean; selector?: string }
  | {
      type: 'dom';
      session: string;
      locator?: Locator;
      selector?: string;
      maxChars?: number;
      format?: 'interactive' | 'clean_html' | 'json' | 'html';
      textChars?: number;
      depth?: number;
    }
  | { type: 'click'; session: string; locator?: Locator; selector?: string }
  | { type: 'press'; session: string; locator?: Locator; selector?: string; key: string }
  | { type: 'fill'; session: string; locator?: Locator; selector?: string; text: string }
  /** @deprecated Use fill. Type now has fill semantics for compatibility. */
  | { type: 'type'; session: string; locator?: Locator; selector?: string; text: string; delay?: number }
  | {
      type: 'wait';
      session: string;
      locator?: Locator;
      selector?: string;
      url?: string;
      text?: string;
      title?: string;
      evaluate?: string;
      count?: number;
      value?: string;
      changes?: boolean;
      state?: 'attached' | 'visible' | 'hidden';
      timeout?: number;
    }
  | { type: 'evaluate'; session: string; expression: string }
  | { type: 'close'; session: string; reason?: string };
export interface Envelope {
  version: number;
  id: string;
  kind: 'hello' | 'command';
  token?: string;
  role?: 'controller' | 'extension';
  adapterId?: string;
  adapterToken?: string;
  command?: Command;
}
export interface Success {
  version: number;
  id: string;
  ok: true;
  result?: unknown;
}
export interface Failure {
  version: number;
  id: string;
  ok: false;
  error: { code: string; message: string; details?: unknown };
}
export type Response = Success | Failure;
export interface ScreenshotResult {
  data: string;
  mimeType: 'image/png';
  width: number;
  height: number;
}
export type DomFormat = 'interactive' | 'clean_html' | 'json' | 'html';
export interface DomInteractiveItem {
  role: string;
  name: string;
  tag: string;
  css?: string;
  value?: string;
  states?: string[];
}
export interface DomResult {
  format: DomFormat;
  url?: string;
  html?: string;
  items?: DomInteractiveItem[];
  node?: unknown;
  truncated?: boolean;
  totalChars?: number;
  totalItems?: number;
}
export interface EvaluateResult {
  value: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';
const locator = (value: unknown) => {
  if (!isObject(value) || !['css', 'role', 'label', 'text'].includes(String(value.by)))
    return false;
  if (!string(value.value) || value.value.length === 0) return false;
  if (value.exact !== undefined && typeof value.exact !== 'boolean') return false;
  if (value.name !== undefined && (!string(value.name) || value.by !== 'role')) return false;
  return true;
};
export function validateEnvelope(
  input: unknown,
): { ok: true; value: Envelope } | { ok: false; code: string; message: string } {
  if (!isObject(input))
    return { ok: false, code: 'invalid_request', message: 'message must be an object' };
  if (input.version !== PROTOCOL_VERSION)
    return {
      ok: false,
      code: 'unsupported_version',
      message: `supported versions: ${PROTOCOL_VERSION}`,
    };
  if (!string(input.id) || input.id.length === 0)
    return { ok: false, code: 'invalid_request', message: 'id must be a non-empty string' };
  if (input.kind === 'hello')
    return {
      ok: true,
      value: {
        version: PROTOCOL_VERSION,
        id: input.id,
        kind: 'hello',
        token: string(input.token) ? input.token : undefined,
        role: input.role === 'extension' ? 'extension' : 'controller',
        adapterId: string(input.adapterId) ? input.adapterId : undefined,
        adapterToken: string(input.adapterToken) ? input.adapterToken : undefined,
      },
    };
  if (input.kind !== 'command' || !isObject(input.command) || !string(input.command.type))
    return { ok: false, code: 'invalid_request', message: 'invalid command envelope' };
  const c = input.command,
    required = (...keys: string[]) => keys.every((k) => string(c[k]) && String(c[k]).length > 0);
  const type = c.type as string;
  if (
    ![
      'start',
      'extension_pair',
      'list',
      'status',
      'navigate',
      'screenshot',
      'dom',
      'click',
      'press',
      'fill',
      'type',
      'wait',
      'evaluate',
      'close',
    ].includes(type)
  )
    return { ok: false, code: 'invalid_request', message: 'unknown command type' };
  if (
    type !== 'start' &&
    type !== 'extension_pair' &&
    type !== 'list' &&
    type !== 'status' &&
    !required('session')
  )
    return { ok: false, code: 'invalid_request', message: 'session is required' };
  if (type === 'navigate' && !required('url'))
    return { ok: false, code: 'invalid_request', message: 'url is required' };
  if (
    (type === 'navigate' || type === 'wait') &&
    c.timeout !== undefined &&
    (typeof c.timeout !== 'number' ||
      !Number.isInteger(c.timeout) ||
      c.timeout < 1 ||
      c.timeout > 120_000)
  )
    return { ok: false, code: 'invalid_request', message: 'timeout must be between 1 and 120000' };
  if ((type === 'dom' || type === 'screenshot') && c.selector !== undefined && !string(c.selector))
    return { ok: false, code: 'invalid_request', message: 'selector must be a string' };
  if (type === 'press' && (!string(c.key) || c.key.length === 0))
    return { ok: false, code: 'invalid_request', message: 'key is required' };
  if (type === 'press' && !locator(c.locator) && !required('selector'))
    return { ok: false, code: 'invalid_request', message: 'locator is required' };
  if (c.locator !== undefined && !locator(c.locator))
    return { ok: false, code: 'invalid_request', message: 'invalid locator' };
  if (locator(c.locator) && required('selector'))
    return { ok: false, code: 'invalid_request', message: 'use locator or selector, not both' };
  if (
    (type === 'click' || type === 'fill' || type === 'type') &&
    !required('selector') &&
    !locator(c.locator)
  )
    return { ok: false, code: 'invalid_request', message: 'locator is required' };
  if ((type === 'fill' || type === 'type') && !string(c.text))
    return { ok: false, code: 'invalid_request', message: 'text is required' };
  if (type === 'evaluate' && !string(c.expression))
    return { ok: false, code: 'invalid_request', message: 'expression is required' };
  if (c.delay !== undefined && (typeof c.delay !== 'number' || c.delay < 0 || c.delay > 10000))
    return { ok: false, code: 'invalid_request', message: 'delay must be between 0 and 10000' };
  if (
    c.maxChars !== undefined &&
    (typeof c.maxChars !== 'number' || !Number.isInteger(c.maxChars) || c.maxChars < 1 || c.maxChars > 1_000_000)
  )
    return { ok: false, code: 'invalid_request', message: 'maxChars must be between 1 and 1000000' };
  if (
    c.format !== undefined &&
    !['interactive', 'clean_html', 'json', 'html'].includes(String(c.format))
  )
    return {
      ok: false,
      code: 'invalid_request',
      message: 'format must be interactive, clean_html, json, or html',
    };
  if (
    c.textChars !== undefined &&
    (typeof c.textChars !== 'number' || !Number.isInteger(c.textChars) || c.textChars < 1 || c.textChars > 10_000)
  )
    return { ok: false, code: 'invalid_request', message: 'textChars must be between 1 and 10000' };
  if (
    c.depth !== undefined &&
    (typeof c.depth !== 'number' || !Number.isInteger(c.depth) || c.depth < 1 || c.depth > 100)
  )
    return { ok: false, code: 'invalid_request', message: 'depth must be between 1 and 100' };
  if (type === 'wait') {
    if (c.title !== undefined && !string(c.title))
      return { ok: false, code: 'invalid_request', message: 'title must be a string' };
    if (c.evaluate !== undefined && !string(c.evaluate))
      return { ok: false, code: 'invalid_request', message: 'evaluate must be a string' };
    if (
      c.count !== undefined &&
      (typeof c.count !== 'number' || !Number.isInteger(c.count) || c.count < 0 || c.count > 100_000)
    )
      return { ok: false, code: 'invalid_request', message: 'count must be between 0 and 100000' };
    if (c.value !== undefined && !string(c.value))
      return { ok: false, code: 'invalid_request', message: 'value must be a string' };
    if (c.changes !== undefined && typeof c.changes !== 'boolean')
      return { ok: false, code: 'invalid_request', message: 'changes must be a boolean' };
    const conditions = [
      locator(c.locator) ? 'locator' : undefined,
      required('selector') ? 'selector' : undefined,
      required('url') ? 'url' : undefined,
      required('text') ? 'text' : undefined,
      required('title') ? 'title' : undefined,
      required('evaluate') ? 'evaluate' : undefined,
    ].filter(Boolean);
    if (conditions.length !== 1)
      return {
        ok: false,
        code: 'invalid_request',
        message: 'wait requires exactly one locator, URL, title, or evaluate expression',
      };
    const predicates = [c.count !== undefined, c.value !== undefined, c.changes === true].filter(Boolean);
    if (predicates.length > 1)
      return { ok: false, code: 'invalid_request', message: 'use only one of count, value, or changes' };
    if (predicates.length && conditions[0] !== 'locator' && conditions[0] !== 'selector')
      return { ok: false, code: 'invalid_request', message: 'count, value, and changes require a locator' };
    if (c.state !== undefined && !['attached', 'visible', 'hidden'].includes(String(c.state)))
      return { ok: false, code: 'invalid_request', message: 'invalid wait state' };
    if (c.state !== undefined && conditions[0] !== 'locator' && conditions[0] !== 'selector')
      return { ok: false, code: 'invalid_request', message: 'wait state requires a locator' };
  }
  return {
    ok: true,
    value: { version: PROTOCOL_VERSION, id: input.id, kind: 'command', command: c as Command },
  };
}
export function success(id: string, result?: unknown): Success {
  return result === undefined
    ? { version: PROTOCOL_VERSION, id, ok: true }
    : { version: PROTOCOL_VERSION, id, ok: true, result };
}
export function failure(id: string, code: string, message: string, details?: unknown): Failure {
  return {
    version: PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
}
