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
      const locate = () => {
        if (!locator) return undefined;
        if (locator.by === 'css') return document.querySelector(locator.value);
        if (locator.by === 'label') {
          const label = [...document.querySelectorAll('label')].find((candidate) =>
            matches(candidate.textContent, locator.value, locator.exact),
          );
          if (label)
            return label.control ?? label.querySelector('input,textarea,select,[contenteditable=true]');
          return (
            [...document.querySelectorAll('input,textarea,select,[contenteditable=true]')].find(
              (candidate) =>
                (candidate.hasAttribute('aria-label') ||
                  candidate.hasAttribute('aria-labelledby')) &&
                matches(accessibleName(candidate), locator.value, locator.exact),
            ) ?? null
          );
        }
        const candidates = [...document.querySelectorAll('body *')];
        if (locator.by === 'role')
          return (
            candidates.find(
              (candidate) =>
                (explicitRole(candidate) ?? implicitRole(candidate)) === locator.value.toLowerCase() &&
                (!locator.name || matches(accessibleName(candidate), locator.name, locator.exact)),
            ) ?? null
          );
        const matching = candidates.filter((candidate) =>
          matches(candidate.textContent, locator.value, locator.exact),
        );
        return (
          matching.find(
            (candidate) =>
              ![...candidate.children].some((child) =>
                matches(child.textContent, locator.value, locator.exact),
              ),
          ) ??
          matching[0] ??
          null
        );
      };
      const locateAll = () => {
        if (!locator) return [];
        if (locator.by === 'css') return [...document.querySelectorAll(locator.value)];
        if (locator.by === 'role')
          return [...document.querySelectorAll('body *')].filter(
            (candidate) =>
              (explicitRole(candidate) ?? implicitRole(candidate)) === locator.value.toLowerCase() &&
              (!locator.name || matches(accessibleName(candidate), locator.name, locator.exact)),
          );
        if (locator.by === 'text')
          return [...document.querySelectorAll('body *')].filter(
            (candidate) =>
              matches(candidate.textContent, locator.value, locator.exact) &&
              ![...candidate.children].some((child) =>
                matches(child.textContent, locator.value, locator.exact),
              ),
          );
        const one = locate();
        return one ? [one] : [];
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
                    ? !visible(element)
                    : visible(element);
          if (matched)
            return {
              action: 'matched',
              condition: m.url
                ? 'url'
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
              elapsedMs: Math.round(performance.now() - started),
              url: location.href,
            };
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('wait_timeout');
      }

      const element = locate();
      if (locator && !element) return 'element_not_found';
      if (m.type === 'dom') {
        const root = locator ? element : document.documentElement;
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
          const html = root.outerHTML;
          return {
            format,
            html: html.slice(0, maxChars),
            truncated: html.length > maxChars,
            totalChars: html.length,
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
          let budget = maxChars;
          let truncated = false;
          const VOID_TAGS = new Set(['input', 'img', 'br', 'hr']);
          const serialize = (node, depth = 0) => {
            if (budget <= 0) {
              truncated = true;
              return '';
            }
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
              if (!keepAttr(attr.name)) continue;
              attrs += ` ${attr.name}="${attr.value.replace(/"/g, '&quot;').slice(0, 80)}"`;
            }
            const open = `<${tag}${attrs}${VOID_TAGS.has(tag) ? ' /' : ''}>`;
            if (budget - open.length < 0) {
              truncated = true;
              return '';
            }
            budget -= open.length;
            if (VOID_TAGS.has(tag)) return open;
            if (depth >= maxDepth) {
              truncated = true;
              return `${open}<!-- depth limit --></${tag}>`;
            }
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
          const html = serialize(root);
          return { format, html, truncated, totalChars: html.length, url };
        }
        if (format === 'interactive') {
          const seen = new Set();
          const interactiveSelector =
            'a[href], button, input, select, textarea, summary, [role], [contenteditable="true"], [onclick]';
          const candidates = [
            ...(root.matches?.(interactiveSelector) ? [root] : []),
            ...root.querySelectorAll(interactiveSelector),
          ];
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
            if (!actionableByTag && !el.isContentEditable && !el.hasAttribute('onclick') && !actionableRole) continue;
            actionable += 1;
            if (items.length >= 500) continue;
            const item = {
              role: role ?? 'generic',
              name: clip(accessibleName(el)).slice(0, 100),
              tag,
            };
            if (el.id) item.css = `#${CSS.escape(el.id)}`;
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
          return {
            format,
            url,
            items,
            truncated: actionable > items.length,
            totalItems: actionable,
          };
        }
        // format === 'json'
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
        return { format, url, node: jsonNode(root) };
      }
      if (m.type === 'click') {
        element.click();
        return 'ok';
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
    if (message.type === 'press') {
      const injection = (await page(state.tabId, { ...message, type: 'focus' }))[0];
      if (injection?.error)
        throw new Error(`page_world_error: ${injection.error.message ?? String(injection.error)}`);
      if (injection?.result === 'element_not_found') throw new Error('element_not_found');
      await nativePress(state.tabId, message.key);
      result = 'ok';
    } else if (
      message.type === 'evaluate' ||
      message.type === 'dom' ||
      message.type === 'click' ||
      message.type === 'fill' ||
      message.type === 'type' ||
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
      const [activeTab] = await chrome.tabs.query({ active: true, windowId: controlTab.windowId });
      if (activeTab?.id !== state.tabId)
        throw new Error(
          'paired_control_tab_not_active: refusing to capture a different active tab',
        );
      await new Promise((resolve) => setTimeout(resolve, 400));
      const data = await chrome.tabs.captureVisibleTab(controlTab.windowId, { format: 'png' });
      result = { data: data.split(',')[1] ?? '', mimeType: 'image/png', width: 0, height: 0 };
    } else if (message.type === 'close') {
      state.session = null;
    }
    if (result === 'element_not_found') throw new Error('element_not_found');
    if (result === 'element_not_fillable') throw new Error('element_not_fillable');
    return { reply: message.id, ok: true, result };
  } catch (error) {
    const description = String(error?.message ?? error);
    return {
      reply: message.id,
      ok: false,
      error: {
        code: description.includes('element_not_found')
          ? 'element_not_found'
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
