# Style-consistency audit — `public/assets/gen/*.png` (root cast)

Anchor: `docs/art/style-anchor-bruno.png` (== `cat-bruno.png`). Style bible:
`src/content/artStyle.ts` (`ART_STYLE`, version 1).

## How this was scored

Each sprite was viewed three ways: at full 640², on a contact sheet over the
real stage gradient (`#1a1626 → #241d33`), and at its **actual in-game pixel
height** (`src/ui/scenes/battle.ts` `GRADE_H` / `spriteHeightFor`: cats
100–112 px, minion 78, standard 92, elite 115, boss 147; HUD portraits 48 px).

Alongside the eyeball pass, per-sprite objective metrics were computed over the
opaque pixels only: median luminance (`medL`), the 10th/90th luminance
percentiles, median saturation, alpha-bbox extent, and `>stage` = the fraction
of body pixels more than 25 luminance above the stage. The cast should cluster;
outliers in either direction are style breaks.

Score = min of five sub-criteria (1–5): silhouette readability at game size,
value contrast against the stage, aura restraint (cat dominates, Stand
supports), consistency with the anchor, apparent scale consistency with
siblings. **Anything ≤ 3 is regenerated.**

## Baseline metrics (before regeneration)

| id | medL | p90 | `>stage` | bbox h | note |
|---|---:|---:|---:|---:|---|
| cat:bruno | 60 | 133 | 0.58 | 0.97 | reference point |
| cat:pixel | 58 | 128 | 0.56 | 0.94 | on-cluster |
| cat:mora | 47 | 110 | 0.44 | 0.97 | dark end |
| cat:baguette | **125** | **212** | **0.87** | 0.93 | 2× the cast median |
| portrait:baguette | **126** | **212** | **0.93** | — | same break in the HUD |
| enemy:crowShaman | **27** | 94 | **0.27** | 0.86 | darkest asset in the game |
| enemy:yarnGolem | **35** | 98 | **0.31** | 0.96 | |
| enemy:ratThug | **39** | 99 | **0.36** | 0.96 | |
| boss:ratPrince | **42** | 94 | **0.36** | 0.99 | |
| enemy:sewerBat | 46 | **88** | 0.42 | 0.86 | lowest peak → no rim light |

The healthy band is roughly `medL 50–75`, `p90 130–190`, `>stage 0.45–0.70`.
`cat:baguette` sits far above it; six assets sit far below.

## Audit table

| id | score | verdict | why |
|---|:--:|---|---|
| `cat:bruno` | **5** | keep | The anchor. Orange body reads instantly at 112 px, purple Stand is a clear backdrop layer, rim light separates the whole outline. |
| `cat:pixel` | **4** | keep | Black cat is the darkest party member but the olive trousers, bone-white claws and green eyes carry the silhouette. On-cluster values. |
| `cat:mora` | **2** | **regen** | Dark purple hood in front of a dark purple Stand in front of a dark purple stage — three layers of the same value. At 100 px it is one smear; the face is invisible. Aura also dominates the cat. |
| `cat:baguette` | **2** | **regen** | The line-up break the human called out: a white-and-gold blaze at `medL 125` next to a cast at 47–60. The gold Stand is bigger and louder than the cat and owns most of the frame's energy. |
| `portrait:bruno` | **5** | keep | Head-and-shoulders crop, matches the battle sprite, reads at 48 px. |
| `portrait:pixel` | **4** | keep | Slightly dark but the face and collar read. |
| `portrait:mora` | **3** | **regen** | Purple-on-purple; at 48 px the face is a dark blob. Must be re-cropped to match the new `cat:mora`. |
| `portrait:baguette` | **2** | **regen** | Gold blaze, and a softer/cuter rendering than the other three — two style breaks at once. |
| `enemy:ratThug` | **3** | **regen** | Brown-on-purple, `>stage 0.36`. Silhouette is fine, values are mud. Needs a rim light and a value lift, not a redesign. |
| `enemy:sewerBat` | **2** | **regen** | Called out by the human. Dark purple wings on a dark purple field, `p90 88` — the lowest highlight in the cast, so nothing catches light. At 78 px it is a smudge. |
| `enemy:dustBunny` | **3** | **regen** | Reads as a value shape but it is a soft photographic fluff-ball with no ink outline and no Stand energy — off-style against everything else. Also undersized (`bbox h 0.70`). |
| `enemy:crowShaman` | **2** | **regen** | Worst asset in the set. `medL 27`, `>stage 0.27`. Black robes on black; only the staff gem reads. |
| `enemy:roombaScout` | **4** | keep | Grey disc, clean lozenge silhouette, good separation. |
| `enemy:sprinklerImp` | **4** | keep | Brass body + bright arcs, strong read. |
| `enemy:yarnGolem` | **3** | **regen** | Red/blue yarn is hue-distinct but very dark (`medL 35`), and the Stand behind it is the same value as the body, so the outline dissolves. |
| `enemy:porcelainHound` | **5** | keep | Best-lit enemy: white porcelain with gold crackle, unmistakable at 115 px. |
| `enemy:laserGhost` | **2** | **regen** | Translucent purple body on a purple stage = no silhouette at all; only the red eye reads. Its energy is also **red**, off the purple/gold palette. |
| `enemy:trashPanda` | **3** | **regen** | The raccoon reads, but a large murky Stand plus a literal pile of garbage under the feet blows out the bbox and breaks the framing contract (feet-aligned, whole silhouette). |
| `enemy:sockWraith` | **4** | keep | Light grey against a dark stage, clean. |
| `enemy:elderStray` | **4** | keep | Grey tabby, adequate separation; Stand is slightly murky but subordinate. |
| `boss:vacuumKing` | **3** | **regen** | Stand energy is **red**, off-palette, and it is the loudest thing in the frame — the "a bit tooo much" case. The vacuum body underneath is dark and gets lost inside its own aura. |
| `boss:dogfather` | **4** | keep | Bright white/purple Stand, dark suit, strong read at 147 px. |
| `boss:ratPrince` | **3** | **regen** | Dark brown rat inside a dark purple Stand cloud, `>stage 0.36`. A boss must read hardest of all and this one reads least. |
| `title:hero` | **5** | keep | The cast canon. Group staging, gold reserved for Baguette's Stand only, values well separated. Used as the character-design reference for the regens. |

**Regenerating (13):** `cat:mora`, `cat:baguette`, `portrait:mora`,
`portrait:baguette`, `enemy:ratThug`, `enemy:sewerBat`, `enemy:dustBunny`,
`enemy:crowShaman`, `enemy:yarnGolem`, `enemy:laserGhost`, `enemy:trashPanda`,
`boss:vacuumKing`, `boss:ratPrince`.

**Keeping (11):** `cat:bruno`, `cat:pixel`, `portrait:bruno`, `portrait:pixel`,
`enemy:roombaScout`, `enemy:sprinklerImp`, `enemy:porcelainHound`,
`enemy:sockWraith`, `enemy:elderStray`, `boss:dogfather`, `title:hero`.

## Regeneration recipe

Model `gpt-image-2` (best anchor fidelity), `--ref docs/art/style-anchor-bruno.png`
plus the best-scoring sibling in the same family, at 1024². Prompt =
`<subject> + ART_STYLE.framing.battleSprite + ART_STYLE.basePrompt + "Avoid: " +
ART_STYLE.negative` with three consistency clauses added to every regen:

1. **Higher-key than the stage** — the creature is clearly brighter than the
   `#1a1626` field and carries a strong rim light along its whole top edge.
2. **Subordinate Stand** — translucent purple-and-gold spectral energy, about a
   third of the image energy, always behind, never over the face or outline.
3. **Matched scale** — body fills ~80–90 % of frame height, feet near the
   bottom edge, centred, same apparent size as its siblings.

Keying is unchanged from the original batch (`/tmp/catrpg-tools/softkey.py`,
mirrored below): per-image median of the 4 px border ring as the background
colour, border-connected flood at max-channel tolerance, hard alpha 0 at
dist ≤ 8, linear alpha ramp to dist 24, then an interior-pocket pass that
frees background trapped inside aura loops (components of dist ≤ 2 and
≥ 100 px). Portraits are **not** keyed — they ship as opaque 256² RGB squares,
matching the existing HUD assets.

### Anchor-bleed trap (worth knowing before the next batch)

Passing `style-anchor-bruno.png` as a `--ref` to `gpt-image-2` makes it copy
**Bruno's Stand** — the rope-and-trash-can-lid colossus — into the background of
whatever you generate. The first enemy batch came back with six unrelated
monsters all sharing the party bruiser's Stand. Fixes that worked:

* For non-party subjects, use `enemy-porcelainHound.png` / `enemy-sockWraith.png`
  as the style ref instead of the anchor — both are on-style and have no
  humanoid Stand to copy.
* Follow up with a single-ref edit pass ("keep the creature EXACTLY, change only
  the background") to delete an inherited figure or to add the aura back.
  `gpt-image-2` preserves the subject essentially pixel-faithfully across these
  passes, so it is safe to iterate on the background alone.

Every regeneration below went through 2–3 such passes: design/value pass →
background cleanup → aura pass.

## Results

All 13 regenerated in place; ids, filenames and dimensions are unchanged, so
`public/assets/gen/manifest.json` needed no edit (verified against the files on
disk). Battle sprites stay 640² RGBA soft-keyed, portraits stay 256² opaque RGB.

| id | medL | p90 | `>stage` |
|---|---|---|---|
| `cat:mora` | 47 → **56** | 110 → **150** | 0.44 → **0.53** |
| `cat:baguette` | 125 → **66** | 212 → **184** | 0.87 → **0.63** |
| `enemy:ratThug` | 39 → **63** | 99 → **161** | 0.36 → **0.59** |
| `enemy:sewerBat` | 46 → **65** | 88 → **136** | 0.42 → **0.60** |
| `enemy:dustBunny` | 56 → **69** | 123 → **191** | 0.54 → **0.62** |
| `enemy:crowShaman` | 27 → **48** | 94 → **142** | 0.27 → **0.45** |
| `enemy:yarnGolem` | 35 → **42** | 98 → **152** | 0.31 → **0.41** |
| `enemy:laserGhost` | 59 → **65** | 142 → **155** | 0.57 → **0.59** |
| `enemy:trashPanda` | 50 → **75** | 102 → **152** | 0.48 → **0.67** |
| `boss:vacuumKing` | 44 → **64** | 100 → **170** | 0.40 → **0.60** |
| `boss:ratPrince` | 42 → **48** | 94 → **159** | 0.36 → **0.47** |
| `portrait:mora` | 52 → **48** | 120 → **156** | 0.50 → **0.47** |
| `portrait:baguette` | 126 → **38** | 212 → **207** | 0.93 → **0.43** |

Cast-wide spread across the 19 battle sprites:

| | before | after |
|---|---|---|
| median luminance | 27 – 125 (4.6× spread) | 42 – 75 (1.8× spread) |
| `>stage` fraction | 0.27 – 0.87 | 0.41 – 0.71 |
| off-palette energy | red on `laserGhost`, `vacuumKing`; gold blaze on `baguette` | purple/gold only |

`portrait:baguette`'s medL drops to 38 because the new crop keeps a dark
backdrop around the head instead of a full-bleed gold field; the *face* is the
brightest thing in it (`p90 207`), which is what matters at 48 px.

### What changed, per asset

* **`cat:mora`** — repainted pale silver-grey with a violet-and-gold cloak and
  her face uncovered; her hatted Stand pushed back and thinned.
* **`cat:baguette`** — the headline fix. Same character (cream medic cat, red
  neckerchief, red cross, satchel) but the Stand is now the cast's standard
  translucent purple with a single small gold cross instead of a gold blaze.
  Sits at `medL 66` against Bruno's 60.
* **`enemy:ratThug`** — same design, repainted sandy-tan with a rim light.
* **`enemy:sewerBat`** — pale tan fur and ochre wing membranes, wings spread
  flat to camera for a bold silhouette.
* **`enemy:dustBunny`** — redrawn with bold ink outlines and hard cel-shaded
  clumps instead of soft photographic fluff; grown to family scale.
* **`enemy:crowShaman`** — ash-grey and bone plumage instead of black-on-black,
  one wing spread; staff gem kept.
* **`enemy:yarnGolem`** — brighter scarlet/cream/teal yarn, aura recoloured from
  orange to violet. Still the darkest sprite in the cast but hue-distinct with
  strong highlights.
* **`enemy:laserGhost`** — mid-value grey cloth with blue-violet fold shadows
  (was a translucent purple wisp, then briefly an over-bright white blaze);
  energy moved from red to cyan lens + purple aura.
* **`enemy:trashPanda`** — silver-grey raccoon, feet on flat ground, the pile of
  garbage removed so the bbox matches the framing contract.
* **`boss:vacuumKing`** — pale gunmetal and brass body, Stand recoloured from
  red to purple/gold and thinned.
* **`boss:ratPrince`** — pale silver fur, crimson-and-gold mantle, thin purple
  rat-wraith Stand instead of a purple cloud swallowing the figure.
* **`portrait:mora` / `portrait:baguette`** — re-cropped head-and-shoulders to
  match the new battle sprites and Bruno's portrait framing.

`docs/art/contact-cast.png` shows the final cast grouped by family, each sprite
at its true relative in-game height on the real stage gradient.
