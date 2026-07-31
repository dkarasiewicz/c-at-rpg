# Mobile — feasibility and plan

> **STATUS: shipped.** Everything in the Plan below is implemented and
> verified on emulated devices (Playwright, `hasTouch: true`) — see
> [What shipped](#what-shipped) at the bottom for the file-by-file map and the
> measured numbers. The one thing deliberately NOT done is the portrait
> reflow; portrait is gated behind a rotate prompt, as recommended.

**Verdict: yes, and the run-map pivot is what made it realistic.** Tile-crawling
with WASD is the most touch-hostile thing a game can do; replacing it with a
route map of discrete tappable choices plus a text box makes the whole game a
sequence of taps and typing — which is exactly what phones are good at.

## What already works

- `src/main.ts` renders at a fixed **1280×720 design resolution** with
  `resizeTo: window`, `resolution: devicePixelRatio`, `autoDensity: true` and
  uniform letterbox scaling. The game is already resolution-independent — the
  usually-painful part is done.
- Pixi normalises pointer events, so existing `pointertap` handlers already
  respond to touch. No separate touch layer is needed.
- The game is offline-first by design, which makes it a natural PWA.

## What actually blocks it

Measured on the current tree: **30 keydown handlers vs 14 pointertap handlers**,
and **10 hover-only affordances**.

1. **Keyboard-first interaction.** Skills (`1-6`), marching order (`Tab`),
   descend (`Enter`), menus (`Esc`) are keys with, at best, a visual hint. Every
   one needs a real tappable control. The UI kit's `button()` already renders a
   hotkey chip and is tappable, so much of this is "route the action through a
   kit button" rather than new design.
2. **Hover-only information.** Battle nameplates, tooltips and stat previews
   appear on `pointerover`. Touch has no hover: these need tap-to-inspect (first
   tap reveals, second commits) or always-visible alternatives.
3. **Hit target size.** Design-pixel targets under ~44 CSS px are unreliable
   under a finger. Rank slots, skill cards and map nodes need auditing at phone
   scale, not desktop scale.
4. **Portrait.** Letterboxing 16:9 into a 9:19.5 phone leaves a small strip with
   huge dead bands. Two options — see below.
5. **Text input.** Pixi cannot do native text entry, so the tabletop
   typed-action layer needs an HTML `<input>`/`<textarea>` overlaid on the
   canvas, plus handling for the virtual keyboard resizing the viewport
   (`visualViewport` API) so the input isn't hidden behind the keyboard.
6. **Page-level touch behaviour.** `index.html` needs `viewport-fit=cover` and
   `user-scalable=no`, and CSS `touch-action: none` / `overscroll-behavior:
   none` to stop pinch-zoom and pull-to-refresh fighting the game.

## Orientation: landscape-first

Recommended: **support landscape properly, prompt to rotate in portrait.** The
existing layouts are wide by nature (a 4v5 battle line, a route map, a shop),
and a rotate prompt is a normal, accepted convention for games.

A true portrait reflow means re-laying-out every screen — the battle HUD, The
Den, the landing shop — and roughly doubles the work. Defer it; if it ever
happens, do it for menu-like screens (Den, Cat Town, inventory) where a vertical
list is natural, and keep battle and the run map landscape-only.

## Plan

1. **Touch parity** — every keyboard action reachable by tap; convert hover
   affordances to tap-to-inspect; audit hit targets at phone scale.
2. **Page setup** — viewport meta, `touch-action`, safe-area insets for notches.
3. **Text input overlay** — HTML input for typed actions, `visualViewport`-aware.
4. **Rotate prompt** — clean landscape gate rather than a broken portrait.
5. **PWA** — web manifest, icons, and a service worker precaching the asset
   manifests. The game already runs without the network, so this is mostly
   packaging, and it makes the game installable.
6. **Verify on real viewport sizes** in headless Chromium with device emulation
   (iPhone-class 390×844 and a tablet), not by resizing a desktop window.

## Performance notes

Backdrops are 1600×900 WebP and sprites are 640² PNGs; after the alpha-bbox
crop pass they shrink meaningfully. Watch total texture memory on low-end
devices — prefer WebP everywhere, and consider a reduced-resolution asset tier
if profiling shows pressure. Pixi v8 WebGL is fine on modern mobile GPUs.


---

## What shipped

Verified with Playwright device emulation at **844×390** (iPhone-class
landscape, `hasTouch: true`, DPR 3) and **1080×810** (tablet), playing a
route → fight → typed action with `page.touchscreen.tap` only — never a key.

### The one number everything follows from

The game letterboxes 1280×720 into the window, so on an 844×390 viewport the
scale is **0.542** and a 44 CSS px touch target is **81 design px**. Almost
every button in the game is visually smaller than that. The answer was to grow
the *target*, never the art:

`src/ui/touch.ts` installs hit areas whose `contains()` recomputes its padding
from the LIVE scale on every hit test (`padHit` / `padHitCircle` / `padHitBox`).
A 34px route chip still paints 34px on a desktop monitor and answers to an
81px box under a finger; on a fine pointer the padding is exactly zero.
Measured: a tap **14 design px below the painted bottom edge** of a route chip
takes the route.

| Deliverable | Where | Notes |
| --- | --- | --- |
| Pointer detection | `src/ui/touch.ts` | `(pointer: coarse)` + `maxTouchPoints`, `?touch=1/0` override, stamped on `<html data-touch>` for CSS |
| Hit-target growth | `src/ui/touch.ts`, applied in `widgets.ts` `button()` + the small tappables | kit buttons, skill cards, map medallions, inventory cells, Den rows, shop rows, belt cells, status chips, battle units |
| Esc parity | `index.html` `#sys-menu` → `main.ts` → `manager.handleKey("esc")` | ONE control reaches every Esc affordance: pause, close overlay, back out of the Den/sell panel, cancel targeting, shut the inspect card. Lives in the letterbox gutter (measured at x 792 on a 844px viewport, gutter starts at 769) |
| Hover → tap | `battle.ts`, `runMap.ts`, `battleWidgets.ts`, `inventoryPanel.ts`, `progressPanel.ts`, `touch.ts#tapToReveal` | enemy inspect (tap→read, tap→attack), map node blurbs (tap→read, tap→walk), cat nameplates, skill-card rules text (press-and-hold on a usable card, tap-toggle on a disabled one), equip chips, status chips. Hover is untouched on a mouse |
| In-flow targeting cancel | `battle.ts` `onSlotPressed` | tapping the LIT skill card backs out — right-click and Esc do not exist on a phone |
| Inspect card Close | `battleWidgets.ts` `makeInspectPanel(onClose)` | a real kit button, not an "Esc closes" hint |
| No dead key names | `widgets.ts` `button()` — the chip is not built when `isTouch()` | A hotkey chip names a KEY, and a phone has none: "Esc", "Enter", "E", "T" beside a button a finger is about to press is dead chrome, and worse, it sends the player looking for an Escape key a virtual keyboard does not have. On a coarse pointer the chip is skipped and the label centres in the full width; nothing moves on a mouse. The skill cards' `1-6` are drawn elsewhere and deliberately stay — those read as slot numbers, not as keys |
| Page setup | `index.html`, `public/style.css` | `viewport-fit=cover`, `user-scalable=no`, `maximum-scale=1`, `interactive-widget=overlays-content`, `touch-action: none`, `overscroll-behavior: none`, `100dvh`, `env(safe-area-inset-*)` on all chrome, no tap highlight / long-press callout |
| Text input | `src/ui/domInput.ts` | ONE keyboard-aware `<input>` component, used by the tabletop card and the title's seed entry. Positioned through the letterbox transform; when `visualViewport` shrinks it floats the field (on its own plate) above the keyboard. Font floor 16px so iOS cannot zoom. `Say it` / `Never mind` kit buttons because a virtual keyboard has a Go key but no Escape |
| Landscape gate | `index.html` `#rotate`, `public/style.css` | touch + portrait only; animated handset, safe-area padded. Portrait reflow explicitly deferred, per the ruling above |
| PWA | `public/manifest.webmanifest`, `public/icons/*`, `public/sw.js`, `main.ts` | fullscreen/landscape manifest, 192/512/maskable icons, worker precaching the shell + both asset manifests, then warmed with the page's real `performance.getEntriesByType('resource')` set (the renderer chunk and the art arrive by dynamic import and no static list can name them). Every cache read passes `ignoreVary` — hosts answer assets with `Vary: Origin` and the page's `<script crossorigin>` sends one, which otherwise misses every time |

### Measured

```
letterbox scale 0.542  →  44 CSS px = 81.2 design px
skill card        128x112 design  →  69x61 CSS px
route chip         168x34 design  →  91x18 CSS px  →  91x44 padded
map medallion       r 41 design   →  44 CSS px diameter, padded
menu button                          44x44 CSS px, in the gutter
typed-action field                   390x40 CSS px, font-size 16px
offline reload after one online visit: boots to `boot`
```

### Known gap

`runMap`'s entry-hold state (the "Into the …" gate on a fresh floor) swallows
every key including Esc, so the menu button is inert until that button is
taken. It has its own tappable control, so touch is not blocked — but Esc
should probably fall through it.
