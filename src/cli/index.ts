#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  discoveryPath,
  readDiscovery,
  removeDiscovery,
  runtimeDir,
  type Discovery,
} from '../supervisor/discovery.js';
import { PROTOCOL_VERSION, type Command, type Locator } from '../protocol/index.js';

const args = process.argv.slice(2);
const command = args[0];
const effectiveCommand = command === 'doctor' ? 'status' : command;
const jsonOutput = args.includes('--json');
const CLI_VERSION = '0.1.0';
const BOOLEAN_FLAGS = new Set(['--json', '--help', '-h', '--exact', '--within-exact', '--full-page', '--changes', '--tab-active', '--window-focused', '--wait-navigation', '--dedicated-window', '--no-auto-pair', '--double', '--clear', '--submit', '--into-view', '--diff', '--from-exact', '--to-exact']);
const DOM_FORMATS = new Set(['interactive', 'summary', 'clean_html', 'json', 'html']);
const KNOWN_FLAGS = new Set([
  '--session', '-s', '--json', '--help', '-h', '--selector', '--role', '--name', '--label',
  '--text', '--exact', '--name', '--adapter', '--url', '--timeout', '--max-chars', '--output',
  '--full-page', '--value', '--state', '--expression', '--reason', '--format', '--text-chars', '--key', '--depth', '--count', '--changes',
  '--offset', '--limit', '--within-selector', '--within-role', '--within-name', '--within-label', '--within-text', '--within-exact',
  '--nth', '--item-limit', '--wait-for-active', '--tab-active', '--window-focused', '--option-text',
  '--url-glob', '--wait-navigation',
  '--max-bytes', '--max-routes', '--max-duration', '--dedicated-window', '--no-auto-pair',
  '--direction', '--amount', '--delta-x', '--delta-y', '--into-view', '--duration-ms', '--diff',
  '--button', '--double', '--modifier', '--offset-x', '--offset-y', '--hold-ms', '--at', '--x', '--y',
  '--clear', '--submit', '--screenshot', '--intent', '--values',
  '--from-selector', '--from-role', '--from-name', '--from-label', '--from-text', '--from-exact', '--from-nth',
  '--to-selector', '--to-role', '--to-name', '--to-label', '--to-text', '--to-exact', '--to-nth', '--to-x', '--to-y',
]);
const invocation =
  process.env.BROWSER_CONTROLLER_COMMAND ??
  (process.argv[1] ? process.argv[1].split('/').pop()! : 'browserctl');

class ConnectionError extends Error {
  constructor(
    message: string,
    readonly reachable = false,
  ) {
    super(message);
  }
}

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function authenticate(d: Discovery): Promise<{ ws: WebSocket; d: Discovery }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(d.url);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      if (error) {
        // Bun can emit a second WebSocket error while close is settling. Keep a
        // sink installed so connection failure stays a normal CLI error.
        ws.on('error', () => {});
        ws.close();
        reject(error);
      } else resolve({ ws, d });
    };
    const timer = setTimeout(
      () => finish(new ConnectionError('connection timeout')),
      2_000,
    );
    ws.once('open', () => {
      ws.send(
        JSON.stringify({ version: PROTOCOL_VERSION, id: 'hello', kind: 'hello', token: d.token }),
      );
      ws.once('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.ok) finish();
          else
            finish(
              new ConnectionError(message.error?.message ?? 'authentication failed', true),
            );
        } catch {
          finish(new ConnectionError('invalid supervisor handshake', true));
        }
      });
    });
    ws.once('error', () => finish(new ConnectionError('connection refused')));
    ws.once('close', () => finish(new ConnectionError('connection closed')));
  });
}

async function reachableDiscovery() {
  const discovery = await readDiscovery();
  if (!discovery) return undefined;
  try {
    return await authenticate(discovery);
  } catch (error) {
    if (error instanceof ConnectionError && error.reachable) throw error;
    return undefined;
  }
}

function supervisorInvocation() {
  const entry = process.argv[1];
  return entry && /\.[cm]?[jt]s$/.test(entry)
    ? { executable: process.execPath, args: [entry, '--internal-supervisor'] }
    : { executable: process.execPath, args: ['--internal-supervisor'] };
}

async function startSupervisor() {
  const directory = runtimeDir();
  const lockPath = path.join(directory, 'startup.lock');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  let lock: fs.FileHandle | undefined;
  const deadline = Date.now() + 5_000;
  while (!lock && Date.now() < deadline) {
    try {
      lock = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await reachableDiscovery();
      if (existing) return existing;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 10_000) await fs.unlink(lockPath);
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!lock) throw new Error('supervisor_unavailable: supervisor startup is locked');
  try {
    const existing = await reachableDiscovery();
    if (existing) return existing;
    await removeDiscovery();
    const launch = supervisorInvocation();
    const child = spawn(launch.executable, launch.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    while (Date.now() < deadline) {
      const connected = await reachableDiscovery();
      if (connected) return connected;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `supervisor_unavailable: supervisor did not become ready; discovery: ${discoveryPath()}`,
    );
  } finally {
    await lock.close();
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function connect(autostart = false) {
  try {
    const existing = await reachableDiscovery();
    if (existing) return existing;
  } catch (error) {
    throw new Error(`supervisor_unavailable: ${(error as Error).message}`);
  }
  if (!autostart)
    throw new Error('supervisor_unavailable: supervisor is unavailable');
  return startSupervisor();
}

const value = (...names: string[]) => {
  for (const name of names) {
    const index = args.indexOf(name);
    if (
      index >= 0 &&
      args[index + 1] !== undefined &&
      !(args[index + 1].startsWith('-') && KNOWN_FLAGS.has(args[index + 1]))
    )
      return args[index + 1];
  }
  return undefined;
};
const numberValue = (...names: string[]) => {
  const raw = value(...names);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${names[0]} must be a number`);
  return parsed;
};
const values = (...names: string[]) => {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1)
    if (names.includes(args[index]) && args[index + 1] !== undefined) found.push(args[index + 1]);
  return found;
};

function validateFlags() {
  const common = ['--session', '-s', '--json', '--help', '-h', '--no-auto-pair'];
  const locator = ['--selector', '--role', '--name', '--label', '--text', '--exact'];
  const within = ['--within-selector', '--within-role', '--within-name', '--within-label', '--within-text', '--within-exact'];
  const byCommand: Record<string, string[]> = {
    start: ['--name', '--adapter'],
    navigate: ['--url', '--timeout'],
    dom: [...locator, ...within, '--max-chars', '--format', '--text-chars', '--depth', '--offset', '--limit', '--nth', '--item-limit', '--diff', '--screenshot', '--output'],
    screenshot: ['--output', '--selector', '--full-page', '--wait-for-active'],
    scrape: ['--url', '--output', '--timeout', '--max-bytes', '--max-routes', '--max-duration', '--dedicated-window'],
    click: [...locator, ...within, '--nth', '--wait-navigation', '--timeout', '--button', '--double', '--modifier', '--offset-x', '--offset-y', '--hold-ms', '--at', '--x', '--y', '--screenshot', '--intent'],
    press: [...locator, ...within, '--key', '--nth', '--screenshot', '--intent'],
    fill: [...locator, ...within, '--value', '--nth', '--screenshot', '--intent'],
    type: [...locator, ...within, '--value', '--nth', '--delay', '--clear', '--submit', '--screenshot', '--intent'],
    select: [...locator, ...within, '--value', '--values', '--option-text', '--nth', '--screenshot', '--intent'],
    scroll: [...locator, ...within, '--nth', '--direction', '--amount', '--delta-x', '--delta-y', '--into-view', '--screenshot', '--intent'],
    bounds: [...locator, ...within, '--nth'],
    highlight: [...locator, ...within, '--nth', '--duration-ms'],
    drag: ['--from-selector', '--from-role', '--from-name', '--from-label', '--from-text', '--from-exact', '--from-nth', '--to-selector', '--to-role', '--to-name', '--to-label', '--to-text', '--to-exact', '--to-nth', '--to-x', '--to-y', '--screenshot', '--intent'],
    activate: [],
    wait: [...locator, ...within, '--url', '--url-glob', '--state', '--timeout', '--title', '--evaluate', '--count', '--value', '--changes', '--nth', '--tab-active', '--window-focused'],
    evaluate: ['--expression'],
    close: ['--reason'],
    status: [],
    list: [],
    extension: [],
  };
  const allowed = new Set([...common, ...(byCommand[effectiveCommand ?? command] ?? [])]);
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('-')) continue;
    if (!allowed.has(argument))
      throw new Error(`unknown option for ${effectiveCommand}: ${argument}`);
    if (!BOOLEAN_FLAGS.has(argument)) {
      if (args[index + 1] === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
    }
  }
}

function commandLocator(): Locator | undefined {
  const candidates: Locator[] = [];
  const selector = value('--selector');
  const role = value('--role');
  const label = value('--label');
  const text = value('--text');
  const exact = args.includes('--exact');
  if (selector) candidates.push({ by: 'css', value: selector });
  if (role) candidates.push({ by: 'role', value: role, name: value('--name'), exact });
  if (label) candidates.push({ by: 'label', value: label, exact });
  if (text) candidates.push({ by: 'text', value: text, exact });
  if (value('--name') && !role) throw new Error('--name requires --role');
  if (candidates.length > 1)
    throw new Error(
      'use exactly one locator: --selector, --role, --label, or --text',
    );
  return candidates[0];
}

function withinLocator(): Locator | undefined {
  const candidates: Locator[] = [];
  const exact = args.includes('--within-exact');
  if (value('--within-selector')) candidates.push({ by: 'css', value: value('--within-selector')! });
  if (value('--within-role')) candidates.push({ by: 'role', value: value('--within-role')!, name: value('--within-name'), exact });
  if (value('--within-label')) candidates.push({ by: 'label', value: value('--within-label')!, exact });
  if (value('--within-text')) candidates.push({ by: 'text', value: value('--within-text')!, exact });
  if (value('--within-name') && !value('--within-role')) throw new Error('--within-name requires --within-role');
  if (candidates.length > 1) throw new Error('use exactly one scope locator: --within-selector, --within-role, --within-label, or --within-text');
  return candidates[0];
}

function prefixedLocator(prefix: 'from' | 'to'): Locator | undefined {
  const exact = args.includes(`--${prefix}-exact`);
  const candidates: Locator[] = [];
  const selector = value(`--${prefix}-selector`);
  const role = value(`--${prefix}-role`);
  const name = value(`--${prefix}-name`);
  const label = value(`--${prefix}-label`);
  const text = value(`--${prefix}-text`);
  if (selector) candidates.push({ by: 'css', value: selector });
  if (role) candidates.push({ by: 'role', value: role, name, exact });
  if (label) candidates.push({ by: 'label', value: label, exact });
  if (text) candidates.push({ by: 'text', value: text, exact });
  if (name && !role) throw new Error(`--${prefix}-name requires --${prefix}-role`);
  if (candidates.length !== 1 && prefix === 'from') throw new Error('drag requires exactly one source locator');
  if (candidates.length > 1) throw new Error(`use exactly one ${prefix} locator`);
  return candidates[0];
}

function clickCoordinates() {
  const at = value('--at');
  if (at) {
    const parts = at.split(',').map(Number);
    if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part)))
      throw new Error('--at must be X,Y');
    return { x: parts[0], y: parts[1] };
  }
  const x = numberValue('--x');
  const y = numberValue('--y');
  if ((x === undefined) !== (y === undefined)) throw new Error('click coordinates require both --x and --y');
  return x === undefined ? {} : { x, y };
}

function browserCommand(pairing: boolean): Command {
  if (pairing) return { type: 'extension_pair' };
  const session = value('--session', '-s') ?? 'last';
  switch (effectiveCommand) {
    case 'start':
      return { type: 'start', name: value('--name'), adapter: value('--adapter') };
    case 'list':
      return { type: 'list' };
    case 'status':
      return { type: 'status' };
    case 'navigate':
      return {
        type: 'navigate',
        session,
        url: value('--url') ?? (args[1]?.startsWith('-') ? '' : args[1] ?? ''),
        timeout: numberValue('--timeout'),
      };
    case 'dom': {
      const format = value('--format');
      if (format !== undefined && !DOM_FORMATS.has(format))
        throw new Error('dom --format must be interactive, summary, clean_html, json, or html');
      return {
        type: 'dom',
        session,
        locator: commandLocator(),
        within: withinLocator(),
        maxChars: numberValue('--max-chars'),
        format: format as 'interactive' | 'summary' | 'clean_html' | 'json' | 'html' | undefined,
        textChars: numberValue('--text-chars'),
        depth: numberValue('--depth'),
        offset: numberValue('--offset'),
        limit: numberValue('--limit'),
        nth: numberValue('--nth'),
        itemLimit: numberValue('--item-limit'),
        diff: args.includes('--diff') || undefined,
        screenshotAfter: value('--screenshot') !== undefined || undefined,
      };
    }
    case 'screenshot':
      if (args.includes('--full-page') && value('--selector'))
        throw new Error('screenshot accepts --full-page or --selector, not both');
      return {
        type: 'screenshot',
        session,
        selector: value('--selector'),
        fullPage: args.includes('--full-page'),
        waitForActive: numberValue('--wait-for-active'),
      };
    case 'scrape':
      return {
        type: 'scrape',
        session,
        url: value('--url') ?? (args[1]?.startsWith('-') ? undefined : args[1]),
        timeout: numberValue('--timeout'),
        maxBytes: numberValue('--max-bytes'),
        maxRoutes: numberValue('--max-routes'),
        maxDuration: numberValue('--max-duration'),
        dedicatedWindow: args.includes('--dedicated-window'),
      };
    case 'click':
      return {
        type: 'click', session, locator: commandLocator(), within: withinLocator(), nth: numberValue('--nth'),
        waitNavigation: args.includes('--wait-navigation') || undefined, timeout: numberValue('--timeout'),
        button: value('--button') as 'left' | 'right' | 'middle' | undefined,
        double: args.includes('--double') || undefined,
        modifiers: values('--modifier').length ? values('--modifier') as Array<'ctrl' | 'alt' | 'shift' | 'meta'> : undefined,
        offsetX: numberValue('--offset-x'), offsetY: numberValue('--offset-y'), holdMs: numberValue('--hold-ms'),
        ...clickCoordinates(), screenshotAfter: value('--screenshot') !== undefined || undefined, intent: value('--intent'),
      };
    case 'press': {
      if (value('--key') === undefined) throw new Error('press requires --key KEY');
      return { type: 'press', session, locator: commandLocator(), within: withinLocator(), nth: numberValue('--nth'), key: value('--key')!, screenshotAfter: value('--screenshot') !== undefined || undefined, intent: value('--intent') };
    }
    case 'fill':
      if (value('--value') === undefined) throw new Error('fill requires --value VALUE');
      return {
        type: 'fill',
        session,
        locator: commandLocator(),
        within: withinLocator(),
        nth: numberValue('--nth'),
        text: value('--value')!,
        screenshotAfter: value('--screenshot') !== undefined || undefined,
        intent: value('--intent'),
      };
    case 'type':
      if (value('--value') === undefined) throw new Error('type requires --value VALUE');
      return {
        type: 'type', session, locator: commandLocator(), within: withinLocator(), nth: numberValue('--nth'),
        text: value('--value')!, delay: numberValue('--delay'), clear: args.includes('--clear') || undefined,
        submit: args.includes('--submit') || undefined, screenshotAfter: value('--screenshot') !== undefined || undefined,
        intent: value('--intent'),
      };
    case 'select':
      {
      const repeatedValues = values('--value');
      const commaValues = value('--values')?.split(',').map((item) => item.trim()).filter(Boolean);
      return {
        type: 'select',
        session,
        locator: commandLocator(),
        within: withinLocator(),
        nth: numberValue('--nth'),
        value: repeatedValues.length === 1 && !commaValues ? repeatedValues[0] : undefined,
        values: commaValues ?? (repeatedValues.length > 1 ? repeatedValues : undefined),
        optionText: value('--option-text'),
        screenshotAfter: value('--screenshot') !== undefined || undefined,
        intent: value('--intent'),
      };
      }
    case 'scroll':
      return {
        type: 'scroll', session, locator: commandLocator(), within: withinLocator(), nth: numberValue('--nth'),
        direction: value('--direction') as 'up' | 'down' | 'left' | 'right' | undefined,
        amount: numberValue('--amount'), deltaX: numberValue('--delta-x'), deltaY: numberValue('--delta-y'),
        intoView: args.includes('--into-view') || undefined, screenshotAfter: value('--screenshot') !== undefined || undefined,
        intent: value('--intent'),
      };
    case 'bounds': {
      const locator = commandLocator();
      if (!locator) throw new Error('bounds requires a locator');
      return { type: 'bounds', session, locator, within: withinLocator(), nth: numberValue('--nth') };
    }
    case 'highlight': {
      const locator = commandLocator();
      if (!locator) throw new Error('highlight requires a locator');
      return { type: 'highlight', session, locator, within: withinLocator(), nth: numberValue('--nth'), duration: numberValue('--duration-ms') };
    }
    case 'drag': {
      const from = prefixedLocator('from')!;
      const to = prefixedLocator('to');
      return {
        type: 'drag', session, from, to, fromNth: numberValue('--from-nth'), toNth: numberValue('--to-nth'),
        toX: numberValue('--to-x'), toY: numberValue('--to-y'), screenshotAfter: value('--screenshot') !== undefined || undefined,
        intent: value('--intent'),
      };
    }
    case 'activate':
      return { type: 'activate', session };
    case 'wait':
      return {
        type: 'wait',
        session,
        locator: commandLocator(),
        within: withinLocator(),
        nth: numberValue('--nth'),
        url: value('--url'),
        urlGlob: value('--url-glob'),
        title: value('--title'),
        evaluate: value('--evaluate'),
        count: numberValue('--count'),
        value: value('--value'),
        changes: args.includes('--changes') || undefined,
        state: value('--state') as 'attached' | 'visible' | 'hidden' | undefined,
        timeout: numberValue('--timeout'),
        tabActive: args.includes('--tab-active'),
        windowFocused: args.includes('--window-focused'),
      };
    case 'evaluate':
      return { type: 'evaluate', session, expression: value('--expression') ?? '' };
    case 'close':
      return { type: 'close', session, reason: value('--reason') };
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

function usage(topic?: string) {
  const locator = `LOCATOR:
  --selector CSS
  --role ROLE [--name NAME] [--exact]
  --label LABEL [--exact]
  --text TEXT [--exact]`;
  const details: Record<string, string> = {
    navigate: `usage: ${invocation} navigate URL [--timeout MS] [--session ID] [--json]\n\nExample: ${invocation} navigate https://example.com --timeout 15000`,
    dom: `usage: ${invocation} dom [LOCATOR] [--format interactive|summary|clean_html|json] [--diff] [--output FILE] [--screenshot FILE] [--offset N] [--limit N] [--item-limit N] [--nth N] [--max-chars N] [--text-chars N] [--depth N] [--session ID] [--json]\n\n${locator}\n\nScope any locator with --within-selector CSS, --within-role ROLE [--within-name NAME], --within-label LABEL, or --within-text TEXT. Summary output groups repeated items and defaults to 100 groups. --nth is zero-based.`,
    click: `usage: ${invocation} click (LOCATOR | --at X,Y) [--button left|right|middle] [--double] [--modifier ctrl|alt|shift|meta] [--offset-x N] [--offset-y N] [--hold-ms N] [--screenshot FILE] [--session ID] [--json]\n\n${locator}\n\nExample: ${invocation} click --role button --name Save --exact`,
    press: `usage: ${invocation} press [LOCATOR] --key KEY [--screenshot FILE] [--session ID] [--json]\n\n${locator}\n\nWithout a locator, sends the chord to the active element/page. KEY combines modifiers with '+': Enter, Tab, Escape, ctrl+Enter, ctrl+a, Shift+Tab`,
    fill: `usage: ${invocation} fill LOCATOR --value VALUE [--session ID] [--json]\n\n${locator}\n\nExample: ${invocation} fill --label URL --value https://example.com`,
    type: `usage: ${invocation} type LOCATOR --value TEXT [--clear] [--submit] [--delay MS] [--screenshot FILE] [--json]\n\n${locator}`,
    select: `usage: ${invocation} select LOCATOR (--value VALUE... | --values A,B | --option-text TEXT) [--nth N] [--session ID] [--json]\n\n${locator}\n\nRepeat --value for a multi-select.`,
    scroll: `usage: ${invocation} scroll [LOCATOR] (--direction up|down|left|right [--amount PX] | --delta-x N --delta-y N | --into-view) [--screenshot FILE] [--json]\n\n${locator}`,
    bounds: `usage: ${invocation} bounds LOCATOR [--json]\n\n${locator}`,
    highlight: `usage: ${invocation} highlight LOCATOR [--duration-ms 2000] [--json]\n\n${locator}`,
    drag: `usage: ${invocation} drag --from-(selector|role|label|text) VALUE (--to-(selector|role|label|text) VALUE | --to-x N --to-y N) [--screenshot FILE] [--json]`,
    activate: `usage: ${invocation} activate [--json]\n\nBrings only the explicitly paired tab and its window to the foreground.`,
    wait: `usage: ${invocation} wait (LOCATOR | --url URL | --title TEXT | --evaluate EXPR) [--state visible|attached|hidden] [--count N | --value VALUE | --changes] [--timeout MS] [--session ID] [--json]\n\n${locator}\n\nLocator waits can require an exact match count, an exact field/text value, or a change from the value observed when waiting began. URL waits are exact; title matching is partial; evaluate expressions are polled until truthy.\n\nExamples:\n  ${invocation} wait --selector '.result' --count 3\n  ${invocation} wait --label Status --value Complete\n  ${invocation} wait --role log --changes\n  ${invocation} wait --evaluate "document.querySelectorAll('[class*=markdown]').length > 0" --timeout 20000`,
    evaluate: `usage: ${invocation} evaluate --expression JAVASCRIPT [--session ID] [--json]`,
    screenshot: `usage: ${invocation} screenshot [--full-page | --selector CSS] [--wait-for-active MS] [--output FILE.png] [--session ID] [--json]`,
    scrape: `usage: ${invocation} scrape [URL] [--output FILE.zip] [--max-routes N] [--max-bytes N] [--max-duration MS] [--timeout MS] [--dedicated-window] [--session ID] [--json]\n\nCaptures same-origin routes as rendered MHTML plus one full-page stitched PNG per route. --dedicated-window moves only the paired tab into a new non-focused window so it remains active there. Defaults: 20 routes, 50 MB, and 120 seconds; hard limits: 50 routes, 100 MB, and 10 minutes.`,
    start: `usage: ${invocation} start [--name NAME] [--adapter ID] [--json]`,
    status: `usage: ${invocation} status [--json]\n       ${invocation} doctor [--json]`,
    list: `usage: ${invocation} list [--json]`,
    close: `usage: ${invocation} close [--session ID] [--reason TEXT] [--json]`,
    extension: `usage: ${invocation} extension pair [--json]`,
  };
  if (topic && details[topic]) return details[topic];
  return `usage: ${invocation} <command> [options]

Commands:
  extension pair  Pair the extension and select its control tab
  status, doctor  Show supervisor, extension, tab, and session health
  navigate URL    Navigate the control tab and wait for completion
  dom              Read bounded page markup
  click            Click an element
  fill             Replace a field value
  type             Type real keystrokes into a field
  select           Select an option
  press            Dispatch a key or key chord to an element
  scroll           Scroll the page, a container, or an element into view
  bounds           Report an element's viewport and page bounds
  highlight        Temporarily highlight an element
  drag             Drag to a locator or viewport coordinates
  activate         Focus only the paired tab and window
  wait             Wait for a locator or URL
  evaluate         Evaluate page-world JavaScript
  screenshot       Save a viewport, full-page, or element image
  scrape           Capture same-origin routes into a ZIP
  list             List sessions
  start            Explicitly create or reconnect a session
  close            Close a session

Ordinary browser commands use the current session automatically. If no usable extension is connected, the CLI opens a one-time pairing page and continues the original command; pass --no-auto-pair to fail instead. Pass --session ID only to select another session. Use --json for stable machine-readable output.

Run '${invocation} COMMAND --help' for command-specific help.`;
}

async function main() {
  if (command === '--version' || command === '-V' || command === 'version') {
    console.log(CLI_VERSION);
    return;
  }
  if (!command || command === 'help' || args.includes('--help') || args.includes('-h')) {
    const topic = command === 'help' ? args[1] : command;
    const help = usage(topic);
    (command ? console.log : console.error)(help);
    if (!command) process.exitCode = 2;
    return;
  }
  if (!effectiveCommand) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  validateFlags();
  const pairing = command === 'extension' && args[1] === 'pair';
  const request = browserCommand(pairing);
  const recoverableCommand =
    !pairing &&
    !args.includes('--no-auto-pair') &&
    !value('--session', '-s') &&
    (request.type === 'start'
      ? !request.adapter
      : ['navigate', 'dom', 'screenshot', 'scrape', 'click', 'fill', 'type', 'select', 'press', 'scroll', 'bounds', 'highlight', 'drag', 'activate', 'wait', 'evaluate'].includes(request.type));
  const autoStart =
    pairing ||
    effectiveCommand === 'start' ||
    ['navigate', 'dom', 'screenshot', 'scrape', 'click', 'fill', 'type', 'select', 'press', 'wait', 'evaluate'].includes(
      effectiveCommand,
    );
  let ws: WebSocket;
  try {
    ({ ws } = await connect(autoStart));
  } catch (error) {
    if (effectiveCommand !== 'status') throw error;
    const result = {
      supervisor: { state: 'unavailable' },
      extensions: [],
      sessions: [],
      recovery: 'run browserctl extension pair',
    };
    printResult('status', result);
    process.exitCode = 1;
    return;
  }
  const id = randomUUID();
  if (request.type === 'scrape')
    console.error(
      `Capturing up to ${request.maxRoutes ?? 20} routes for up to ${Math.round((request.maxDuration ?? 120_000) / 1000)} seconds…`,
    );
  ws.send(JSON.stringify({ version: PROTOCOL_VERSION, id, kind: 'command', command: request }));
  await new Promise<void>((resolve, reject) => {
    let pair: any;
    let starting = false;
    let recovering = pairing;
    let recoveryAttempted = false;
    let activeId = id;
    const artifactChunks: Buffer[] = [];
    const commandTimeoutMs = pairing
      ? 305_000
      : request.type === 'wait'
        ? (request.timeout ?? 10_000) + 5_000
        : request.type === 'click'
          ? (request.timeout ?? 10_000) + 5_000
        : request.type === 'screenshot' && request.waitForActive
          ? request.waitForActive + 125_000
          : request.type === 'scrape'
            ? (request.maxDuration ?? 120_000) + 90_000
        : 15_000;
    const timeoutMs = commandTimeoutMs + (recoverableCommand ? 305_000 : 0);
    const timer = setTimeout(() => reject(new Error('command timed out waiting for supervisor')), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve();
    };
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (!recovering && message.id === activeId && message.event === 'artifact_chunk') {
        if (message.index !== artifactChunks.length || typeof message.data !== 'string')
          return finish(new Error('invalid artifact chunk sequence'));
        artifactChunks.push(Buffer.from(message.data, 'base64'));
        return;
      }
      if (
        recovering &&
        message.event === 'adapter_connected' &&
        pair &&
        !starting &&
        message.adapterId === pair.adapterId
      ) {
        starting = true;
        activeId = randomUUID();
        ws.send(
          JSON.stringify({
            version: PROTOCOL_VERSION,
            id: activeId,
            kind: 'command',
            command: {
              type: 'start',
              adapter: message.adapterId,
              ...(request.type === 'start' && request.name ? { name: request.name } : {}),
            },
          }),
        );
        return;
      }
      if (message.id !== activeId) return;
      if (message.ok) {
        if (recovering && !pair) {
          pair = message.result;
          const pairingPage = new URL(pair.endpoint);
          pairingPage.protocol = pairingPage.protocol === 'wss:' ? 'https:' : 'http:';
          pairingPage.pathname = '/pair';
          pairingPage.search = new URLSearchParams({ code: pair.code, adapter: pair.adapterId }).toString();
          console.error('Opening the Browser Controller pairing page; waiting for the extension…');
          console.error(`If it does not open, visit: ${pairingPage}`);
          console.error(
            `Manual extension-popup fallback: browser-controller://pair?${new URLSearchParams({ endpoint: pair.endpoint, code: pair.code, adapter: pair.adapterId })}`,
          );
          if (process.env.BROWSER_CONTROLLER_DISABLE_OPEN !== '1')
            spawn('xdg-open', [pairingPage.toString()], { detached: true, stdio: 'ignore' }).unref();
          return;
        }
        if (recovering && starting) {
          const session = message.result;
          if (pairing) {
            printResult('extension pair', { action: 'paired', ...session });
            return finish();
          }
          if (request.type === 'start') {
            printResult('start', session);
            return finish();
          }
          recovering = false;
          pair = undefined;
          starting = false;
          activeId = randomUUID();
          artifactChunks.length = 0;
          console.error('Extension paired; continuing original command…');
          ws.send(JSON.stringify({
            version: PROTOCOL_VERSION,
            id: activeId,
            kind: 'command',
            command: request,
          }));
          return;
        }
        if (message.result?.screenshot && value('--screenshot')) {
          const screenshot = message.result.screenshot;
          const bytes = Buffer.from(screenshot.data, 'base64');
          writeFileSync(value('--screenshot')!, bytes);
          message.result.screenshot = {
            output: value('--screenshot'),
            bytes: bytes.length,
            width: screenshot.width,
            height: screenshot.height,
          };
        }
        if (command === 'dom') {
          const result = message.result;
          const domOutput = value('--output');
          if (domOutput) {
            const content = result.format === 'json'
              ? `${JSON.stringify(result.node, null, 2)}\n`
              : result.html ?? `${JSON.stringify(result, null, 2)}\n`;
            writeFileSync(domOutput, content);
            printResult('dom-file', { output: domOutput, bytes: Buffer.byteLength(content), format: result.format });
          } else if (jsonOutput) printResult('dom', result);
          else if (result?.format === 'interactive' || result?.format === 'summary') {
            for (const item of result.items ?? []) {
              const states = item.states?.length ? ` [${item.states.join(',')}]` : '';
              const viewport = item.inViewport === false ? ' [offscreen]' : '';
              const value = item.value ? ` value="${item.value}"` : '';
              const hint = item.css ? ` (${item.tag}${item.css})` : ` (${item.tag})`;
              const count = item.count > 1 ? ` ×${item.count}` : '';
              const href = item.href ? ` -> ${item.href}` : '';
              console.log(`- ${item.role}${item.name ? ` "${item.name}"` : ''}${count}${hint}${value}${states}${viewport}${href}`);
            }
          } else if (result?.format === 'json') console.log(JSON.stringify(result.node, null, 2));
          else console.log(typeof result === 'string' ? result : (result?.html ?? ''));
          if ((result?.format === 'interactive' || result?.format === 'summary') && result?.truncated)
            console.error(
              `${result.format === 'summary' ? 'Summary' : 'Interactive list'} truncated to ${result.items.length} of ${result.uniqueItems ?? result.totalItems} ${result.format === 'summary' ? 'groups' : 'elements'} (${result.rawItems ?? result.totalItems} raw); scope or raise --item-limit.`,
            );
          else if (result?.truncated)
            console.error(
               `DOM output truncated to ${result.format === 'json' ? 'tree' : result.returnedChars} of ${result.totalChars} characters; use --max-chars to change the limit.`,
            );
          if (result?.diff && !jsonOutput && !domOutput) {
            if (result.diff.baseline) console.error('DOM diff baseline established.');
            else {
              for (const line of result.diff.removed) console.log(`- ${line}`);
              for (const line of result.diff.added) console.log(`+ ${line}`);
              if (!result.diff.changed) console.error('DOM unchanged.');
            }
          }
        } else if (command === 'screenshot') {
          const output = value('--output') ?? 'screenshot.png';
          const bytes = Buffer.from(message.result.data, 'base64');
          writeFileSync(output, bytes);
          printResult('screenshot', { action: 'screenshot-saved', output, bytes: bytes.length });
        } else if (command === 'scrape') {
          const output = value('--output') ?? 'page-scrape.zip';
          const result = message.result;
          if (result.mimeType !== 'application/zip')
            throw new Error(`unexpected scrape result type: ${result.mimeType ?? 'missing'}`);
          if (typeof result.chunks !== 'number' || result.chunks !== artifactChunks.length)
            throw new Error('incomplete scrape archive transfer');
          const archive = Buffer.concat(artifactChunks);
          writeFileSync(output, archive);
          printResult('scrape', {
            action: 'scrape-saved',
            output,
            bytes: archive.length,
            routes: result.routes,
            skippedRoutes: result.skippedRoutes ?? 0,
            deadlineReached: result.deadlineReached ?? false,
          });
        } else printResult(effectiveCommand, message.result ?? {});
        finish();
      } else if (
        message.error &&
        recoverableCommand &&
        !recovering &&
        !recoveryAttempted &&
        ['adapter_unavailable', 'adapter_disconnected', 'control_tab_unavailable', 'extension_timeout'].includes(message.error.code)
      ) {
        recoveryAttempted = true;
        recovering = true;
        activeId = randomUUID();
        console.error('Browser extension unavailable; opening a new pairing session…');
        ws.send(JSON.stringify({
          version: PROTOCOL_VERSION,
          id: activeId,
          kind: 'command',
          command: { type: 'extension_pair' },
        }));
      } else if (message.error) {
        finish(new CliError(message.error.code, message.error.message, message.error.details));
      }
    });
    ws.once('error', () => finish(new Error('supervisor connection failed')));
  });
}

if (command === '--internal-supervisor') {
  const { Supervisor } = await import('../supervisor/index.js');
  const supervisor = new Supervisor(Number(process.env.BROWSER_CONTROLLER_PORT ?? 47921));
  process.once('SIGTERM', () => supervisor.close().finally(() => process.exit(0)));
  process.once('SIGINT', () => supervisor.close().finally(() => process.exit(0)));
} else {
  await main().catch((error) => {
    const code = error instanceof CliError ? error.code : 'cli_error';
    if (jsonOutput)
      console.error(JSON.stringify({ ok: false, error: { code, message: error.message, ...(error instanceof CliError && error.details !== undefined ? { details: error.details } : {}) } }));
    else console.error(`Error [${code}]: ${error.message}`);
    process.exitCode = 1;
  });
}

function printResult(kind: string, result: any) {
  if (jsonOutput) {
    console.log(JSON.stringify({ ok: true, result }));
    return;
  }
  if (kind === 'status') {
    console.log(`Supervisor: ${result.supervisor?.state ?? 'unknown'}`);
    for (const extension of result.extensions ?? []) {
      const tab = extension.tabAvailable
        ? `tab ${extension.tabId}${extension.active ? ' (active)' : ''} ${extension.url ?? ''}`
        : 'control tab unavailable';
      console.log(`Extension ${extension.id}: ${extension.state}; ${tab}`);
    }
    if (!(result.extensions?.length ?? 0)) console.log('Extension: unavailable');
    console.log(`Sessions: ${result.sessions?.length ?? 0}`);
    if (result.recovery) console.log(`Recovery: ${result.recovery}`);
    return;
  }
  if (kind === 'list') {
    if (!result.length) return void console.log('No sessions.');
    for (const session of result)
      console.log(`${session.id}\t${session.state}\t${session.name ?? ''}`);
    return;
  }
  if (kind === 'dom') return void console.log(result.html ?? result);
  if (kind === 'evaluate')
    return void console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  const locator = describeLocator(result.locator);
  const messages: Record<string, string> = {
    start: `Session ready: ${result.id}`,
    navigate: `Navigated to ${result.url ?? result.requestedUrl}`,
    click: `Clicked${locator ? ` ${locator}` : ''}.`,
    press: `Pressed ${result.key}${locator ? ` on ${locator}` : ''}.`,
    fill: `Filled${locator ? ` ${locator}` : ''} with ${result.valueLength ?? 0} characters.${result.verified === false ? ' WARNING: field value did not match after fill.' : ''}`,
    type: `Typed ${result.characters ?? 0} characters${locator ? ` into ${locator}` : ''}.`,
    select: `Selected ${JSON.stringify(result.values ?? result.value ?? result.optionText)}${locator ? ` in ${locator}` : ''}.`,
    scroll: `Scrolled to ${result.scrollX ?? 0},${result.scrollY ?? 0}${result.moved === false ? ' (no movement)' : ''}.`,
    bounds: `Bounds: ${result.x},${result.y} ${result.width}×${result.height}${result.inViewport ? ' (in viewport)' : ' (outside viewport)'}.`,
    highlight: `Highlighted element for ${result.duration}ms.`,
    drag: `Dragged from ${result.from?.x},${result.from?.y} to ${result.to?.x},${result.to?.y}.`,
    activate: `Activated paired tab ${result.tabId}.`,
    wait: `Matched ${result.condition ?? 'condition'} after ${result.elapsedMs ?? 0}ms.`,
    close: `Closed session ${result.session}.`,
    screenshot: `Saved screenshot to ${result.output} (${result.bytes} bytes).`,
    scrape: `Saved ${result.routes} routes to ${result.output} (${result.bytes} bytes).`,
    'dom-file': `Saved ${result.format} DOM to ${result.output} (${result.bytes} bytes).`,
    'extension pair': `Paired. Control session: ${result.id}`,
  };
  console.log(messages[kind] ?? JSON.stringify(result, null, 2));
}

function describeLocator(locator: Locator | undefined) {
  if (!locator) return '';
  if (locator.by === 'role')
    return locator.name
      ? `role ${JSON.stringify(locator.value)} named ${JSON.stringify(locator.name)}`
      : `role ${JSON.stringify(locator.value)}`;
  return `${locator.by} ${JSON.stringify(locator.value)}`;
}
