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
  'scrollgif',
  'screenshot',
  'dom',
  'click',
  'press',
  'select',
  'scroll',
  'bounds',
  'highlight',
  'drag',
  'activate',
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
  [(c) => c.delay, 0, 1_000, 'delay must be between 0 and 1000'],
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
  [(c) => c.fps, 1, 30, 'fps must be between 1 and 30'],
  [(c) => c.step, 1, 65535, 'step must be between 1 and 65535'],
  [(c) => c.duration, 250, 600_000, 'duration must be between 250 and 600000'],
  [(c) => c.maxWidth, 0, 100_000, 'maxWidth must be between 0 and 100000'],
  [(c) => c.settleMs, 0, 10_000, 'settleMs must be between 0 and 10000'],
  [(c) => c.loop, 0, 1_000, 'loop must be between 0 and 1000'],
  [(c) => c.maxFrames, 1, 10_000, 'maxFrames must be between 1 and 10000'],
  [(c) => c.amount, 1, 100_000, 'amount must be between 1 and 100000'],
  [(c) => c.holdMs, 0, 10_000, 'holdMs must be between 0 and 10000'],
  [(c) => c.duration, 100, 30_000, 'duration must be between 100 and 30000'],
  [(c) => c.fromNth, 0, Number.MAX_SAFE_INTEGER, 'fromNth must be a non-negative integer'],
  [(c) => c.toNth, 0, Number.MAX_SAFE_INTEGER, 'toNth must be a non-negative integer'],
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
  if ((type === 'scrape' || type === 'scrollgif') && c.dedicatedWindow !== undefined && typeof c.dedicatedWindow !== 'boolean')
    return { ok: false, code: 'invalid_request', message: 'dedicatedWindow must be a boolean' };
  if ((type === 'dom' || type === 'screenshot' || type === 'scrollgif') && c.selector !== undefined && !string(c.selector))
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
  for (const name of ['double', 'clear', 'submit', 'intoView', 'diff', 'screenshotAfter', 'dither'])
    if (c[name] !== undefined && typeof c[name] !== 'boolean')
      return { ok: false, code: 'invalid_request', message: `${name} must be a boolean` };
  if (c.intent !== undefined && !string(c.intent))
    return { ok: false, code: 'invalid_request', message: 'intent must be a string' };
  if (string(c.intent) && c.intent.length > 500)
    return { ok: false, code: 'invalid_request', message: 'intent must be at most 500 characters' };
  return undefined;
}

function validateLocatorCommands(c: RecordInput, type: CommandType): FailureResult | undefined {
  const needsLocator = type === 'fill' || type === 'type' || type === 'select' || type === 'bounds' || type === 'highlight';
  if (needsLocator && !locator(c.locator) && !string(c.selector))
    return { ok: false, code: 'invalid_request', message: 'locator is required' };
  if (type === 'press' && !string(c.key))
    return { ok: false, code: 'invalid_request', message: 'key is required' };
  if ((type === 'fill' || type === 'type') && !string(c.text))
    return { ok: false, code: 'invalid_request', message: 'text is required' };
  return undefined;
}

function validateSelect(c: RecordInput): FailureResult | undefined {
  if (c.values !== undefined && (!Array.isArray(c.values) || !c.values.every(string) || c.values.length === 0))
    return { ok: false, code: 'invalid_request', message: 'values must be a non-empty string array' };
  const selectors = [c.value, c.optionText, c.values].filter((v) => v !== undefined).length;
  if (selectors !== 1)
    return {
      ok: false,
      code: 'invalid_request',
      message: 'select requires exactly one value, optionText, or values array',
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
  for (const name of ['deltaX', 'deltaY', 'offsetX', 'offsetY', 'x', 'y', 'toX', 'toY'])
    if (c[name] !== undefined && (typeof c[name] !== 'number' || !Number.isInteger(c[name]) || Math.abs(c[name] as number) > 100_000))
      return { ok: false, code: 'invalid_request', message: `${name} must be an integer between -100000 and 100000` };
  if (c.direction !== undefined && !['up', 'down', 'left', 'right'].includes(String(c.direction)))
    return { ok: false, code: 'invalid_request', message: 'invalid scroll direction' };
  if (c.button !== undefined && !['left', 'right', 'middle'].includes(String(c.button)))
    return { ok: false, code: 'invalid_request', message: 'invalid mouse button' };
  if (c.modifiers !== undefined && (!Array.isArray(c.modifiers) || !c.modifiers.every((v) => ['ctrl', 'alt', 'shift', 'meta'].includes(String(v)))))
    return { ok: false, code: 'invalid_request', message: 'invalid modifier' };
  if (type === 'click') {
    const coordinates = c.x !== undefined || c.y !== undefined;
    if (coordinates && (c.x === undefined || c.y === undefined || locator(c.locator) || string(c.selector)))
      return { ok: false, code: 'invalid_request', message: 'click requires a locator or both x and y' };
    if (!coordinates && !locator(c.locator) && !string(c.selector))
      return { ok: false, code: 'invalid_request', message: 'click requires a locator or both x and y' };
    if (coordinates && (c.within !== undefined || c.nth !== undefined || c.offsetX !== undefined || c.offsetY !== undefined))
      return { ok: false, code: 'invalid_request', message: 'coordinate clicks do not accept locator options' };
  }
  if (type === 'press' && !locator(c.locator) && !string(c.selector) && (c.within !== undefined || c.nth !== undefined))
    return { ok: false, code: 'invalid_request', message: 'page-level press does not accept locator options' };
  if (type === 'drag') {
    if (!locator(c.from)) return { ok: false, code: 'invalid_request', message: 'drag source locator is required' };
    const coordinates = c.toX !== undefined || c.toY !== undefined;
    if ((coordinates && (c.toX === undefined || c.toY === undefined || c.to !== undefined)) || (!coordinates && !locator(c.to)))
      return { ok: false, code: 'invalid_request', message: 'drag requires a target locator or both toX and toY' };
  }
  if (type === 'scroll') {
    const modes = [c.intoView === true, c.direction !== undefined, c.deltaX !== undefined || c.deltaY !== undefined].filter(Boolean).length;
    if (modes !== 1) return { ok: false, code: 'invalid_request', message: 'scroll requires exactly one mode' };
    if (c.intoView === true && !locator(c.locator)) return { ok: false, code: 'invalid_request', message: 'intoView requires a locator' };
    if (!locator(c.locator) && (c.within !== undefined || c.nth !== undefined))
      return { ok: false, code: 'invalid_request', message: 'page scroll does not accept locator options' };
  }
  if (type === 'scrollgif' && c.step !== undefined && c.duration !== undefined)
    return { ok: false, code: 'invalid_request', message: 'scrollgif accepts step or duration, not both' };
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
