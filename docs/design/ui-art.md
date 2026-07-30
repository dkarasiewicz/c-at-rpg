# c(at)rpg — UI & Art Direction
## "Midnight Picture-Book" (procedural-only art bible)

**Status: FINAL — realigned to `combat.md` "Claws & Ranks: Nine Lives Edition".**
This version supersedes the previous ui-art.md, which was written against the retired
"Pounce & Poise" combat draft (Pouncer/Oracle/Purrmedic classes, Vigor, Stalk, weakness
tags). Everything combat-facing below — classes, statuses, resources, screens — matches
the final combat spec: 4v5 single-file **ranks**, per-cat **Energy 0–10**, the six
statuses (Scratched / Frazzled / Off-Balance / Guarded / Provoked / Mending), boss
**Poise**, **Cat Pile**, and **Nine Lives** paw pips. (`classes.md`, `dungeon.md`,
`events.md` still cite the old spec and need their own realignment pass; where they
conflict with this doc + combat.md, this doc + combat.md win.)

Everything on screen is PixiJS v8 `Graphics` primitives and `Text` — zero image assets,
zero external fonts. This document is exact: hex values, pixel rectangles at the
1280×720 design resolution, draw recipes with coordinates, and data shapes. If a number
is here, it is the number.

**The look in one sentence:** a children's-picture-book alley at 3 AM — chunky flat
shapes with thick dark outlines, a deep plum night everywhere, and small pools of warm
gold where the player should look right now.

Art pillars:

1. **Chunky flat + fat outline.** Every gameplay shape gets an outline in a darker
   shade of its own fill: 3px on units, 2px on UI panels/chips, 1px on bars. No
   gradients on characters, no textures. Reads at 50% scale; screenshots like a
   sticker sheet.
2. **Two-and-a-half colors per thing.** Each cat/enemy/tile is base + accent + outline
   (+ eye color). Silhouette and palette do the identification work, not detail.
3. **Dark stage, lit actors.** Backgrounds live in the `#14101E`–`#332E45` band; units
   and interactive UI sit 2–4 steps lighter. Gold (`#F5C84C`) is *reserved* for "act
   here now": the active unit, legal targets, hotkey chips, stairs, the Poise pips,
   the Cat Pile prompt. Gold never decorates.
4. **Text is an art material.** Status glyphs, hotkey chips, damage numbers, paw pips,
   rank numerals — single characters in chunky type on colored chips. Cheap, crisp,
   data-driven.

---

## 1. Global Rendering Rules

- **Design resolution 1280×720.** One root `Container` holds the whole game. On
  resize: `scale = min(innerWidth/1280, innerHeight/720)`, scale the root uniformly,
  center it, fill the letterbox with `PAL.void`. Never lay out against window size —
  always 1280×720 virtual pixels.
  `app.init({ antialias: true, resolution: devicePixelRatio, autoDensity: true,
  background: PAL.void })`.
- **Layer stack** (children of root, bottom→top):
  `bg` → `world` (tiles or battlefield; units y-sorted by ground line) → `fx` (dust,
  wobble stars, pile cloud, shockwaves) → `hud` (panels, bars, ribbon, skill bar) →
  `floaters` (damage numbers) → `modal` (event dialog, Cat Pile prompt, results) →
  `flash` (full-screen flash quad, normally alpha 0). Screen shake offsets `world` +
  `fx` only; the HUD never shakes.
- **Visual RNG is `Math.random()`**, never the battle's mulberry32 stream. Shake
  angles, blink timers, star scatter must not consume gameplay rolls (determinism
  contract, combat.md §3). The renderer only *consumes* the engine's event queue
  (`Damage`, `Moved`, `OffBalance`, `PoiseBreak`, `CatPile`, `KO`, …, combat.md §14);
  it never computes outcomes.
- **Text performance:** damage numbers and the log line use `BitmapText` (install one
  `BitmapFont` from the `MONO` style at load); everything else is plain `Text`.
  `roundPixels: true` everywhere.
- All rectangles below are `[x, y, w, h]` in design pixels. Corner radius: 8 for
  panels, 6 for buttons, 4 for chips, unless stated.

```ts
// src/ui/layout.ts — every rect in this doc lives in one const
export type Rect = [x: number, y: number, w: number, h: number];
export const R = { title: {...}, explore: {...}, combat: {...}, event: {...},
                   results: {...} } as const;   // filled in §§7-11
```

---

## 2. Palette (single source of truth)

```ts
// src/ui/palette.ts
export const PAL = {
  // ---- chrome ----
  void:      0x0E0C16,  // letterbox / outside world
  bgDeep:    0x1A1626,  // screen background
  panel:     0x262038,  // HUD panel fill
  panelLite: 0x322A4A,  // hovered / raised panel
  border:    0x4A3F66,  // default 2px panel border
  gold:      0xF5C84C,  // ACTIVE / attention accent — see pillar 3
  goldDark:  0xB98A1F,  // pressed gold, gold outlines
  text:      0xF2EDE4,  // primary text (warm off-white)
  textDim:   0x9C93B0,  // secondary text, disabled labels
  textDark:  0x1A1626,  // text on gold chips
  danger:    0xE5484D,  // damage numbers, HP-low, Scatter!, KO, telegraphed ranks
  heal:      0x5FD068,  // heal numbers, full-HP bar, Mending
  warnYel:   0xF5C84C,  // mid-HP bar (same value as gold)
  energy:    0x3FC1C9,  // Energy pips/bar (cats)
  crit:      0xFFE066,  // crit damage numbers
  offBal:    0xFF9F43,  // Off-Balance markers, wobble stars, "OFF-BALANCE!" tag
  hpBack:    0x241F33,  // empty bar track
  scrim:     0x000000,  // modal scrim, drawn at alpha 0.6

  // ---- 4 cat classes (body / accent / belly / outline / eye) ----
  bruiser:  { body: 0xE8853B, accent: 0xB35F1F, belly: 0xF7C08A, outline: 0x5C3212, eye: 0x5FD068 }, // Bruno: orange tabby
  trickster:{ body: 0x33303F, accent: 0x4A4560, belly: 0x55506B, outline: 0xA9A3BC, eye: 0xFFE066 }, // Pixel: soot-black (light outline: dark cat, dark bg)
  hexer:    { body: 0xA98BD6, accent: 0x6E549C, belly: 0xD6C7F0, outline: 0x4A3670, eye: 0x3FC1C9 }, // Mora: dusk-purple
  medic:    { body: 0xF2E3C6, accent: 0xD9A066, belly: 0xFBF3E0, outline: 0x8A6A3F, eye: 0x7EC8E3 }, // Baguette: warm cream
  earInner: 0xE8A0A8,   // shared pink
  nosePink: 0xD97B8A,

  // ---- enemy families (base / accent / outline / eye) ----
  vermin:   { base: 0x8A7264, accent: 0xB09484, outline: 0x3E3028, eye: 0xE5484D }, // rats, mice
  bird:     { base: 0x4A4658, accent: 0x8F86B5, outline: 0x201C2C, eye: 0xFFB84C }, // crows, pigeons; beak PAL.gold
  beast:    { base: 0x7A5C43, accent: 0xA8846A, outline: 0x38281C, eye: 0xF5C84C }, // hounds, possums
  construct:{ base: 0xB0483E, accent: 0xC8C4D4, outline: 0x4E1E1A, eye: 0xC8F03C }, // vacuums, appliances

  // ---- enemy tier & rank markers ----
  tier1:    0x9C93B0,   // floors 1-2 nameplate chevron (plum-gray)
  tier2:    0x5FA06A,   // floors 3-4 chevron (sewer moss)
  tier3:    0xE5484D,   // floors 5-6 chevron (ember)
  eliteRing:0xF5C84C,   // elites & bosses: gold ground-ring; boss adds pulsing outline

  // ---- the six statuses (chip fill; glyph is PAL.text, chip outline = darkened fill) ----
  stScratched: 0xE5484D,  // glyph '/'  (bleed)
  stFrazzled:  0xA855F7,  // glyph 'z'  (stun)
  stOffBal:    0xFF9F43,  // glyph '!'  (take +50%)
  stGuarded:   0x5B7A9A,  // glyph 'O'  (take -50%)
  stProvoked:  0xD9744F,  // glyph '>'  (must target provoker)
  stMending:   0x5FD068,  // glyph '+'  (regen)
} as const;
```

```ts
// ---- dungeon tile themes, keyed by enemy tier (dungeon.md floors 1-2/3-4/5-6) ----
export const THEMES = [
  { name: 'Cellars',      floorA: 0x2E2A3E, floorB: 0x332E45, wallFace: 0x201B30, wallTop: 0x4A3F66, accent: 0x8A9A5B },
  { name: 'Sewers',       floorA: 0x263636, floorB: 0x2B3D3B, wallFace: 0x1B2A2A, wallTop: 0x3F6660, accent: 0x3FC1C9 },
  { name: 'Ember Depths', floorA: 0x3A2A2A, floorB: 0x403030, wallFace: 0x2A1B1B, wallTop: 0x66463F, accent: 0xE8853B },
];
```

**HP bar fill is fraction-dependent:** `> 0.5 → PAL.heal`, `0.25–0.5 → PAL.warnYel`,
`< 0.25 → PAL.danger`; the track is always `PAL.hpBack` with a 1px `PAL.border`
outline. **Energy** is always `PAL.energy` pips on `PAL.hpBack`.

---

## 3. Typography (system/web-safe only)

Three `TextStyle` presets; every text object uses exactly one (size varies):

| Preset | fontFamily | Weight | Use | Sizes used |
|---|---|---|---|---|
| `DISPLAY` | `'Trebuchet MS', Verdana, sans-serif` | bold | Title logo, screen headers, "CAT PILE?!" banner, VICTORY/DEFEAT | 72 (logo), 40 (banner), 32 (header), 22 (event title) |
| `UI` | `Verdana, Geneva, sans-serif` | normal (bold for names) | Buttons, nameplates, tooltips, skill names, event body | 18 (buttons), 16 (event body, lineHeight 24), 14 (skill names, tooltips), 13 (nameplates, card names), 11 (chips, HP text, rank numerals) |
| `MONO` | `'Courier New', Courier, monospace` | bold | Damage numbers, log line, energy/HP numerals, status glyphs, seed display | 26 (damage; 34 crit; 22 DoT ticks), 14 (log), 12 (status chips), 11 (seed) |

Rules:
- Any text drawn over the `world` layer (damage numbers, nameplates, telegraph text)
  gets `stroke: { color: PAL.void, width: 4 }` (3 for sizes ≤ 14). Text on HUD panels
  gets no stroke.
- Word wrap: event body wraps at 740px; tooltips at 260px; log line is truncated with
  `…`, never wrapped.
- Never more than 3 font sizes visible in one panel.

---

## 4. Drawing a Cat (the core recipe)

One function draws all four classes: `drawCat(g: Graphics, cls: ClassId, pose: 'sit'
| 'battle', scale?: number)`. Design canvas **96×96**; origin = feet center (48, 92).
Battle cats face right (`scale.x = -1` flips enemies-side-facing sprites; enemies face
left). Draw order (painter's algorithm), all fills stroked 3px with `cls.outline`:

1. **Tail** — stroked cubic bezier, width 7, color `accent`, no fill:
   from (28, 82) via (10, 78) and (8, 56) to (18, 46) — an S-curl on the cat's left.
   Idle sway animates the last control point ±4px (§12).
2. **Body (seated pear)** — ellipse center (48, 66), rx 24, ry 22, fill `body`.
3. **Belly patch** — ellipse center (48, 74), rx 13, ry 12, fill `belly`, no outline.
4. **Front paws** — two ellipses rx 6, ry 4 at (38, 88) and (58, 88), fill `body`.
5. **Head** — circle center (48, 34), r 20, fill `body`.
6. **Ears** — left triangle (30,24)-(33,4)-(46,15), right mirrored around x=48; fill
   `body`. Inner-ear triangles inset 4px, fill `PAL.earInner`, no outline.
7. **Eyes** — two ellipses rx 4.5, ry 6 at (40, 33) and (56, 33), fill `cls.eye`, no
   outline; **pupils** rounded-rect 3×9, r 1.5, centered in each eye, fill `PAL.void`
   (vertical slit). Blink = tween eye `scale.y → 0.1 → 1` over 120ms.
8. **Nose + mouth** — triangle (45,40)-(51,40)-(48,44) fill `PAL.nosePink`; mouth =
   two 6px-radius arcs from the nose tip ("ω"), stroke 2 `cls.outline`.
9. **Whiskers** — 3 lines per side, stroke 1.5, `PAL.text` at alpha 0.55: from
   (34, 40±3) to (16, 36/40/45) and mirrored.
10. **Class marker** (silhouette differentiator, see table).

| Class | Cat | Silhouette differentiators (drawn after step 9) |
|---|---|---|
| Bruiser | **Bruno** | Whole cat at 1.12× scale; **notched left ear** (cut a triangle (36,10)-(40,14)-(38,6) of `bgDeep`); 3 tabby stripes = rounded-rects 14×4, r 2, fill `accent`, across the back at (30,58) / (34,66) / (32,74), rotated −15°. |
| Trickster | **Pixel** | 0.9× body scale (head full size — big-headed sneak); tail redrawn width 5 and 12px longer (tip at (4,40)); **red bandana**: triangle (36,50)-(60,50)-(48,62), fill `PAL.danger`, outline `0x8A2B2E`. |
| Hexer | **Mora** | **Witch hat** replaces ear tips: brim ellipse center (48,12), rx 17, ry 4.5, fill `PAL.panel`; cone triangle (36,12)-(60,12)-(54,-8), fill `PAL.panel`, hat band 2px `PAL.gold` line across the cone base; ears drawn shorter (tips y 10). |
| Medic | **Baguette** | Head r 22 (rounder); big white bib = `belly` ellipse enlarged to rx 15, ry 14; **collar bell**: line of 2px `accent` across neck at y 50 + circle r 3.5 at (48, 53), fill `PAL.gold`, outline `PAL.goldDark`. |

**Poses.** `sit` is the recipe above (title, event, results, exploration lead marker).
`battle` = same but body ellipse ry 20 and paws 4px forward — slight crouch. All
animation is tween-only on the container (position/rotation/scale); the cat is never
redrawn per frame.

**Mini-portrait** (HUD cards, timeline ribbon): steps 5–9 only (head, ears, eyes,
nose, whiskers at stroke 2), drawn at 48×48 into a container, scaled to fit the slot.
**KO'd portrait:** greyscale fills (`0x55506B` body, `0x9C93B0` accents), eyes
replaced by "×" glyphs (MONO 12, `PAL.textDim`).

**Nine Lives pips:** a cat's Lives render as 9 paw glyphs — circle r 2.5 + three
r 1.2 toe circles above, total 7×7px, fill `PAL.gold` (spent: `PAL.hpBack` fill,
1px `PAL.border` outline). Rows of 9 under portraits, 1px gaps.

---

## 5. Drawing Enemies (four families, distinct silhouettes)

Same 96×96 canvas, feet at (48, 92), 3px outlines, facing left. Family recipes (tier
palette from §2; a family's shapes never change between tiers — only nameplate
chevrons and stat blocks change, so learned silhouettes stay honest):

| Family | Silhouette (read at a glance) | Recipe |
|---|---|---|
| **Vermin** (rat, mouse) | low wide hunch + huge round ears + bare tail | Body: ellipse (48,72) rx 30, ry 20 `base`. Head: circle (26,58) r 14 merged into body front. Ears: two circles r 9 at (20,42) and (38,42), `base` fill, inner circles r 5 `PAL.earInner`. Muzzle cone: triangle (14,58)-(22,50)-(22,66). Tail: stroked polyline width 4 `PAL.earInner`-desaturated `accent`, zigzag (78,78)→(92,70)→(86,58)→(94,48). Eye: single circle r 3.5 `eye`. |
| **Bird** (crow, pigeon) | teardrop on stick legs + gold beak | Legs: two 2px lines (42,92)-(44,74) and (56,92)-(54,74). Body: ellipse (48,58) rx 20, ry 24 rotated −20° `base`. Wing: arc-shaped ellipse (54,58) rx 12, ry 18, fill `accent`, no outline. Head: circle (34,36) r 11. Beak: triangle (22,34)-(34,30)-(34,40) fill `PAL.gold`, outline `PAL.goldDark`. Eye: circle r 3 `eye`. Tail feathers: 3 rounded-rects 16×4 fanned from (66,66) at −10°/0°/+10°. |
| **Beast** (hound, possum) | tall boxy chest + drooping ears + snout block | Body: rounded-rect (30,40,36,52) r 12 `base`. Chest patch: ellipse (44,72) rx 10, ry 14 `accent` no outline. Head: rounded-rect (22,22,30,24) r 9. Snout: rounded-rect (12,34,16,12) r 5, nose circle r 3 `PAL.void` at (14,38). Ears: two rounded-rects 8×18, r 4, hanging from head top corners, rotated ±12°, fill `accent`. Eye: circle r 3.5 `eye`. Stub tail: circle r 5 at (70,50). |
| **Construct** (vacuum, appliance) | symmetric box + dome + hose + glowing eye-strip | Chassis: rounded-rect (26,48,44,40) r 6 `base`. Dome: half-circle r 22 centered (48,48) (arc + closePath) `base`. Eye-strip: rounded-rect (32,42,32,8) r 4, fill `PAL.void`, three r 2.5 circles inside, fill `eye` (blink by toggling alpha). Hose: stroked bezier width 6 `accent` from (30,60) via (8,52) and (6,76) to (18,84), nozzle rounded-rect 10×8 at the end. Wheels: two circles r 6 `accent` at (34,90), (62,90). No feet — hovers 2px (idle bob is ±3px, floatier). |

**Size grades by role:** minion 0.85×, standard 1.0×, elite 1.25× + gold ground-ring
(ellipse rx 34, ry 9, stroke 3 `PAL.eliteRing`, alpha 0.8, under feet), boss 1.6×.
**Bosses** additionally get: a pulsing outline (redraw stroke `PAL.eliteRing`, alpha
tween 0.4→0.9, 1.2s loop), one unique prop drawn per boss in data (e.g. the Vacuum
King's cardboard crown: 5-point zigzag strip 40×12, fill `PAL.gold`), and the Poise
pips on their nameplate (§8). `heavy` elites (non-boss) show a small anchor glyph
"▼" (MONO 12, `PAL.textDim`) next to the nameplate — the "you can't shove me" tell.

**Tier chevrons:** next to every enemy nameplate, `tier` chevron glyphs "‹" repeated
(1/2/3), MONO 12, colored `PAL.tier1/2/3`. Tier recolors nothing on the body.

Enemy visual data shape (in each enemy's data object):

```ts
interface EnemyLook {
  family: 'vermin' | 'bird' | 'beast' | 'construct';
  sizeGrade: 'minion' | 'standard' | 'elite' | 'boss';
  tier: 1 | 2 | 3;
  props?: ('crown' | 'shamanStaff' | 'scarf' | 'patchEye')[]; // tiny data-driven accessories
}
```

Props are 1–6 primitives each, drawn last: `shamanStaff` = 2px line + circle r 4
`THEMES[tier].accent`; `scarf` = Pixel's bandana recipe recolored; `patchEye` = eye
covered by 8×8 `PAL.void` rounded-rect + 1px strap line.

---

## 6. Shared HUD Widgets (used by every screen)

- **Bar** (`w×h`, default 64×7 units / 120×10 cards): track `PAL.hpBack`, 1px
  `PAL.border` outline, fill inset 1px, colored per §2. HP changes tween width over
  200ms; on damage, a `PAL.text` "ghost" segment lingers 300ms then shrinks (classic
  chip-away).
- **Energy pips:** 10 rounded-rects 6×8, r 2, gap 2 (78px total), fill `PAL.energy`
  when banked else `PAL.hpBack`. Gaining pips pop `scale 1.4→1` (120ms).
- **Status chips:** 16×16 rounded-rect r 4, fill = status color, 1px darkened
  outline, MONO-12 glyph `PAL.text` centered (glyphs in §2). Scratched/Mending show
  their stacked `value` as a 9px numeral bottom-right. Chips row is centered above a
  unit's head, 2px gaps; hover any chip → tooltip (UI-14, 260px, `PAL.panelLite`).
- **Hotkey chip:** 16×16 rounded-rect r 4, fill `PAL.gold`, MONO-12 numeral
  `PAL.textDark`. Disabled: fill `PAL.panel`, numeral `PAL.textDim`.
- **Button:** rounded-rect r 6, fill `PAL.panel`, 2px `PAL.border`; hover
  `PAL.panelLite` + border `PAL.gold`; pressed: offset content 1px down; disabled:
  alpha 0.5. Primary buttons (Enter-bound): fill `PAL.gold`, text `PAL.textDark`.
- **Panel:** rounded-rect r 8, fill `PAL.panel` alpha 0.92, 2px `PAL.border`.

---

## 7. Exploration Screen (1280×720)

```ts
R.explore = {
  viewport:  [0, 0, 1280, 632],     // world layer; tiles 48×48, camera on party
  floorChip: [12, 12, 232, 36],     // "Floor 2 — Cellars" UI-14 + theme accent dot
  seedChip:  [12, 52, 232, 22],     // "seed 8F3A21C9" MONO-11 PAL.textDim
  minimap:   [1080, 12, 188, 140],  // panel; map centered inside at 4px/tile
  partyStrip:[0, 632, 1280, 88],    // bottom HUD panel (square corners, full-bleed)
  catCards:  [[16,644,244,68],[272,644,244,68],[528,644,244,68],[784,644,244,68]],
  goldChip:  [1044, 644, 220, 30],  // coin (circle r7 PAL.gold + ring) + "128g" UI-14
  itemChips: [1044, 680, 220, 26],  // consumable glyph chips ×N (tuna/catnip/wand)
  toast:     [340, 560, 600, 48],   // centered event/pickup toast, auto-hide 2.5s
};
```

- **Tiles** (48×48): floor = `floorA`/`floorB` checkerboard by `(x+y)%2`, plus a 1px
  `wallFace`-colored inner border at alpha 0.15 (subtle grid). Walls = `wallFace`
  full tile with an 8px `wallTop` cap strip on the top edge (cheap depth). Stairs
  down = `PAL.void` circle r 16 + three shrinking gold arcs (descent swirl). Chest =
  20×14 rounded-rect `0xC98A3D`, lid strip `PAL.gold`, keyhole dot `PAL.void`.
  Event tile = "?" DISPLAY-22 `THEMES[t].accent` bobbing ±3px on a `PAL.panel`
  circle r 14. Door = wall tile with 32×40 `floorA` arch inset.
- **Fog of war:** unexplored = tile not drawn (void). Seen-but-not-visible = tile
  drawn, then a `PAL.bgDeep` alpha-0.55 quad over it. Visible = full color. (Fog
  data comes from dungeon layer; renderer just reads 3 states.)
- **Party marker:** lead cat mini-portrait (head recipe, 32px) on a `PAL.panel`
  circle r 18 with 2px class-outline ring; 3 trailing dots r 4 in the other cats'
  body colors, following 0.6 tiles behind along the path. Roamers: family silhouette
  at 32px with a `PAL.danger` r 4 alert dot that pulses when the party is within
  their sight range (dungeon layer flag).
- **Minimap:** 4px/tile rects — seen floor `PAL.border`, visible floor `0x6E6188`,
  walls omitted (background shows), stairs `PAL.gold` 4×4, chests `0xC98A3D`,
  events `THEMES[t].accent`, visible roamers `PAL.danger` dots, party = blinking
  `PAL.gold` dot (2Hz). Maps larger than 45×31 tiles scale down to fit the panel.
- **Cat card** (244×68): mini-portrait 48×48 at x+8,y+10 → name UI-13 bold in class
  body color → HP bar 120×10 + "31/40" MONO-11 right of it → Lives pip row (9 paws,
  §4) beneath. KO'd-then-revived cats just show low HP; a cat at 0 Lives shows the
  card at alpha 0.35 with "GONE" UI-11 `PAL.danger` across it.
- **Controls:** WASD/arrows = step (one tile per press/repeat at 8 steps/s held);
  mouse click on a visible tile = auto-path (cancels on any keypress or roamer
  sighting); `M` toggles a full-screen map overlay (same minimap renderer at
  12px/tile on scrim); `E`/`Enter` = interact with the faced tile.

---

## 8. Combat Screen (1280×720)

Side-view formation battle, matching combat.md §1 exactly: cats left (ranks 4-3-2-1,
front toward center), gap, enemies right (ranks 1-2-3-4-5).

```ts
R.combat = {
  ribbon:    [160, 8, 960, 60],     // initiative timeline (frozen per round)
  roundChip: [24, 16, 120, 32],     // "ROUND 3" UI-14 bold
  fleeChip:  [1136, 16, 120, 32],   // "R Scatter!" chip; hidden in boss fights
  battlefield:[0, 84, 1280, 440],   // world layer; ground line y = 460
  // rank slot centers on the ground line (x positions; unit feet sit here):
  catSlots:   { 1: 544, 2: 440, 3: 336, 4: 232 },
  enemySlots: { 1: 736, 2: 840, 3: 944, 4: 1048, 5: 1152 },
  logLine:   [16, 540, 1248, 26],   // latest event, MONO-14; click or L = scrollback
  skillBar:  [16, 576, 824, 128],   // 6 slots
  slotRects: [[24,584,128,112],[160,584,128,112],[296,584,128,112],
              [432,584,128,112],[568,584,128,112],[704,584,128,112]],
  activePanel:[856, 576, 408, 128], // active cat readout
};
```

### Battlefield

- Backdrop: `bgDeep` fill; THEME-tinted ground band (`floorA`) from y 460 to 524;
  6 seeded alley props (trash-can cylinders, brick rects, a moon circle `PAL.text`
  alpha 0.12 at (640, 150) r 70) in `wallFace`, alpha 0.5 — silhouettes only.
- **Rank slots:** shadow ellipse rx 34, ry 9, `PAL.void` alpha 0.5 at each slot
  center; rank numeral UI-11 `PAL.textDim` 12px below the ground line. The **active
  unit's** slot ellipse is stroked 3px `PAL.gold` and pulses (alpha 0.5→1, 0.8s).
- **Units** stand feet-on-slot at 1.0 scale (96px canvas). Cats face right, enemies
  face left. Above each head: status chip row; below feet: HP bar 64×7; cats add
  the 10-pip energy row (48px wide mini-pips 4×6) under the HP bar. Nameplate
  (UI-13 + tier chevrons + `heavy` anchor glyph) appears on hover, above status
  chips.
- **Boss extras:** Poise pips — N diamonds 12×12 (rotated squares, fill `PAL.gold`,
  spent = `PAL.hpBack` + gold outline) always visible above the boss's status row.
  **Charging telegraph:** "!" DISPLAY-32 `PAL.gold` bouncing (±6px, 2Hz) over the
  boss + the threatened cat-rank slots flooded `PAL.danger` alpha 0.25 + telegraph
  text on the log line. Phase switch: boss body accent recolors to its phase-2
  accent (data field), plus §12 effects.
- **Off-Balance units** tilt 8° (container rotation, away from their front) with 3
  orbiting `offBal` star glyphs "✶" MONO-12 above the head — the single most
  important state read in the game, so it gets silhouette (tilt) + color + icon.

### Initiative ribbon (960×60)

One chip per queue entry, laid left→right in action order, 8px gaps: 44×44 rounded-
rect r 6, containing a 36px mini-portrait (cat classes / enemy family heads). Acted:
alpha 0.35. **Current actor:** chip enlarges to 56×56, rises 4px, 2px `PAL.gold`
border. Dead entries collapse (width→0, 150ms). Boss double-turn = two chips with a
small "×2" MONO-11 tag. A `PAL.border` 2px vertical divider ends the round; after it,
a `PAL.textDim` "next round…" UI-11 label (next round's order is unrolled — never
shown, only implied). Hover a chip → nameplate tooltip. Frazzled entries get the
'z' status glyph overlaid on the chip.

### Skill bar (6 slots, hotkeys 1–6)

Slot layout (128×112): hotkey chip top-left (§6) → skill name UI-14 bold (wraps to
2 lines) → cost row: N energy pips 6×8 (`PAL.energy`; "FREE" UI-11 for cost 0) →
**range strip**: nine 8×8 squares in a row — cat ranks 4..1 (left, filled `PAL.gold`
if in `usableFrom`, else `PAL.hpBack`), a 4px gap glyph, enemy/ally ranks 1..5
(filled `PAL.danger` for enemy-target ranks / `PAL.heal` for ally, `row` pattern
underlines the strip 2px). This makes every skill's geometry visible without
reading text. Move glyphs: `moveTarget` shows "→N"/"←N" MONO-11 `PAL.offBal` at
strip right; `moveSelf` shows it in `PAL.energy`.

Slot assignment per cat: **[1] Claw Swipe, [2–4] class skills, [5] Guard,
[6] Item** (opens a 3-row item flyout above the slot; item rows reuse the Skill
shape). **Move = arrow keys / clicking an adjacent cat's slot** (swap forward/back;
shown as a ghost arrow between the two cats on hover). **Scatter! = R** (top-right
chip; disabled + hidden vs bosses). Unaffordable/out-of-rank slots: desaturated
(fill `PAL.panel`, name `PAL.textDim`) with the *reason* in the tooltip ("Needs
rank 3–4 — Pixel is at rank 2").

### Active panel (408×128)

Active cat's full portrait 96px (battle pose) at left → name + class UI-14 bold →
big energy readout: 10 pips 10×14 + "6/10" MONO-14 → Lives paw row → current
statuses with durations (chips + "2r" MONO-11).

### Targeting flow

1. Press 1–6 / click slot → slot border goes `PAL.gold`; all **valid targets** get
   a pulsing gold underline ellipse; invalid units dim to alpha 0.6.
2. Hover/arrow-cycle (←/→) a target → **preview chip** above it: "≈12" MONO-14
   (expected damage at variance 1.0, no crit — same math as AI `expectedDamage`;
   heals "≈+11" in `PAL.heal`). If the skill has `moveTarget`, a ghost arrow (3px
   `PAL.offBal` line + arrowhead, dashed 6/4) shows the clamped shove path, and an
   Off-Balance chip previews on the destination — or a **Poise diamond chips** on a
   `heavy` target. `row` skills highlight every occupant at once, with one preview
   chip each.
3. Click / Enter confirms; Esc / right-click cancels back to the bar. Self/no-target
   skills (Hiss, Guard) fire on confirm immediately with the panel as the "target".

### Cat Pile prompt

When the engine emits `CatPilePrompt`, timeline pauses and a banner slides down to
[340, 260, 600, 140]: "CAT PILE?!" DISPLAY-40 `PAL.gold`, subtitle UI-14 "each enemy
takes {n} — or keep them Off-Balance…", two buttons: primary "[Enter] PILE ON"
(gold) and "[Esc] hold" (default). Declining collapses the banner in 150ms; combat
never waits on animation otherwise.

### Floating numbers & log

- Damage: MONO-26 `PAL.text`, 4px void stroke, spawns at target head-height ±6px
  jitter, rises 44px over 600ms (quadOut), fades in the last 200ms. Crit: MONO-34
  `PAL.crit` + "!" and a 1.3→1 scale pop. Off-Balance bonus hits append "✶" in
  `PAL.offBal`. Heals: "+N" `PAL.heal`. DoT ticks: MONO-22. Status applications
  float the chip glyph + name UI-13 in the status color ("OFF-BALANCE!",
  "GUARDED"). Multi-target hits stagger 90ms per target in rank order.
- Log line: latest event sentence, MONO-14 `PAL.textDim` ("Mora's Yank of Yarn drags
  Crow Shaman to rank 1 — Off-Balance!"). Click or `L` → scrollback panel
  [16, 300, 560, 236] (panel style, last 40 events, wheel-scroll), Esc closes.

---

## 9. Event Dialog (modal over exploration)

```ts
R.event = {
  scrim: [0, 0, 1280, 720],         // PAL.scrim alpha 0.6
  panel: [240, 96, 800, 528],
  glyph: [272, 128, 96, 96],        // event icon, procedural (see below)
  title: [392, 140, 620, 32],       // DISPLAY-22 PAL.gold
  body:  [272, 240, 736, 140],      // UI-16, lineHeight 24, wrap 736
  options: [[272, 396, 736, 52], [272, 456, 736, 52], [272, 516, 736, 52]],
  leave:   [272, 576, 736, 36],     // always-present Leave row, UI-14 PAL.textDim
};
```

- Option row = button (§6) with hotkey chip **1–3** left, option text UI-16, and a
  right-aligned **gate chip** when gated: "[Bruiser]" / "[SPD 7+]" / "[25g]" UI-11
  on `PAL.panelLite` — `PAL.gold` text if met, `PAL.textDim` + row disabled if not
  (disabled rows stay visible: showing locked doors sells build value). Leave is
  bound to `4` and `Esc`.
- Outcome: the panel body swaps to the result text + reward/penalty chips (item
  glyph, "+30g", a cracking paw pip for Life loss), and options are replaced by one
  primary "[Enter] Continue" button.
- **Event glyphs** (pick per event in data, 96×96, chunky + outlined): `yarnBall`
  (circle r 34 `THEMES[t].accent` + 3 crossing bezier strands), `fishBones` (oval
  head + 5 rib lines + tail triangles, `PAL.text`), `pawShrine` (rounded-rect stone
  `PAL.panelLite` + §4 paw glyph at 4× scale, `PAL.gold`), `strangeBox` (cardboard
  rounded-rect `0xC98A3D` + "?" DISPLAY-32). Four glyphs cover v1; events reference
  them by id.

---

## 10. Results Screens

**Post-battle victory panel** (auto after `Victory` event): panel [340, 100, 600,
520]. Contents top-down: "VICTORY" DISPLAY-32 `PAL.gold` (drops in with backOut
scale 1.4→1) → loot rows (item glyph chip + name UI-16 + "+Ng" gold text; each row
pops in 120ms apart) → XP bar per cat (bar 320×10 `PAL.energy`, fills tweened
400ms; level-up flashes the card gold + "LEVEL UP!" UI-13) → **Lives ledger**: any
cat that was still KO'd shows its card with a paw pip cracking (pip flashes
`PAL.danger`, splits into 2 falling halves — 4 triangles, 500ms) and "-1 Life"
MONO-14 `PAL.danger` → primary "[Enter] Continue". Defeat in battle skips straight
to the run-end screen.

**Run-end screen** (defeat, or floor-6 win): full `bgDeep` screen. "THE ALLEY
REMEMBERS" (defeat) / "NINE LIVES WELL SPENT" (win) DISPLAY-40 centered y 140 →
stats block MONO-14 two columns [400, 220, 480, 240] (floors, battles, gold, cats
lost, seed) → the four cats in `sit` pose at y 480, spaced 120px, centered — dead
cats rendered in KO greyscale, survivors idle-bobbing → "[Enter] New Run"
primary + "[S] Same Seed" buttons at y 620.

---

## 11. Title Screen

- Backdrop: `bgDeep`; 40 seeded stars (r 1–2 `PAL.text` circles, alpha 0.3–0.8,
  slow 4s twinkle); moon circle r 90 fill `PAL.text` at (980, 150) with a r 82
  `bgDeep` crater circle offset (+18, −12) (crescent); rooftop skyline = one
  `PAL.void` polygon strip across y 470–720 with 8–10 rectangular chimney/gable
  teeth.
- The four cats sit on the rooftop at y 470: x = 420 / 520 / 620 / 720 (Bruno,
  Pixel, Mora, Baguette, sit pose, 1.0 scale), tails swaying out of phase; eyes
  blink on independent 3–7s timers.
- Logo: "c(at)rpg" DISPLAY-72 centered at (640, 200) — "c", "rpg" in `PAL.text`,
  "(at)" in `PAL.gold`; whisker flourish = 3 lines per side (stroke 2, `PAL.textDim`)
  angled off the logo baseline. Subtitle UI-18 `PAL.textDim` at y 260: "a cRPG of
  considerable fluffiness".
- Menu buttons (§6, 280×48, centered x, y 360/420/480): "[Enter] New Run",
  "[S] Seed…" (opens a MONO-14 text-entry chip; typed seed shown live), "[H] How to
  Play" (3-page panel of UI-16 text + the §4/§5 recipes as living illustrations).
  Current seed chip MONO-11 bottom-left (12, 692). Version bottom-right.

---

## 12. Juice (the whole animation budget)

One 40-line tween helper drives everything:
`tween(obj, props, ms, ease, onDone?)` with eases `linear`, `quadOut`, `backOut`
(overshoot 1.7). No animation library. All effects are fire-and-forget on `fx` /
unit containers and never block engine event consumption by more than 350ms
(events queue and drain at ≥3/s even mid-animation).

1. **Attack lunge** — actor tweens 28px toward its target (90ms quadOut), then back
   (180ms quadOut). Ranged/back-rank actors instead do a 6px hop + a 12px recoil.
2. **Hit flash + jitter** — victim fills swap to solid `PAL.text` for 2 frames (tint
   white via a `flash` overlay quad matched to the unit bounds), then `PAL.danger`
   tint 60ms; container x-jitter ±5px decaying over 150ms.
3. **Screen shake** — `world`+`fx` offset by random angle, amplitude decaying to 0
   over 250ms. Amplitudes: 3px Poise chip / KO, 5px crit / phase switch, 8px Cat
   Pile / boss nuke landing. Never shakes the HUD (§1).
4. **Floating numbers** — §8 spec (rise 44px / 600ms / late fade, crit pop 1.3→1).
5. **Off-Balance wobble** — on application: rotation ±10° oscillating at 5Hz,
   decaying to the resting 8° tilt over 400ms; the 3 orbit stars (§8) circle at
   0.8 rev/s while the status lasts. On expiry/consumption: 150ms ease back to 0°.
6. **Cat Pile dust cloud** — 5 overlapping `PAL.textDim` circles r 24–40 at the
   enemy line's center, alpha-pulsing 0.6→0.3, with 4 paw glyphs (§4, 3× scale,
   class colors) and 2 "✶" poking out at tweened random angles; 700ms hold, then
   all enemies' numbers land at once + shake 8. Cats blink out/in at their slots
   (alpha 0→1) rather than pathing — cheaper and funnier.
7. **Poise break shockwave** — expanding circle stroke (r 20→90, width 6→1,
   `PAL.gold`, alpha 1→0, 400ms) centered on the boss + all Poise diamonds shatter
   (each splits into 2 triangles that fall 30px and fade) + the boss tips into its
   Off-Balance tilt in 200ms backOut.
8. **KO poof** — unit squashes (scaleY→0.15, 120ms), then 4 `PAL.textDim` circles
   r 8 puff outward and fade (250ms) as it vanishes; corpse-slide then tweens every
   unit behind it forward one slot (200ms quadOut) — the rank system's most
   important readability beat, so nothing else may play during the slide.

Freebie ambience (near-zero cost, always on): **idle bob** — every unit
`y += sin(t·2π/1.6s + rank·0.9) · 2px`; tails/hose sway ±4px at matching phase;
eye blinks on 3–7s `Math.random()` timers.

---

## 13. Scope & Module Budget (renderer side)

| Module | ~LoC | Contents |
|---|---|---|
| `ui/palette.ts` + `ui/layout.ts` | 120 | §2 PAL/THEMES, §§7-11 rect consts, TextStyle presets |
| `ui/draw/cats.ts` | 180 | §4 recipe, 4 class variants, mini-portrait, KO/greyscale, Lives paws |
| `ui/draw/enemies.ts` | 200 | §5 four families, size grades, props, tier chevrons |
| `ui/widgets.ts` | 180 | §6 bar, pips, chips, buttons, panels, tooltips |
| `ui/tween.ts` | 60 | tween core + 3 eases + shake |
| `screens/title.ts` | 120 | §11 |
| `screens/explore.ts` | 300 | §7 tiles, fog, minimap, party strip, toasts, input |
| `screens/combat.ts` | 550 | §8 (this is `battle/ui.ts` from combat.md §14: ribbon, slots, skill bar, targeting, floaters, log, Cat Pile prompt) |
| `screens/event.ts` + `screens/results.ts` | 220 | §§9-10 incl. event glyphs |
| **Total** | **~1930** | fits the "few thousand lines total" pitch alongside the ~1500-line engine |

Performance notes: every static drawing (cats, enemies, tiles via one
`GraphicsContext` per tile type, panels) is drawn once and reused; per-frame work is
tweens + ≤4 `BitmapText` floaters + the fog overlay. Comfortably 60fps.
