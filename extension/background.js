import { CommandCache } from './command-cache.js';
import { selectControlTab } from './control-tab.js';

const state = {
  socket: null,
  connecting: false,
  session: null,
  adapterId: null,
  tabId: null,
  controlTabId: null,
  pairingTabId: null,
  commands: new CommandCache(),
};
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
      if (['click', 'focus', 'fill', 'type', 'select'].includes(m.type) && m.within && scopeMatches === 0)
        return 'scope_not_found';
      if (['click', 'focus', 'fill', 'type', 'select'].includes(m.type) && m.within && scopeMatches > 1)
        return `ambiguous_scope:${scopeMatches}`;
      if (['click', 'focus', 'fill', 'type', 'select'].includes(m.type) && m.nth === undefined && rawLocateAll().length > 1)
        return `ambiguous_locator:${rawLocateAll().length}`;
      if (locator && !element) return 'element_not_found';
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
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  await chrome.debugger.attach(target, '1.3');
  try {
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
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function stitchedScreenshot(tabId, windowId, selector) {
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
    throw new Error('screenshot_too_large');
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
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { data: btoa(binary), mimeType: 'image/png', width: outputWidth, height: outputHeight };
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
    const injection = (await page(tabId, message))[0];
    if (injection?.error)
      throw new Error(`page_world_error: ${injection.error.message ?? String(injection.error)}`);
    const result = injection?.result;
    if (typeof result === 'string') return result;
    const shouldWait = message.waitNavigation || result?.submissionExpected;
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
    } else if (message.type === 'click') {
      result = await clickAndWait(state.tabId, message);
    } else if (message.type === 'press') {
      const injection = (await page(state.tabId, { ...message, type: 'focus' }))[0];
      if (injection?.error)
        throw new Error(`page_world_error: ${injection.error.message ?? String(injection.error)}`);
      if (injection?.result === 'element_not_found') throw new Error('element_not_found');
      await nativePress(state.tabId, message.key);
      result = 'ok';
    } else if (
      message.type === 'evaluate' ||
      message.type === 'dom' ||
      message.type === 'fill' ||
      message.type === 'type' ||
      message.type === 'select' ||
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
      } else {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const data = await chrome.tabs.captureVisibleTab(controlTab.windowId, { format: 'png' });
        const bitmap = await createImageBitmap(await (await fetch(data)).blob());
        result = { data: data.split(',')[1] ?? '', mimeType: 'image/png', width: bitmap.width, height: bitmap.height };
        bitmap.close();
      }
    } else if (message.type === 'close') {
      state.session = null;
    }
    if (result === 'element_not_found') throw new Error('element_not_found');
    if (result === 'element_not_fillable') throw new Error('element_not_fillable');
    if (result === 'element_not_selectable') throw new Error('element_not_selectable');
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
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== state.controlTabId) return;
  state.controlTabId = null;
  state.pairingTabId = null;
  state.tabId = null;
  chrome.storage.local.remove(['controlTabId']).catch(() => {});
  chrome.storage.session.remove(['tabId']).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  // Chromium can reuse tab IDs after a browser restart. Require a fresh explicit
  // pairing instead of risking control of an unrelated tab with a recycled ID.
  state.controlTabId = null;
  state.pairingTabId = null;
  state.tabId = null;
  chrome.storage.local.remove(['controlTabId']).catch(() => {});
  chrome.storage.session.remove(['tabId']).catch(() => {});
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
