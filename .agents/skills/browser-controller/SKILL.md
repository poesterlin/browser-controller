---
name: browser-controller
description: Control the user's existing Chromium tab with browserctl when a task requires live navigation, DOM inspection, form interaction, page-world JavaScript, waits, screenshots, device-viewport emulation, or scrolling screen-capture video. Use for browser UI workflows, including when the user explicitly asks to perform an action through a site's interface.
---

# Browser Controller

Use `~/.local/bin/browserctl` to control one user-owned Chromium tab through the paired extension. `browserctl --help` lists the commands (navigate, dom, click, fill, type, select, press, scroll, bounds, highlight, drag, activate, device, wait, evaluate, screenshot, scrollgif, scrape, list, start, close, extension pair, status, doctor); `browserctl COMMAND --help` gives exact usage, locator flags, and defaults — consult it instead of guessing flags.

## Connect

Pair only for first use, credential recovery, or when the user explicitly requests pairing:

```sh
browserctl extension pair
```

Pairing starts the supervisor when necessary and opens a one-time loopback page that becomes the only browser-control tab; adapter credentials survive supervisor restarts. `status --json` shows the complete connection state. Ordinary commands automatically pair, start a missing supervisor, and retry once when the extension or paired tab is unavailable; `--no-auto-pair` fails instead, and an explicit `--session ID` never switches sessions automatically.

## Operate

Typical flow: `navigate URL` → `dom --format interactive` to discover controls → act with `fill`/`click`/`type`/`select` → `wait` for the observable completion condition → verify from page state.

```sh
browserctl click --role button --name "Add Bookmark" --exact --json
browserctl fill --label URL --value https://example.com --json
browserctl wait --text Saved --timeout 10000 --json
browserctl click --within-text Hardware-Basteln --role button --name Edit --json
```

- One locator per command: prefer `--role`/`--name` or `--label` over CSS; scope repeats with `--within-*`; zero-based `--nth` only without a stable scope.
- `fill` replaces the whole value and returns `verified` from reading the field back — treat `verified: false` as a failed fill. `type` sends real keystrokes (`--clear`, `--delay`, `--submit` for keyboard-sensitive fields); `fill` and `select` dispatch `input` and `change`.
- `wait` takes exactly one predicate: a locator, URL/glob, title, `--evaluate`, `--tab-active`, or `--window-focused`, optionally `--count`/`--value`/`--changes` for locator waits. Prefer it to sleeps after navigation and mutations.
- `scroll` reports `moved: false` on a stall; `--into-view` centers a locator. Use `bounds` before coordinate clicks.
- `press`, `click --at`, and `drag` send native input through CDP; `drag` needs source and target in the shared viewport.
- Screenshots capture the paired tab and require it active in its window; `--full-page` and `--selector` scroll-and-stitch and may show artifacts from fixed or sticky content. `--screenshot FILE` on mutations captures the result in the same round-trip.
- `evaluate --expression` runs through the Chrome debugger, so it works on CSP-strict pages; a bare positional argument is silently ignored. Return structured values directly — serialization handles bigints, functions, and circular references.
- `device WIDTHxHEIGHT [--mobile]` emulates a responsive device viewport for every command on the session: media queries work, pages render at the chosen size, and screenshots and `scrollgif` capture it exactly. Omit a dimension to keep the current value. The emulation lives in the debugger attachment, so it ends on `device --clear`, session close, infobar dismissal, or an extension reload — re-run `device` after reloading.
- `scrollgif` records a smooth top-to-bottom scroll as MP4 (default) or `--format gif`. It requires the paired tab active, dismisses cookie-consent banners first (reported as `consentDismissed`), handles lazy-loaded growth, and is tuned for smoothness over speed. `--selector` records a specific container; `--dedicated-window` moves the tab to its own window at the original window's geometry, keeping the responsive theme intact.
- `scrape` captures same-origin routes as rendered MHTML plus full-page PNGs into a ZIP. Treat it as private: it includes content visible to the current browser session.
- `activate` and `--dedicated-window` visibly move focus; use only when the user requested or approved it.
- Use `--json` for the stable `{ ok, result }` envelope. Verify consequential mutations from page state; after repeated stalls, stop and reassess instead of retrying blindly.

## Workflow

1. `status --json`; pair only when its recovery field requests pairing.
2. Navigate, then `dom --format interactive` to discover controls.
3. Locate by role/name or label; fall back to visible text or CSS.
4. `fill` fields and `click` the site's actual controls; keep UI workflows in the UI rather than substituting direct HTTP requests.
5. Wait for the completion condition after mutations; `type --submit` sends Enter without assuming navigation.
6. Verify the result from the page; stop before repeating a mutation whose outcome is uncertain.
7. Close the session when finished; the browser tab stays open.

## Recovery and limits

- The control tab binds at pairing only. Never assume `start` can choose the current tab, and it never falls back to an active or arbitrary tab. Pair again after the control tab closes or Chromium restarts; an extension reload keeps the association.
- After changing `extension/`: run `bun run extension:build` in the source repository and ask the user to reload `dist/extension/` as the unpacked extension in `chrome://extensions`. If supervisor-side code changed too, kill the supervisor from `/run/user/<uid>/browser-controller/connection.json` — a stale supervisor rejects newer commands with confusing errors — and let the next command restart it.
- Browser actions require an `http://` or `https://` tab and the extension's advertised capability.
- Navigation waits 10 seconds by default; set `--timeout` for slow pages.
