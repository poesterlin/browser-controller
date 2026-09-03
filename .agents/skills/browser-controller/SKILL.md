---
name: browser-controller
description: Control the user's existing Chromium tab with browserctl when a task requires live navigation, DOM inspection, form interaction, page-world JavaScript, waits, or screenshots. Use for browser UI workflows, including when the user explicitly asks to perform an action through a site's interface.
---

# Browser Controller

Use `~/.local/bin/browserctl` to control one user-owned Chromium tab through the paired extension. Source lives at the repository root.

## Connect

Pair only for first use, credential recovery, or when the user explicitly requests pairing:

```sh
browserctl extension pair
```

Pairing starts the supervisor when necessary and opens a one-time loopback page. That page becomes the only browser-control tab. Adapter credentials are stored separately from the controller token and survive supervisor restarts.

Check the complete connection state with:

```sh
browserctl status --json
```

Ordinary browser commands safely create or reconnect the current session. Use `--session ID` only to select a specific session.

## Operate

```sh
browserctl navigate URL [--timeout MS] --json
browserctl dom [LOCATOR] [--format interactive|summary|clean_html|json] [--offset N] [--limit N] [--item-limit N] [--nth N] [--max-chars N] [--text-chars N] [--depth N] --json
browserctl click LOCATOR [--wait-navigation] [--timeout MS] --json
browserctl fill LOCATOR --value VALUE --json
browserctl select LOCATOR (--value VALUE | --option-text TEXT) --json
browserctl press LOCATOR --key 'ctrl+Enter' --json
browserctl wait LOCATOR [--state visible|attached|hidden] [--count N | --value VALUE | --changes] [--timeout MS] --json
browserctl wait --url URL [--timeout MS] --json
browserctl wait --url-glob GLOB [--timeout MS] --json
browserctl wait --title TEXT [--timeout MS] --json
browserctl wait --evaluate EXPR [--timeout MS] --json
browserctl wait --tab-active [--timeout MS] --json
browserctl evaluate --expression EXPR --json
browserctl screenshot [--full-page | --selector CSS] [--wait-for-active MS] --output FILE.png --json
browserctl close --json
```

`fill` replaces the complete value and dispatches `input` and `change`. `--value` supplies the replacement; `--text` always remains a locator. The result includes `verified: true|false` — the field value read back after the fill. Treat `verified: false` as a failed fill and investigate before submitting. The legacy `type` command is a fill-compatible alias; use `fill` in new workflows.

Element commands accept exactly one locator: `--selector CSS`, `--role ROLE` with optional `--name NAME`, `--label LABEL`, or `--text TEXT`. Semantic matching is case-insensitive and partial by default; `--exact` uses normalized exact matching. Prefer role/name or label over CSS when the page exposes stable semantics.

Scope a locator to a repeated card, row, or section with `--within-selector`, `--within-role` plus optional `--within-name`, `--within-label`, or `--within-text`. Use `--within-exact` for exact scope matching.

Mutation locators must resolve uniquely. Use zero-based `--nth N` only when a stable scope is unavailable. `select` chooses a native option by exact `--value` or normalized `--option-text`, dispatches `input` and `change`, and verifies the result.

```sh
browserctl click --role button --name "Add Bookmark" --exact --json
browserctl fill --label URL --value https://example.com --json
browserctl press --label Message --key 'ctrl+Enter' --json
browserctl wait --text Saved --timeout 10000 --json
browserctl click --within-text Hardware-Basteln --role button --name Edit --json
```

`press` focuses the located element and sends a native key chord through Chrome DevTools Protocol. Modifiers are `ctrl`, `alt`, `shift`, and `meta`; join them with `+`. Chrome briefly attaches its debugger for each press and detaches immediately afterward.

`wait` accepts exactly one locator, exact URL, URL glob, title substring, page-world expression, `--tab-active`, or `--window-focused`. Prefer it to sleeps after navigation, clicks, and form submissions. URL globs use `*` within one path segment and `**` across segments. Locator waits can require `--count N`, exact field/text `--value VALUE`, or `--changes` from the value observed when waiting starts; these predicates are mutually exclusive. Use `--evaluate` only when those built-ins cannot express the observable application state. Locator waits default to `visible`; `--state` only applies to locator waits. Results include the locator, requested state, matched and visible counts, and observed value where relevant. A hidden wait succeeds only when every matching element is hidden or no elements match. Clicks automatically wait for native form submissions; use `--wait-navigation` for other navigating controls.

DOM output has five formats via `--format` (default `clean_html`):

- `interactive` — flat list of visible actionable elements: `- role "name" (tag#css) value="…" [states]`. Use this for element discovery; each line maps directly back to a locator, so dump it before hunting for controls with `evaluate`.
- `summary` — compact visible landmarks, headings, and actionable elements; repeated entries are grouped with a count and `--item-limit` defaults to 100 groups.
- `clean_html` — trimmed markup: whitelisted attributes plus `aria-*`/`role`/`data-*`, text clipped, `<head>`/`script`/`style` skipped. Default; good for readable structure of a scoped element.
- `json` — full recursive tree with ARIA lifted into an `aria` object; use with `--json` for machine parsing.
- `html` — raw `outerHTML`, unfiltered; accepted as an undocumented escape hatch only.

`--max-chars` (1–1,000,000, default 50,000) bounds the output and truncation is reported, including `totalItems` for `interactive` and `summary`. `--text-chars` (default 100) controls per-node text clipping. `--depth` bounds `clean_html` and `json` tree depth. When a locator matches repeated records, `--offset` and `--limit` select a stable slice and the result reports matched and returned counts. Scope before raising limits. `evaluate` safely serializes objects, arrays, bigints, functions, and circular references; return structured values directly rather than wrapping them in `JSON.stringify`.

Screenshots capture the active paired tab. The default captures its viewport. `--full-page` and `--selector CSS` scroll and stitch the full document or element, then restore the original scroll position. Pages with fixed or sticky content may show stitching artifacts.

Use `--json` for a stable `{ "ok": true, "result": ... }` result envelope. Mutation results name the completed action and relevant context, for example `navigated`, `clicked`, `filled`, or `closed`. Commands are protected against duplicate execution, but verify consequential site mutations from page state.

## Workflow

1. Run `status --json`. Pair only when its recovery field requests pairing.
2. Navigate, then run `dom --format interactive` to discover controls. Fall back to `dom` on a focused selector or a small `evaluate` summary when needed.
3. Locate controls by role/name or label when possible; use visible text or CSS when needed.
4. Use `fill` for fields and `click` for the site's actual controls. When the user requests a UI workflow, keep the mutation in the UI instead of substituting a direct HTTP request.
5. Wait for the observable completion condition.
6. Verify the result from the page. Stop before repeating a mutation when its outcome is uncertain.
7. Close the session when finished. Closing leaves the browser tab open.

Never assume `start` can choose the current tab. It can bind only the tab selected by the CLI pairing page. It must fail when that tab is unavailable and must never fall back to an active or arbitrary tab. Pair again after the control tab closes or Chromium restarts. An extension reload keeps the explicit association.

## Recovery and limits

- Commands that need a browser session safely start a missing supervisor and create or reconnect the current session. `status`, `list`, and `close` do not create background state.
- Startup validates discovery, removes definitively stale discovery during autostart, and serializes concurrent starts. Use `status --json` before considering manual process or file cleanup.
- The extension reconnects with its persisted credential after supervisor restarts. Run a fresh pair if that credential is invalid or was revoked.
- After changing `extension/`, run `bun run extension:build` in the source repository and ask the user to reload `dist/extension/` as the unpacked extension in `chrome://extensions`.
- Screenshots require the bound control tab to be active in its window. Otherwise they fail instead of capturing or activating another tab. Full-page and element captures scroll and stitch the page, restore its original scroll position, and may show artifacts from fixed or sticky content.
- Browser actions require an `http://` or `https://` tab and the extension's advertised capability.
- Navigation waits 10 seconds by default and returns `timeout` if loading does not complete. Set `--timeout` when the page needs a different bound.
