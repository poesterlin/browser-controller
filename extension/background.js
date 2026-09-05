import { CommandCache } from './command-cache.js';
import { selectControlTab } from './control-tab.js';
import { withTimeout } from './async.js';
import { createScrapeArchive } from './scrape-archive.js';
import { GifEncoder } from './gif.js';
import { easedScrollPositions } from './scroll-easing.js';
import { artifactChunks } from './artifact-chunks.js';

const state = {
  socket: null,
  connecting: false,
  session: null,
  adapterId: null,
  tabId: null,
  controlTabId: null,
  pairingTabId: null,
  commands: new CommandCache(),
  // Device emulation keeps the debugger attached for the whole session so the
  // emulated viewport applies to every command until it is cleared. The
  // shared attachment is reused by all debugger-based operations.
  device: null,
  debuggerTabId: null,
};

async function ensureDebuggerAttached(tabId) {
  if (state.debuggerTabId === tabId) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  state.debuggerTabId = tabId;
}

// Runs an operation with the Chrome debugger attached. A device-emulation
// attachment is reused and never detached here, so the emulated viewport
// survives individual commands.
async function withDebugger(tabId, operation) {
  const persistent = state.debuggerTabId === tabId;
  if (!persistent) {
    await chrome.debugger.attach({ tabId }, '1.3');
    state.debuggerTabId = tabId;
  }
  try {
    return await operation((method, params) => chrome.debugger.sendCommand({ tabId }, method, params));
  } finally {
    if (!persistent) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      if (state.debuggerTabId === tabId) state.debuggerTabId = null;
    }
  }
}

function resetDeviceEmulation() {
  state.device = null;
  state.debuggerTabId = null;
}
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'pair') {
    const controlTabId = sender.tab?.id;
    state.pairingTabId = Number.isInteger(controlTabId) ? controlTabId : null;
    state.controlTabId = state.pairingTabId;
    state.tabId = state.pairingTabId;
    const values = {
      endpoint: message.endpoint,
      pairingCode: message.code,
      adapterId: message.adapterId,
      pairingInfo: `browser-controller://pair?endpoint=${encodeURIComponent(message.endpoint)}&code=${encodeURIComponent(message.code)}&adapter=${encodeURIComponent(message.adapterId)}`,
    };
    if (state.controlTabId != null) values.controlTabId = state.controlTabId;
    chrome.storage.local.set(values);
    if (state.controlTabId == null) chrome.storage.local.remove(['controlTabId']);
  }
});

async function page(tabId, message) {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (m) => {
      if (m.type === 'evaluate') {
        const safeStringify = (value) => {
          const seen = new WeakSet();
          return JSON.stringify(value, (_key, item) => {
            if (typeof item === 'bigint') return String(item);
            if (typeof item === 'function')
              return `[Function${item.name ? ` ${item.name}` : ''}]`;
            if (typeof item === 'object' && item !== null) {
              if (seen.has(item)) return '[Circular]';
              seen.add(item);
            }
            return item;
          });
        };
        const value = await (0, eval)(m.expression); // oxlint-disable-line no-eval -- evaluate capability requires page-world eval
        if (value === undefined) return null;
        return JSON.parse(safeStringify(value));
      }
      if (m.type === 'screenshot_region') {
        const element = m.selector ? document.querySelector(m.selector) : null;
        if (m.selector && !element) return 'element_not_found';
        const rect = element?.getBoundingClientRect();
        const width = Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0,
          document.documentElement.clientWidth,
        );
        const height = Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
          document.documentElement.clientHeight,
        );
        return {
          region: rect
            ? { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height }
            : { x: 0, y: 0, width, height },
          viewport: { width: innerWidth, height: innerHeight },
          document: { width, height },
          scroll: { x: scrollX, y: scrollY },
          devicePixelRatio,
        };
      }
      if (m.type === 'screenshot_scroll') {
        scrollTo(m.x, m.y);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { x: scrollX, y: scrollY };
      }
      if (m.type === 'scrollgif_viewport') {
        return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
      }
      if (m.type === 'scrollgif_measure') {
        if (m.selector) {
          const el = document.querySelector(m.selector);
          if (!el) return 'element_not_found';
          const maxScrollY = Math.max(0, el.scrollHeight - el.clientHeight);
          if (!maxScrollY) return 'element_not_scrollable';
          return {
            mode: 'element',
            maxScrollY,
            viewportHeight: el.clientHeight,
            scroll: { x: el.scrollLeft, y: el.scrollTop },
          };
        }
        const root = document.scrollingElement ?? document.documentElement;
        return {
          mode: 'page',
          maxScrollY: Math.max(0, root.scrollHeight - innerHeight),
          maxScrollX: Math.max(0, root.scrollWidth - innerWidth),
          viewportHeight: innerHeight,
          scroll: { x: scrollX, y: scrollY },
        };
      }
      if (m.type === 'scrollgif_scroll') {
        let scrolled;
        let target;
        if (m.selector) {
          const el = document.querySelector(m.selector);
          if (!el) return 'element_not_found';
          el.scrollTo({ left: m.x, top: m.y, behavior: 'instant' });
          scrolled = { x: el.scrollLeft, y: el.scrollTop };
          target = el;
        } else {
          scrollTo({ left: m.x, top: m.y, behavior: 'instant' });
          scrolled = { x: scrollX, y: scrollY };
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        // Give lazy-loaded viewport images a bounded chance to finish before
        // the frame is captured.
        if (m.settleMs) {
          const deadline = performance.now() + m.settleMs;
          const pendingImages = () => [...document.images].filter((img) => {
            const rect = img.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth && !img.complete;
          });
          while (performance.now() < deadline && pendingImages().length)
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const root = document.scrollingElement ?? document.documentElement;
        return {
          ...scrolled,
          maxScrollY: target
            ? Math.max(0, target.scrollHeight - target.clientHeight)
            : Math.max(0, root.scrollHeight - innerHeight),
        };
      }
      if (m.type === 'screenshot_sticky') {
        const key = '__browserControllerStickyRestore';
        if (m.hide) {
          if (!window[key]) window[key] = [...document.querySelectorAll('body *')]
            .filter((element) => ['fixed', 'sticky'].includes(getComputedStyle(element).position))
            .map((element) => ({ element, visibility: element.style.visibility }));
          for (const entry of window[key]) entry.element.style.setProperty('visibility', 'hidden', 'important');
          return { hidden: window[key].length };
        }
        for (const entry of window[key] ?? []) entry.element.style.visibility = entry.visibility;
        const restored = window[key]?.length ?? 0;
        delete window[key];
        return { restored };
      }
      if (m.type === 'scrape_links') {
        const origin = location.origin;
        return [...document.querySelectorAll('a[href]')]
          .map((link) => {
            try {
              const url = new URL(link.href, location.href);
              if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return null;
              url.hash = '';
              url.search = '';
              return url.href;
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }

      const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const matches = (actual, expected, exact = false) => {
        const left = normalize(actual);
        const right = normalize(expected);
        return exact
          ? left === right
          : left.toLocaleLowerCase().includes(right.toLocaleLowerCase());
      };
      const explicitRole = (element) => element.getAttribute('role')?.split(/\s+/)[0];
      const implicitRole = (element) => {
        const tag = element.tagName.toLowerCase();
        const type = element.getAttribute('type')?.toLowerCase();
        if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset', 'image', 'file'].includes(type))) return 'button';
        if (tag === 'a' && element.hasAttribute('href')) return 'link';
        if (tag === 'input' && type === 'search') return 'searchbox';
        if (tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'number', 'hidden'].includes(type ?? 'text'))) return 'textbox';
        if (tag === 'input' && type === 'checkbox') return 'checkbox';
        if (tag === 'input' && type === 'radio') return 'radio';
        if (tag === 'input' && type === 'range') return 'slider';
        if (tag === 'input' && type === 'number') return 'spinbutton';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'img') return 'img';
        if (tag === 'select') return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
        if (tag === 'option') return 'option';
        if (tag === 'ul' || tag === 'ol') return 'list';
        if (tag === 'li') return 'listitem';
        return undefined;
      };
      const accessibleName = (element) => {
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent)
            .filter(Boolean)
            .join(' ');
          if (text) return normalize(text);
        }
        const aria = element.getAttribute('aria-label');
        if (aria) return normalize(aria);
        if (element.labels?.length)
          return normalize([...element.labels].map((label) => label.textContent).join(' '));
        if (element.getAttribute('alt')) return normalize(element.getAttribute('alt'));
        if (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type))
          return normalize(element.value);
        return normalize(element.textContent);
      };
      const locator =
        m.locator ??
        (m.selector
          ? { by: 'css', value: m.selector }
          : m.type === 'wait' && m.text
            ? { by: 'text', value: m.text }
            : undefined);
      const findAll = (target, root = document) => {
        if (!target) return [];
        const candidates = [...(root instanceof Element ? [root] : []), ...root.querySelectorAll('*')];
        if (target.by === 'css') return candidates.filter((candidate) => candidate.matches(target.value));
        if (target.by === 'label') {
          const label = [...root.querySelectorAll('label')].find((candidate) =>
            matches(candidate.textContent, target.value, target.exact),
          );
          if (label) {
            const control = label.control ?? label.querySelector('input,textarea,select,[contenteditable=true]');
            return control ? [control] : [];
          }
          const control = [...root.querySelectorAll('input,textarea,select,[contenteditable=true]')].find(
            (candidate) =>
              (candidate.hasAttribute('aria-label') || candidate.hasAttribute('aria-labelledby')) &&
              matches(accessibleName(candidate), target.value, target.exact),
          );
          return control ? [control] : [];
        }
        if (target.by === 'role')
          return candidates.filter(
            (candidate) =>
              (explicitRole(candidate) ?? implicitRole(candidate)) === target.value.toLowerCase() &&
              (!target.name || matches(accessibleName(candidate), target.name, target.exact)),
          );
        return candidates.filter(
          (candidate) =>
            matches(candidate.textContent, target.value, target.exact) &&
            ![...candidate.children].some((child) =>
              matches(child.textContent, target.value, target.exact),
            ),
        );
      };
      const getScope = () => {
        if (!m.within) return document;
        const matches = findAll(m.within);
        if (m.within.by !== 'text' || !locator) return matches[0];
        for (const match of matches) {
          let candidate = match;
          while (candidate && candidate !== document.documentElement) {
            if (findAll(locator, candidate).length) return candidate;
            candidate = candidate.parentElement;
          }
        }
        return matches[0];
      };
      const rawLocateAll = () => {
        const scope = getScope();
        return !locator || !scope ? [] : findAll(locator, scope);
      };
      const locateAll = () => {
        const elements = rawLocateAll();
        return m.nth === undefined ? elements : elements.slice(m.nth, m.nth + 1);
      };
      const locate = () => locateAll()[0] ?? null;
      const globMatches = (input, glob) => {
        const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
        return new RegExp(`^${escaped}$`).test(input);
      };
      const visible = (element) =>
        !!element &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== 'hidden' &&
        getComputedStyle(element).display !== 'none';

      if (m.type === 'wait') {
        const started = performance.now();
        const timeout = m.timeout ?? 10_000;
        const observedValue = (candidate) =>
          candidate instanceof HTMLInputElement ||
          candidate instanceof HTMLTextAreaElement ||
          candidate instanceof HTMLSelectElement
            ? candidate.value
            : normalize(candidate?.textContent);
        const initial = m.changes ? observedValue(locate()) : undefined;
        while (performance.now() - started <= timeout) {
          const elements = locateAll();
          const element = elements[0];
          const waitState = m.state ?? 'visible';
          const matched = m.url
            ? location.href === new URL(m.url, location.href).href
            : m.urlGlob
              ? globMatches(location.href, m.urlGlob)
            : m.title
              ? matches(document.title, m.title)
              : m.evaluate
                ? !!(0, eval)(m.evaluate) // oxlint-disable-line no-eval -- wait condition needs page-world eval
                : m.count !== undefined
                  ? elements.filter((candidate) => waitState === 'attached' || visible(candidate)).length === m.count
                  : m.value !== undefined
                    ? !!element && observedValue(element) === m.value
                    : m.changes
                      ? !!element && observedValue(element) !== initial
                : waitState === 'attached'
                  ? !!element
                  : waitState === 'hidden'
                    ? elements.every((candidate) => !visible(candidate))
                    : visible(element);
          if (matched) {
            const visibleCount = elements.filter(visible).length;
            return {
              action: 'matched',
              condition: m.url
                ? 'url'
                : m.urlGlob
                  ? 'url-glob'
                : m.title
                  ? 'title'
                  : m.evaluate
                    ? 'evaluate'
                    : m.count !== undefined
                      ? 'count'
                      : m.value !== undefined
                        ? 'value'
                        : m.changes
                          ? 'changes'
                           : locator.by,
              state: m.state,
              locator,
              observed: {
                matchedCount: elements.length,
                visibleCount,
                ...(m.value !== undefined || m.changes ? { value: observedValue(element) } : {}),
              },
              elapsedMs: Math.round(performance.now() - started),
              url: location.href,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const elements = locateAll();
        return {
          action: 'timeout',
          condition: m.url ? 'url' : m.urlGlob ? 'url-glob' : m.title ? 'title' : m.evaluate ? 'evaluate' : locator?.by ?? (m.tabActive ? 'tab-active' : 'window-focused'),
          state: m.state,
          locator,
          observed: {
            matchedCount: elements.length,
            visibleCount: elements.filter(visible).length,
            ...(m.value !== undefined || m.changes ? { value: observedValue(elements[0]) } : {}),
          },
          elapsedMs: Math.round(performance.now() - started),
          url: location.href,
        };
      }

      const element = locate();
      const scopeMatches = m.within ? findAll(m.within).length : undefined;
      const locatorAction = ['click', 'focus', 'fill', 'type', 'select', 'scroll', 'bounds', 'highlight', 'point'];
      if (locatorAction.includes(m.type) && m.within && scopeMatches === 0)
        return 'scope_not_found';
      if (locatorAction.includes(m.type) && m.within && scopeMatches > 1)
        return `ambiguous_scope:${scopeMatches}`;
      if (locatorAction.includes(m.type) && locator && m.nth === undefined && rawLocateAll().length > 1)
        return `ambiguous_locator:${rawLocateAll().length}`;
      if (locator && !element) return 'element_not_found';
      const elementBounds = (target) => {
        const rect = target.getBoundingClientRect();
        return {
          x: rect.left,
          y: rect.top,
          pageX: rect.left + scrollX,
          pageY: rect.top + scrollY,
          width: rect.width,
          height: rect.height,
          inViewport:
            rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
        };
      };
      if (m.type === 'point') {
        if (m.scroll !== false) {
          element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        const bounds = elementBounds(element);
        return {
          ...bounds,
          centerX: bounds.x + bounds.width / 2 + (m.offsetX ?? 0),
          centerY: bounds.y + bounds.height / 2 + (m.offsetY ?? 0),
          submissionExpected:
            (element instanceof HTMLButtonElement && !!element.form && element.type === 'submit') ||
            (element instanceof HTMLInputElement && !!element.form && ['submit', 'image'].includes(element.type)),
        };
      }
      if (m.type === 'bounds') return { action: 'bounded', ...elementBounds(element) };
      if (m.type === 'scroll') {
        if (m.intoView) {
          const before = elementBounds(element);
          element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const after = elementBounds(element);
          return {
            action: 'scrolled',
            scrollX,
            scrollY,
            intoView: true,
            moved: before.x !== after.x || before.y !== after.y,
            bounds: after,
          };
        }
        const target = element ?? window;
        const beforeX = target === window ? scrollX : target.scrollLeft;
        const beforeY = target === window ? scrollY : target.scrollTop;
        const amount = m.amount ?? 600;
        const directions = {
          up: [0, -amount],
          down: [0, amount],
          left: [-amount, 0],
          right: [amount, 0],
        };
        const [deltaX, deltaY] = m.direction ? directions[m.direction] : [m.deltaX ?? 0, m.deltaY ?? 0];
        target.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const afterX = target === window ? scrollX : target.scrollLeft;
        const afterY = target === window ? scrollY : target.scrollTop;
        return { action: 'scrolled', scrollX: afterX, scrollY: afterY, deltaX: afterX - beforeX, deltaY: afterY - beforeY, moved: beforeX !== afterX || beforeY !== afterY };
      }
      if (m.type === 'highlight') {
        const previous = { outline: element.style.outline, outlineOffset: element.style.outlineOffset };
        element.style.setProperty('outline', '3px solid #ff2d55', 'important');
        element.style.setProperty('outline-offset', '3px', 'important');
        setTimeout(() => {
          element.style.outline = previous.outline;
          element.style.outlineOffset = previous.outlineOffset;
        }, m.duration ?? 2000);
        return { action: 'highlighted', duration: m.duration ?? 2000, ...elementBounds(element) };
      }
      if (m.type === 'active_value') {
        const target = document.activeElement;
        const value = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          ? target.value
          : target?.textContent ?? '';
        return { value, valueLength: value.length };
      }
      if (m.type === 'dom') {
        const allRoots = locator ? rawLocateAll() : [document.documentElement];
        const offset = m.offset ?? 0;
        const limit = m.limit ?? (m.offset === undefined ? 1 : 100);
        const roots = locator
          ? m.nth === undefined
            ? allRoots.slice(offset, offset + limit)
            : allRoots.slice(m.nth, m.nth + 1)
          : allRoots;
        const root = roots[0];
        const format = m.format ?? 'clean_html';
        const maxChars = m.maxChars ?? 50_000;
        const textChars = m.textChars ?? 100;
        const maxDepth = m.depth ?? Infinity;
        const url = location.href;
        const clip = (text) => {
          const t = String(text ?? '').replace(/\s+/g, ' ').trim();
          return t.length > textChars ? `${t.slice(0, textChars)}…` : t;
        };
        if (format === 'html') {
          const html = roots.map((candidate) => candidate.outerHTML).join('\n');
          return {
            format,
            html: html.slice(0, maxChars),
            truncated: html.length > maxChars,
            returnedChars: Math.min(html.length, maxChars),
            totalChars: html.length,
            offset,
            matchedItems: allRoots.length,
            returnedItems: roots.length,
            ...(scopeMatches !== undefined ? { scopeMatches } : {}),
          };
        }
        const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);
        const KEEP_ATTRS = new Set([
          'id', 'name', 'type', 'href', 'placeholder', 'value', 'title', 'alt', 'for',
          'action', 'method', 'target', 'autocomplete', 'disabled', 'checked', 'required',
          'selected', 'readonly', 'contenteditable',
        ]);
        const keepAttr = (name) =>
          KEEP_ATTRS.has(name) || name === 'role' || name.startsWith('aria-') || name.startsWith('data-');
        if (format === 'clean_html') {
          const VOID_TAGS = new Set(['input', 'img', 'br', 'hr']);
          const render = (initialBudget) => {
            let budget = initialBudget;
            let truncated = false;
            const serialize = (node, depth = 0) => {
              if (budget <= 0) return void (truncated = true) || '';
              if (node.nodeType === Node.TEXT_NODE) {
                const text = String(node.textContent ?? '').replace(/\s+/g, ' ').trim();
                if (!text) return '';
                const out = clip(text);
                budget -= out.length + 1;
                return `${out} `;
              }
              if (node.nodeType !== Node.ELEMENT_NODE) return '';
              const el = node;
              const tag = el.tagName.toLowerCase();
              if (SKIP_TAGS.has(tag)) return '';
              let attrs = '';
              for (const attr of el.attributes) {
                if (keepAttr(attr.name)) attrs += ` ${attr.name}="${attr.value.replace(/"/g, '&quot;').slice(0, 80)}"`;
              }
              const open = `<${tag}${attrs}${VOID_TAGS.has(tag) ? ' /' : ''}>`;
              if (budget - open.length < 0) return void (truncated = true) || '';
              budget -= open.length;
              if (VOID_TAGS.has(tag)) return open;
              if (depth >= maxDepth) return void (truncated = true) || `${open}<!-- depth limit --></${tag}>`;
              let body = '';
              for (const child of el.childNodes) {
                if (budget <= 0) {
                  truncated = true;
                  body += '\n<!-- truncated: increase --max-chars for more -->';
                  break;
                }
                body += serialize(child, depth + 1);
              }
              const close = `</${tag}>`;
              budget -= close.length + 1;
              return `${open}${body.trim() ? `\n${body}` : ''}${close}`;
            };
            return { html: roots.map((candidate) => serialize(candidate)).join('\n'), truncated };
          };
          const complete = render(Infinity);
          const bounded = complete.html.length > maxChars ? render(maxChars) : complete;
          return { format, html: bounded.html, truncated: bounded.truncated, returnedChars: bounded.html.length, totalChars: complete.html.length, url, offset, matchedItems: allRoots.length, returnedItems: roots.length, ...(scopeMatches !== undefined ? { scopeMatches } : {}) };
        }
        if (format === 'interactive' || format === 'summary') {
          const seen = new Set();
          const interactiveSelector = format === 'summary'
            ? 'main,nav,aside,section,article,h1,h2,h3,h4,h5,h6,a[href],button,input,select,textarea,summary,[role],[contenteditable="true"],[onclick]'
            : 'a[href],button,input,select,textarea,summary,[role],[contenteditable="true"],[onclick]';
          const candidates = roots.flatMap((candidate) => [
            ...(candidate.matches?.(interactiveSelector) ? [candidate] : []),
            ...candidate.querySelectorAll(interactiveSelector),
          ]);
          const items = [];
          let actionable = 0;
          for (const el of candidates) {
            if (seen.has(el)) continue;
            seen.add(el);
            if (!visible(el)) continue;
            const tag = el.tagName.toLowerCase();
            const role =
              explicitRole(el) ??
              implicitRole(el) ??
              (tag === 'summary' ? 'button' : el.isContentEditable ? 'textbox' : undefined);
            const actionableByTag = ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag);
            const actionableRole = new Set([
              'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'slider',
              'spinbutton', 'combobox', 'listbox', 'option', 'menuitem', 'switch', 'tab', 'treeitem',
            ]).has(role);
            const summaryRole = format === 'summary' && ((role && role !== 'generic') || /^h[1-6]$/.test(tag));
            if (!summaryRole && !actionableByTag && !el.isContentEditable && !el.hasAttribute('onclick') && !actionableRole) continue;
            actionable += 1;
            if (items.length >= 500) continue;
            const item = {
              role: role ?? 'generic',
              name: clip(accessibleName(el)).slice(0, 100),
              tag,
              inViewport: elementBounds(el).inViewport,
            };
            if (el.id) item.css = `#${CSS.escape(el.id)}`;
            if (el instanceof HTMLAnchorElement && el.href) item.href = el.href;
            const states = [];
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
            if (el.getAttribute('aria-expanded') === 'true') states.push('expanded');
            if (el.getAttribute('aria-expanded') === 'false') states.push('collapsed');
            if (el.checked === true || el.getAttribute('aria-checked') === 'true') states.push('checked');
            if (el.required) states.push('required');
            if (states.length) item.states = states;
            if (el instanceof HTMLInputElement && !['hidden', 'password'].includes(el.type))
              item.value = clip(el.value).slice(0, 50);
            items.push(item);
          }
          let returnedItems = items;
          if (format === 'summary') {
            const grouped = new Map();
            for (const item of items) {
              const key = JSON.stringify([item.role, item.name, item.tag, item.states ?? [], item.value ?? '', item.href ?? '']);
              const existing = grouped.get(key);
              if (existing) existing.count = (existing.count ?? 1) + 1;
              else grouped.set(key, { ...item });
            }
            returnedItems = [...grouped.values()].slice(0, m.itemLimit ?? 100);
          }
          return {
            format,
            url,
            items: returnedItems,
            truncated: actionable > items.length || returnedItems.length < (format === 'summary' ? new Set(items.map((item) => JSON.stringify([item.role, item.name, item.tag, item.states ?? [], item.value ?? '', item.href ?? '']))).size : items.length),
            rawItems: actionable,
            uniqueItems: format === 'summary' ? new Set(items.map((item) => JSON.stringify([item.role, item.name, item.tag, item.states ?? [], item.value ?? '', item.href ?? '']))).size : items.length,
            totalItems: actionable,
            offset,
            matchedItems: allRoots.length,
            returnedItems: roots.length,
            ...(scopeMatches !== undefined ? { scopeMatches } : {}),
          };
        }
        // format === 'json'
        const jsonNode = (el, depth = 0) => {
          const tag = el.tagName.toLowerCase();
          if (SKIP_TAGS.has(tag)) return null;
          const role = explicitRole(el) ?? implicitRole(el);
          const aria = {};
          const attrs = {};
          for (const attr of el.attributes) {
            if (attr.name.startsWith('aria-')) aria[attr.name.slice(5)] = attr.value;
            else if (keepAttr(attr.name) && attr.name !== 'role') attrs[attr.name] = clip(attr.value);
          }
          const ownText = clip(
            [...el.childNodes]
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.textContent)
              .join(' '),
          );
          let children = [];
          let nodeClipped = false;
          if (depth < maxDepth) children = [...el.children].map((child) => jsonNode(child, depth + 1)).filter(Boolean);
          else if (el.children.length) nodeClipped = true;
          if (!ownText && !children.length && !Object.keys(attrs).length && !Object.keys(aria).length && !role)
            return null;
          const node = { tag };
          if (nodeClipped) node.clipped = true;
          if (role) node.role = role;
          if (Object.keys(aria).length) node.aria = aria;
          if (Object.keys(attrs).length) node.attrs = attrs;
          if (ownText) node.text = ownText;
          if (children.length) node.children = children;
          return node;
        };
        const nodes = roots.map((candidate) => jsonNode(candidate)).filter(Boolean);
        return {
          format,
          url,
          node: nodes.length === 1 ? nodes[0] : nodes,
          offset,
          matchedItems: allRoots.length,
          returnedItems: roots.length,
        };
      }
      if (m.type === 'click') {
        element.click();
        const submit = element instanceof HTMLButtonElement && (element.type === 'submit' || !!element.form);
        return { ok: true, submissionExpected: submit, url: location.href };
      }
      if (m.type === 'focus') {
        element.focus();
        return 'ok';
      }
      if (m.type === 'press') {
        const key = String(m.key ?? '');
        const parts = key.split('+').map((p) => p.trim());
        const modifiers = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
        let main = 'Enter';
        for (const part of parts) {
          const lower = part.toLowerCase();
          if (lower === 'ctrl' || lower === 'control') modifiers.ctrlKey = true;
          else if (lower === 'alt' || lower === 'option') modifiers.altKey = true;
          else if (lower === 'shift') modifiers.shiftKey = true;
          else if (lower === 'meta' || lower === 'cmd' || lower === 'super') modifiers.metaKey = true;
          else main = part.length === 1 ? part : part.charAt(0).toUpperCase() + part.slice(1);
        }
        const init = { key: main, bubbles: true, cancelable: true, ...modifiers };
        element.focus();
        element.dispatchEvent(new KeyboardEvent('keydown', init));
        element.dispatchEvent(new KeyboardEvent('keypress', init));
        element.dispatchEvent(new KeyboardEvent('keyup', init));
        return 'ok';
      }
      if (m.type === 'fill' || m.type === 'type') {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const prototype =
            element instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          setter?.call(element, m.text);
        } else if (element.isContentEditable) element.textContent = m.text;
        else return 'element_not_fillable';
        const valueLength =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value.length
            : (element.textContent ?? '').length;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, valueLength, verified: valueLength === m.text.length };
      }
      if (m.type === 'select') {
        if (!(element instanceof HTMLSelectElement)) return 'element_not_selectable';
        if (m.values) {
          if (!element.multiple) return 'element_not_multi_select';
          const wanted = new Set(m.values);
          for (const option of element.options) option.selected = wanted.has(option.value);
          const selected = [...element.selectedOptions].map((option) => option.value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return { values: selected, verified: selected.length === wanted.size && selected.every((value) => wanted.has(value)) };
        }
        const option = m.value !== undefined
          ? [...element.options].find((candidate) => candidate.value === m.value)
          : [...element.options].find((candidate) => normalize(candidate.textContent) === normalize(m.optionText));
        if (!option) return 'option_not_found';
        element.value = option.value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { value: element.value, optionText: normalize(option.textContent), verified: element.value === option.value };
      }
    },
    args: [message],
  });
}

async function nativePress(tabId, chord) {
  const target = { tabId };
  const parts = String(chord).split('+').map((part) => part.trim()).filter(Boolean);
  let modifiers = 0;
  let key = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'alt' || lower === 'option') modifiers |= 1;
    else if (lower === 'ctrl' || lower === 'control') modifiers |= 2;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'super') modifiers |= 4;
    else if (lower === 'shift') modifiers |= 8;
    else key = part;
  }
  if (!key) throw new Error('press_key_missing');
  const named = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
  };
  const lower = key.toLowerCase();
  const info = named[lower] ?? {
    key: modifiers & 8 ? key.toUpperCase() : key,
    code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : '',
    keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
  };
  await withDebugger(tabId, async (send) => {
    const common = {
      key: info.key,
      code: info.code,
      modifiers,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
    };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
    if (info.key.length === 1 && !(modifiers & 7))
      await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: info.key });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  });
}

function modifierBits(modifiers = []) {
  return modifiers.reduce(
    (bits, modifier) => bits | ({ alt: 1, ctrl: 2, meta: 4, shift: 8 }[modifier] ?? 0),
    0,
  );
}

async function nativeClick(tabId, point, options) {
  const button = options.button ?? 'left';
  const modifiers = modifierBits(options.modifiers);
  const clicks = options.double ? 2 : 1;
  await withDebugger(tabId, async (send) => {
    for (let clickCount = 1; clickCount <= clicks; clickCount += 1) {
      const common = { x: point.x, y: point.y, button, modifiers, clickCount };
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
      if (options.holdMs) await new Promise((resolve) => setTimeout(resolve, options.holdMs));
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
    }
  });
}

async function nativeDrag(tabId, source, target) {
  await withDebugger(tabId, async (send) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: source.x, y: source.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: source.x, y: source.y, button: 'left', clickCount: 1 });
    const steps = 12;
    for (let step = 1; step <= steps; step += 1) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: source.x + ((target.x - source.x) * step) / steps,
        y: source.y + ((target.y - source.y) * step) / steps,
        button: 'left',
        buttons: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  });
}

async function nativeType(tabId, text, options) {
  await withDebugger(tabId, async (send) => {
    if (options.clear) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
    for (const character of text) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
    }
    if (options.submit) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
  });
}

async function stitchedScreenshot(tabId, windowId, selector, returnBytes = false, deadline = Infinity) {
  const response = (await page(tabId, { type: 'screenshot_region', selector }))[0];
  if (response?.error)
    throw new Error(`page_world_error: ${response.error.message ?? String(response.error)}`);
  if (response?.result === 'element_not_found') throw new Error('element_not_found');
  const metrics = response?.result;
  if (!metrics?.region || metrics.region.width <= 0 || metrics.region.height <= 0)
    throw new Error('screenshot_region_empty');

  const region = metrics.region;
  const scale = metrics.devicePixelRatio || 1;
  const outputWidth = Math.ceil(region.width * scale);
  const outputHeight = Math.ceil(region.height * scale);
  if (outputWidth > 32767 || outputHeight > 32767 || outputWidth * outputHeight > 268_000_000)
    throw new Error(`screenshot_too_large: ${outputWidth}x${outputHeight}`);
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('screenshot_canvas_unavailable');

  const xStops = [];
  const yStops = [];
  for (let x = region.x; x < region.x + region.width; x += metrics.viewport.width) xStops.push(x);
  for (let y = region.y; y < region.y + region.height; y += metrics.viewport.height) yStops.push(y);
  try {
    let tileIndex = 0;
    for (const requestedY of yStops) {
      for (const requestedX of xStops) {
        if (Date.now() >= deadline) throw new Error('scrape_screenshot_timeout');
        if (tileIndex === 1 && !selector)
          await page(tabId, { type: 'screenshot_sticky', hide: true });
        const scrollResponse = (await page(tabId, {
          type: 'screenshot_scroll',
          x: Math.min(
            Math.floor(requestedX / metrics.viewport.width) * metrics.viewport.width,
            Math.max(0, metrics.document.width - metrics.viewport.width),
          ),
          y: Math.min(
            Math.floor(requestedY / metrics.viewport.height) * metrics.viewport.height,
            Math.max(0, metrics.document.height - metrics.viewport.height),
          ),
        }))[0];
        if (scrollResponse?.error)
          throw new Error(`page_world_error: ${scrollResponse.error.message ?? String(scrollResponse.error)}`);
        await new Promise((resolve) => setTimeout(resolve, 550));
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
        const actual = scrollResponse.result;
        const viewportScaleX = bitmap.width / metrics.viewport.width;
        const viewportScaleY = bitmap.height / metrics.viewport.height;
        const left = Math.max(region.x, actual.x);
        const top = Math.max(region.y, actual.y);
        const right = Math.min(region.x + region.width, actual.x + metrics.viewport.width);
        const bottom = Math.min(region.y + region.height, actual.y + metrics.viewport.height);
        if (right > left && bottom > top) {
          context.drawImage(
            bitmap,
            (left - actual.x) * viewportScaleX,
            (top - actual.y) * viewportScaleY,
            (right - left) * viewportScaleX,
            (bottom - top) * viewportScaleY,
            (left - region.x) * scale,
            (top - region.y) * scale,
            (right - left) * scale,
            (bottom - top) * scale,
          );
        }
        bitmap.close();
        tileIndex += 1;
      }
    }
  } finally {
    await page(tabId, { type: 'screenshot_sticky', hide: false }).catch(() => {});
    await page(tabId, { type: 'screenshot_scroll', x: metrics.scroll.x, y: metrics.scroll.y }).catch(() => {});
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (returnBytes)
    return { bytes, mimeType: 'image/png', width: outputWidth, height: outputHeight };
  return { data: bytesToBase64(bytes), mimeType: 'image/png', width: outputWidth, height: outputHeight };
}

async function tabObservation(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const window = await chrome.windows.get(tab.windowId);
  return { active: !!tab.active, windowFocused: !!window.focused };
}

async function waitForTab(tabId, condition, timeout) {
  const started = performance.now();
  let observed = await tabObservation(tabId);
  while (performance.now() - started <= timeout) {
    if ((condition === 'tab-active' && observed.active) || (condition === 'window-focused' && observed.windowFocused))
      return { action: 'matched', condition, observed, elapsedMs: Math.round(performance.now() - started) };
    await new Promise((resolve) => setTimeout(resolve, 100));
    observed = await tabObservation(tabId);
  }
  return { action: 'timeout', condition, observed, elapsedMs: Math.round(performance.now() - started) };
}

async function clickAndWait(tabId, message) {
  let completed = false;
  let resolveNavigation;
  const navigation = new Promise((resolve) => (resolveNavigation = resolve));
  const listener = (id, info) => {
    if (id === tabId && info.status === 'complete') {
      completed = true;
      resolveNavigation(true);
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
  try {
    let point = { centerX: message.x, centerY: message.y, submissionExpected: false };
    if (message.locator || message.selector) {
      const injection = (await page(tabId, { ...message, type: 'point' }))[0];
      if (injection?.error)
        throw new Error(`page_world_error: ${injection.error.message ?? String(injection.error)}`);
      if (typeof injection?.result === 'string') return injection.result;
      point = injection?.result;
    }
    await nativeClick(tabId, { x: point.centerX, y: point.centerY }, message);
    const result = {
      button: message.button ?? 'left',
      clickCount: message.double ? 2 : 1,
      x: point.centerX,
      y: point.centerY,
      submissionExpected: point.submissionExpected,
    };
    const shouldWait = message.waitNavigation || ((message.button ?? 'left') === 'left' && result?.submissionExpected);
    if (!shouldWait) return result;
    const navigated = completed || await Promise.race([
      navigation,
      new Promise((resolve) => setTimeout(() => resolve(false), message.timeout ?? 10_000)),
    ]);
    if (!navigated && message.waitNavigation) throw new Error('navigation_timeout');
    return { ...result, navigationWaited: true, navigated, url: (await chrome.tabs.get(tabId)).url };
  } finally {
    chrome.tabs.onUpdated.removeListener(listener);
  }
}

async function navigateTab(tabId, url, timeout) {
  await withTimeout(
    chrome.tabs.update(tabId, { url }),
    timeout,
    'navigation_timeout',
  );
  const deadline = Date.now() + timeout;
  let stableUrl;
  let stableSince = 0;
  while (Date.now() <= deadline) {
    const tab = await withTimeout(chrome.tabs.get(tabId), 2_000, 'tab_status_timeout');
    if (tab.status === 'complete' && tab.url) {
      if (tab.url !== stableUrl) {
        stableUrl = tab.url;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 750) return tab;
    } else {
      stableUrl = undefined;
      stableSince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('navigation_timeout');
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function routeName(url, index) {
  const parsed = new URL(url);
  const slug = parsed.pathname === '/'
    ? 'index'
    : parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 100) || 'index';
  return `${String(index + 1).padStart(3, '0')}-${slug}`;
}

async function captureMhtml(tabId) {
  return withDebugger(tabId, async (send) =>
    withTimeout(
      send('Page.captureSnapshot', { format: 'mhtml' }),
      15_000,
      'scrape_snapshot_timeout',
    ).then((result) => new TextEncoder().encode(result.data)),
  );
}

async function scrapeRoutes(tabId, windowId, message) {
  const original = await chrome.tabs.get(tabId);
  const requested = message.url ?? original.url;
  const root = new URL(requested);
  if (!['http:', 'https:'].includes(root.protocol)) throw new Error('scrape_url_not_http');
  const maxRoutes = message.maxRoutes ?? 20;
  const maxBytes = message.maxBytes ?? 50_000_000;
  const timeout = message.timeout ?? 15_000;
  const deadline = Date.now() + (message.maxDuration ?? 120_000);
  const queue = [root.href];
  const seen = new Set();
  const files = [];
  let totalBytes = 0;
  let rootTitle = null;
  let skippedRoutes = 0;
  try {
    while (queue.length && seen.size < maxRoutes && Date.now() < deadline) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      let tab;
      try {
        tab = await navigateTab(tabId, url, Math.min(timeout, Math.max(1, deadline - Date.now())));
      } catch (error) {
        if (!files.length) throw error;
        skippedRoutes += 1;
        continue;
      }
      if (seen.size === 1) rootTitle = tab.title ?? null;
      const [active] = await chrome.tabs.query({ active: true, windowId });
      if (active?.id !== tabId) throw new Error('paired_control_tab_not_active');
      let mhtml;
      let screenshot;
      try {
        mhtml = await captureMhtml(tabId);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const fullPage = await stitchedScreenshot(tabId, windowId, undefined, true, deadline);
        screenshot = fullPage.bytes;
      } catch (error) {
        if (!files.length) throw error;
        skippedRoutes += 1;
        continue;
      }
      const nextBytes = mhtml.length + screenshot.length;
      if (totalBytes + nextBytes > maxBytes) {
        if (!files.length) throw new Error('scrape_too_large');
        break;
      }
      const name = routeName(url, seen.size - 1);
      files.push({ name: `routes/${name}.mhtml`, data: mhtml });
      files.push({ name: `screenshots/${name}.png`, data: screenshot });
      totalBytes += nextBytes;
      const links = (await withTimeout(
        page(tabId, { type: 'scrape_links' }),
        5_000,
        'scrape_links_timeout',
      ))[0]?.result ?? [];
      for (const link of links) {
        const candidate = new URL(link);
        if (candidate.origin === root.origin && !seen.has(candidate.href) && !queue.includes(candidate.href))
          queue.push(candidate.href);
      }
    }
    const metadata = {
      url: root.href,
      title: rootTitle,
      capturedAt: new Date().toISOString(),
      capturedBytes: totalBytes,
      routes: files.length / 2,
      skippedRoutes,
      deadlineReached: Date.now() >= deadline,
    };
    const archive = createScrapeArchive(files, {
      ...metadata,
      format: 'Rendered MHTML snapshots with full-page screenshots',
    });
    return {
      ...metadata,
      archive,
      mimeType: 'application/zip',
      bytes: archive.length,
    };
  } finally {
    await navigateTab(tabId, root.href, timeout).catch(() => {});
  }
}

// Records the paired tab (or a scrollable container inside it) scrolling from
// top to bottom. Smoothness comes from small scroll steps captured as discrete
// frames, played back at a fixed frame rate. Priorities are smoothness and
// capture reliability, not speed: every frame scrolls, settles, and is captured
// before the next step starts.
async function recordScroll(tabId, message) {
  let controlTab = await chrome.tabs.get(tabId);
  let [active] = await chrome.tabs.query({ active: true, windowId: controlTab.windowId });
  if (active?.id !== tabId && message.dedicatedWindow) {
    // Match the original window's geometry: a different viewport size renders
    // a different responsive theme, which would look wrong in the recording.
    const originalWindow = await chrome.windows.get(controlTab.windowId);
    const isolated = await chrome.windows.create({
      tabId,
      focused: false,
      width: originalWindow.width,
      height: originalWindow.height,
      top: originalWindow.top,
      left: originalWindow.left,
    });
    if (!isolated?.id) throw new Error('dedicated_window_failed');
    controlTab = await chrome.tabs.get(tabId);
    [active] = await chrome.tabs.query({ active: true, windowId: controlTab.windowId });
  }
  if (message.waitForActive) {
    const activeWait = await waitForTab(tabId, 'tab-active', message.waitForActive);
    if (activeWait.action !== 'matched') throw new Error('paired_control_tab_not_active');
    [active] = await chrome.tabs.query({ active: true, windowId: controlTab.windowId });
  }
  if (active?.id !== tabId)
    throw new Error('paired_control_tab_not_active: refusing to record a different active tab');

  const selector = typeof message.selector === 'string' && message.selector ? message.selector : undefined;
  const measureResponse = (await page(tabId, { type: 'scrollgif_measure', selector }))[0];
  if (measureResponse?.error)
    throw new Error(`page_world_error: ${measureResponse.error.message ?? String(measureResponse.error)}`);
  if (measureResponse?.result === 'element_not_found') throw new Error('element_not_found');
  if (measureResponse?.result === 'element_not_scrollable') throw new Error('element_not_scrollable');
  const metrics = measureResponse?.result;
  if (!metrics?.mode) throw new Error('scrollgif_measure_unavailable');

  const video = message.format === 'video';
  const fps = message.fps ?? 25;
  const maxFrames = message.maxFrames ?? 2500;
  const settleMs = Math.max(0, Math.round(message.settleMs ?? 100));
  const holdMs = Math.max(0, Math.round(message.holdMs ?? 800));
  const holdDelay = Math.max(1, Math.round(holdMs / 10));
  const original = { x: metrics.scroll.x, y: metrics.scroll.y };
  const scrollTo = (y) =>
    page(tabId, { type: 'scrollgif_scroll', selector, x: original.x, y, settleMs });

  const scroll = async (y) => {
    const response = (await scrollTo(y))[0];
    if (response?.error)
      throw new Error(`page_world_error: ${response.error.message ?? String(response.error)}`);
    return response?.result;
  };

  // Lazy-loaded content grows the page while scrolling, so the bottom must be
  // discovered by scrolling it once before frame positions are computed.
  let total = metrics.maxScrollY;
  {
    const probeStep = Math.max(1, Math.round(metrics.viewportHeight * 0.9));
    const measure = async () => {
      const response = (await page(tabId, { type: 'scrollgif_measure', selector }))[0];
      if (response?.error)
        throw new Error(`page_world_error: ${response.error.message ?? String(response.error)}`);
      return response?.result;
    };
    const started = Date.now();
    let y = 0;
    for (let guard = 0; guard < 5000 && Date.now() - started < 30_000; guard += 1) {
      const response = await scroll(y);
      const actual = response?.y ?? 0;
      const max = response?.maxScrollY ?? 0;
      if (actual >= max) {
        const fresh = await measure();
        if (!fresh || actual >= fresh.maxScrollY) {
          total = fresh?.maxScrollY ?? max;
          break;
        }
      }
      y = Math.min(max, actual + probeStep);
      total = Math.max(total, max);
    }
  }

  const stepPx = message.step ?? Math.max(8, Math.round(metrics.viewportHeight / 48));
  let positions;
  if (total <= 0) {
    positions = [0];
  } else {
    const frameCount =
      message.duration != null
        ? Math.max(1, Math.round((message.duration * fps) / 1000))
        : Math.max(1, Math.ceil(total / stepPx));
    positions = easedScrollPositions(total, frameCount);
  }
  if (positions[positions.length - 1] !== total) positions.push(total);
  if (positions.length > maxFrames)
    throw new Error(
      `scrollgif_too_many_frames: ${positions.length} frames required; raise --step, lower --duration-ms, or raise --max-frames`,
    );

  // captureVisibleTab is quota-limited to ~2 captures per second by Chromium,
  // which would cap the animation at 2 fps. The debugger's Page.captureScreenshot
  // has no such quota and captures the same visible surface.
  let encoder;
  let context;
  let videoFrames;
  let frames = 0;
  let reached = total;
  const holdCount = Math.max(1, Math.round((holdMs * fps) / 1000));
  await withDebugger(tabId, async (send) => {
    const capture = async () => {
      // With device emulation, crop the window surface to the emulated viewport.
      const params = { format: 'png' };
      if (state.device)
        params.clip = { x: 0, y: 0, width: state.device.width, height: state.device.height, scale: 1 };
      const shot = await send('Page.captureScreenshot', params);
      return createImageBitmap(await (await fetch(`data:image/png;base64,${shot.data}`)).blob());
    };
    const emit = async (bitmap, hold) => {
      if (!context) {
        // Output dimensions are fixed once from the first capture so that a
        // later size change (e.g. a scrollbar appearing) only rescales the
        // frame instead of mismatching the encoder.
        const maxWidth = message.maxWidth ?? 1200;
        const width = !maxWidth || bitmap.width <= maxWidth ? bitmap.width : maxWidth;
        const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
        const canvas = new OffscreenCanvas(width, height);
        context = canvas.getContext('2d', { willReadFrequently: true });
        if (video) videoFrames = [];
        else encoder = new GifEncoder({ width, height, fps, loop: message.loop ?? 0, dither: !!message.dither });
      }
      context.drawImage(bitmap, 0, 0, context.canvas.width, context.canvas.height);
      bitmap.close();
      if (video) {
        const blob = await context.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const copies = hold ? holdCount : 1;
        for (let copy = 0; copy < copies; copy += 1) videoFrames.push(bytes);
        frames += copies;
      } else {
        encoder.addFrame(context.getImageData(0, 0, encoder.width, encoder.height).data, hold ? holdDelay : undefined);
        frames += 1;
      }
    };
    const captureAt = async (y, hold) => {
      const response = await scroll(y);
      // Held frames (the top and bottom pauses) get extra settle time so
      // scroll-triggered reveals and lazy images finish before they are
      // captured; the pause magnifies any half-faded content.
      const wait = hold ? settleMs * 4 : settleMs;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      await emit(await capture(), hold);
      return response;
    };
    try {
      let lastResponse = await captureAt(positions[0], true);
      for (let index = 1; index < positions.length; index += 1)
        lastResponse = await captureAt(positions[index], false);
      // Content that loaded during capture can grow the page; keep recording
      // uniform steps until the scroll truly reaches the bottom.
      for (;;) {
        const actual = lastResponse?.y ?? 0;
        const max = lastResponse?.maxScrollY ?? 0;
        if (actual < max) {
          lastResponse = await captureAt(Math.min(max, actual + stepPx), false);
          continue;
        }
        const fresh = (await page(tabId, { type: 'scrollgif_measure', selector }))[0]?.result;
        if (!fresh || actual >= fresh.maxScrollY) break;
        lastResponse = { ...lastResponse, maxScrollY: fresh.maxScrollY };
      }
      // The true bottom always gets the pause; eased-final and tail frames
      // play at base speed, so a growing page never freezes mid-video.
      lastResponse = await captureAt(lastResponse?.y ?? 0, true);
      reached = lastResponse?.y ?? reached;
    } finally {
      await scroll(original.y).catch(() => {});
    }
  });
  if (video) {
    let bytes = 0;
    for (const frame of videoFrames) bytes += 4 + frame.length;
    const archive = new Uint8Array(bytes);
    const view = new DataView(archive.buffer);
    let offset = 0;
    for (const frame of videoFrames) {
      view.setUint32(offset, frame.length, true);
      offset += 4;
      archive.set(frame, offset);
      offset += frame.length;
    }
    return {
      archive,
      mimeType: 'video/jpeg-sequence',
      format: 'video',
      width: context.canvas.width,
      height: context.canvas.height,
      fps,
      frames,
      pixelsScrolled: reached,
      durationMs: Math.round((frames * 1000) / fps),
      bytes: archive.length,
    };
  }
  const archive = encoder.finish();
  const holdExtra = positions.length >= 2 ? 2 * Math.max(0, holdDelay - encoder.delay) : 0;
  return {
    archive,
    mimeType: 'image/gif',
    format: 'gif',
    width: encoder.width,
    height: encoder.height,
    fps,
    frames,
    pixelsScrolled: reached,
    durationMs: frames * encoder.delay * 10 + holdExtra * 10,
    bytes: archive.length,
  };
}

async function execute(message) {
  if (!state.tabId)
    return {
      reply: message.id,
      ok: false,
      error: {
        code: 'adapter_error',
        message:
          'the explicitly paired control tab is unavailable; run browserctl extension pair to select a new control tab',
      },
    };
  try {
    await chrome.tabs.get(state.tabId);
    let result;
    if (message.type === 'wait' && (message.tabActive || message.windowFocused)) {
      result = await waitForTab(
        state.tabId,
        message.tabActive ? 'tab-active' : 'window-focused',
        message.timeout ?? 10_000,
      );
    } else if (message.type === 'scrape') {
      let controlTab = await chrome.tabs.get(state.tabId);
      let [active] = await chrome.tabs.query({ active: true, windowId: controlTab.windowId });
      if (active?.id !== state.tabId && message.dedicatedWindow) {
        const isolated = await chrome.windows.create({ tabId: state.tabId, focused: false });
        if (!isolated?.id) throw new Error('dedicated_window_failed');
        controlTab = await chrome.tabs.get(state.tabId);
        [active] = await chrome.tabs.query({ active: true, windowId: controlTab.windowId });
      }
      if (active?.id !== state.tabId) throw new Error('paired_control_tab_not_active');
      result = await scrapeRoutes(state.tabId, controlTab.windowId, message);
    } else if (message.type === 'scrollgif') {
      result = await recordScroll(state.tabId, message);
    } else if (message.type === 'device') {
      if (message.clear) {
        if (state.debuggerTabId != null)
          await chrome.debugger.detach({ tabId: state.debuggerTabId }).catch(() => {});
        resetDeviceEmulation();
        result = { action: 'device-cleared' };
      } else {
        if (!Number.isInteger(message.width) || !Number.isInteger(message.height))
          throw new Error('device_size_required');
        // Reuse the session attachment when present; Chrome keeps the
        // emulation only while the debugger stays attached.
        await ensureDebuggerAttached(state.tabId);
        const viewport = message.width && message.height ? undefined : (await page(state.tabId, { type: 'scrollgif_viewport' }))[0]?.result;
        await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Emulation.setDeviceMetricsOverride', {
          width: message.width ?? viewport?.width ?? 0,
          height: message.height ?? viewport?.height ?? 0,
          deviceScaleFactor: 0,
          mobile: !!message.mobile,
        });
        state.device = { width: message.width ?? viewport?.width, height: message.height ?? viewport?.height, mobile: !!message.mobile };
        result = { action: 'device-set', ...state.device };
      }
    } else if (message.type === 'click') {
      result = await clickAndWait(state.tabId, message);
    } else if (message.type === 'press') {
      if (message.locator || message.selector) {
        const injection = (await page(state.tabId, { ...message, type: 'focus' }))[0];
        if (injection?.error)
          throw new Error(`page_world_error: ${injection.error.message ?? String(injection.error)}`);
        if (injection?.result === 'element_not_found') throw new Error('element_not_found');
      }
      await nativePress(state.tabId, message.key);
      result = 'ok';
    } else if (message.type === 'type') {
      const injection = (await page(state.tabId, { ...message, type: 'focus' }))[0];
      if (injection?.error)
        throw new Error(`page_world_error: ${injection.error.message ?? String(injection.error)}`);
      if (typeof injection?.result === 'string' && injection.result !== 'ok') throw new Error(injection.result);
      await nativeType(state.tabId, message.text, message);
      result = (await page(state.tabId, { type: 'active_value' }))[0]?.result;
    } else if (message.type === 'drag') {
      const sourceResponse = (await page(state.tabId, {
        type: 'point', locator: message.from, nth: message.fromNth,
      }))[0];
      if (sourceResponse?.error) throw new Error(`page_world_error: ${sourceResponse.error.message}`);
      if (typeof sourceResponse?.result === 'string') throw new Error(sourceResponse.result);
      const source = sourceResponse.result;
      let target = { centerX: message.toX, centerY: message.toY, inViewport: true };
      if (message.to) {
        const targetResponse = (await page(state.tabId, {
          type: 'point', locator: message.to, nth: message.toNth, scroll: false,
        }))[0];
        if (targetResponse?.error) throw new Error(`page_world_error: ${targetResponse.error.message}`);
        if (typeof targetResponse?.result === 'string') throw new Error(targetResponse.result);
        target = targetResponse.result;
        if (!target.inViewport) throw new Error('drag_target_not_in_viewport');
      }
      await nativeDrag(
        state.tabId,
        { x: source.centerX, y: source.centerY },
        { x: target.centerX, y: target.centerY },
      );
      result = { from: { x: source.centerX, y: source.centerY }, to: { x: target.centerX, y: target.centerY } };
    } else if (message.type === 'activate') {
      const tab = await chrome.tabs.update(state.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      result = { action: 'activated', tabId: state.tabId, windowId: tab.windowId };
    } else if (
      message.type === 'evaluate' ||
      message.type === 'dom' ||
      message.type === 'fill' ||
      message.type === 'select' ||
      message.type === 'scroll' ||
      message.type === 'bounds' ||
      message.type === 'highlight' ||
      message.type === 'wait'
    ) {
      const injection = (await page(state.tabId, message))[0];
      if (injection?.error)
        throw new Error(`page_world_error: ${injection.error.message ?? String(injection.error)}`);
      result = injection?.result;
      if (result === undefined && message.type === 'wait') throw new Error('wait_timeout');
      if (result === undefined)
        throw new Error(`page_world_error: ${message.type} returned no result`);
    } else if (message.type === 'navigate') {
      const tab = await chrome.tabs.update(state.tabId, { url: message.url });
      if (tab?.id != null && tab.status !== 'complete')
        await new Promise((resolve, reject) => {
          let settled = false;
          const listener = (id, info) => {
            if (id === tab.id && info.status === 'complete') {
              settled = true;
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(() => {
            if (settled) return;
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error('navigation_timeout'));
          }, message.timeout ?? 10_000);
        });
      const current = await chrome.tabs.get(state.tabId);
      result = { url: current.url ?? message.url, title: current.title ?? null };
    } else if (message.type === 'screenshot') {
      const controlTab = await chrome.tabs.get(state.tabId);
      if (message.waitForActive) {
        const activeWait = await waitForTab(state.tabId, 'tab-active', message.waitForActive);
        if (activeWait.action !== 'matched') throw new Error('paired_control_tab_not_active');
      }
      const [activeTab] = await chrome.tabs.query({ active: true, windowId: controlTab.windowId });
      if (activeTab?.id !== state.tabId)
        throw new Error(
          'paired_control_tab_not_active: refusing to capture a different active tab',
        );
      if (message.fullPage || message.selector) {
        result = await stitchedScreenshot(state.tabId, controlTab.windowId, message.selector);
      } else if (state.device) {
        // With device emulation the visible surface is larger than the
        // emulated viewport; capture exactly the emulated viewport instead.
        result = await withDebugger(state.tabId, async (send) => {
          const shot = await send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: 0, y: 0, width: state.device.width, height: state.device.height, scale: 1 },
            captureBeyondViewport: false,
          });
          const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${shot.data}`)).blob());
          const sized = { data: shot.data, mimeType: 'image/png', width: bitmap.width, height: bitmap.height };
          bitmap.close();
          return sized;
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const data = await chrome.tabs.captureVisibleTab(controlTab.windowId, { format: 'png' });
        const bitmap = await createImageBitmap(await (await fetch(data)).blob());
        result = { data: data.split(',')[1] ?? '', mimeType: 'image/png', width: bitmap.width, height: bitmap.height };
        bitmap.close();
      }
    } else if (message.type === 'close') {
      state.session = null;
      if (state.debuggerTabId != null)
        await chrome.debugger.detach({ tabId: state.debuggerTabId }).catch(() => {});
      resetDeviceEmulation();
    }
    if (result === 'element_not_found') throw new Error('element_not_found');
    if (result === 'element_not_fillable') throw new Error('element_not_fillable');
    if (result === 'element_not_selectable') throw new Error('element_not_selectable');
    if (result === 'element_not_multi_select') throw new Error('element_not_multi_select');
    if (result === 'option_not_found') throw new Error('option_not_found');
    if (typeof result === 'string' && result.startsWith('ambiguous_locator:')) throw new Error(result);
    if (typeof result === 'string' && (result.startsWith('ambiguous_scope:') || result === 'scope_not_found')) throw new Error(result);
    return { reply: message.id, ok: true, result };
  } catch (error) {
    const description = String(error?.message ?? error);
    return {
      reply: message.id,
      ok: false,
      error: {
        code: description.includes('element_not_found')
          ? 'element_not_found'
          : description.includes('ambiguous_locator')
            ? 'ambiguous_locator'
            : description.includes('ambiguous_scope')
              ? 'ambiguous_scope'
              : description.includes('scope_not_found')
                ? 'scope_not_found'
            : description.includes('option_not_found')
              ? 'option_not_found'
              : description.includes('element_not_selectable')
                ? 'element_not_selectable'
                : description.includes('element_not_multi_select')
                  ? 'element_not_multi_select'
                  : description.includes('element_not_scrollable')
                    ? 'element_not_scrollable'
                    : description.includes('scrollgif_too_many_frames')
                      ? 'scrollgif_too_many_frames'
                      : description.includes('paired_control_tab_not_active')
                        ? 'paired_tab_inactive'
            : description.includes('wait_timeout') || description.includes('navigation_timeout')
            ? 'timeout'
            : 'adapter_error',
        message: description,
      },
    };
  }
}

async function handle(message, socket) {
  if (message.kind === 'status') {
    const tabs = await chrome.tabs.query({});
    const controlTab = selectControlTab(tabs, state.controlTabId);
    let active = false;
    if (controlTab) {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        windowId: controlTab.windowId,
      });
      active = activeTab?.id === controlTab.id;
    }
    if (socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          reply: message.id,
          ok: true,
          result: {
            extensionVersion: chrome.runtime.getManifest().version,
            scrapeMode: 'full-page-settled',
            actionSurface: 'locator-actions-v1.2',
            paired: Number.isInteger(state.controlTabId),
            tabAvailable: !!controlTab,
            tabId: controlTab?.id ?? null,
            url: controlTab?.url ?? null,
            title: controlTab?.title ?? null,
            active,
          },
        }),
      );
    return;
  }
  if (message.kind === 'bind') {
    if (state.session !== message.session) state.commands.clear();
    const tabs = await chrome.tabs.query({});
    const controlTab = selectControlTab(tabs, state.controlTabId);
    if (!controlTab) {
      state.session = null;
      state.tabId = null;
      chrome.storage.session.remove(['tabId']).catch(() => {});
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            reply: message.id,
            ok: false,
            error: {
              code: 'control_tab_unavailable',
              message:
                'the explicitly paired control tab is unavailable; run browserctl extension pair to select a new control tab',
            },
          }),
        );
      return;
    }
    state.session = message.session;
    state.tabId = controlTab.id;
    chrome.storage.session.set({ tabId: state.tabId }).catch(() => {});
    if (socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          reply: message.id,
          ok: true,
          result: { tabId: controlTab.id, url: controlTab.url ?? null },
        }),
      );
    return;
  }
  if (message.kind !== 'command') return;
  const key = `${message.session}:${message.id}`;
  const response = await state.commands.run(key, () => execute(message));
  if (socket.readyState !== WebSocket.OPEN) return;
  if (response.ok && response.result?.archive instanceof Uint8Array) {
    const { archive, ...result } = response.result;
    let index = 0;
    for (const chunk of artifactChunks(archive)) {
      socket.send(JSON.stringify({
        reply: message.id,
        event: 'artifact_chunk',
        index,
        data: bytesToBase64(chunk),
      }));
      index += 1;
      const started = Date.now();
      while (socket.bufferedAmount > 2 * 1024 * 1024) {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - started > 30_000) throw new Error('artifact_transport_timeout');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    socket.send(JSON.stringify({ ...response, result: { ...result, chunks: index } }));
    return;
  }
  socket.send(JSON.stringify(response));
}

let backoffMs = 2000;
let reconnectPending = false;
function scheduleReconnect() {
  if (reconnectPending) return;
  reconnectPending = true;
  setTimeout(() => {
    reconnectPending = false;
    chrome.storage.local
      .get(['endpoint', 'pairingCode', 'adapterId', 'adapterToken', 'controlTabId'])
      .then(connect);
  }, backoffMs);
  // Keep automatic CLI recovery inside the supervisor's 10-second adapter wait.
  backoffMs = Math.min(backoffMs * 2, 5_000);
}

async function connect(values) {
  if (state.socket || state.connecting) return;
  if (
    (!values.endpoint || !values.pairingCode || !values.adapterId) &&
    !(values.endpoint && values.adapterId && values.adapterToken)
  )
    return;
  state.connecting = true;
  state.controlTabId = Number.isInteger(values.controlTabId) ? values.controlTabId : null;
  // Probe over HTTP first: a refused connection here is silent, unlike a
  // refused WebSocket which Chrome logs as a scary extension error.
  try {
    await fetch(values.endpoint.replace(/^ws/, 'http'), { mode: 'no-cors' });
  } catch {
    state.connecting = false;
    scheduleReconnect();
    return;
  }
  const socket = new WebSocket(values.endpoint);
  socket.onopen = () => {
    backoffMs = 2000;
    // MV3 kills an idle worker even with an open WebSocket; the ping keeps
    // both the worker and the connection alive.
    state.ping = setInterval(
      () => socket.readyState === 1 && socket.send(JSON.stringify({ kind: 'ping', id: 'ping' })),
      20000,
    );
    socket.send(
      JSON.stringify({
        version: 1,
        id: 'extension-hello',
        kind: 'hello',
        role: 'extension',
        token: values.pairingCode,
        adapterId: values.adapterId,
        adapterToken: values.adapterToken,
      }),
    );
  };
  socket.onmessage = (event) => {
    try {
      const m = JSON.parse(event.data);
      if (m.ok && m.result?.adapterToken) {
        chrome.storage.local.set({ adapterToken: m.result.adapterToken }).catch(() => {});
        chrome.storage.local.remove(['pairingCode']).catch(() => {});
        if (state.pairingTabId != null)
          chrome.scripting
            .executeScript({
              target: { tabId: state.pairingTabId },
              func: () => {
                document.body.innerHTML =
                  '<h1>Browser Controller</h1><p>Paired! This tab is the browser-control tab: browserctl will drive it (e.g. navigate it to a URL). Leave it open — closing it ends the session.</p>';
              },
            })
            .catch(() => {});
      }
      void handle(m, socket);
    } catch {}
  };
  socket.onerror = () => socket.close();
  socket.onclose = () => {
    clearInterval(state.ping);
    state.ping = null;
    if (state.socket === socket) {
      state.socket = null;
    }
    scheduleReconnect();
  };
  state.socket = socket;
  state.connecting = false;
  state.adapterId = values.adapterId;
}

function resetNativeState() {
  state.controlTabId = null;
  state.pairingTabId = null;
  state.tabId = null;
  resetDeviceEmulation();
  chrome.storage.local.remove(['controlTabId']).catch(() => {});
  chrome.storage.session.remove(['tabId']).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== state.controlTabId) return;
  resetNativeState();
  resetDeviceEmulation();
});

// The debugger attachment (and with it the device emulation) is lost when the
// user closes the infobar or opens DevTools on the tab.
chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId === state.debuggerTabId) resetDeviceEmulation();
});

chrome.runtime.onStartup.addListener(() => {
  // Chromium can reuse tab IDs after a browser restart. Require a fresh explicit
  // pairing instead of risking control of an unrelated tab with a recycled ID.
  resetNativeState();
});

chrome.storage.local
  .get(['endpoint', 'pairingCode', 'adapterId', 'adapterToken', 'controlTabId'])
  .then(connect);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.controlTabId) {
    const id = changes.controlTabId.newValue;
    state.controlTabId = Number.isInteger(id) ? id : null;
    if (state.tabId !== state.controlTabId) state.tabId = null;
  }
  if (
    area === 'local' &&
    ['endpoint', 'adapterId'].some((k) => changes[k] && changes[k].oldValue !== changes[k].newValue)
  ) {
    // adapterToken/pairingCode updates don't affect the live connection —
    // forcing a reconnect here would drop the just-authenticated socket.
    state.socket?.close();
  }
});
