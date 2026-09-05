import type {
  Capability,
  DomFormat,
  DomResult,
  EvaluateResult,
  Locator,
  ScreenshotResult,
  ScrapeResult,
  ScrollGifResult,
} from './protocol/index.js';
export interface ScreenshotOptions {
  fullPage?: boolean;
  selector?: string;
  waitForActive?: number;
}
export interface ScrapeOptions {
  url?: string;
  timeout?: number;
  maxBytes?: number;
  maxRoutes?: number;
  maxDuration?: number;
  dedicatedWindow?: boolean;
}
export interface ScrollGifOptions {
  selector?: string;
  format?: 'gif' | 'video';
  fps?: number;
  step?: number;
  duration?: number;
  maxWidth?: number;
  settleMs?: number;
  holdMs?: number;
  loop?: number;
  maxFrames?: number;
  dither?: boolean;
  dedicatedWindow?: boolean;
  waitForActive?: number;
}
export interface DomOptions {
  locator?: Locator;
  selector?: string;
  maxChars?: number;
  format?: DomFormat;
  textChars?: number;
  depth?: number;
  offset?: number;
  limit?: number;
  within?: Locator;
  nth?: number;
  itemLimit?: number;
  diff?: boolean;
}
export interface ActionOptions {
  screenshotAfter?: boolean;
  intent?: string;
}
export interface WaitOptions {
  locator?: Locator;
  selector?: string;
  url?: string;
  urlGlob?: string;
  text?: string;
  title?: string;
  evaluate?: string;
  count?: number;
  value?: string;
  changes?: boolean;
  state?: 'attached' | 'visible' | 'hidden';
  timeout?: number;
  within?: Locator;
  nth?: number;
  tabActive?: boolean;
  windowFocused?: boolean;
}
export interface BrowserSession {
  capabilities(): readonly Capability[];
  navigate(url: string, timeout?: number): Promise<unknown>;
  screenshot(options: ScreenshotOptions): Promise<ScreenshotResult>;
  scrape(options: ScrapeOptions): Promise<ScrapeResult>;
  scrollgif(options: ScrollGifOptions): Promise<ScrollGifResult>;
  dom(options: DomOptions): Promise<DomResult>;
  click(locator: Locator | undefined, within: Locator | undefined, nth: number | undefined, options: ActionOptions & { waitNavigation?: boolean; timeout?: number; button?: 'left' | 'right' | 'middle'; double?: boolean; modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'meta'>; offsetX?: number; offsetY?: number; holdMs?: number; x?: number; y?: number }): Promise<unknown>;
  press(locator: Locator | undefined, key: string, within?: Locator, nth?: number): Promise<unknown>;
  fill(locator: Locator, text: string, within?: Locator, nth?: number): Promise<unknown>;
  type(locator: Locator, text: string, options: { within?: Locator; nth?: number; delay?: number; clear?: boolean; submit?: boolean }): Promise<unknown>;
  select(locator: Locator, options: { value?: string; optionText?: string; values?: string[]; within?: Locator; nth?: number }): Promise<unknown>;
  scroll(options: { locator?: Locator; within?: Locator; nth?: number; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; deltaX?: number; deltaY?: number; intoView?: boolean }): Promise<unknown>;
  bounds(locator: Locator, within?: Locator, nth?: number): Promise<unknown>;
  highlight(locator: Locator, within?: Locator, nth?: number, duration?: number): Promise<unknown>;
  drag(from: Locator, options: { to?: Locator; fromNth?: number; toNth?: number; toX?: number; toY?: number }): Promise<unknown>;
  activate(): Promise<unknown>;
  device(options: { width?: number; height?: number; mobile?: boolean; clear?: boolean }): Promise<unknown>;
  wait(options: WaitOptions): Promise<unknown>;
  evaluate(expression: string): Promise<EvaluateResult>;
  close(reason: string): Promise<void>;
}
export class SessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
export type SessionState = 'starting' | 'running' | 'disconnected' | 'exited' | 'removed';
export class QueuedSession {
  state: SessionState = 'starting';
  private tail = Promise.resolve();
  private closed = false;
  readonly deadline: ReturnType<typeof setTimeout>;
  readonly deadlineAt: number;
  constructor(
    public readonly id: string,
    public readonly name: string | undefined,
    public readonly adapter: BrowserSession,
    lifetimeMs = 300_000,
  ) {
    this.deadlineAt = Date.now() + lifetimeMs;
    this.deadline = setTimeout(() => {
      void this.close('session deadline');
    }, lifetimeMs);
    this.deadline.unref?.();
  }
  start() {
    this.state = 'running';
  }
  execute<T>(job: () => Promise<T>, timeoutMs = 30000): Promise<T> {
    if (this.state !== 'running')
      return Promise.reject(new SessionError('session_not_running', 'session is not running'));
    const run = this.tail.then(
      () =>
        new Promise<T>((resolve, reject) => {
          if (this.closed)
            return reject(new SessionError('session_not_running', 'session is not running'));
          const timer = setTimeout(
            () => reject(new SessionError('timeout', 'command timed out')),
            timeoutMs,
          );
          job()
            .then(resolve, reject)
            .finally(() => clearTimeout(timer));
        }),
    );
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  disconnect() {
    if (this.state === 'running') this.state = 'disconnected';
  }
  reconnect() {
    if (this.state === 'disconnected') this.state = 'running';
  }
  async close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.deadline);
    this.state = 'exited';
    await this.adapter.close(reason);
    this.state = 'removed';
  }
}
