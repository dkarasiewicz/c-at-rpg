# THE ASSET AUDIT — every generated id in the game

Audited **2026-08-01**, after the SCENE gap-fill and the `prop:*` retirement.
Replaces the 2026-07-31 run-map-cleanup audit.

**Method.** Every id declared in all four manifests
(`public/assets/gen/{,env/,items/,scenes/}manifest.json`) was read off disk,
its real pixel size measured, and cross-referenced against a full-text grep of
`src/` — including the *dynamic* id constructions
(`` `enemy:${speciesId}` ``, `` `item:${defId}` ``, `` `scene:battle:${floorNum}` ``,
`` `node:${node.type}` ``…), which is how most ids are actually reached. A
literal-grep miss is not evidence of death; an id is dead only when the
constructor that could build it is gone too.

**"Rendered at"** is the real on-screen size in design px on the 1280×720
stage — battle character heights from `ui/draw/spriteFrame.ts`
(`UNIT_HEIGHT` / `CAT_HEIGHT`), icon sizes from the `makeSpriteIcon` call
sites, medallions from `R_NODE = 33`. The canvas is rendered at up to 2×
design, so **an asset is right-sized at about 2× its design-px size** and
oversized beyond ~3×.

> The `items/` table is a **snapshot**: two other art agents were writing
> `items/manifest.json` while this audit ran, and it grew from 29 to 45 ids
> during it. Its ids and byte counts are true as of the timestamp above; the
> *verdicts* on that namespace hold regardless.

## Summary

| namespace | ids | bytes on disk |
|---|---:|---:|
| root (`cat:` `portrait:` `enemy:` `boss:` `title:`) | 24 | 15,745,994 |
| `env/` (`prop:` `node:`) | 11 | 1,141,022 |
| `items/` (`item:` `equip:` `status:` `bestiary:`) | 45 | 15,829,407 |
| `scenes/` (`scene:` `npc:` `town:`) | 38 | 4,255,406 |
| **total** | **118** | **36,971,829  (35.3 MiB)** |

- **Every declared id resolves to a file that exists at its declared size.**
  No manifest entry is broken, no `w`/`h` disagrees with the pixels.
- **No orphans.** Every file under `public/assets/gen/**` is declared by a
  manifest. Nothing is shipped that nothing can load.
- **Two ids were retired** as unreferenced-and-unrepurposable (see "Retired",
  below); two more were repurposed rather than deleted.
- **Eight ids have no reference in `src/` yet** — the `status:*` (7) and
  `bestiary:unknown` namespaces, both created by a sibling art agent mid-audit
  and presumably awaiting their consuming code. They are marked
  **IN FLIGHT — verify** rather than dead: an id whose consumer is still being
  written is not the same thing as an id whose consumer was deleted.

## What changed in this pass

**Added — 5 backdrops (`scenes/`, 1600×900 WebP q82, 680 KB total).**

| id | fills the hole at | was |
|---|---|---|
| `scene:treasure` | the chest / boss-hoard loot card (`loot.ts`) | a flat scrim over nothing |
| `scene:rest` | the catnap card (`runMap.ts`) | a flat scrim over the map |
| `scene:elite` | the battle stage of an **elite** node | the floor's own `scene:battle:<floor>` |
| `scene:partyCreator` | the party-creator screen | `paletteWash` (procedural) |
| `scene:floorgen` | the "DESCENDING / Floor N" interstitial | `paletteWash` (procedural) |

`scene:partyCreator` and `scene:floorgen` were already *referenced* by name in
`partyCreator.ts:595` / `floorgen.ts:70` and had simply never been drawn — the
two remaining bare procedural backgrounds in the run loop. `scene:boot` and
`scene:title` are **deliberately** unpublished (the boot wash *is* the boot
look; `title:hero` is the title's real backdrop) and were left alone.

**Retired — `prop:chest`, `prop:eventSparkle`.** Deleted from disk and from
`env/manifest.json`. See "Retired", below.

**Repurposed — `prop:chestOpen`, `prop:hoardChest`.** Now the loot card's
header emblem. Downscaled 512² → 256² (782 KB → 210 KB).

**Downscaled — `npc:peddler`** 640² → 384² (622 KB → 230 KB); it renders at
176 design px and 384 is already 2.2×.


### root — cast, bosses, portraits, title

| id | file | size | rendered at | referenced by | verdict |
|---|---|---:|---|---|---|
| `cat:bruno` | cat-bruno.png | 711 KB (728×782) | 198–216 px tall | `` `cat:${classId}` `` — ui/sprites.ts:114 → battle units, title skyline, party creator | KEEP |
| `cat:pixel` | cat-pixel.png | 647 KB (654×768) | 198–216 px tall | `` `cat:${classId}` `` — ui/sprites.ts:114 → battle units, title skyline, party creator | KEEP |
| `cat:mora` | cat-mora.png | 604 KB (713×742) | 198–216 px tall | `` `cat:${classId}` `` — ui/sprites.ts:114 → battle units, title skyline, party creator | KEEP |
| `cat:baguette` | cat-baguette.png | 613 KB (635×737) | 198–216 px tall | `` `cat:${classId}` `` — ui/sprites.ts:114 → battle units, title skyline, party creator | KEEP |
| `portrait:bruno` | portrait-bruno.png | 225 KB (320×320) | 32–88 px | `` `portrait:${classId}` `` — ui/sprites.ts:119 → widgets.avatar() | KEEP |
| `portrait:pixel` | portrait-pixel.png | 214 KB (320×320) | 32–88 px | `` `portrait:${classId}` `` — ui/sprites.ts:119 → widgets.avatar() | KEEP |
| `portrait:mora` | portrait-mora.png | 252 KB (320×320) | 32–88 px | `` `portrait:${classId}` `` — ui/sprites.ts:119 → widgets.avatar() | KEEP |
| `portrait:baguette` | portrait-baguette.png | 197 KB (320×320) | 32–88 px | `` `portrait:${classId}` `` — ui/sprites.ts:119 → widgets.avatar() | KEEP |
| `enemy:ratThug` | enemy-ratThug.png | 580 KB (703×843) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `enemy:sewerBat` | enemy-sewerBat.png | 580 KB (713×900) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `enemy:dustBunny` | enemy-dustBunny.png | 528 KB (669×685) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `enemy:crowShaman` | enemy-crowShaman.png | 703 KB (652×900) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `enemy:roombaScout` | enemy-roombaScout.png | 455 KB (647×617) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `enemy:sprinklerImp` | enemy-sprinklerImp.png | 495 KB (636×900) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `enemy:yarnGolem` | enemy-yarnGolem.png | 691 KB (701×867) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `enemy:porcelainHound` | enemy-porcelainHound.png | 489 KB (642×900) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `enemy:laserGhost` | enemy-laserGhost.png | 580 KB (651×900) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `enemy:trashPanda` | enemy-trashPanda.png | 592 KB (724×795) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `enemy:sockWraith` | enemy-sockWraith.png | 450 KB (647×805) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `enemy:elderStray` | enemy-elderStray.png | 540 KB (693×795) | 156–232 px tall | `` `enemy:${speciesId}` `` — ui/sprites.ts:137 | KEEP |
| `boss:vacuumKing` | boss-vacuumKing.png | 802 KB (662×882) | 306 px tall | `` `boss:${speciesId}` `` — ui/sprites.ts:133 | KEEP |
| `boss:dogfather` | boss-dogfather.png | 625 KB (643×900) | 306 px tall | `` `boss:${speciesId}` `` — ui/sprites.ts:133 | KEEP |
| `boss:ratPrince` | boss-ratPrince.png | 523 KB (655×900) | 306 px tall | `` `boss:${speciesId}` `` — ui/sprites.ts:133 | KEEP |
| `title:hero` | title-hero.png | 3,282 KB (1792×1015) | 1272×720 (contain) | literal — ui/scenes/title.ts:165 | KEEP |

### env/ — chest props + run-map medallions

| id | file | size | rendered at | referenced by | verdict |
|---|---|---:|---|---|---|
| `prop:chestOpen` | env/prop-chestOpen.png | 94 KB (256×256) | 84 px | `EMBLEM.chest` — ui/overlays/loot.ts:124 → the chest loot card header | KEEP — repurposed |
| `prop:hoardChest` | env/prop-hoardChest.png | 111 KB (256×256) | 84 px | `EMBLEM.boss` — ui/overlays/loot.ts:126 → the boss-hoard card header | KEEP — repurposed |
| `node:fight` | env/node-fight.png | 104 KB (256×256) | 66 px | `` `node:${node.type}` `` — ui/scenes/runMap.ts:843 | KEEP |
| `node:elite` | env/node-elite.png | 114 KB (256×256) | 66 px | `` `node:${node.type}` `` — ui/scenes/runMap.ts:843 | KEEP |
| `node:event` | env/node-event.png | 98 KB (256×256) | 66 px | `` `node:${node.type}` `` — ui/scenes/runMap.ts:843 | KEEP |
| `node:shop` | env/node-shop.png | 90 KB (256×256) | 66 px | `` `node:${node.type}` `` — ui/scenes/runMap.ts:843 | KEEP |
| `node:rest` | env/node-rest.png | 84 KB (256×256) | 66 px | `` `node:${node.type}` `` — ui/scenes/runMap.ts:843 | KEEP |
| `node:treasure` | env/node-treasure.png | 106 KB (256×256) | 66 px | `` `node:${node.type}` `` — ui/scenes/runMap.ts:843 | KEEP |
| `node:boss` | env/node-boss.png | 109 KB (256×256) | 66 px | `` `node:${node.type}` `` — ui/scenes/runMap.ts:843 | KEEP |
| `node:locked` | env/node-locked.png | 104 KB (256×256) | 66 px | literal — ui/scenes/runMap.ts:733-734 (state overlays) | KEEP |
| `node:visited` | env/node-visited.png | 100 KB (256×256) | 66 px | literal — ui/scenes/runMap.ts:733-734 (state overlays) | KEEP |

### scenes/ — backdrops, event art, town marks, NPC

| id | file | size | rendered at | referenced by | verdict |
|---|---|---:|---|---|---|
| `scene:event:yarnBall` | scenes/event-yarnBall.webp | 117 KB (1600×907) | 1280×720 (cover) | `` `scene:event:${event.id}` `` — ui/scenes/event.ts:289 | KEEP |
| `scene:event:suspiciousHuman` | scenes/event-suspiciousHuman.webp | 127 KB (1600×907) | 1280×720 (cover) | `` `scene:event:${event.id}` `` — ui/scenes/event.ts:289 | KEEP |
| `scene:event:cursedPost` | scenes/event-cursedPost.webp | 122 KB (1600×907) | 1280×720 (cover) | `` `scene:event:${event.id}` `` — ui/scenes/event.ts:289 | KEEP |
| `scene:event:shrineOfNine` | scenes/event-shrineOfNine.webp | 108 KB (1600×907) | 1280×720 (cover) | `` `scene:event:${event.id}` `` — ui/scenes/event.ts:289 | KEEP |
| `scene:event:perfectBox` | scenes/event-perfectBox.webp | 91 KB (1600×907) | 1280×720 (cover) | `` `scene:event:${event.id}` `` — ui/scenes/event.ts:289 | KEEP |
| `scene:event:milkBowl` | scenes/event-milkBowl.webp | 105 KB (1600×907) | 1280×720 (cover) | `` `scene:event:${event.id}` `` — ui/scenes/event.ts:289 | KEEP |
| `scene:event:redDot` | scenes/event-redDot.webp | 123 KB (1600×907) | 1280×720 (cover) | `` `scene:event:${event.id}` `` — ui/scenes/event.ts:289 | KEEP |
| `scene:event:dormantRoomba` | scenes/event-dormantRoomba.webp | 144 KB (1600×907) | 1280×720 (cover) | `` `scene:event:${event.id}` `` — ui/scenes/event.ts:289 | KEEP |
| `scene:event:catnipPatch` | scenes/event-catnipPatch.webp | 154 KB (1600×907) | 1280×720 (cover) | `` `scene:event:${event.id}` `` — ui/scenes/event.ts:289 | KEEP |
| `scene:event:elderStray` | scenes/event-elderStray.webp | 159 KB (1600×907) | 1280×720 (cover) | `` `scene:event:${event.id}` `` — ui/scenes/event.ts:289 | KEEP |
| `scene:treasure` | scenes/treasure.webp | 139 KB (1600×900) | 1280×720 (cover) | literal — ui/overlays/loot.ts:221 (chest + boss-hoard loot cards) | **NEW** |
| `scene:rest` | scenes/rest.webp | 114 KB (1600×900) | 1280×720 (cover) | literal — ui/scenes/runMap.ts:1595 (the catnap card) | **NEW** |
| `scene:elite` | scenes/elite.webp | 127 KB (1600×900) | 1360×800 (cover + parallax) | literal — ui/scenes/battleWidgets.ts:341 (elite-node battle stage) | **NEW** |
| `scene:partyCreator` | scenes/partyCreator.webp | 137 KB (1600×900) | 1280×720 (cover) | literal — ui/scenes/partyCreator.ts:595 | **NEW** |
| `scene:floorgen` | scenes/floorgen.webp | 147 KB (1600×900) | 1280×720 (cover) | literal — ui/scenes/floorgen.ts:70 | **NEW** |
| `scene:landing` | scenes/landing.webp | 162 KB (1600×907) | 1280×720 (cover) | literal — ui/scenes/landing.ts:218 | KEEP |
| `scene:victory` | scenes/victory.webp | 185 KB (1600×907) | 1280×720 (cover) | literal — ui/scenes/results.ts:183 | KEEP |
| `scene:defeat` | scenes/defeat.webp | 90 KB (1600×907) | 1280×720 (cover) | literal — ui/scenes/results.ts:183 | KEEP |
| `scene:battle:1` | scenes/battle-1.webp | 139 KB (1600×900) | 1360×800 (cover + parallax) | `` `scene:battle:${floorNum}` `` — ui/scenes/battleWidgets.ts:342 | KEEP |
| `scene:battle:2` | scenes/battle-2.webp | 108 KB (1600×900) | 1360×800 (cover + parallax) | `` `scene:battle:${floorNum}` `` — ui/scenes/battleWidgets.ts:342 | KEEP |
| `scene:battle:3` | scenes/battle-3.webp | 71 KB (1600×900) | 1360×800 (cover + parallax) | `` `scene:battle:${floorNum}` `` — ui/scenes/battleWidgets.ts:342 | KEEP |
| `scene:battle:4` | scenes/battle-4.webp | 110 KB (1600×900) | 1360×800 (cover + parallax) | `` `scene:battle:${floorNum}` `` — ui/scenes/battleWidgets.ts:342 | KEEP |
| `scene:battle:5` | scenes/battle-5.webp | 129 KB (1600×900) | 1360×800 (cover + parallax) | `` `scene:battle:${floorNum}` `` — ui/scenes/battleWidgets.ts:342 | KEEP |
| `scene:battle:6` | scenes/battle-6.webp | 83 KB (1600×900) | 1360×800 (cover + parallax) | `` `scene:battle:${floorNum}` `` — ui/scenes/battleWidgets.ts:342 | KEEP |
| `scene:map:1` | scenes/map-1.webp | 82 KB (1600×900) | 1280×720 (cover) | `` `scene:map:${floorNum}` `` — ui/scenes/runMap.ts:431 | KEEP |
| `scene:map:2` | scenes/map-2.webp | 72 KB (1600×900) | 1280×720 (cover) | `` `scene:map:${floorNum}` `` — ui/scenes/runMap.ts:431 | KEEP |
| `scene:map:3` | scenes/map-3.webp | 93 KB (1600×900) | 1280×720 (cover) | `` `scene:map:${floorNum}` `` — ui/scenes/runMap.ts:431 | KEEP |
| `scene:map:4` | scenes/map-4.webp | 176 KB (1600×900) | 1280×720 (cover) | `` `scene:map:${floorNum}` `` — ui/scenes/runMap.ts:431 | KEEP |
| `scene:map:5` | scenes/map-5.webp | 80 KB (1600×900) | 1280×720 (cover) | `` `scene:map:${floorNum}` `` — ui/scenes/runMap.ts:431 | KEEP |
| `scene:map:6` | scenes/map-6.webp | 111 KB (1600×900) | 1280×720 (cover) | `` `scene:map:${floorNum}` `` — ui/scenes/runMap.ts:431 | KEEP |
| `npc:peddler` | scenes/npc-peddler.png | 230 KB (384×384) | 176 px | literal — ui/scenes/landing.ts:545 | KEEP — downscaled |
| `scene:catTown` | scenes/catTown.webp | 240 KB (1600×900) | 1280×720 (cover) | literal — ui/scenes/catTown.ts:266 | KEEP |
| `town:bowls` | scenes/town-bowls.webp | 10 KB (256×256) | 72–76 px | `PLACES[].art` — core/meta/unlocks.ts:35-80 → catTown.ts:534/764 | KEEP |
| `town:stoop` | scenes/town-stoop.webp | 13 KB (256×256) | 72–76 px | `PLACES[].art` — core/meta/unlocks.ts:35-80 → catTown.ts:534/764 | KEEP |
| `town:fence` | scenes/town-fence.webp | 15 KB (256×256) | 72–76 px | `PLACES[].art` — core/meta/unlocks.ts:35-80 → catTown.ts:534/764 | KEEP |
| `town:cart` | scenes/town-cart.webp | 14 KB (256×256) | 72–76 px | `PLACES[].art` — core/meta/unlocks.ts:35-80 → catTown.ts:534/764 | KEEP |
| `town:board` | scenes/town-board.webp | 15 KB (256×256) | 72–76 px | `PLACES[].art` — core/meta/unlocks.ts:35-80 → catTown.ts:534/764 | KEEP |
| `town:drain` | scenes/town-drain.webp | 12 KB (256×256) | 72–76 px | `PLACES[].art` — core/meta/unlocks.ts:35-80 → catTown.ts:534/764 | KEEP |

### items/ — item &amp; equipment icons

| id | file | size | rendered at | referenced by | verdict |
|---|---|---:|---|---|---|
| `bestiary:unknown` | items/bestiary-unknown.png | 261 KB (512×512) | unknown | no reference in `src/` at audit time — a sibling art agent's in-flight namespace (the unknown-entry placeholder for the Bestiary panel) | **IN FLIGHT — verify** |
| `equip:appliesAlwaysHit` | items/equip-appliesAlwaysHit.png | 509 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:batteryCollar` | items/equip-batteryCollar.png | 316 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:bubbleWrapRuff` | items/equip-bubbleWrapRuff.png | 338 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:cardboardCuirass` | items/equip-cardboardCuirass.png | 431 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:catPileDouble` | items/equip-catPileDouble.png | 460 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:chimeBell` | items/equip-chimeBell.png | 410 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:critOffBalance` | items/equip-critOffBalance.png | 388 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:driedLuckyBeetle` | items/equip-driedLuckyBeetle.png | 437 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:flealessBand` | items/equip-flealessBand.png | 211 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:fluffyCollar` | items/equip-fluffyCollar.png | 436 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:healsGrantMending` | items/equip-healsGrantMending.png | 458 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:leadLinedCollar` | items/equip-leadLinedCollar.png | 250 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:mittsOfMenace` | items/equip-mittsOfMenace.png | 471 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:moverOffBalance` | items/equip-moverOffBalance.png | 487 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:ninthBell` | items/equip-ninthBell.png | 460 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:noNameTag` | items/equip-noNameTag.png | 192 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:poiseChip2` | items/equip-poiseChip2.png | 502 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:quiltedGorget` | items/equip-quiltedGorget.png | 271 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:ribbonRapier` | items/equip-ribbonRapier.png | 348 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:spikedCollar` | items/equip-spikedCollar.png | 388 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:startEnergy6` | items/equip-startEnergy6.png | 519 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:tangleTalisman` | items/equip-tangleTalisman.png | 476 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:tinBell` | items/equip-tinBell.png | 347 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:wardCollar` | items/equip-wardCollar.png | 382 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:wovenCollar` | items/equip-wovenCollar.png | 325 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `equip:yarnBangle` | items/equip-yarnBangle.png | 442 KB (512×512) | 26–54 px | `` `equip:${art}` `` — inventoryPanel.ts:175 `itemSpriteId()` | KEEP |
| `item:bagOfFleas` | items/item-bagOfFleas.png | 382 KB (512×512) | 22–54 px | `` `item:${defId}` `` — battle.ts:1548, runMap.ts:1208, loot.ts:333, landing.ts:659, inventoryPanel.ts:177 | KEEP |
| `item:canOpenerRecording` | items/item-canOpenerRecording.png | 448 KB (512×512) | 22–54 px | `` `item:${defId}` `` — battle.ts:1548, runMap.ts:1208, loot.ts:333, landing.ts:659, inventoryPanel.ts:177 | KEEP |
| `item:cardboardBox` | items/item-cardboardBox.png | 407 KB (512×512) | 22–54 px | `` `item:${defId}` `` — battle.ts:1548, runMap.ts:1208, loot.ts:333, landing.ts:659, inventoryPanel.ts:177 | KEEP |
| `item:catnip` | items/item-catnip.png | 411 KB (512×512) | 22–54 px | `` `item:${defId}` `` — battle.ts:1548, runMap.ts:1208, loot.ts:333, landing.ts:659, inventoryPanel.ts:177 | KEEP |
| `item:featherWand` | items/item-featherWand.png | 394 KB (512×512) | 22–54 px | `` `item:${defId}` `` — battle.ts:1548, runMap.ts:1208, loot.ts:333, landing.ts:659, inventoryPanel.ts:177 | KEEP |
| `item:sardineTin` | items/item-sardineTin.png | 510 KB (512×512) | 22–54 px | `` `item:${defId}` `` — battle.ts:1548, runMap.ts:1208, loot.ts:333, landing.ts:659, inventoryPanel.ts:177 | KEEP |
| `item:shinies` | items/item-shinies.png | 438 KB (512×512) | 18–22 px | literal — runMap.ts:1138, loot.ts:277 (the currency icon) | KEEP |
| `item:squeakyToy` | items/item-squeakyToy.png | 392 KB (512×512) | 22–54 px | `` `item:${defId}` `` — battle.ts:1548, runMap.ts:1208, loot.ts:333, landing.ts:659, inventoryPanel.ts:177 | KEEP |
| `item:theCucumber` | items/item-theCucumber.png | 457 KB (512×512) | 22–54 px | `` `item:${defId}` `` — battle.ts:1548, runMap.ts:1208, loot.ts:333, landing.ts:659, inventoryPanel.ts:177 | KEEP |
| `item:tunaSnack` | items/item-tunaSnack.png | 453 KB (512×512) | 22–54 px | `` `item:${defId}` `` — battle.ts:1548, runMap.ts:1208, loot.ts:333, landing.ts:659, inventoryPanel.ts:177 | KEEP |
| `item:warmMilk` | items/item-warmMilk.png | 350 KB (512×512) | 22–54 px | `` `item:${defId}` `` — battle.ts:1548, runMap.ts:1208, loot.ts:333, landing.ts:659, inventoryPanel.ts:177 | KEEP |
| `status:braced` | items/status-braced.png | 35 KB (256×256) | 18–22 px (status chip) | no reference in `src/` at audit time — a sibling art agent's in-flight namespace (status-chip icons for `ui/scenes/battleWidgets.ts`) | **IN FLIGHT — verify** |
| `status:frazzled` | items/status-frazzled.png | 35 KB (256×256) | 18–22 px (status chip) | no reference in `src/` at audit time — a sibling art agent's in-flight namespace (status-chip icons for `ui/scenes/battleWidgets.ts`) | **IN FLIGHT — verify** |
| `status:guarded` | items/status-guarded.png | 43 KB (256×256) | 18–22 px (status chip) | no reference in `src/` at audit time — a sibling art agent's in-flight namespace (status-chip icons for `ui/scenes/battleWidgets.ts`) | **IN FLIGHT — verify** |
| `status:mending` | items/status-mending.png | 45 KB (256×256) | 18–22 px (status chip) | no reference in `src/` at audit time — a sibling art agent's in-flight namespace (status-chip icons for `ui/scenes/battleWidgets.ts`) | **IN FLIGHT — verify** |
| `status:offBalance` | items/status-offBalance.png | 30 KB (256×256) | 18–22 px (status chip) | no reference in `src/` at audit time — a sibling art agent's in-flight namespace (status-chip icons for `ui/scenes/battleWidgets.ts`) | **IN FLIGHT — verify** |
| `status:provoked` | items/status-provoked.png | 49 KB (256×256) | 18–22 px (status chip) | no reference in `src/` at audit time — a sibling art agent's in-flight namespace (status-chip icons for `ui/scenes/battleWidgets.ts`) | **IN FLIGHT — verify** |
| `status:scratched` | items/status-scratched.png | 65 KB (256×256) | 18–22 px (status chip) | no reference in `src/` at audit time — a sibling art agent's in-flight namespace (status-chip icons for `ui/scenes/battleWidgets.ts`) | **IN FLIGHT — verify** |

## Retired — dead since the tile crawl was deleted

| id | file | was | decision |
|---|---|---:|---|
| `prop:chest` | env/prop-chest.png | 269 KB | **DELETED** |
| `prop:eventSparkle` | env/prop-eventSparkle.png | 201 KB | **DELETED** |
| `prop:chestOpen` | env/prop-chestOpen.png | 344 KB | **KEPT, repurposed + downscaled to 256²** |
| `prop:hoardChest` | env/prop-hoardChest.png | 419 KB | **KEPT, repurposed + downscaled to 256²** |

**Why the split rather than "delete all four".** The brief offered
delete-or-repurpose and said repurpose is better *if it fits*. Two fit and two
do not:

- `prop:chestOpen` and `prop:hoardChest` now paint the **loot card's header
  emblem** — the object the panel is about, on the panel — for the `chest` and
  `boss` variants respectively (`EMBLEM` in `ui/overlays/loot.ts`). They are
  keyed, on-palette (gold hoard, purple Stand fringe) and they read cleanly at
  their real 84 px size, verified over the panel colour. The card that used to
  be a bare gold-ruled box on a flat scrim is now a chest on a hoard. That is
  the asset earning its place, not being found a job.
- `prop:chest` (the **closed** chest) has no beat to occupy. A `treasure` node
  resolves straight into the loot roll — there is no "before you open it"
  screen, and inventing one to justify 269 KB of art is a design change wearing
  an art change's clothes.
- `prop:eventSparkle` is redundant twice over: `node:event` is *already* a
  yarn ball in a spiral of purple wisps, and `runMap.ts` already draws its own
  procedural pulse on unresolved nodes. Stacking a third glow on the same
  medallion makes the board noisier, not richer.

Both deleted files' bytes were re-earned: `env/` went 1,141 KB → 1,114 KB while
gaining nothing dead, and the two survivors got 4× cheaper.

## Oversized for its rendered size

The canvas renders at up to 2× design px, so ~2× the design size is correct and
beyond ~3× is waste.

| what | ships at | renders at | ratio | cost now | cost fixed | verdict |
|---|---|---|---:|---:|---:|---|
| `items/` — all 45 icons | 512² PNG (7 already 256²) | 22–54 px (44 px inventory cell) | **≈9×** | 15.1 MB | ~1.5 MB @160² | **DOWNSCALE — the single biggest waste in the repo** |
| `title:hero` | 1792×1015 PNG | 1272×720 contain-fit | 1.4× (fine) | 3.36 MB | 0.34 MB as WebP q82 | **RE-ENCODE** — it is opaque; PNG buys nothing |
| root cast (`cat:` `enemy:` `boss:` `portrait:`, 23 files) | 635–724 px PNG w/ alpha | 156–306 px character height | ≈2× (correct) | 12.4 MB | ~2.7 MB as WebP q88 | **RE-ENCODE** — pixel size is right, container is wrong |
| `node:*` | 256² | 66 px | 1.9× | 1.03 MB | — | fine |
| `portrait:*` | 320² | 32–88 px | 1.8× | 0.87 MB | — | fine |
| `scene:*` backdrops | 1600×900 WebP | 1280×720 (1360×800 in battle) | 1.2× | 3.4 MB | — | fine |

`items/` is not mine to change (two other agents hold that manifest), so it is
flagged with the number rather than fixed: **downscaling those 45 icons to 160²
recovers ~14.3 MB — well over a third of the entire asset budget — for pixels
no player can ever see.** The two re-encode rows would recover a further
~12.6 MB. All three together would take `public/assets/gen/` from 35.3 MiB
to roughly 10 MB with **zero** visible change.

## Coverage — complete

Cross-checked at audit time: **every** `EQUIP_DEFS` entry and every Mewthical
`uniqueId` in `src/content/equipment.ts` now has an `equip:*` icon, and every
`CONSUMABLES` entry has an `item:*` icon. Nothing in the game falls back to a
procedural glyph any more. (Eight equipment defs were uncovered when this pass
started; the item agents closed the gap while it ran.) Every `EVENTS` id has a
`scene:event:*` illustration, every floor 1-6 has both a `scene:battle:*` and a
`scene:map:*`, and every `NODE_TYPES` entry has a `node:*` medallion.

## COHESION — does this read as one art direction?

Looked at all of it together: `contact-cast.png` (the whole cast at true
relative in-game scale), `contact-scenes.png` (all 25 backdrops + 10 event
illustrations), `contact-env.png` (medallions at their true 66 px board size,
plus the desaturated legibility row), `contact-items.png` (every icon at 96 px
and again at the real 44 px inventory cell, in colour and desaturated).

**Verdict: no — not quite. The main direction holds 102 of 118 ids and holds
well, but the library ships THREE art directions. Two of the seams are
deliberate legibility trades; one flaw is an accident; and one whole group is a
generation behind.**

**1. The main direction holds.** Inked cel-shading, purple-indigo key, exactly
one warm accent per frame, gold/brass highlights, translucent purple Stand
energy. The cast, every backdrop, the item icons, the town marks, the peddler
and the two chest props all live inside it. The five new backdrops were
composited under the real party (`cat-bruno` + `cat-mora` at 186/170 px) and
real enemies at true battle scale and cross-faded against `scene:battle:1`:
same ink weight, same value range, same palette, sprites separate cleanly on
all of them. They are indistinguishable from the shipped set.

**2. The run-map medallions (`node:*`, 9 ids) are a second, deliberate art
direction.** Flat poster silhouettes on saturated single-hue discs — no ink
texture, no rim light, no cel shading. This is documented and intentional
(`scripts/gen-node-medallions.mjs`): the first pewter family was illegible at
board scale, so the second batch traded style for silhouette + hue + value
separation, and it works — the desaturated row in `contact-env.png` is tellable
apart. But it should be said plainly: on the painted run map they read as
clip-art badges pinned to an illustration. Named, not "fixed" — reverting the
look would break the legibility contract it exists to satisfy. Two real
defects inside it, though:

- **`node:event` is off-palette.** Its question mark samples at ≈`#D80060`, a
  hot magenta that appears nowhere in `ART_STYLE.palette` or
  `src/ui/palette.ts`. It is the single most off-key colour in the shipped
  library. Recolour to `PAL.standPurple` / `PAL.gold` and it costs nothing in
  legibility (its silhouette already carries the type).
- **`node:shop` misreads.** At 66 px the hooded figure is a white spectre, not
  a merchant. `node:shop` is the one emblem a player has to learn rather than
  recognise.

**3. The status-chip icons (`status:*`, 7 ids) are a THIRD art direction, and
the least defensible one.** `braced` is a pair of flat teal bars, `mending` a
flat green cross, `guarded` a flat blue shield, `offBalance` a flat orange
triangle, `frazzled` a flat purple spiral — no ink outline, no cel shading, no
rim light, no palette discipline, and brighter and more saturated than anything
else in the game. They are generic UI clip-art. The size argument that excuses
the medallions applies here too (a status chip renders at ~18-22 px, where
painterly detail is wasted), but `provoked` and `scratched` prove the point
against the rest: those two ARE drawn in the house language — a slit amber eye,
raked claw slashes — and they read *better* at 44 px than the flat five, not
worse. The other five should be re-drawn to match those two. (Sibling agent's
namespace; flagged, not touched.)

**4. `scene:event:*` (10) + `scene:landing` + `scene:victory` + `scene:catTown`
are the same direction one generation behind.** Same palette, same subject
matter, but a softer, glow-heavy, more *rendered* finish with much less visible
ink than the battle/map/new backdrops beside them in `contact-scenes.png`. They
are not wrong, they are older. If anything in this library gets re-rolled next,
it is this group — and `scene:landing` and `scene:victory` most of all, because
they contain painted cats whose finish does not match the `cat-*.png` sprites
the player is standing next to on the same screen.

### Named defects that are craft, not style

- **`scene:map:1..6` ship large unpainted black voids** — the one place where
  the "every part of the canvas is painted scenery" rule that governs the
  battle backdrops was not applied. The six are drawn as side-on *cutaways*, so
  the black above and below the section is meant to be solid earth; but it is
  literally `#000` with a hard silhouette edge and no strata, no rock texture,
  no reflected light, where `scene:battle:*` paints every surface. Measured
  rows with mean luma < 12 on the 1600×900 files:

  | id | dead rows top | dead rows bottom | % of frame |
  |---|---:|---:|---:|
  | `scene:map:2` | 181 | 187 | **41 %** |
  | `scene:map:5` | 142 | 173 | 35 % |
  | `scene:map:6` | 108 | 107 | 24 % |
  | `scene:map:3` | 0 | 98 | 11 % |
  | `scene:map:1` | 86 | 100 | 21 % |
  | `scene:map:4` | 67 | 95 | 18 % |

  The viewport is the same 16:9, so `sceneBackdrop` cover-fits 1:1 and those
  voids land on screen exactly as painted — up to 41 % of the run map is flat
  black. This is **not** a crop bug (cropping would cut the cutaway silhouette
  the composition depends on) and it is **not** a keying artefact: it is
  unpainted canvas. The fix is a re-roll with the void painted as strata,
  packed earth and pipe runs receding into shadow, the way `scene:battle:1`
  paints its cellar walls. Cheapest single improvement available to the run
  map. Left alone in this pass because re-rolling six accepted backdrops is a
  bigger decision than a gap-fill.
- **`items/` now ships ten torus-shaped collars and three brass bells.** At the
  real 44 px cell — and especially desaturated — `batteryCollar`,
  `bubbleWrapRuff`, `flealessBand`, `fluffyCollar`, `leadLinedCollar`,
  `quiltedGorget`, `spikedCollar`, `wardCollar`, `wovenCollar` and
  `yarnBangle` are one silhouette in ten colourways, and `chimeBell` /
  `ninthBell` / `tinBell` are one bell in three. See the bottom half of
  `contact-items.png`. Some of this is unavoidable (they *are* all collars —
  it is one equipment slot), but silhouette, not hue, is what survives 44 px:
  the set needs distinct hanging charms, buckles and profiles, the way
  `noNameTag` and `spikedCollar` already have. Owned by the item agents.
- **`enemy:yarnGolem` is the one cast member outside the roster's chroma
  range** — full-saturation scarlet and teal where everything else is muted
  earth, bone and steel under purple. It reads a tier cartoonier than its
  neighbours in `contact-cast.png`.
- **`scene:catTown`** is materially warmer and brighter than every other
  backdrop and contains a character. It is a hub, so the warmth is defensible;
  the character is the same "painted cat that is not one of your cats" problem
  as `scene:landing`.

### What the new art was checked against

Every one of the five new backdrops was: viewed at full size (text hunt — one
`rest` render was **rejected** for painting the word "MILK" on a tin, and again
for carrying purple spectral wisps into a scene whose whole job is "no threat";
the accepted v2 has neither); composited under the real party and real enemies
at true battle scale; and checked for the "no character that contradicts the
player's actual party" rule — **all five are empty of living things.** That
rule is why `scene:rest` is a warm, dented, still-occupied-looking *nest* with
nobody in it rather than the pile of sleeping cats the brief sketched: any
painted cat in that frame is a cat the player did not choose.

## Contact sheets

Regenerated in `docs/art/`:

| sheet | what it shows |
|---|---|
| `contact-cast.png` | every cat, enemy, boss and portrait at **true relative in-game scale** |
| `contact-scenes.png` | all 25 backdrops + 10 event illustrations, grouped by role |
| `contact-env.png` | the 9 medallions at their true 66 px board size, plus the desaturated legibility row, plus the 2 surviving props at their true 84 px header size |
| `contact-items.png` | every icon at 96 px, then the real test: 44 px, in colour and desaturated |

Also still current: `node-legibility.png` (medallion acceptance test, written
by `scripts/key-node-medallions.mjs`) and `trim-contact.png` (the subject/aura
classifier used by `scripts/trim-sprites.mjs`).

## Pipeline (unchanged, reused as-is)

- **Prompt composition.** `ART_STYLE.framing.scene` + per-scene scenery +
  `ART_STYLE.basePrompt` + `"Avoid: " + ART_STYLE.negative` (plus
  backdrop-specific negatives), from `src/content/artStyle.ts`. The one
  documented deviation for backdrops is unchanged: `basePrompt`'s "flat
  #1a1626 background for clean keying" sentence is replaced by "deep
  desaturated purple-indigo palette, muted low-contrast values so bright
  character sprites can be composited on top and still read", because a
  full-bleed environment has no background to key.
- **Model / size.** `gemini-3-pro-image-preview`, `--dimension 2752x1536`,
  `--ref` the accepted `map-1` (carries the ink/palette language and contains
  no figure to copy — the anchor is avoided for backdrops because it bleeds
  Bruno into the frame). Export: centre-crop to exactly 16:9, LANCZOS to
  1600×900, WebP q82.
- **Chroma-key.** Backdrops are opaque WebP and are not keyed. The two
  repurposed props were already keyed by the repo's existing recipe
  (per-image median of the 4 px border ring → border-seeded flood fill at
  colour tolerance 8 → soft alpha ramp out to colour distance 24 → interior
  pocket cleanup) and were **not** re-keyed; the downscale to 256² was done on
  *premultiplied* alpha and un-premultiplied afterwards, so the keyed pixels'
  retained background RGB cannot bleed a dark halo into the silhouette. Same
  for `npc-peddler` at 384². Verified over the panel colour: no halo, no
  fringe.

