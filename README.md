# browser-controller

A local TypeScript/Bun CLI that controls one browser tab through a paired Chromium extension. Version 1 does not include Playwright; `src/adapters/playwright/` is reserved for a later adapter.

## Development

```sh
bun install
bun run build
bun test
bun run extension:build
```

Load the generated `dist/extension/` directory as an unpacked extension from `chrome://extensions` with Developer mode enabled. Reload it after each extension build.

## Pairing

```sh
browserctl extension pair
```

The command starts the supervisor when necessary and opens a one-time loopback pairing page. That page becomes the sole browser-control tab. `start` can reuse only that exact tab and fails if it is gone; it never falls back to the active tab or another tab. Extension reloads preserve the association. Pair again after closing the control tab or restarting Chromium.

If the page does not open, use the pairing URL printed by the command. You can also paste the manual pairing string into the toolbar popup; the tab under that popup becomes the explicit control tab.

Adapter credentials are separate from the controller token. The supervisor stores only their hash and reuses them after supervisor restarts.

## Commands

```sh
browserctl status
browserctl navigate https://example.com [--timeout 10000]
browserctl dom [LOCATOR] [--format summary] [--offset N] [--limit N] [--max-chars 50000]
browserctl click LOCATOR
browserctl fill LOCATOR --value VALUE
browserctl select LOCATOR (--value VALUE | --option-text TEXT)
browserctl wait LOCATOR [--state visible|attached|hidden] [--timeout MS]
browserctl wait --tab-active [--timeout MS]
browserctl wait --url URL [--timeout MS]
browserctl wait --url-glob '**/karriere/**' [--timeout MS]
browserctl evaluate --expression JAVASCRIPT
browserctl screenshot [--full-page | --selector CSS] [--wait-for-active MS] --output FILE.png
browserctl scrape [URL] --output page-scrape.zip [--max-routes 20] [--max-bytes 50000000] [--max-duration 120000] [--dedicated-window]
browserctl close
```

Ordinary browser commands automatically use the current session. If none exists, the supervisor safely creates one after the extension confirms the exact paired control tab. Use `--session ID` only to select a specific session.

Commands produce concise human-readable results by default. Add `--json` for a stable `{ "ok": true, "result": ... }` envelope. Run `browserctl COMMAND --help` for command-specific syntax and options.

`fill` replaces the complete value and dispatches `input` and `change` events. Its replacement value uses `--value`; `--text` always identifies an element by visible text. `type` remains a compatibility alias with fill semantics.

`select` chooses a native `<select>` option by exact value or normalized visible text, dispatches `input` and `change`, and verifies the resulting value.

### Locators

Commands that target an element accept exactly one locator:

- `--selector CSS`
- `--role ROLE` with optional `--name NAME`
- `--label LABEL`
- `--text TEXT`

Semantic matching is case-insensitive and partial by default. Add `--exact` for normalized exact matching. Common native HTML roles and explicit ARIA `role` attributes are supported.

Use `--within-selector`, `--within-role` with optional `--within-name`, `--within-label`, or `--within-text` to scope a target to a repeated card, row, or section. Add `--within-exact` for exact scope matching.

```sh
browserctl click --role button --name "Add Bookmark" --exact
browserctl fill --label URL --value https://example.com
browserctl wait --text Saved --timeout 10000
browserctl click --within-text Hardware-Basteln --role button --name Edit
```

`dom --format summary` returns visible landmarks, headings, and controls, groups repeated items, and accepts `--item-limit`. A DOM locator can match repeated records; use `--offset` and `--limit` to retrieve a slice. Add zero-based `--nth` to choose one match; mutation commands reject ambiguous unindexed locators. Screenshot capture defaults to the viewport; full-page and selector captures scroll and stitch the active paired tab and restore its original position afterward. `--wait-for-active` waits for that tab instead of failing immediately.

Summary links include their resolved `href`, and summary accounting distinguishes raw elements, unique groups, and returned groups. `click` automatically waits for native form submissions; use `--wait-navigation` when a non-submit control is also expected to navigate. URL waits accept either exact `--url` or `--url-glob` patterns where `*` stays within one path segment and `**` spans segments.

`scrape` captures the requested page and discovered same-origin routes into one ZIP. Each route gets a rendered MHTML snapshot (including loaded assets) and a viewport PNG. Discovery strips query strings and fragments, never leaves the starting origin, and is bounded to 20 routes, 50 MB, and 120 seconds by default (hard limits: 50 routes, 100 MB, and 10 minutes). Every CDP, screenshot, decode, and link-discovery operation has its own deadline; failed secondary routes are skipped. The archive can contain content visible to your signed-in browser; review it before sharing.

Use `scrape --dedicated-window` when the paired tab cannot remain active among other tabs. This explicitly moves only the paired tab into a new non-focused one-tab window before capture; it never selects or moves another tab.

`wait` accepts exactly one locator or `--url`. Locator waits default to `visible`. DOM output is limited to 50,000 characters by default; `--max-chars` accepts values up to 1,000,000 and reports when output was truncated.

Navigation waits up to 10 seconds by default and returns a timeout error instead of silently continuing. Use `--timeout` to change the limit.

Run `browserctl status` or `browserctl doctor` to inspect the supervisor, extension, paired tab, current URL, sessions, and recommended recovery action.

Mutation commands return structured results such as `navigated`, `clicked`, `filled`, and `closed` instead of an empty object.

Viewport screenshots are allowed only while the paired control tab is active in its window. Otherwise the command fails instead of capturing or activating a different tab.

Ordinary browser commands, `start`, and `extension pair` safely start a missing supervisor. Startup uses authenticated liveness checks and a single-flight lock. Diagnostic and lifecycle-only commands do not create background state.

See [ARCHITECTURE.md](ARCHITECTURE.md) and the reviewed decision records in `.scratch/browser-controller-architecture/` for the protocol and lifecycle design.
