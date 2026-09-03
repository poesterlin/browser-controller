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
browserctl dom [LOCATOR] [--max-chars 50000]
browserctl click LOCATOR
browserctl fill LOCATOR --value VALUE
browserctl wait LOCATOR [--state visible|attached|hidden] [--timeout MS]
browserctl wait --url URL [--timeout MS]
browserctl evaluate --expression JAVASCRIPT
browserctl screenshot --output FILE.png
browserctl close
```

Ordinary browser commands automatically use the current session. If none exists, the supervisor safely creates one after the extension confirms the exact paired control tab. Use `--session ID` only to select a specific session.

Commands produce concise human-readable results by default. Add `--json` for a stable `{ "ok": true, "result": ... }` envelope. Run `browserctl COMMAND --help` for command-specific syntax and options.

`fill` replaces the complete value and dispatches `input` and `change` events. Its replacement value uses `--value`; `--text` always identifies an element by visible text. `type` remains a compatibility alias with fill semantics.

### Locators

Commands that target an element accept exactly one locator:

- `--selector CSS`
- `--role ROLE` with optional `--name NAME`
- `--label LABEL`
- `--text TEXT`

Semantic matching is case-insensitive and partial by default. Add `--exact` for normalized exact matching. Common native HTML roles and explicit ARIA `role` attributes are supported.

```sh
browserctl click --role button --name "Add Bookmark" --exact
browserctl fill --label URL --value https://example.com
browserctl wait --text Saved --timeout 10000
```

`wait` accepts exactly one locator or `--url`. Locator waits default to `visible`. DOM output is limited to 50,000 characters by default; `--max-chars` accepts values up to 1,000,000 and reports when output was truncated.

Navigation waits up to 10 seconds by default and returns a timeout error instead of silently continuing. Use `--timeout` to change the limit.

Run `browserctl status` or `browserctl doctor` to inspect the supervisor, extension, paired tab, current URL, sessions, and recommended recovery action.

Mutation commands return structured results such as `navigated`, `clicked`, `filled`, and `closed` instead of an empty object.

Viewport screenshots are allowed only while the paired control tab is active in its window. Otherwise the command fails instead of capturing or activating a different tab.

Ordinary browser commands, `start`, and `extension pair` safely start a missing supervisor. Startup uses authenticated liveness checks and a single-flight lock. Diagnostic and lifecycle-only commands do not create background state.

See [ARCHITECTURE.md](ARCHITECTURE.md) and the reviewed decision records in `.scratch/browser-controller-architecture/` for the protocol and lifecycle design.
