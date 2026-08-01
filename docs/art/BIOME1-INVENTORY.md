# Biome 1 (Cellar) — Generated Asset Inventory & Style Audit

Audited 2026-07-31. Source dirs: `public/assets/gen/{env,items,scenes}/` (each with its own
`manifest.json`, all verified: every entry parses, every listed file exists, no orphan files).
Contact sheets: [`contact-env.png`](contact-env.png), [`contact-items.png`](contact-items.png),
[`contact-scenes.png`](contact-scenes.png) (this folder).

> **Superseded in part, 2026-07-31 (run-map cleanup).** The tile crawl is gone, and with it
> the nine `tile:*` textures and five `token:*` map tokens listed below — files deleted,
> `env/manifest.json` entries removed. The `env/` section is kept as the historical record of
> what that pack contained; `prop:*` survives. What replaces them is at the bottom of this
> file: [Run-Map Backdrops + Node Medallions](#run-map-backdrops--node-medallions-added-2026-07-31).
> The live per-id ledger is [`ASSET-AUDIT.md`](ASSET-AUDIT.md).

**Audit verdict: GREEN.** All 60 assets share the v2 bible style (cel-shading, ink outlines,
deep purple/near-black base, gold/amber accents, spectral purple glow). No text, watermarks,
frames, photoreal drift, or pixel-art drift found. No regenerations were needed. Downscale
checks passed: all tokens/props read at 48 px, all icons read at 64 px, floors/wall tile
cleanly at game scale (48 px).

## env/ — tiles, props, tokens (18, all 512x512) — DELETED except `prop:*`

| id | description | weaknesses |
|---|---|---|
| tile:floor | Muted purple flagstone floor, seamless | intentionally low-contrast; fine |
| tile:floor2 | Flagstone variant, finer cracks, seamless | — |
| tile:floor3 | Rounder cobble variant, seamless | slightly lighter than floor/floor2; reads as natural variation |
| tile:wall | Dark brick wall with faint gold mortar glints, seamless both axes | — |
| tile:door | Wooden plank door, iron ring, stone arch, frontal | — |
| tile:doorBoss | Boss door: red claw gouges, skull knocker, red underglow | red accent exceeds base palette — intentional danger signal, matches red-dot item accents; not a Tile enum kind (dressing asset) |
| tile:stairsUp | Stairs ascending into warm gold light | more gold/saturated than floors; pops as landmark (desirable) |
| tile:stairsDown | Stairs descending into purple-glow dark | same landmark saturation as stairsUp |
| tile:nook | Dead-end alcove: cushion + candle, top-down | faint dark speckle halo around candle glow from keying; invisible on dark floors, visible on light bg; not a Tile enum kind (dressing asset) |
| prop:chest | Closed banded chest, purple aura rim, transparent bg | — |
| prop:chestOpen | Open chest spilling gold, purple aura | — |
| prop:eventSparkle | Yarn-ball orb wrapped in purple sparkle wisps | — |
| prop:hoardChest | Overflowing treasure hoard chest with gold cascade | — |
| token:party | Four-cat cluster (orange/black/grey/cream), top-down | dark at 48 px: group silhouette + orange cat read, individual cats mush; brighter-rim retry prompt in env agent transcript if playtesting complains |
| token:vermin | Rat thug with bandaged arms, hunched, top-down | — |
| token:bird | Crow shaman: spread black wings, skull fetish, gold-edged mantle | busiest token; at 48 px reads as winged menace but detail is lost (already 1 retry from an all-black first render) |
| token:beast | Trash-panda beast, low prowl, purple aura | — |
| token:construct | Haunted robot-vacuum, glowing purple eye-lens | best 48 px read of all tokens |

## items/ — consumable + equipment icons (29, all 512x512, baked #1a1626 bg)

All icons share one camera/light rig (3/4 top-down, upper-left key, warm gold underlight),
so the grid reads as one set. Mewthical uniques carry golden glow + spectral purple wisps
and are visibly a tier above their base archetypes. No weaknesses found on any icon; the
only set-wide note is that backgrounds are baked opaque `#1a1626` (no alpha) — key out in a
follow-up pass if the inventory UI ever needs transparency.

| id | description |
|---|---|
| item:tunaSnack | Opened gold tin of tuna chunks |
| item:sardineTin | Peeled-back sardine tin, silver fish |
| item:warmMilk | Steaming pawprint bowl of milk |
| item:catnip | Burlap sack spilling green catnip |
| item:theCucumber | Cucumber wreathed in ominous purple aura |
| item:squeakyToy | Stitched grey toy mouse |
| item:bagOfFleas | Tattered hole-riddled burlap pouch |
| item:cardboardBox | Open cardboard box, golden inner glow |
| item:canOpenerRecording | Cassette recorder emitting gold sound rings |
| item:featherWand | Feather teaser wand, glowing plume |
| item:shinies | Pile of rings, bottlecaps, marbles, gold trinkets |
| equip:mittsOfMenace | Studded leather battle mitts (weapon) |
| equip:ribbonRapier | Red ribbon twisted into a rapier, gold guard (weapon) |
| equip:tangleTalisman | Knotted dark cord charm with purple beads and bone toggle (weapon) |
| equip:chimeBell | Hand bell with radiating gold sound rings (weapon) |
| equip:fluffyCollar | Plush white fur collar with buckle (trinket) |
| equip:cardboardCuirass | Cardboard chest armor with crown doodle (trinket) |
| equip:tinBell | Small tin bell on rope loop (trinket) |
| equip:driedLuckyBeetle | Iridescent gold scarab beetle (trinket) |
| equip:yarnBangle | Braided gold-and-purple yarn bracelet (trinket) |
| equip:spikedCollar | Black spiked leather collar (trinket) |
| equip:poiseChip2 | Dumpster Lid Mitts — dented metal-lid gauntlets (unique) |
| equip:critOffBalance | The Red Dot — cursed rapier-wand projecting a red laser dot (unique) |
| equip:appliesAlwaysHit | Grandmother's Cursed Yarn — black-purple yarn ball, gold strand (unique) |
| equip:healsGrantMending | Bell of Purrfect Pitch — ornate gold bell, jeweled handle (unique) |
| equip:moverOffBalance | Static-Charged Fluff — crackling fur ring with charm bell (unique) |
| equip:ninthBell | The Ninth Bell — massive cracked dark bell leaking gold light (unique) |
| equip:catPileDouble | Alpha Beetle — horned royal beetle in purple flame (unique) |
| equip:startEnergy6 | Ball of Pure Yarn — radiant gold yarn sphere (unique) |

## scenes/ — event & meta illustrations (13, all 1600x907 ≈16:9)

All scenes weight their subject to the right third, leaving the left calm for UI text
overlay. Cats in scenes follow the set's anthro convention (ragged clothes, JoJo poses);
the canonical four (orange brawler, black trickster, purple hexer, cream medic) match
between landing and victory. Set-wide note: PNGs are ~1.7–2.2 MB each (~25 MB total);
a WebP/AVIF pass would cut ~5x if load weight matters.

| id | description | weaknesses |
|---|---|---|
| scene:event:yarnBall | Glowing yarn ball alone in a torchlit corridor | — |
| scene:event:suspiciousHuman | Shadow-faced human in hat offering treats to a wary orange cat | — |
| scene:event:cursedPost | Scratching post totem ringed with purple runes | runes are stylized glyphs, not legible text (pass) |
| scene:event:shrineOfNine | Yawning cat idol above nine candles | — |
| scene:event:perfectBox | Pristine cardboard box radiating golden light | — |
| scene:event:milkBowl | Steaming milk bowl on a carved pedestal, caged cat watching | — |
| scene:event:redDot | Hunched orange cat stalking a red laser dot down a cell block | red dot pushes red accent; consistent with critOffBalance/doorBoss danger red |
| scene:event:dormantRoomba | Sleeping roomba with a looming spectral Stand above it | — |
| scene:event:catnipPatch | Luminous catnip plant sparkling in a chained cellar corner | — |
| scene:event:elderStray | Grey elder cat with GRANDFATHER CLAWS spirit looming behind | 1 retry (first render copied anchor's Stand) — final is distinct |
| scene:landing | Four canonical cats around a campfire, hooded merchant cart behind | — |
| scene:victory | Four cats posed atop the slain beast, Stands blazing, gold light | — |
| scene:defeat | Rain-soaked broken collar and fading purple flame by a drain | — |

## Audit method

1. Full-category labeled contact sheets built with PIL and reviewed (100% of assets seen,
   exceeding the 1/3 sample requirement).
2. Downscale grids: all 9 tokens/props at 48 px, 12-icon random sample at 64 px, four
   tiles PIL-tiled at 48 px — all readable, no seams.
3. Full-size review of borderline assets (tile:doorBoss, scene:event:redDot) and the two
   busiest scenes (landing, victory) for hidden text — clean.
4. Manifests cross-checked against disk: 18 + 29 + 13 entries, zero missing, zero orphans.

---

# Battle Backdrops + The Peddler (added 2026-07-31)

Second art pass, filling the two holes visible in playtest screenshots: battles were fought on an
empty dark stage with a placeholder circle, and the landing screen's shopkeeper was still drawn by
the old flat-vector procedural cat renderer on top of painted art.

All new files live in `public/assets/gen/scenes/` and are registered in that folder's
`manifest.json` (now 20 entries: the original 13 plus the 7 below, all verified against disk —
every entry parses, every file exists at its declared size, no orphans).

## scenes/ — battle backdrops (6, all 1600x900 WebP q82)

One per floor of `src/content/floors.ts`. These are **backdrops, not illustrations**: no
characters, no cats, no creatures anywhere in them. Each has three depth layers (far background,
midground scenery pushed to the left/right edges, near ground plane), an unobstructed horizontal
ground plane across the lower third for the sprite row, and an open centre band. All are
deliberately darker, more desaturated and lower-contrast than the character sprites, with a
purple-indigo key and exactly one warm accent light source per floor.

| id | file | floor | warm accent | notes |
|---|---|---|---|---|
| scene:battle:1 | battle-1.webp | 1 The Cellar | bare filament bulb, upper left | coolest/greyest of the six (stone cellar); crate + coal-sack silhouettes at both edges |
| scene:battle:2 | battle-2.webp | 2 The Drains | amber shaft from a storm grate, upper right | near ledge is the standing plane, black water channel behind it |
| scene:battle:3 | battle-3.webp | 3 The Appliance Graveyard | open fridge bulb + sparks, right | 3 renders: v1/v2 rejected (see below), v3 keeps the appliance ridge low and dark |
| scene:battle:4 | battle-4.webp | 4 The Undergarden | gold daylight shaft through broken glass, upper left | only backdrop with a second (teal) light: bioluminescent mushrooms, edges only |
| scene:battle:5 | battle-5.webp | 5 The Cold Pantry | cracked-open freezer door, right | brightest of the six by design (ice); shelf labels are blank shapes, no text |
| scene:battle:6 | battle-6.webp | 6 The Hollow Throne | two braziers of gold flame at the far dais | throne is far background, small, silhouetted — centre band stays clear |

## scenes/ — NPC sprite (1, 640x640 keyed PNG)

| id | file | description |
|---|---|---|
| npc:peddler | npc-peddler.png | THE PEDDLER: fat, smug, one-eyed stray tomcat merchant in a ragged hooded cloak hung with charms, sitting cross-legged behind a spread of scavenged wares on a tattered rug (tuna tins, bottle caps, corked bottles, a brass bell, a fish skeleton, a coin pouch). Painted to match the cat battle sprites (`cat-bruno.png` passed as `--ref`), transparent background. |

## Generation recipe

- Backdrops: `gemini-3-pro-image-preview` (best original designs, obeys "no text"), `--dimension
  2752x1536` (the model's closest landscape size to 16:9), `--ref docs/art/style-anchor-bruno.png`
  for palette/ink language. Prompt = framing paragraph + per-floor scenery + the `ART_STYLE`
  cel-shading paragraph + `Avoid: <ART_STYLE.negative + backdrop-specific negatives>`. Export:
  centre-crop to exactly 16:9, LANCZOS to 1600x900, WebP quality 82.
  - The one style-bible deviation: `ART_STYLE.basePrompt`'s "flat #1a1626 background for clean
    keying" sentence is dropped for backdrops (it fights a full-bleed environment) and replaced
    with "deep desaturated purple-indigo palette, muted low-contrast values so bright character
    sprites can be composited on top and still read" — the same intent as
    `ART_STYLE.framing.tile`. All other style sentences are used verbatim.
- Peddler: `gpt-image-2` (best anchor fidelity) with `--ref public/assets/gen/cat-bruno.png`, then
  a second `gpt-image-2` img2img pass on that render to lift its values (see below), then keyed.

## Chroma-key (unchanged recipe, reused as-is)

Per-image median of the 4px border ring as the background estimate → border-seeded flood fill at
colour tolerance 8 → soft alpha ramp from 8 out to colour distance 24 → interior-pocket cleanup
pass (enclosed bg-coloured regions ≥24 px keyed too). RGB of keyed pixels is left untouched, so a
transparent corner still carries the estimated bg colour — same as the existing `cat-*.png`
(`npc-peddler.png` corner is `(18,18,36,0)`, `cat-bruno.png` is `(19,15,34,0)`).

## Rejections and retries (looked at every render at full size)

- **Backdrops 1, 2, 3 v1 — rejected.** Prompt wording "the whole middle band of the frame is
  deliberately empty negative space" was taken literally: each came back with a hard-edged solid
  rectangle painted across the middle. Fixed by rewording to "down the centre the eye travels
  straight through to the distant background… every part of the canvas is painted scenery in
  perspective" and adding `solid rectangle, flat colour block, dark banner across the middle,
  letterbox bar, unpainted empty area` to the negatives. Backdrops 4, 5, 6 were clean on v1.
- **Backdrop 3 v2 — rejected.** Band gone, but a tall pale mound of appliances filled the centre
  (a centred subject, and too light). Re-prompted for a low dark ridge on the horizon with the
  centre in shadow and smoke; v3 (2 seeds generated, seed 11 chosen) accepted.
- **Peddler v1 — rejected after keying.** The design/pose/wares were perfect but the cloak was
  painted at almost exactly the background value, so the key (correctly) ate the cloak's shadow
  folds and left the character riddled with holes. Fixed at the art level, not the key level: an
  img2img relight pass on the same image ("keep this exact character, pose, layout and wares; only
  repaint the cloak and rug to a mid-value dusty plum, add a cool lavender rim light along the
  whole silhouette, no part of the character as dark as the background"). v2 keys cleanly.

## Verification

- Every backdrop composited at 1:1 with the real party sprites (`cat-*.png` at 190 px) and the
  floor's own enemies/bosses at 230 px: sprites read clearly against all six, no silhouette is
  lost, no backdrop element competes for attention.
- Full-size text hunt on the two busiest backdrops (5's pantry shelves, 3's appliance heap):
  jar/box labels and appliance panels are blank shapes — no letters, numbers or logos anywhere.
- Peddler keyed sprite composited over flat red and a checkerboard: clean silhouette, no interior
  bleed-through, no halo.

---

# Run-Map Backdrops + Node Medallions (added 2026-07-31)

The tile crawl's replacement art, per the shared asset contract in
[`docs/design/run-map-and-dm.md`](../design/run-map-and-dm.md) §2: one painted backdrop per
floor and one illustrated medallion per node type, plus two state overlays. 15 files,
1,669,378 B added; the 14 `tile:*` / `token:*` files they replace were 5,595,556 B.
Contact sheet: [`contact-runmap.png`](contact-runmap.png) (this folder).

## scenes/ — per-floor run-map backdrops (6, all 1600x900 WebP q82)

Each is an inked **cutaway diorama** of its floor: the ground sliced open side-on, staggered
chambers and ledges stepping left→right (entry to boss/stairs), a dark silhouetted foreground
lip, lit mid-ground, hazy back wall. Deliberately dark, desaturated and low-contrast with a
single small distant light, so medallions and route lines composite over them and still read.
Uninhabited by design — no characters anywhere in the set.

| id | file | size | the floor it paints (`src/content/floors.ts`) |
|---|---|---:|---|
| `scene:map:1` | map-1.webp | 82 KB | **The Cellar** — flagstone ledges, crates, preserve jars, coal heap, cobwebs, wooden stair right, one bare bulb as the only warm light |
| `scene:map:2` | map-2.webp | 72 KB | **The Drains** — brick culverts at three heights, dripping cast-iron pipes, ladder rungs, a black runoff channel, one grated moonshaft far right |
| `scene:map:3` | map-3.webp | 93 KB | **The Appliance Graveyard** — stepped heap of gutted washers and fridges, arcing blue sparks, purple burn-off flames, smoke ridge on the horizon, the Vacuum King's hull half-buried top right |
| `scene:map:4` | map-4.webp | 176 KB | **The Undergarden** — concrete terraces split by pale roots, shelf mushrooms, still black pools, teal bioluminescence, a collapsed greenhouse frame right |
| `scene:map:5` | map-5.webp | 80 KB | **The Cold Pantry** — frost-rimed steel tiers, ice-glazed jars, hanging cured meat, icicle curtains, freezer door cracked open right leaking pale blue |
| `scene:map:6` | map-6.webp | 111 KB | **The Hollow Throne** — broken galleries, torn banners, bone-and-brass chandeliers, gnawed bones and collars, the Dogfather's throne of smashed furniture right, red votives the only warm light |

`map-4.webp` is twice the size of its siblings — its teal fungus glow is the one high-frequency
element in the set and WebP q82 spends bits on it. Left as-is; 176 KB is still under every
event scene except `event-catnipPatch`.

## env/ — node medallions + state overlays (9, all 256x256 keyed PNG)

One matched family, struck from the same die: a beveled ring of tarnished pewter with a
hammered-gold inner bevel and four rivets at the compass points, a dusty plum inner plate, one
chunky emblem, key light from the upper left. Every emblem is distinct in silhouette *and*
hue, so the type is legible at 64 px and still guessable at 48 px.

| id | file | size | emblem | reads as |
|---|---|---:|---|---|
| `node:fight` | node-fight.png | 110 KB | tabby paw mid-strike behind three gold claw slashes | gold diagonal slashes |
| `node:elite` | node-elite.png | 124 KB | paw + spiked collar + jagged crown in purple spectral flame | the purple-flame one |
| `node:event` | node-event.png | 114 KB | yarn ball caught in a spiral of purple wisps | the purple sphere |
| `node:shop` | node-shop.png | 115 KB | hooded peddler's lantern over spilled coins and trinkets | the only warm gold glow |
| `node:rest` | node-rest.png | 108 KB | cat curled asleep under a thin crescent moon | low horizontal mass + crescent |
| `node:treasure` | node-treasure.png | 119 KB | open banded chest spilling gold | brown box + gold pile |
| `node:boss` | node-boss.png | 121 KB | crowned dog skull, spiked collar, lit from below in blood red | the only red field — unmistakable |
| `node:locked` | node-locked.png | 104 KB | rusted chain wrapped round a **hollow** ring, padlock hanging | overlay: route closed |
| `node:visited` | node-visited.png | 100 KB | gold laurel on a **hollow** ring, red wax pawprint seal | overlay: already cleared |

**Registration.** The two overlays are cropped so their ring occupies the same fraction of the
256² box as a medallion's ring (0.918 / 0.923 vs 0.931). Draw an overlay at the same size and
centre as the medallion underneath and the chain / laurel lands exactly on the pewter band —
verified by compositing all four combinations at 128 px and 64 px. Their centres are genuinely
transparent, so the node type stays visible through a locked or visited marker.

## Generation recipe

- Prompts composed from `src/content/artStyle.ts` as usual:
  `ART_STYLE.framing.<category>` + `ART_STYLE.basePrompt` + `"Avoid: " + ART_STYLE.negative`
  (plus per-asset scenery/emblem text and per-asset negatives).
- **Backdrops:** `gemini-3-pro-image-preview`, `--dimension 2752x1536`, framing `scene`.
  Same single documented deviation as the battle backdrops — `basePrompt`'s "flat #1a1626
  background for clean keying" sentence is replaced by "deep desaturated purple-indigo
  palette, muted low-contrast values…", because a full-bleed environment has no background to
  key. Floors 1 and 2 used `docs/art/style-anchor-bruno.png` as `--ref`; floors 3 and 4 used
  the **accepted `map-1`** as `--ref` instead (see rejections), floors 5 and 6 used the anchor.
  Export: centre-crop to exactly 16:9, LANCZOS to 1600x900, WebP q82.
- **Medallions:** generated as ONE 3x3 sheet (`gemini-3-pro-image-preview`, 2048²) so the nine
  badges are necessarily a family, then a `gpt-image-2` img2img pass on that sheet for the two
  fixes below, then sliced on the detected grid and downscaled to 256².
- **State overlays:** a separate two-up render (`gemini-3-pro-image-preview`, 2528x1696,
  `--ref` the medallion sheet) so the ring interiors could be specified as *empty background*
  and key through to transparent.

## Chroma-key (unchanged recipe, reused as-is)

`/tmp/catrpg-tools/softkey.py`, byte-identical to the pass that keyed `cat-*.png` and
`npc-peddler.png`: per-image median of the 4px border ring as the background estimate →
border-seeded flood fill at colour tolerance 8 → soft alpha ramp from 8 out to colour distance
24 → interior-pocket cleanup (enclosed background-coloured components ≥100 px). RGB of keyed
pixels untouched. Backdrops are opaque WebP and are not keyed.

Keyed-fraction sanity check: the seven medallions all land at 31.8–32.2 % transparent, which
is exactly the corner area outside a disc of 0.93 × the box — i.e. the flood stopped at the
ring on every one. The two overlays land at 47.3 % / 52.4 %, the extra being their hollow
centres, which is the intended result.

## Rejections and retries (looked at every render at full size)

- **Backdrop 2 v1 and v2 — rejected.** Both came back with hard-edged flat black rectangles
  floating in the middle band (the "solid rectangle" failure already documented for the battle
  backdrops). Fixed by prompt, not by paint: "every tunnel mouth, doorway, pipe opening and
  platform is fully PAINTED with visible interior depth — receding brickwork, grime streaks,
  faint reflected light and a lit top edge — never a flat black shape… no floating slabs and
  no hard-edged rectangles anywhere". v3 accepted.
- **Backdrop 4 v2 — rejected: anchor bleed.** Re-rolled at 2752x1536 with
  `style-anchor-bruno.png` as `--ref`, it painted **Bruno and his Stand** dead centre in the
  Undergarden. Same trap as the first enemy batch. Fix: drop the anchor and pass the already
  accepted `map-1` as the style ref instead — it carries the identical ink/palette language
  and contains no figure to copy. Backdrop 3 was re-rolled the same way and improved too.
- **Medallion sheet v1 — background wrong.** Perfect nine-badge grid, but the model painted it
  on **white** despite the flat-#1a1626 clause. Keying white is fine, but the recipe leaves
  keyed pixels' RGB untouched, so every badge would ship with a white fringe on a dark map.
  Fixed at the art level with a `gpt-image-2` img2img background swap (the documented
  "iterate on the background alone" pass) — emblems preserved pixel-faithfully.
- **Background swap, first attempt — rejected.** The same instruction sent to
  `gemini-3-pro-image-preview` (and to `gpt-image-2` with a looser prompt) replaced all nine
  cat emblems with generic fantasy sword/shield/helmet heraldry. Only the tightly worded
  `gpt-image-2` pass that re-lists every emblem preserved the set.
- **Medallion sheet v2 — rejected after keying.** With the dark background in place, the
  badges' *inner* plate was still nearly background-valued, so the flood ate straight through
  it: `fight`, `rest` and `treasure` keyed out to hollow rings with a floating emblem (52.9 %,
  47.5 %, 42.0 % transparent instead of ~32 %). Fixed at the art level again, never at the key
  level — one more `gpt-image-2` pass that repaints only the inner disc a clearly lighter
  dusty plum. v3 keys correctly on all seven.

## Verification

- Every backdrop viewed at full size: no text, no letters or logos on any jar, panel or
  banner; no characters or creatures in any of the six; no flat unpainted region survives.
- All nine medallions composited over a red/green checkerboard at 256 px: clean silhouettes,
  no interior bleed-through, no halo, no keyed-away emblem.
- All nine downscaled to 64 px and 48 px over `map-6` (the darkest backdrop): every type
  distinguishable at 64, all but `event`/`rest` still crisp at 48.
- Overlay registration checked by compositing `locked` and `visited` over `fight`, `treasure`,
  `boss` and `shop` at 128 px and 64 px.
- Manifests re-validated programmatically after the edit: every entry resolves to a file, every
  file is listed, no orphans in any of the four directories.

---

# The Camp, the Boot Screen and the Memorial (added 2026-08-01)

The gaps `npm run audit` was naming (`scene:camp`, `scene:boot`) plus an art pass for the
three newest screens — the camp, the roster and the memorial, none of which had ever had one.
Five assets, all `gemini-3-pro-image-preview` at 16:9 (1:1 for the medallion), every prompt
composed by `src/services/artPrompt.ts` from `ART_STYLE` (`basePrompt` + `framing.scene` /
`framing.icon` + `Avoid: …`), anchored on `docs/art/style-anchor-bruno.png`.

Contact sheet: [`contact-camp-memorial.png`](contact-camp-memorial.png).
Before/after comparison sheets for these screens were one-off review artefacts
and have been removed; the shipped result is in docs/screenshots/.

| id | file | px | what it is |
|---|---|---|---|
| `scene:camp` | scenes/camp.webp | 1600×900 | Three strays around one small fire on a cellar floor — asleep, on watch, warming its paws over a kettle. The fire is the only light and sits low centre; the whole upper half and left third fall away into unlit dark. |
| `scene:boot` | scenes/boot.webp | 1600×900 | The way down: a stone stair descending into black, one lantern far below, a dropped bell collar on a step. Almost no incident on purpose — it is shown blurred behind the crest. |
| `scene:memorial` | scenes/memorial.webp | 1600×900 | A shrine alcove: nine guttering candle stubs on a stone ledge, empty collars and **blank** tags on the boards above, dried flowers, a chipped saucer. Nothing alive in frame. Weighted right, calm dark left. |
| `scene:roster` | scenes/roster.webp | 1600×900 | The clowder waiting to be picked: five strays on crates, a fence rail and a stoop in a moonlit alley, one of them with its Stand up. |
| `prop:memorialMark` | env/prop-memorialMark.png | 192² | The keyed memorial emblem — a candle in a coiled collar, struck like a dark bronze coin. Alpha-keyed with the node-medallion recipe (radial disc scan + circular clip, `scripts/key-node-medallions.mjs`). |

## Where each one is used

- `scene:camp` — `ui/scenes/camp.ts`, full-bleed at `dim 0.3` + vignette, **plus a hem**: an
  eased wash from y=420 down to 0.82 α, because this painting puts its fire exactly where the
  five action buttons and the hint line land. Without it the buttons sit on burning wood.
- `scene:boot` — `ui/scenes/boot.ts`, blurred, at `dim 0.44`. The `title:hero` stand-in keeps
  its old `dim 0.66`: it is a bright cast poster and it has to be knocked further back than a
  painting that was made for this screen.
- `scene:memorial` / `scene:roster` — `ui/overlays/rosterPanel.ts`, twice each: full-bleed
  behind the modal (`dim 0.52` + vignette, scrim dropped 0.72 → 0.34) and again INSIDE the
  card, cover-fitted, masked to the card's rounded corners and washed downward so rows and
  buttons keep their contrast. That second use is the point: a town with two cats in it left
  two thirds of the card as flat purple, and the memorial's emptiness is its subject.
- `prop:memorialMark` — the memorial's title ornament, and the whole middle of the card in the
  "Nobody yet. Keep it that way." empty state.

## Deliberate non-delivery: `scene:title`

`scene:title` stays an undeclared, fail-soft miss and the audit will keep naming it. The title
screen paints `sceneBackdrop("scene:title", …)` as the wash UNDER `title:hero`, which is then
cover-fitted full-bleed over the entire screen — so art published under that id would be
invisible whenever the pack is present, and would fight the procedural night sky (stars, moon,
rooftop, four cats) whenever it is not. The title already works; the id is a hook, not a hole.

## Rejections and retries (every render looked at full size)

- **Memorial v1 — rejected: anchor bleed + text.** Same trap as the first enemy batch: with
  `style-anchor-bruno.png` as `--ref`, the model painted **a full Stand figure** looming over
  the shrine, and wrote `NAME` on two of the hanging tags. Re-prompted with "NOTHING ALIVE IN
  FRAME: no cat, no person, no figure, no ghost, no spirit" and "small BLANK metal tags with no
  writing on them at all".
- **Memorial v2 (two variants) — one kept, one rejected.** Both were figure-free and text-free;
  the accepted one is warm candlelight on violet stone with the shrine weighted right, the
  rejected one had a hard-edged pure-black slab filling its left third, which would have shown
  as a seam at full bleed. A third pair was rolled adding "FILLS THE WHOLE 16:9 FRAME edge to
  edge, no black bars, no letterbox" — that render is the one that shipped.
- **Baked letterbox on two renders.** `boot` and `memorial` came back with pure-black bars
  despite `frame, border` in the negative. Trimmed in post (scan for near-black edge rows and
  columns, then centre-crop to 16:9, then progressive-halving resample to 1600×900 webp at
  q0.92 — the `scripts/downscale-assets.mjs` recipe). `boot` lost its two cat-eye glints to the
  crop; the screen is quieter for it.
- **Camp and roster — accepted first render.** No retries.

## Verification

- Every render viewed at full size and every screen viewed at its real rendered size (1440×810
  screenshots through `window.__scene`/`__hits`): no text, no letters, no watermark, no
  characters in `scene:memorial`, no letterbox left anywhere.
- Two tuning passes were driven by those screenshots, not by taste at full size: the camp hem
  (buttons were sitting on the fire) and the card wash (a 14-band alpha ramp read as scan lines
  across the card; it is 40 eased bands now).
- **Zero-asset invariant re-checked**: with `**/assets/gen/**` aborted and the service worker
  blocked, boot, title, town, the clowder, the memorial and the camp all render procedurally,
  the memorial's header does not shift, and the run reaches the camp with zero page errors and
  zero off-site requests.
- `npm run audit` clean on all eight checks; the only ids it still names are the three
  deliberate fail-soft misses (`cat:bruiser`, `cat:trickster`, `scene:title`).
