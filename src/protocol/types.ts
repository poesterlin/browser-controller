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
  | 'select'
  | 'scroll'
  | 'bounds'
  | 'highlight'
  | 'drag'
  | 'activate'
  | 'scrape.snapshot'
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
  | {
      type: 'scrape';
      session: string;
      url?: string;
      timeout?: number;
      maxBytes?: number;
      maxRoutes?: number;
      maxDuration?: number;
      dedicatedWindow?: boolean;
    }
  | { type: 'screenshot'; session: string; fullPage?: boolean; selector?: string; waitForActive?: number }
  | {
      type: 'dom';
      session: string;
      locator?: Locator;
      selector?: string;
      maxChars?: number;
      format?: 'interactive' | 'summary' | 'clean_html' | 'json' | 'html';
      textChars?: number;
      depth?: number;
      offset?: number;
      limit?: number;
      within?: Locator;
      nth?: number;
      itemLimit?: number;
      diff?: boolean;
      screenshotAfter?: boolean;
    }
  | {
      type: 'click';
      session: string;
      locator?: Locator;
      selector?: string;
      within?: Locator;
      nth?: number;
      waitNavigation?: boolean;
      timeout?: number;
      button?: 'left' | 'right' | 'middle';
      double?: boolean;
      modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'meta'>;
      offsetX?: number;
      offsetY?: number;
      holdMs?: number;
      x?: number;
      y?: number;
      screenshotAfter?: boolean;
      intent?: string;
    }
  | {
      type: 'press';
      session: string;
      locator?: Locator;
      selector?: string;
      within?: Locator;
      nth?: number;
      key: string;
      screenshotAfter?: boolean;
      intent?: string;
    }
  | {
      type: 'fill';
      session: string;
      locator?: Locator;
      selector?: string;
      within?: Locator;
      nth?: number;
      text: string;
      screenshotAfter?: boolean;
      intent?: string;
    }
  | {
      type: 'type';
      session: string;
      locator?: Locator;
      selector?: string;
      within?: Locator;
      nth?: number;
      text: string;
      delay?: number;
      clear?: boolean;
      submit?: boolean;
      screenshotAfter?: boolean;
      intent?: string;
    }
  | {
      type: 'wait';
      session: string;
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
  | {
      type: 'select';
      session: string;
      locator?: Locator;
      selector?: string;
      within?: Locator;
      nth?: number;
      value?: string;
      optionText?: string;
      values?: string[];
      screenshotAfter?: boolean;
      intent?: string;
    }
  | {
      type: 'scroll';
      session: string;
      locator?: Locator;
      within?: Locator;
      nth?: number;
      direction?: 'up' | 'down' | 'left' | 'right';
      amount?: number;
      deltaX?: number;
      deltaY?: number;
      intoView?: boolean;
      screenshotAfter?: boolean;
      intent?: string;
    }
  | { type: 'bounds'; session: string; locator: Locator; within?: Locator; nth?: number }
  | { type: 'highlight'; session: string; locator: Locator; within?: Locator; nth?: number; duration?: number }
  | {
      type: 'drag';
      session: string;
      from: Locator;
      to?: Locator;
      fromNth?: number;
      toNth?: number;
      toX?: number;
      toY?: number;
      screenshotAfter?: boolean;
      intent?: string;
    }
  | { type: 'activate'; session: string }
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
export interface ScrapeResult {
  mimeType: 'application/zip';
  url: string;
  title: string | null;
  capturedAt: string;
  bytes: number;
  capturedBytes: number;
  routes: number;
  skippedRoutes?: number;
  deadlineReached?: boolean;
  chunks?: string[];
}
export type DomFormat = 'interactive' | 'summary' | 'clean_html' | 'json' | 'html';
export interface DomInteractiveItem {
  role: string;
  name: string;
  tag: string;
  css?: string;
  value?: string;
  states?: string[];
  count?: number;
  href?: string;
  inViewport?: boolean;
}
export interface DomResult {
  format: DomFormat;
  url?: string;
  html?: string;
  items?: DomInteractiveItem[];
  node?: unknown;
  truncated?: boolean;
  totalChars?: number;
  returnedChars?: number;
  totalItems?: number;
  offset?: number;
  matchedItems?: number;
  returnedItems?: number;
  rawItems?: number;
  uniqueItems?: number;
  scopeMatches?: number;
  diff?: { added: string[]; removed: string[]; changed: boolean; baseline: boolean };
}
export interface EvaluateResult {
  value: unknown;
}
