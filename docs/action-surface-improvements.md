# Action surface improvements

> Implemented with one deliberate omission: read-only tab enumeration was skipped to keep the interface centered on the explicitly paired tab. Unrestricted CDP, free tab selection, and input locking remain intentionally out of scope.

Ideas for expanding browserctl’s action surface, drawn from the Cursor IDE browser MCP (`cursor-ide-browser`) while keeping browserctl’s locator-first model.

## What to steal vs what to skip

| MCP idea | Steal? | Why |
|----------|--------|-----|
| `scroll` / into-view | Yes | Biggest gap for long pages, sticky headers, infinite lists |
| richer `click` (button, modifiers, double, offset, hold) | Yes | Canvas UIs, context menus, shift-click, long-press |
| `drag` | Yes | Kanban, sliders, reorder, maps |
| `click_xy` | Yes, but secondary | Fallback after screenshot / canvas; not primary targeting |
| `type` with clear/submit/slowly | Partial | browserctl already has better `fill`+`verified`; add a real keystroke `type` |
| `highlight` + `bbox` | Yes | Debug + screenshot→xy grounding |
| `take_screenshot_afterwards` | Yes (flag) | Cuts round-trips in agent loops |
| snapshot `interactive` / `compact` / `diff` | Partial | Formats already exist; add diff + into-view helpers |
| `tabs` list/select | Careful | Conflicts with “one paired control tab” — expose read-only first |
| `lock`/`unlock` | Adapted | User owns the browser; full lock is different |
| raw `cdp` | Optional escape hatch | Powerful; easy to misuse — gate tightly |
| snapshot refs | No | Locators are the better primary address space |

---

## 1. Missing primitives (highest leverage)

### `scroll`

MCP: direction/amount, deltaX/Y, scrollIntoView on a ref.

browserctl shape:

```sh
browserctl scroll [--direction up|down|left|right] [--amount PX]
browserctl scroll --delta-x N --delta-y N
browserctl scroll LOCATOR --into-view
browserctl scroll LOCATOR --direction down --amount 400   # scroll inside a container
```

Protocol sketch:

```ts
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
  }
```

Return `{ action: 'scrolled', scrollX, scrollY, intoView?: boolean }` so agents can detect no-op scrolls (common failure mode).

### `drag`

MCP: sourceRef → targetRef | (targetX, targetY).

```sh
browserctl drag --from LOCATOR --to LOCATOR
browserctl drag --from LOCATOR --to-x N --to-y N
```

Prefer locator→locator; coords only as escape hatch. Verify with a post-state wait, not by assuming success.

### Richer `click`

MCP: `doubleClick`, `button`, `modifiers`, `offsetX/Y`, `holdDurationMs`.

```sh
browserctl click LOCATOR [--button left|right|middle] [--double]
  [--modifier ctrl|alt|shift|meta]... [--offset-x N] [--offset-y N]
  [--hold-ms N] [--wait-navigation]
```

Keep uniqueness rules. Offsets are relative to the element’s center (same as MCP).

### `click --at x,y` (or `click-xy`)

Only after `screenshot` / `bbox` — document that semantic click stays preferred. Useful for canvas and non-a11y widgets.

### Real `type` (keystroke), keep `fill` as replace+verify

MCP’s `type` has `clear`, `submit`, `slowly`. browserctl’s `type` currently aliases `fill`. Split:

| Command | Semantics |
|---------|-----------|
| `fill` | Replace value, dispatch input/change, return `verified` (keep) |
| `type` | Focus + keystroke stream; `--clear`, `--submit`, `--delay MS` |

Agents need both: React-controlled fields often want fill; autocomplete/search wants slow type.

### `press` without a locator

MCP’s `press_key` is page-scoped. Allow:

```sh
browserctl press --key Escape          # document/activeElement
browserctl press LOCATOR --key Tab     # focus then chord (existing)
```

---

## 2. Grounding helpers (from highlight / bbox / vision loop)

### `bbox` / `bounds`

```sh
browserctl bounds LOCATOR --json
# → { x, y, width, height, inViewport }
```

Feeds `click-xy` and “is this off-screen?” decisions before scroll.

### `highlight`

```sh
browserctl highlight LOCATOR [--duration-ms 2000]
```

Cheap for human-in-the-loop and for agents verifying they resolved the right control before a destructive click.

### Optional `--screenshot` on mutations

MCP’s `take_screenshot_afterwards` pattern:

```sh
browserctl click LOCATOR --screenshot /tmp/after.png
browserctl fill LOCATOR --value … --screenshot …
```

Or a session default: `browserctl session configure --screenshot-after on`. One round-trip instead of mutate + screenshot.

---

## 3. Discovery upgrades (snapshot ideas without refs)

browserctl already beats MCP on locator stability. Steal *snapshot knobs*, not refs:

| MCP snapshot flag | browserctl analogue |
|-------------------|---------------------|
| `interactive` | already `dom --format interactive` |
| `compact` | tighten `summary` / add `--compact` |
| `maxDepth` | already `--depth` |
| `selector` scope | already locator / `--within-*` |
| `includeDiff` | **add** `dom --diff` vs last dump for this session |
| `take_screenshot_afterwards` | `dom … --screenshot FILE` |

**`dom --diff`** is high value for agents: after click/fill, “what changed?” without re-reading a huge tree.

Optional: emit a stable `css` hint on every interactive line (partly already present) plus `inViewport: true|false` so agents know to scroll first.

---

## 4. Select / tabs / lock — adapt carefully

### `select` multi

MCP: `values: string[]`. Add `--value` repeatable or `--values a,b` for `<select multiple>`, still verify selected options.

### Tabs

MCP has list/new/close/select. browserctl’s invariant is “one paired control tab.” Safer ladder:

1. `browserctl tabs --json` — list only (id, url, title, active, paired?)
2. Later: `focus` / `activate` on the *paired* tab only
3. Avoid free “select any tab as control” unless pairing is redesigned

That matches MCP’s “know what’s open” without breaking the safety story.

### Lock (user browser adaptation)

Full MCP lock doesn’t map cleanly. Better fits:

- `browserctl wait --tab-active` (already exists)
- `browserctl activate` — bring paired tab to front (for screenshots)
- Soft lock: extension overlay “Agent controlling — Take control” that queues or rejects concurrent user input for N seconds
- Or: document “user must not touch” and fail fast on focus loss (screenshot already does)

Ship `activate` + clearer focus-loss errors before a true lock UI.

---

## 5. Cross-cutting MCP ergonomics worth copying

These are interface design, not new verbs:

1. **Human `element` / `--intent` string** — optional description on mutations for logs (`clicked "Save draft"`). Helps agents and postmortems; MCP encourages `element` alongside `ref`.
2. **Default target = last session** — mostly already true; keep it boring like MCP’s omitted `viewId`.
3. **Structured action results** — always `{ action, …context }`; add `bbox` / `scroll` / `verified` consistently.
4. **Deny raw Input.\* if adding `cdp`** — same policy as MCP: dedicated tools for input; CDP for Runtime/DOM/Network only.
5. **Large payloads → files** — screenshots/scrape already; extend to huge `dom json` with `--output` + path in the envelope (MCP does this for CDP dumps).
6. **Workflow copy in the skill** — MCP’s “snapshot → act → verify; stop after 4 stalls” belongs in the skill for scroll/drag/xy too.

---

## Suggested rollout order

1. **`scroll` (+ into-view)** and **`bounds`** — unblock most stuck agents
2. **Click richness** (button, double, modifiers, offset)
3. **Split `type` from `fill`**; page-level `press`
4. **`drag`** + **`click-xy`**
5. **`--screenshot` on mutations** + **`dom --diff`**
6. **`highlight`**, multi-`select`, read-only **`tabs`**
7. Soft **activate/focus** policy; optional gated **`cdp`**

---

## What not to copy

- Opaque snapshot refs as the primary API (addressing is already solved better with locators).
- Making screenshots the action oracle (MCP itself: snapshot for actions, screenshot for vision).
- Free multi-tab control without pairing redesign.
- Unrestricted CDP `Input.*` / cookie / download / target APIs.
