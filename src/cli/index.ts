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
const BOOLEAN_FLAGS = new Set(['--json', '--help', '-h', '--exact', '--within-exact', '--full-page', '--changes', '--tab-active', '--window-focused', '--wait-navigation']);
const DOM_FORMATS = new Set(['interactive', 'summary', 'clean_html', 'json', 'html']);
const KNOWN_FLAGS = new Set([
  '--session', '-s', '--json', '--help', '-h', '--selector', '--role', '--name', '--label',
  '--text', '--exact', '--name', '--adapter', '--url', '--timeout', '--max-chars', '--output',
  '--full-page', '--value', '--state', '--expression', '--reason', '--format', '--text-chars', '--key', '--depth', '--count', '--changes',
  '--offset', '--limit', '--within-selector', '--within-role', '--within-name', '--within-label', '--within-text', '--within-exact',
  '--nth', '--item-limit', '--wait-for-active', '--tab-active', '--window-focused', '--option-text',
  '--url-glob', '--wait-navigation',
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

function validateFlags() {
  const common = ['--session', '-s', '--json', '--help', '-h'];
  const locator = ['--selector', '--role', '--name', '--label', '--text', '--exact'];
  const within = ['--within-selector', '--within-role', '--within-name', '--within-label', '--within-text', '--within-exact'];
  const byCommand: Record<string, string[]> = {
    start: ['--name', '--adapter'],
    navigate: ['--url', '--timeout'],
    dom: [...locator, ...within, '--max-chars', '--format', '--text-chars', '--depth', '--offset', '--limit', '--nth', '--item-limit'],
    screenshot: ['--output', '--selector', '--full-page', '--wait-for-active'],
    click: [...locator, ...within, '--nth', '--wait-navigation', '--timeout'],
    press: [...locator, ...within, '--key', '--nth'],
    fill: [...locator, ...within, '--value', '--nth'],
    type: [...locator, ...within, '--value', '--nth'],
    select: [...locator, ...within, '--value', '--option-text', '--nth'],
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
    case 'click':
      return { type: 'click', session, locator: commandLocator(), within: withinLocator(), nth: numberValue('--nth'), waitNavigation: args.includes('--wait-navigation') || undefined, timeout: numberValue('--timeout') };
    case 'press': {
      if (value('--key') === undefined) throw new Error('press requires --key KEY');
      return { type: 'press', session, locator: commandLocator(), within: withinLocator(), nth: numberValue('--nth'), key: value('--key')! };
    }
    case 'fill':
    case 'type':
      if (value('--value') === undefined) throw new Error('fill requires --value VALUE');
      return {
        type: 'fill',
        session,
        locator: commandLocator(),
        within: withinLocator(),
        nth: numberValue('--nth'),
        text: value('--value')!,
      };
    case 'select':
      return {
        type: 'select',
        session,
        locator: commandLocator(),
        within: withinLocator(),
        nth: numberValue('--nth'),
        value: value('--value'),
        optionText: value('--option-text'),
      };
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
    dom: `usage: ${invocation} dom [LOCATOR] [--format interactive|summary|clean_html|json] [--offset N] [--limit N] [--item-limit N] [--nth N] [--max-chars N] [--text-chars N] [--depth N] [--session ID] [--json]\n\n${locator}\n\nScope any locator with --within-selector CSS, --within-role ROLE [--within-name NAME], --within-label LABEL, or --within-text TEXT. Summary output groups repeated items and defaults to 100 groups. --nth is zero-based.`,
    click: `usage: ${invocation} click LOCATOR [--session ID] [--json]\n\n${locator}\n\nExample: ${invocation} click --role button --name Save --exact`,
    press: `usage: ${invocation} press LOCATOR --key KEY [--session ID] [--json]\n\n${locator}\n\nKEY combines modifiers with '+': Enter, Tab, Escape, ctrl+Enter, ctrl+a, Shift+Tab\n\nExample: ${invocation} press --selector '#chat-input' --key ctrl+Enter`,
    fill: `usage: ${invocation} fill LOCATOR --value VALUE [--session ID] [--json]\n\n${locator}\n\nExample: ${invocation} fill --label URL --value https://example.com`,
    select: `usage: ${invocation} select LOCATOR (--value VALUE | --option-text TEXT) [--nth N] [--session ID] [--json]\n\n${locator}\n\nExample: ${invocation} select --label Kind --value atom`,
    wait: `usage: ${invocation} wait (LOCATOR | --url URL | --title TEXT | --evaluate EXPR) [--state visible|attached|hidden] [--count N | --value VALUE | --changes] [--timeout MS] [--session ID] [--json]\n\n${locator}\n\nLocator waits can require an exact match count, an exact field/text value, or a change from the value observed when waiting began. URL waits are exact; title matching is partial; evaluate expressions are polled until truthy.\n\nExamples:\n  ${invocation} wait --selector '.result' --count 3\n  ${invocation} wait --label Status --value Complete\n  ${invocation} wait --role log --changes\n  ${invocation} wait --evaluate "document.querySelectorAll('[class*=markdown]').length > 0" --timeout 20000`,
    evaluate: `usage: ${invocation} evaluate --expression JAVASCRIPT [--session ID] [--json]`,
    screenshot: `usage: ${invocation} screenshot [--full-page | --selector CSS] [--wait-for-active MS] [--output FILE.png] [--session ID] [--json]`,
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
  select           Select an option
  press            Dispatch a key or key chord to an element
  wait             Wait for a locator or URL
  evaluate         Evaluate page-world JavaScript
  screenshot       Save a viewport, full-page, or element image
  list             List sessions
  start            Explicitly create or reconnect a session
  close            Close a session

Ordinary browser commands use the current session automatically. Pass --session ID only to select another session. Use --json for stable machine-readable output.

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
  const autoStart =
    pairing ||
    effectiveCommand === 'start' ||
    ['navigate', 'dom', 'screenshot', 'click', 'fill', 'type', 'select', 'press', 'wait', 'evaluate'].includes(
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
  ws.send(JSON.stringify({ version: PROTOCOL_VERSION, id, kind: 'command', command: request }));
  await new Promise<void>((resolve, reject) => {
    let pair: any;
    let starting = false;
    const timeoutMs = pairing
      ? 305_000
      : request.type === 'wait'
        ? (request.timeout ?? 10_000) + 5_000
        : request.type === 'click'
          ? (request.timeout ?? 10_000) + 5_000
        : request.type === 'screenshot' && request.waitForActive
          ? request.waitForActive + 125_000
        : 15_000;
    const timer = setTimeout(() => reject(new Error('command timed out waiting for supervisor')), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve();
    };
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (pairing && message.event === 'adapter_connected' && pair && !starting) {
        starting = true;
        ws.send(
          JSON.stringify({
            version: PROTOCOL_VERSION,
            id: randomUUID(),
            kind: 'command',
            command: { type: 'start', adapter: message.adapterId },
          }),
        );
        return;
      }
      if (!pairing && message.id !== id) return;
      if (pairing && !pair && message.id !== id) return;
      if (pairing && pair && !starting) return;
      if (message.ok) {
        if (pairing && !pair) {
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
          spawn('xdg-open', [pairingPage.toString()], { detached: true, stdio: 'ignore' }).unref();
          return;
        }
        if (pairing) {
          const session = message.result;
          printResult('extension pair', { action: 'paired', ...session });
        } else if (command === 'dom') {
          const result = message.result;
          if (jsonOutput) printResult('dom', result);
          else if (result?.format === 'interactive' || result?.format === 'summary') {
            for (const item of result.items ?? []) {
              const states = item.states?.length ? ` [${item.states.join(',')}]` : '';
              const value = item.value ? ` value="${item.value}"` : '';
              const hint = item.css ? ` (${item.tag}${item.css})` : ` (${item.tag})`;
              const count = item.count > 1 ? ` ×${item.count}` : '';
              const href = item.href ? ` -> ${item.href}` : '';
              console.log(`- ${item.role}${item.name ? ` "${item.name}"` : ''}${count}${hint}${value}${states}${href}`);
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
        } else if (command === 'screenshot') {
          const output = value('--output') ?? 'screenshot.png';
          const bytes = Buffer.from(message.result.data, 'base64');
          writeFileSync(output, bytes);
          printResult('screenshot', { action: 'screenshot-saved', output, bytes: bytes.length });
        } else printResult(effectiveCommand, message.result ?? {});
        finish();
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
    select: `Selected ${JSON.stringify(result.value ?? result.optionText)}${locator ? ` in ${locator}` : ''}.`,
    wait: `Matched ${result.condition ?? 'condition'} after ${result.elapsedMs ?? 0}ms.`,
    close: `Closed session ${result.session}.`,
    screenshot: `Saved screenshot to ${result.output} (${result.bytes} bytes).`,
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
