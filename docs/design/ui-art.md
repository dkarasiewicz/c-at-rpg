# c(at)rpg — UI & Art Direction
## "Midnight Picture-Book" (procedural-only art bible)

Companion to `combat.md` (Nine Lives: Pounce & Poise). Everything on screen is PixiJS v8
`Graphics` primitives and `Text` — zero image assets, zero external fonts. This document is
exact: hex values, pixel rectangles at the 1280×720 design resolution, draw recipes with
coordinates, and data shapes. If a number is here, it is the number.

**The look in one sentence:** a children's-picture-book alley at 3 AM — chunky flat shapes
with thick dark outlines, a deep plum night everywhere, and small pools of warm gold where
the player should look.

Art pillars:

1. **Chunky flat + fat outline.** Every gameplay shape gets a 2px (UI) / 3px (units)
   outline in a darker shade of its own fill. No gradients on characters, no textures.
   Reads at 50% scale, screenshots like a sticker sheet.
2. **Two-and-a-half colors per thing.** Each cat/enemy/tile is base + accent + outline
   (+ eye color). Silhouette and palette do the identification work, not detail.
3. **Dark stage, lit actors.** Backgrounds sit in the `#1A1626`–`#332E45` band; units and
   interactive UI are 2–4 steps lighter. Gold (`#F5C84C`) is reserved for "act here now":
   the active unit, legal targets, hotkey chips, stairs, the Poise meter.
4. **Text is an art material.** Skill icons, status chips, damage numbers, paw prints —
   single glyphs in chunky monospace on colored chips. Cheap, crisp, data-driven.

---

## 1. Global Rendering Rules

- **Design resolution 1280×720.** One root `Container` holds the whole game. On resize:
  `scale = min(innerWidth/1280, innerHeight/720)`; scale the root uniformly, center it,
  fill the letterbox with `PAL.void`. Never lay out against window size — always 1280×720
  virtual pixels. `app.init({ antialias: true, resolution: devicePixelRatio, autoDensity:
  true, background: PAL.void })`.
- **Layer stack** (children of root, bottom→top): `bg` → `world` (tiles or battlefield;
  units y-sorted) → `fx` (dust, stars, pile cloud) → `hud` (panels, bars, ribbon) →
  `floaters` (damage numbers) → `modal` (event dialog, results) → `flash` (full-screen
  flash quad) — screen shake offsets `world`+`fx` only, so the HUD never shakes.
- **Visual RNG is `Math.random()`**, never the battle's mulberry32 stream. Shake angles,
  blink timers, dust scatter must not consume gameplay rolls (determinism contract, §3 of
  combat.md).
- **Text performance:** damage numbers and the log use `BitmapText` (install one
  `BitmapFont` from the monospace style at load); everything else is plain `Text`.
  `roundPixels: true` on all text.
- All rectangles below are `{x, y, w, h}` in design pixels. Corner radius is 8 for panels,
  6 for buttons, 4 for chips unless stated.

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
  gold:      0xF5C84C,  // ACTIVE / attention accent (borders, hotkeys, stairs, Poise)
  text:      0xF2EDE4,  // primary text (warm off-white)
  textDim:   0x9C93B0,  // secondary text
  textDark:  0x1A1626,  // text on gold chips
  danger:    0xE5484D,  // damage, HP-low, Flee, KO
  heal:      0x5FD068,  // heals, full HP
  warnYel:   0xF5C84C,  // mid HP (same as gold)
  vigor:     0x3FC1C9,  // Vigor pips, event markers
  crit:      0xFFE066,  // crit numbers
  weak:      0xFF9F43,  // "WEAK!" tag popup
  resist:    0x8A93A6,  // "resist" tag popup
  hpBack:    0x241F33,  // empty bar track
  scrim:     0x000000,  // modal scrim at alpha 0.6

  // ---- 4 cat classes (body / accent / belly / outline / eye) ----
  bruiser:   { body: 0xE8853B, accent: 0xB35F1F, belly: 0xF7C08A, outline: 0x5C3212, eye: 0xFFB84C },
  pouncer:   { body: 0x33303F, accent: 0xEDEDED, belly: 0x4A4560, outline: 0xA9A3BC, eye: 0xC8F03C }, // light outline: dark cat on dark bg
  oracle:    { body: 0xA98BD6, accent: 0x6E549C, belly: 0xD6C7F0, outline: 0x4A3670, eye: 0xFFE066 },
  purrmedic: { body: 0xF2E3C6, accent: 0xD9A066, belly: 0xFBF3E0, outline: 0x8A6A3F, eye: 0x7EC8E3 },
  earInner:  0xE8A0A8,  // shared pink
  nosePink:  0xD97B8A,

  // ---- enemy families (base / accent / outline / eye) ----
  rodent:    { base: 0x8A7264, accent: 0xB09484, outline: 0x3E3028, eye: 0xE5484D },
  blob:      { base: 0x8D8A9C, accent: 0xA5A2B5, outline: 0x4E4B5E, eye: 0x2A2430 },
  toad:      { base: 0x7A8450, accent: 0xB0B878, outline: 0x39402A, eye: 0xF5C84C },
  bird:      { base: 0x6E7B8A, accent: 0xB8C2CE, outline: 0x2E3640, eye: 0xFFB84C },
  bug:       { base: 0x5C4A6E, accent: 0x9B7FB8, outline: 0x2A2038, eye: 0xC8F03C },
  eliteRing: 0xF5C84C,  // elites: gold ground-ring + 1.25x scale
  bossGlow:  0xF5C84C,  // bosses: pulsing gold outline

  // ---- status chip colors (see §7) ----
  stStartled: 0xA855F7, stRuffled: 0xE8853B, stBleeding: 0xE5484D, stGunked: 0x8A9A5B,
  stZoomies:  0x3FC1C9, stStalking: 0xF5C84C, stGuarding: 0x5B7A9A, stWary: 0x9C93B0,
};

// ---- dungeon tile themes, one per floor (cycle after 3) ----
export const THEMES = [
  { name: 'Cellar',       floorA: 0x2E2A3E, floorB: 0x332E45, wallFace: 0x201B30, wallTop: 0x4A3F66, accent: 0x8A9A5B },
  { name: 'Sewers',       floorA: 0x263636, floorB: 0x2B3D3B, wallFace: 0x1B2A2A, wallTop: 0x3F6660, accent: 0x3FC1C9 },
  { name: 'Ember Depths', floorA: 0x3A2A2A, floorB: 0x403030, wallFace: 0x2A1B1B, wallTop: 0x66463F, accent: 0xE8853B },
];
```

HP bar fill is fraction-dependent: `> 0.5 → PAL.heal`, `0.25–0.5 → PAL.warnYel`,
`< 0.25 → PAL.danger`; track is always `PAL.hpBack` with a 1px `PAL.border` outline.

---

## 3. Typography (system/web-safe only)

Three `TextStyle` presets; every text object uses one of them (size varies):

| Preset | fontFamily | Weight | Use | Sizes used |
|---|---|---|---|---|
| `DISPLAY` | `'Trebuchet MS', Verdana, sans-serif` | bold | Title logo, screen headers, "CAT PILE!" banner, VICTORY | 72 (logo), 40 (banner), 32 (header) |
| `UI` | `Verdana, Geneva, sans-serif` | normal (bold for names) | Buttons, nameplates, descriptions, event body | 18 (buttons), 16 (event body), 14 (skill names), 13 (nameplates), 11 (hotkey chips, HP text) |
| `MONO` | `'Courier New', monospace` | bold | Damage numbers, log line, Vigor/HP numerals, status glyphs, seed display | 24 (damage; 32 crit), 14 (log), 12 (status chips) |

Rules: any text drawn over the world (damage numbers, nameplates) gets
`stroke: { color: PAL.void, width: 3 }`. Event body text uses `wordWrap: true,
wordWrapWidth: 720, lineHeight: 24`. Letter-spacing 1 on `DISPLAY`. No other fonts, ever.

---

## 4. Drawing a Cat (the recipe)

One function draws all four classes: `drawCat(g: Graphics, look: CatLook, pose: 'sit')`.
Local space: **origin at the feet (bottom-center)**, y negative = up, unit fits in
64 wide × 66 tall. Rendered at scale 1.5 in battle (≈96px tall), 0.75 in the exploration
party snake, 0.55 for turn-ribbon chips (head only), 1.1 for portraits (head+chest crop).

Draw order (painter's algorithm), all shapes `.fill(color)` then
`.stroke({ width: 3, color: look.outline, join: 'round' })`:

1. **Tail** — path `moveTo(12,-10).quadraticCurveTo(34,-6, 30,-34)`, stroke only,
   `width: 6, cap: 'round'`, color `look.accent`. (Idle sway animates the control point.)
2. **Haunch body** — ellipse center `(0,-15)`, radii `(17,15)`, fill `look.body`.
3. **Chest** — ellipse `(0,-27)`, radii `(10,13)`, fill `look.body` (no stroke on the
   overlap edge: stroke chest first, then re-fill body region — in practice stroke both;
   the doubled line reads as fur crease and looks good).
4. **Belly patch** — ellipse `(0,-22)`, radii `(6,9)`, fill `look.belly`, no stroke.
5. **Front paws** — two ellipses `(-6,-4)` and `(6,-4)`, radii `(4.5,3.5)`, fill
   `look.body`, stroke 2.
6. **Head** — circle `(0,-44)`, r `13`, fill `look.body`.
7. **Ears** — triangles: left `(-11,-50) (-3,-53) (-10,-64)`, right mirrored
   `(11,-50) (3,-53) (10,-64)`; fill `look.body`, stroke 3. **Inner ears**: triangles at
   60% size, same centroid, fill `PAL.earInner`, no stroke.
8. **Eyes** — ellipses `(-5,-45)` and `(5,-45)`, radii `(2.4,3.2)`, fill `look.eye`,
   no stroke; **pupils** ellipses radii `(1,2.6)` fill `0x1A1626`; **glints** circles
   r `0.8` at `(-4.3,-46.2)` / `(5.7,-46.2)` fill white. Blink = eye container
   `scale.y = 0.1` for 100ms.
9. **Muzzle** — nose triangle `(-2,-40) (2,-40) (0,-37.5)` fill `PAL.nosePink`; mouth:
   two 3px-radius arcs from the nose tip, stroke 1.5 `look.outline`.
10. **Whiskers** — 3 lines per side from `(±6,-40)`: to `(±16,-42)`, `(±17,-40)`,
    `(±16,-38)`; stroke `{ width: 1.5, color: 0xF2EDE4, alpha: 0.75 }`.
11. **Class marking + accessory** (see table).

```ts
// src/ui/looks.ts
interface CatLook {
  body: number; accent: number; belly: number; outline: number; eye: number;
  marking: 'stripes' | 'sock' | 'thirdEye' | 'patch';
  accessory: 'earNotch' | 'none' | 'beadCollar' | 'bellCollar';
}
export const CAT_LOOKS: Record<ClassId, CatLook> = {
  bruiser:   { ...PAL.bruiser,   marking: 'stripes',  accessory: 'earNotch'   },
  pouncer:   { ...PAL.pouncer,   marking: 'sock',     accessory: 'none'       },
  oracle:    { ...PAL.oracle,    marking: 'thirdEye', accessory: 'beadCollar' },
  purrmedic: { ...PAL.purrmedic, marking: 'patch',    accessory: 'bellCollar' },
};
```

| Class | Silhouette tweak | Marking (drawn with `accent`) | Accessory |
|---|---|---|---|
| **Bruiser** | body radii ×1.15 wide (barrel chest) | 3 stripes: roundRects 10×3, r1.5, at `(-4,-20) (-2,-14) (-4,-8)` rotated −15° | left ear has a notch: cut triangle `(-9,-60) (-6,-62) (-8,-57)` filled `PAL.bgDeep` |
| **Pouncer** | body radii ×0.9 narrow (sleek), tail 20% longer | white sock: left paw filled `accent` instead of body | none (clean silhouette) |
| **Oracle** | ears +15% taller | third-eye diamond on forehead: poly `(0,-52) (2.5,-49) (0,-46) (-2.5,-49)` fill `PAL.gold` | bead collar: 5 circles r1.8 across the neck at y −33, fill `accent` |
| **Purrmedic** | default | patch over right eye: circle r5 at `(5,-46)` fill `accent`, under the eye redraw | red collar: arc stroke width 3 color `PAL.danger` at y −33 + bell circle r2.5 fill `PAL.gold` at `(0,-30)` |

**KO'd cat:** the blob is replaced by a ghost — same head shape at alpha 0.5 in
`0xC9C4DE`, wavy skirt (`quadraticCurveTo` zigzag) instead of a body, eyes drawn as two
`×` strokes — which floats up 30px and fades over 600ms, leaving an empty slot.

---

## 5. Drawing Enemies (family grammar)

One draw function per **family** (5 families ship v1); species = family + palette +
`props`. Distinct silhouette = distinct aspect ratio + distinct protrusion count, so
families are tellable in pure black. Same local space (feet origin), base size ≈56 wide.

```ts
interface EnemyLook {
  family: 'rodent' | 'blob' | 'toad' | 'bird' | 'bug';
  base: number; accent: number; outline: number; eye: number;
  scale: number;                     // 1 = normal, 1.25 elite, 2.6–3 boss
  props: ('hood' | 'flute' | 'warts' | 'crown' | 'crestFeather' | 'stinger')[];
}
```

| Family | Recipe (fill `base`, stroke 3 `outline`) | Reads as |
|---|---|---|
| **rodent** | Horizontal teardrop: ellipse `(0,-12)` radii `(19,11)` + snout triangle to `(26,-10)`; 2 round ears (circles r5 at `(-8,-24)`, `(0,-26)`, inner `PAL.earInner`); tail = 3-segment polyline from `(-18,-8)` to `(-34,-16)` stroke 3 `accent`; beady eye circle r2 `eye` + white glint; 2 whisker lines; front paws 2 tiny circles. | long + low, pointy nose |
| **blob** (dust bunny) | Cluster of 3 overlapping circles r `10/8/7` at `(-5,-10) (6,-12) (0,-18)` fill `base`; 5 lint wisps = stroke-only arcs r2 `accent` scattered on the rim; two BIG eyes: white circles r4 at `(-3,-16) (5,-16)` with dark pupils r2 `eye`; no limbs. Idle = whole body jitters ±1px. | round + fuzzy + huge eyes |
| **toad** | Squat half-ellipse: ellipse `(0,-11)` radii `(21,13)` flattened by drawing ground line; throat sac circle r6 at `(0,-6)` fill `accent` (inflates 1.0→1.15 on idle sine); two bulge eyes ON TOP: circles r4.5 at `(-8,-25) (8,-25)` fill `base` with vertical slit pupils (2×5 rects `eye`... pupil fill dark, iris `eye`); wart dots r1.5 ×4 `accent` if `props` has `warts`; splayed feet = 2 flat triangles. | wide + low + eyes on stalks |
| **bird** (floor 2 pigeon/crow) | Egg body: ellipse `(0,-16)` radii `(13,16)`; wedge tail poly `(-10,-14) (-24,-8) (-22,-18)`; head circle r8 at `(4,-32)`; beak triangle `(11,-32) (18,-30) (11,-28)` fill `accent`; stick legs 2 lines to ground; round eye r2. | upright egg + beak |
| **bug** (floor 3 roach/spider) | Dome: half-circle r14 at `(0,-8)`; head bump circle r6 at `(12,-10)`; 3 legs per side = polylines stroke 2.5 `outline` bending at knees (6 protrusions!); antennae 2 arcs from head; shell split line down the middle stroke 2 `accent`; if `stinger`: triangle at rear. | dome + many legs |

**Props:** `hood` = arc-capped triangle cowl over the head, fill `0x5B7A9A`, stroke 3
(Rat Piper); `flute` = 24×3 roundRect `0xD9CBA0` held at the snout, 3 hole dots; `crown` =
3-point gold zigzag polyline above the head (bosses); `crestFeather` = 2 curved strokes.

**Tiers & bosses:** floor tier shows via the THEME accent as a thin r2 rim-light stroke on
the body top edge (tier recognition without new shapes). **Elites**: `scale 1.25` + gold
ground ring (ellipse stroke 2, radii `(26,8)`, alpha pulsing 0.4–0.9). **Bosses**:
`scale 2.6–3.0`, drawn across 2 slot heights (combat.md §10), gold outline replaces
`outline` and pulses width 3→5 at 1 Hz, `crown` prop, and a **Poise meter** floats above
(see §10.6).

All units cast the same **shadow**: ellipse at `(0,0)` radii `(20·scale, 6·scale)`, fill
`0x000000` alpha 0.35, drawn before the unit.

---

## 6. Iconography (glyphs on chips)

A "chip" = 16×16 roundRect r4, fill = chip color, 1px outline `PAL.void`, centered `MONO`
12px glyph in `PAL.text` (or `PAL.textDark` on gold).

**Tag glyphs** (skill buttons, bestiary, "WEAK!" popups):
`claw '≡'` · `bite '∧'` · `pounce '🐾'` · `yowl '♪'` · `trick '✦'` · unknown `'?'`
(`?` is reserved for undiscovered — that's why trick is `✦` even though the Curious Paw
*skill icon* is `?`; skill icons are per-skill data, tag glyphs are this fixed table).

**Status chips** (max 4 shown per unit, oldest dropped; Bleeding shows stack digit
bottom-right in 8px):

| Status | Glyph | Chip color |
|---|---|---|
| Startled | `!` | `PAL.stStartled` |
| Ruffled | `R` | `PAL.stRuffled` |
| Bleeding | `B` | `PAL.stBleeding` |
| Gunked | `G` | `PAL.stGunked` |
| Zoomies | `Z` | `PAL.stZoomies` |
| Stalking | `S` | `PAL.stStalking` |
| Guarding | `D` | `PAL.stGuarding` |
| Wary | `W` | `PAL.stWary` |

**Nine Lives paw:** drawn, not emoji — pad circle r4 + three toe circles r1.7 arced above,
fill `PAL.gold` when alive, stroke-only `PAL.border` when spent. 18×18 each, 4px gaps.

**Item glyphs:** tuna `▲` (fish-ish wedge, drawn poly in inventory), catnip `❋`, cucumber
`⌇` — rendered as glyph chips in item menus, 20×20.

---

## 7. Title Screen

Background: `bg` = full-rect `PAL.bgDeep`; a second rect `0x141020` for the lower third
(ground); **moon** circle r70 at `(1020, 140)` fill `0xF2EDE4` alpha 0.9 with crater
circles alpha 0.08; **roofline** silhouette polygon across `y 430–470` fill `PAL.void`;
12 star dots (circles r1–2, alpha 0.5–0.9, slow twinkle).

| Element | Rect / position | Spec |
|---|---|---|
| Logo | centered at `(640, 150)` | `DISPLAY` 72: `c(at)rpg` — `c`, `rpg` in `PAL.text`; `(at)` in `PAL.gold`. Sub-line `UI` 16 `PAL.textDim`: "nine lives. one dungeon." at `(640, 205)` |
| The four cats | seated ON the roofline at x `470, 585, 695, 810`, scale 1.3 | idle bob + blink + tail sway; hovering one shows its class name in a 14px tooltip |
| Menu buttons | `{x:490, y:490, w:300, h:56}`, next at y `558`, `626` | "NEW RUN" (Enter), "HOW TO PLAY" (H), "SEED: 428113" (S cycles → click to type digits). Button: `panel` fill, `border` 2px → hover: `panelLite` + `gold` border + raise 2px |
| Version/seed footer | `(16, 694)` | `MONO` 12 `PAL.textDim` |

"HOW TO PLAY" opens the event-dialog modal (§11) reused with 3 pages of controls text.

---

## 8. Exploration Screen

Tile size **48px**. Camera follows the party leader, lerp `0.15/frame`, clamped to map
bounds. The world renders only tiles intersecting the viewport (simple cull loop).

| Region | Rect |
|---|---|
| Viewport (world) | `{x:0, y:0, w:1280, h:656}` |
| Floor label chip | `{x:16, y:16, w:200, h:32}` — "FLOOR 2 · SEWERS", `UI` 14 on `panel` alpha 0.85 |
| Minimap | `{x:1096, y:16, w:168, h:168}` |
| Party status strip | `{x:0, y:656, w:1280, h:64}` |

**Tiles** (all Graphics, one `Graphics` object per visible chunk, redrawn on room reveal):
- Floor: 48×48 rect, checker `floorA`/`floorB`; 10% of floor tiles get a 2–3px pebble dot
  of `wallTop` alpha 0.4 (hash of tile coords, not RNG).
- Wall: `wallFace` rect with a 12px `wallTop` cap strip on top edge (fake depth).
- Stairs down: floor tile + 3 nested chevrons stroke `PAL.gold`.
- Door: `0x8A6A3F` rect inset 6px with 2px outline.
- Chest (loot): 32×22 roundRect `0xC98A3D` + lid line + `PAL.gold` clasp dot.
- Encounter entity: the enemy family blob at scale 0.75, idle-bobbing on its tile;
  patrols 1 tile back/forth. Elite ring if elite; boss door tile is framed in gold.
- Event marker: floating `✦` glyph chip in `PAL.vigor`, sine-bob ±3px.
- Unexplored: `PAL.void`; explored-but-not-visible: draw tiles then a `PAL.void` alpha 0.5
  cover rect per tile.
- **Light:** one radial `FillGradient` circle (black alpha 0 → 0.85, radius 300) centered
  on the party, drawn into an overlay that covers the viewport — the torch pool.

**Party in the world:** leader cat at scale 0.75 + 3 followers trailing snake-style
(follower i lerps toward the position 10 frames behind i−1). Movement: WASD/arrows, one
tile per 140ms held; cats hop (y −4px arc) per tile.

**Minimap** (168×168, `panel` fill alpha 0.85, 2px `border`): 4px/tile, centered on the
party — shows a 42×42 tile window. Explored floor `#4A3F66`, walls omitted, party = 2×2
white blinking dot, stairs `PAL.gold`, encounter `PAL.danger`, event `PAL.vigor`, chest
`0xC98A3D`. Press **M**: expands to `{x:240, y:60, w:800, h:560}` at 8px/tile (toggle).

**Party status strip** — 4 class-colored cards + a run card:
- Cat card i: `{x: 12 + i*250, y: 662, w: 240, h: 52}`, `panel` fill, left edge 4px bar in
  class body color. Contents: head-only portrait 40×40 at x+6; name `UI` 13 bold; HP bar
  `{w:130, h:8}` under the name + `MONO` 11 `27/34`; up to 3 status chips (persisting
  statuses don't exist outside battle in v1, so this row shows KO ghost icon or nothing).
- Run card: `{x:1020, y:662, w:248, h:52}`: nine paw prints (top row), `MONO` 12 bottom:
  `🐟 23` fish (currency) + `⌘ seed` … drawn glyphs, plus `[E]vents log` hint.

Interaction hints: contextual chip bottom-center of viewport `{x:540, y:610, w:200, h:30}`
— "SPACE — open chest" / "SPACE — descend" when standing on a thing.

---

## 9. Combat Screen — layout

Cats on the **left**, enemies on the **right** (mirrors combat.md's row diagram).

| Region | Rect |
|---|---|
| Turn-order ribbon | `{x:0, y:0, w:1280, h:52}` |
| Battlefield | `{x:0, y:52, w:1280, h:456}` |
| Log line | `{x:16, y:508, w:1248, h:36}` |
| Bottom panel | `{x:0, y:548, w:1280, h:172}` |
| · Active-cat card | `{x:16, y:560, w:230, h:148}` |
| · Skill bar (6 buttons) | `{x:262, y:560, w:712, h:96}` |
| · Skill description strip | `{x:262, y:664, w:712, h:44}` |
| · Universal actions | `{x:990, y:560, w:274, h:96}` (2×2 buttons `132×44`, 8px gaps) |
| · Nine Lives row | `{x:990, y:664, w:274, h:44}` |

**Battlefield slots.** Slot positions are *ground points* (unit feet anchor). Units draw
at scale 1.5 (~96px tall); nameplates hang below the ground point.

```ts
// column x by (side, row); ground y by slot-within-row
const COL_X = { catBack: 200, catFront: 400, enemyFront: 880, enemyBack: 1080 };
const ROW_Y = [200, 320, 440];            // slot 0/3 → 200, 1/4 → 320, 2/5 → 440
// Boss: single unit at (880, 340), scale 3, occupies the whole enemy front column.
```

Background: `PAL.bgDeep` + THEME `wallFace` band `y 52–180` (back wall) with 3 brick
seam lines; ground = THEME `floorA` from y 180 down, with a center line of scattered
pebble dots. A faint gold spotlight ellipse (radii `(90,20)`, alpha 0.10) sits under the
currently acting unit.

**Nameplate** (per unit, 104×34, centered on ground point x, top at ground y + 8):
name `UI` 13 bold (class color for cats / `PAL.text` for enemies); HP bar 96×8 with
fraction coloring; status chip row (16×16 chips, 2px gaps) below. Enemies append the
bestiary readout right of the name: two mini tag chips `w:🐾` `r:♪` — glyphs replaced by
`?` until discovered (combat.md §7.3). Cats show a mini Vigor bar instead: 10 2×6 ticks
in `PAL.vigor`.

### 9.1 Turn-order ribbon

`panel` fill, bottom 2px `border`. Left: `ROUND 3` `DISPLAY` 20 at `(16,14)`. Chips start
at x 150: 40×40 roundRect r6 per queue entry in initiative order (combat.md §4), 8px gaps
— fill = class body color (cats) / family base (enemies) at alpha 0.35 with the unit's
head-only mini-face (scale 0.55) on top. **Active** chip: 48×48, gold 2px border, nudged
down 4px. **Startled** units: chip alpha 0.45 + `!` overlay (their turn will be skipped).
Dead units' chips pop (scale to 0, 150ms) and the row slides closed. Right end of ribbon:
flee-chance chip when hovering Flee.

### 9.2 Skill bar & hotkeys

Six main buttons, 112×96, 8px gaps, hotkeys **1–6**:

```
[1 Swipe] [2 skillA] [3 skillB] [4 skillC] [5 skillD] [6 Stalk]
```

Universal 2×2 grid: `[G Guard] [R Swap]` / `[T Item] [F Flee]` (Flee hidden vs bosses;
Item opens a 3-slot popup above the button, picks with 1–3).

Button anatomy (112×96): `panel` fill r6, 2px `border`; hotkey chip 18×18 top-left
(`PAL.gold` fill, `MONO` 12 `PAL.textDark`); skill icon glyph `MONO` 28 centered at
y 34; skill name `UI` 14 at y 62; bottom row: Vigor cost pips (cost × 6px diamonds in
`PAL.vigor`) left, tag chip right. States: **affordable** as above; **hover/selected**
`panelLite` + gold border + raised 2px; **unaffordable/illegal** (can't pay, or melee
from back row) alpha 0.4 + cost pips tinted `PAL.danger`; **Stalking-free Pounce** —
cost pips replaced by `FREE` in `PAL.gold` and the button gets the boss-glow pulse.
Description strip below shows the hovered/selected skill's `description` + exact numbers
("power 160 · melee · single"), `UI` 14 `PAL.textDim`.

### 9.3 Input flow (two modal steps)

1. **Choose action** (keys 1–6/G/R/T/F or click). Selecting a targeted skill enters…
2. **Choose target**: legal targets get a pulsing gold ground-ring + a numbered gold chip
   `1..5` floating 8px above their head — **number = order in slot order among legal
   targets** (combat.md's "click or press 1–5"). Illegal units dim to alpha 0.55. Hovered
   target: white 2px outline flash + its nameplate raises; a damage **preview** range
   ("~12–15", `MONO` 12) appears over its HP bar, including known weak/resist multipliers.
   Row-target skills highlight the whole row as one bracket. `Esc`/right-click cancels
   back to step 1. `Enter` confirms the sole target when only one is legal.

Keyboard-only is fully supported: arrows also cycle legal targets.

### 9.4 Floating combat text

`BitmapText MONO`, spawn at target head, rise 40px over 700ms `outCubic`, fade after 60%:
- damage `24px PAL.text`; **crit** `32px PAL.crit`, spawns at scale 1.6 → 1.0 in 100ms,
  suffix `!`
- heal `24px PAL.heal`, prefix `+`
- `WEAK!` tag popup `16px PAL.weak` 20px above the number; `resist` `14px PAL.resist`
- status applied: chip glyph + name, `14px` in the status color ("RUFFLED", "STARTLED!")
- `MISSED?` never exists (everything hits); pushes/pulls print `shoved!` / `yanked!`
  `14px PAL.stRuffled`
- Multi-target: stagger 80ms per target in slot order (matches resolution order).

### 9.5 Log line

One line, `MONO` 14 `PAL.textDim` on `panel` alpha 0.85: latest event, e.g.
`Pip pounces Sewer Rat A for 51! (crit, weak) — it is STARTLED.` New line slides the old
one up 8px and fades it (120ms). Press `L`: scrollable 12-line history panel
`{x:16, y:180, w:560, h:328}` overlays the cat side (toggle).

### 9.6 Boss extras

Poise meter above the boss: 3 sockets (20×20 diamonds, 6px gaps) that fill `PAL.gold` per
weakness hit this round, all reset at round start; on the 3rd — "BROKEN!" banner (`DISPLAY`
40, slides in from right, 900ms hold) and the boss slumps (rotation 8°, y +10). Telegraph:
charge announcement prints in the log AND a `⚠ + text` strip (`{x:640-180, y:60, w:360,
h:28}`, `PAL.danger` fill alpha 0.9) that stays until the charge fires or a `yowl` hit
cancels it (strip shatters into 6 rect shards, 300ms).

### 9.7 CAT PILE presentation (scripted, 1.4s)

① flash quad `0xFFFFFF` alpha 0.6 → 0 (60ms) → ② all 4 cat blobs tween (`outBack`,
250ms, stagger 60ms) onto the Startled enemies' centroid → ③ dust cloud: 8 gray circles
(r 8–16, `PAL.textDim` alpha 0.5) expanding outward + 4 class-colored paw/tail shapes
poking out at angles, jittering ±2px → ④ `CAT PILE!` `DISPLAY` 40 `PAL.gold` banner slams
center with 12px screen shake → ⑤ one damage number per enemy (stagger 100ms) → ⑥ cats
hop back to slots (200ms). Skippable to end-state with Space, like all animations.

---

## 10. Event Dialog

Modal over a `PAL.scrim` alpha-0.6 full-screen quad (world keeps idling beneath).

| Element | Rect |
|---|---|
| Panel | `{x:240, y:120, w:800, h:480}` — `panel` fill r8, 2px gold border |
| Title band | `{x:240, y:120, w:800, h:56}` — `panelLite`, `DISPLAY` 24 centered |
| Scene doodle | `{x:280, y:196, w:160, h:160}` — a `panelLite` r8 frame containing a 2–3 primitive doodle keyed by `event.art: 'chest'|'shrine'|'stranger'|'puddle'|'hole'` (e.g. `stranger` = a hooded rodent blob at scale 1.6) |
| Body text | `{x:472, y:196, w:536, h:220}` — `UI` 16, `lineHeight 24`, `wordWrapWidth 520` |
| Option buttons | 3 max: `{x:280, y:432, w:720, h:44}`, next at y `484`, y `536` — hotkey chips **1/2/3**, `UI` 16 left-aligned at x+52; a right-aligned `PAL.textDim` hint shows known stakes, e.g. `(LCK check)` or `(costs 5 fish)` |

```ts
interface EventScreenData {
  title: string; art: EventArt; body: string;
  options: { label: string; hint?: string }[];  // 1–3; hotkeys auto-assigned
}
```

No Esc — an option must be chosen. The chosen option's **outcome** replaces the body text
(same panel, options collapse to one `[1] Continue`), so every event is: read → pick →
read result → continue. Rewards/punishments print as floating text over the party strip
when the panel closes.

---

## 11. Results Screens

**Victory (post-battle loot).** Panel `{x:320, y:80, w:640, h:560}`, gold border.
- `VICTORY` `DISPLAY` 32 `PAL.gold` centered at y 116; sub-line `UI` 14 `PAL.textDim`
  "Round 2 · Cat Pile ×1".
- Loot rows from y 180, each `{x:352, y:…, w:576, h:40}` `panelLite` r6, 8px gaps: item
  glyph chip 24×24, name `UI` 16, qty `MONO` 14 right. Rows slide in from the right,
  stagger 90ms, with a `+` ping.
- Revive notice (if any KO): row with the ghost icon — "Miso is revived at 30% HP · −1
  Life" — the Nine Lives row is redrawn here `{x:352, y:472, w:576, h:32}` with the spent
  paw hollowing out (scale-pop).
- `[Enter] CONTINUE` button `{x:490, y:560, w:300, h:48}`.

**Run over.** Full-screen `PAL.void`; the 4 cats' ghost sprites drift upward slowly.
`OUT OF LIVES` (or `THE PILE DISPERSES` on full wipe) `DISPLAY` 40 `PAL.danger` at
`(640,200)`. Stats block `MONO` 16 `PAL.textDim` centered from y 280 — floor reached,
enemies dispatched, cat piles, damage dealt, seed. Buttons `{x:490,y:520,w:300,h:48}`
`[Enter] NEW RUN (new seed)` and `{y:580}` `[R] RETRY SAME SEED`, `{y:640}` `[T] TITLE`.

---

## 12. Juice (8 cheap effects + the tween helper)

One ~40-LoC helper powers everything; no animation library:

```ts
type Ease = 'linear' | 'outCubic' | 'outBack' | 'inOutSine';
function tween(target: any, props: Record<string, number>, ms: number,
               ease: Ease = 'outCubic', onDone?: () => void): void;
// driven by app.ticker; supports x/y/alpha/rotation/scaleX/scaleY; ~8 concurrent max
function shake(container: Container, amp: number, ms: number): void; // decaying Math.random offsets
```

| # | Effect | Exact spec |
|---|---|---|
| 1 | **Hit flash + knockback** | victim container `tint 0xFFFFFF` for 80ms, then restore; simultaneously x ±6px away from attacker and back (120ms `outCubic`) |
| 2 | **Attack lunge** | attacker tweens 24px toward target (90ms), squash at contact (`scaleX 1.15, scaleY 0.85`, 60ms), return (140ms `outCubic`). Reach skills instead scale-pulse the caster 1.0→1.1→1.0 and draw a 2-frame arc line to the target |
| 3 | **Screen shake** | `shake(world, amp, 250ms)`: amp 4 normal kill, 6 crit, 12 Cat Pile/boss charge; decaying random offsets each frame; HUD never shakes |
| 4 | **Floating numbers** | §9.4 spec (rise 40px/700ms, crit pre-pop 1.6→1.0) |
| 5 | **Startle stars** | 3 gold 4-point star polys orbit the victim's head (r 18, 1.2 rev/s) for the whole Startled duration + a `!` chip pops in at scale 0→1.3→1 (`outBack` 200ms); victim blob tips 12° and eyes go to swirls (two arc strokes) |
| 6 | **Low-HP heartbeat** | any cat < 25% HP: its nameplate HP bar and party-strip card pulse alpha 1→0.55 at 0.8 Hz; a 24px `PAL.danger` alpha-0.12 vignette frame fades in on the world |
| 7 | **Idle life** | every unit: sine bob ±2px (period 1.6–2.4s, per-unit `Math.random` phase), blink every 3–6s (eyes `scale.y 0.1`, 100ms), cat tails sway (tail ctrl point ±4px, 2s); dust bunnies jitter, toad throats inflate |
| 8 | **UI feedback** | buttons: hover = raise 2px + gold border (80ms), press = `scale 0.96` (60ms); Vigor pips pop `scale 1.4→1` when gained; damage-preview numbers count up over 120ms; panel opens = `scale 0.95→1` + `alpha 0→1` (120ms `outBack`) |

Budget rule: an effect may not exceed ~15 LoC beyond `tween`/`shake` calls, and all combat
animation is a replay of the engine's `BattleEvent[]` — a queue that plays each event's
juice, Space fast-forwards by finishing all tweens instantly (set to end values).

---

## 13. Scope & File Budget (render layer)

Fits the combat.md plan (`battle/ui.ts` 420 LoC) plus:

| Module | Est. LoC | Contents |
|---|---|---|
| `ui/palette.ts` + `ui/looks.ts` | 90 | §2 consts, CatLook/EnemyLook data |
| `ui/draw.ts` | 260 | drawCat, 5 enemy family fns, chips, paw, HP bar, buttons, panel |
| `ui/tween.ts` | 60 | tween/shake/ease |
| `ui/text.ts` | 40 | 3 TextStyles, BitmapFont install, makeText helpers |
| `scenes/title.ts` | 90 | §7 |
| `scenes/explore.ts` | 260 | tiles, camera, minimap, party strip, light overlay |
| `battle/ui.ts` | 420 | §9 (already budgeted in combat.md) |
| `scenes/event.ts` + `scenes/results.ts` | 140 | §10–§11 |
| **Total render layer** | **~1360** | |

Non-goals for v1 (explicitly out): particle systems beyond the dust circles, filters/
shaders, walk-cycle limb animation, portrait art variants, resizable panels, gamepad,
color-blind palettes (the glyph-on-chip system already carries meaning without hue).
