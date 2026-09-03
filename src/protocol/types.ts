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
    }
  | {
      type: 'press';
      session: string;
      locator?: Locator;
      selector?: string;
      within?: Locator;
      nth?: number;
      key: string;
    }
  | {
      type: 'fill';
      session: string;
      locator?: Locator;
      selector?: string;
      within?: Locator;
      nth?: number;
      text: string;
    }
  /** @deprecated Use fill. Type now has fill semantics for compatibility. */
  | {
      type: 'type';
      session: string;
      locator?: Locator;
      selector?: string;
      within?: Locator;
      nth?: number;
      text: string;
      delay?: number;
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
export interface ScrapeResult {
  files: Array<{ name: string; data: string }>;
  url: string;
  title: string | null;
  capturedAt: string;
  bytes: number;
  routes: number;
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
}
export interface EvaluateResult {
  value: unknown;
}
