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
