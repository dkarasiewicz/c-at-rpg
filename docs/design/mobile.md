# Mobile — feasibility and plan

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
