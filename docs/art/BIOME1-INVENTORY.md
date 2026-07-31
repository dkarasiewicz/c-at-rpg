# Biome 1 (Cellar) — Generated Asset Inventory & Style Audit

Audited 2026-07-31. Source dirs: `public/assets/gen/{env,items,scenes}/` (each with its own
`manifest.json`, all verified: every entry parses, every listed file exists, no orphan files).
Contact sheets: [`contact-env.png`](contact-env.png), [`contact-items.png`](contact-items.png),
[`contact-scenes.png`](contact-scenes.png) (this folder).

**Audit verdict: GREEN.** All 60 assets share the v2 bible style (cel-shading, ink outlines,
deep purple/near-black base, gold/amber accents, spectral purple glow). No text, watermarks,
frames, photoreal drift, or pixel-art drift found. No regenerations were needed. Downscale
checks passed: all tokens/props read at 48 px, all icons read at 64 px, floors/wall tile
cleanly at game scale (48 px).

## env/ — tiles, props, tokens (18, all 512x512)

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
