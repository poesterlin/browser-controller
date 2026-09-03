import {
  PROTOCOL_VERSION,
  type Command,
  type Envelope,
  type Success,
  type Failure,
} from './types.js';

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

type RecordInput = Record<string, unknown>;
type FailureResult = { ok: false; code: string; message: string };
type CommandType = Command['type'];

const COMMAND_TYPES = new Set<CommandType>([
  'start',
  'extension_pair',
  'list',
  'status',
  'navigate',
  'scrape',
  'screenshot',
  'dom',
  'click',
  'press',
  'select',
  'fill',
  'type',
  'wait',
  'evaluate',
  'close',
]);
const DOM_FORMATS = new Set(['interactive', 'summary', 'clean_html', 'json', 'html']);
const WAIT_STATES = new Set(['attached', 'visible', 'hidden']);
const INTEGER_RANGES: Array<[(c: RecordInput) => unknown, number, number, string]> = [
  [(c) => c.timeout, 1, 120_000, 'timeout must be between 1 and 120000'],
  [(c) => c.waitForActive, 1, 120_000, 'waitForActive must be between 1 and 120000'],
  [(c) => c.delay, 0, 10_000, 'delay must be between 0 and 10000'],
  [(c) => c.maxChars, 1, 1_000_000, 'maxChars must be between 1 and 1000000'],
  [(c) => c.textChars, 1, 10_000, 'textChars must be between 1 and 10000'],
  [(c) => c.depth, 1, 100, 'depth must be between 1 and 100'],
  [(c) => c.offset, 0, Number.MAX_SAFE_INTEGER, 'offset must be a non-negative integer'],
  [(c) => c.limit, 1, 500, 'limit must be between 1 and 500'],
  [(c) => c.nth, 0, Number.MAX_SAFE_INTEGER, 'nth must be a non-negative integer'],
  [(c) => c.itemLimit, 1, 500, 'itemLimit must be between 1 and 500'],
  [(c) => c.count, 0, 100_000, 'count must be between 0 and 100000'],
  [(c) => c.maxBytes, 1_000_000, 100_000_000, 'maxBytes must be between 1000000 and 100000000'],
  [(c) => c.maxRoutes, 1, 50, 'maxRoutes must be between 1 and 50'],
  [(c) => c.maxDuration, 10_000, 600_000, 'maxDuration must be between 10000 and 600000'],
];

function rangeFailure(c: RecordInput, rule: (typeof INTEGER_RANGES)[number]): FailureResult | undefined {
  const value = rule[0](c);
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < rule[1] || value > rule[2])
    return { ok: false, code: 'invalid_request', message: rule[3] };
  return undefined;
}

function validateCommon(c: RecordInput, type: CommandType): FailureResult | undefined {
  if (type !== 'start' && type !== 'extension_pair' && type !== 'list' && type !== 'status' && !string(c.session))
    return { ok: false, code: 'invalid_request', message: 'session is required' };
  if (type === 'navigate' && !string(c.url))
    return { ok: false, code: 'invalid_request', message: 'url is required' };
  if (type === 'scrape' && c.url !== undefined && !string(c.url))
    return { ok: false, code: 'invalid_request', message: 'url must be a string' };
  if ((type === 'dom' || type === 'screenshot') && c.selector !== undefined && !string(c.selector))
    return { ok: false, code: 'invalid_request', message: 'selector must be a string' };
  if (type === 'press' && !string(c.key))
    return { ok: false, code: 'invalid_request', message: 'key is required' };
  if (c.locator !== undefined && !locator(c.locator))
    return { ok: false, code: 'invalid_request', message: 'invalid locator' };
  if (c.within !== undefined && !locator(c.within))
    return { ok: false, code: 'invalid_request', message: 'invalid within locator' };
  if (locator(c.locator) && string(c.selector))
    return { ok: false, code: 'invalid_request', message: 'use locator or selector, not both' };
  if (type === 'evaluate' && !string(c.expression))
    return { ok: false, code: 'invalid_request', message: 'expression is required' };
  if (type === 'click' && c.waitNavigation !== undefined && typeof c.waitNavigation !== 'boolean')
    return { ok: false, code: 'invalid_request', message: 'waitNavigation must be a boolean' };
  return undefined;
}

function validateLocatorCommands(c: RecordInput, type: CommandType): FailureResult | undefined {
  const needsLocator =
    type === 'press' || type === 'click' || type === 'fill' || type === 'type' || type === 'select';
  if (needsLocator && !locator(c.locator) && !string(c.selector))
    return { ok: false, code: 'invalid_request', message: 'locator is required' };
  if (type === 'press' && !string(c.key))
    return { ok: false, code: 'invalid_request', message: 'key is required' };
  if ((type === 'fill' || type === 'type') && !string(c.text))
    return { ok: false, code: 'invalid_request', message: 'text is required' };
  return undefined;
}

function validateSelect(c: RecordInput): FailureResult | undefined {
  const selectors = [c.value, c.optionText].filter((v) => string(v)).length;
  if (selectors !== 1)
    return {
      ok: false,
      code: 'invalid_request',
      message: 'select requires exactly one value or optionText',
    };
  return undefined;
}

function validateWait(c: RecordInput): FailureResult | undefined {
  if (c.title !== undefined && !string(c.title))
    return { ok: false, code: 'invalid_request', message: 'title must be a string' };
  if (c.evaluate !== undefined && !string(c.evaluate))
    return { ok: false, code: 'invalid_request', message: 'evaluate must be a string' };
  if (c.urlGlob !== undefined && !string(c.urlGlob))
    return { ok: false, code: 'invalid_request', message: 'urlGlob must be a string' };
  if (c.value !== undefined && !string(c.value))
    return { ok: false, code: 'invalid_request', message: 'value must be a string' };
  if (c.changes !== undefined && typeof c.changes !== 'boolean')
    return { ok: false, code: 'invalid_request', message: 'changes must be a boolean' };
  const conditions = [
    locator(c.locator) ? 'locator' : undefined,
    string(c.selector) ? 'selector' : undefined,
    string(c.url) ? 'url' : undefined,
    string(c.urlGlob) ? 'urlGlob' : undefined,
    string(c.text) ? 'text' : undefined,
    string(c.title) ? 'title' : undefined,
    string(c.evaluate) ? 'evaluate' : undefined,
    c.tabActive === true ? 'tabActive' : undefined,
    c.windowFocused === true ? 'windowFocused' : undefined,
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
  if (c.state !== undefined && !WAIT_STATES.has(String(c.state)))
    return { ok: false, code: 'invalid_request', message: 'invalid wait state' };
  if (c.state !== undefined && conditions[0] !== 'locator' && conditions[0] !== 'selector')
    return { ok: false, code: 'invalid_request', message: 'wait state requires a locator' };
  return undefined;
}

function validateFields(c: RecordInput, type: CommandType): FailureResult | undefined {
  for (const rule of INTEGER_RANGES) {
    const result = rangeFailure(c, rule);
    if (result) return result;
  }
  if (c.format !== undefined && !DOM_FORMATS.has(String(c.format)))
    return {
      ok: false,
      code: 'invalid_request',
      message: 'format must be interactive, summary, clean_html, json, or html',
    };
  if (type === 'select') {
    const result = validateSelect(c);
    if (result) return result;
  }
  if (type === 'wait') {
    const result = validateWait(c);
    if (result) return result;
  }
  return undefined;
}

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
  const c = input.command;
  const type = c.type as CommandType;
  if (!COMMAND_TYPES.has(type))
    return { ok: false, code: 'invalid_request', message: 'unknown command type' };
  let failure: FailureResult | undefined;
  failure = validateCommon(c, type);
  if (!failure) failure = validateLocatorCommands(c, type);
  if (!failure) failure = validateFields(c, type);
  if (failure) return failure;
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
