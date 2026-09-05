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
browserctl type LOCATOR --value TEXT [--clear] [--submit] [--delay MS]
browserctl select LOCATOR (--value VALUE | --option-text TEXT)
browserctl scroll [LOCATOR] (--direction down --amount 600 | --delta-y 600 | --into-view)
browserctl bounds LOCATOR
browserctl highlight LOCATOR [--duration-ms 2000]
browserctl drag --from-selector CSS (--to-selector CSS | --to-x N --to-y N)
browserctl activate
browserctl wait LOCATOR [--state visible|attached|hidden] [--timeout MS]
browserctl wait --tab-active [--timeout MS]
browserctl wait --url URL [--timeout MS]
browserctl wait --url-glob '**/karriere/**' [--timeout MS]
browserctl evaluate --expression JAVASCRIPT
browserctl screenshot [--full-page | --selector CSS] [--wait-for-active MS] --output FILE.png
browserctl scrollgif [--output FILE.mp4] [--format gif|video] [--fps N] (--step PX | --duration-ms MS) [--selector CSS] [--dedicated-window]
browserctl scrape [URL] --output page-scrape.zip [--max-routes 20] [--max-bytes 50000000] [--max-duration 120000] [--dedicated-window]
browserctl close
```

Ordinary browser commands automatically use the current session. If none exists, the supervisor safely creates one after the extension confirms the exact paired control tab. Use `--session ID` only to select a specific session.

If no usable extension is connected, an ordinary browser command automatically opens a one-time pairing page, waits for that explicitly created tab to bind, starts a session, and then retries the original command once. This recovery never selects an existing arbitrary tab. Use `--no-auto-pair` when unattended scripts should fail instead of opening a browser page.

Commands produce concise human-readable results by default. Add `--json` for a stable `{ "ok": true, "result": ... }` envelope. Run `browserctl COMMAND --help` for command-specific syntax and options.

`fill` replaces the complete value and verifies the result. `type` focuses the field and sends a real CDP key stream; use `--clear`, `--delay`, and `--submit` for autocomplete and search interfaces. `press` accepts an optional locator—without one, it targets the page's current active element.

`select` chooses a native `<select>` option by exact value or normalized visible text, dispatches `input` and `change`, and verifies the resulting value.
Repeat `--value` or pass `--values a,b` for a native multi-select.

### Actions and grounding

`scroll` moves the page or a uniquely located scroll container and reports the resulting position and actual delta, including no-op movement at an edge. `--into-view` centers a located element. `bounds` reports viewport and page coordinates, dimensions, and `inViewport`; use it before the coordinate fallback `click --at X,Y`. Semantic locators remain preferred.

`click` supports left, right, and middle buttons, double-click, repeatable modifiers, center-relative offsets, and holds. `drag` prefers locator-to-locator movement and accepts viewport coordinates only as a fallback. Both use native CDP pointer events after enforcing locator uniqueness.

```sh
browserctl click --role button --name Open --button right
browserctl click --selector canvas --offset-x 40 --offset-y -20
browserctl click --at 640,420
browserctl drag --from-text Todo --to-text Done
```

`highlight` temporarily outlines the unique match for human verification. `activate` may focus only the explicitly paired tab and its window; it cannot select another tab.

Add `--screenshot FILE.png` to `click`, `fill`, `type`, `select`, `press`, `scroll`, `drag`, or `dom` to save a viewport screenshot in the same controller round-trip. Add `--intent TEXT` to mutations to preserve a human-readable reason in the structured result.

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

Interactive and summary records include `inViewport`. `dom --diff` compares the current bounded snapshot with the previous DOM read in the same session and returns up to 200 added and removed lines. The first diff establishes a baseline. Use `dom --output FILE` for large HTML or JSON results.

`scrape` captures the requested page and discovered same-origin routes into one ZIP. Each route gets a rendered MHTML snapshot (including loaded assets) and a full-page stitched PNG. Sticky and fixed elements are retained only in the first tile. Discovery strips query strings and fragments, never leaves the starting origin, and is bounded to 20 routes, 50 MB, and 120 seconds by default (hard limits: 50 routes, 100 MB, and 10 minutes). Every CDP, screenshot, and link-discovery operation has a deadline; failed secondary routes are skipped. The archive can contain content visible to your signed-in browser; review it before sharing.

Use `scrape --dedicated-window` when the paired tab cannot remain active among other tabs. This explicitly moves only the paired tab into a new non-focused one-tab window before capture; it never selects or moves another tab.

`scrollgif` records the paired tab (or a scrollable container via `--selector CSS`) scrolling smoothly from top to bottom. By default every frame is a full-color JPEG converted into a video in the CLI — MP4 via ffmpeg when available, otherwise a motion-JPEG AVI with no external dependencies; `--format gif` encodes an animated GIF with per-frame median-cut palettes instead. Smoothness comes from capture density, not speed: every frame scrolls a small step, waits for the paint (and viewport images) to settle, and is captured before the next step via the CDP screenshot API (no capture-rate quota). The scroll bottom is re-measured while recording, so lazy-loaded content that grows the page is still captured to the end. The scroll starts at 70% of base speed and eases up to a hard cap of 130% of base speed, and the first and last frames hold for a pause at the top and bottom. Options: `--fps` (default 25), `--step` for average pixels per frame (default: viewport height / 32, minimum 12), `--duration-ms` to set the animation length instead of the step, `--max-width` (default 1200, `0` disables downscaling), `--settle-ms` (default 100), `--hold-ms` (default 800), `--loop` (gif only, 0 = forever), `--max-frames` (default 2500), and `--dedicated-window`/`--wait-for-active` like screenshots — the dedicated window keeps the original window's size so responsive styling stays identical. GIF dithering is off by default so flat design stays crisp and shimmer-free; pass `--dither` for Floyd–Steinberg dithering. The page's original scroll position is restored afterwards.

`wait` accepts exactly one locator or `--url`. Locator waits default to `visible`. DOM output is limited to 50,000 characters by default; `--max-chars` accepts values up to 1,000,000 and reports when output was truncated.

Navigation waits up to 10 seconds by default and returns a timeout error instead of silently continuing. Use `--timeout` to change the limit.

Run `browserctl status` or `browserctl doctor` to inspect the supervisor, extension, paired tab, current URL, sessions, and recommended recovery action.

Mutation commands return structured results such as `navigated`, `clicked`, `filled`, and `closed` instead of an empty object.

Viewport screenshots are allowed only while the paired control tab is active in its window. Otherwise the command fails instead of capturing or activating a different tab.

Ordinary browser commands, `start`, and `extension pair` safely start a missing supervisor. Startup uses authenticated liveness checks and a single-flight lock. Diagnostic and lifecycle-only commands do not create background state.

See [ARCHITECTURE.md](ARCHITECTURE.md) and the reviewed decision records in `.scratch/browser-controller-architecture/` for the protocol and lifecycle design.
