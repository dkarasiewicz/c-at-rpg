# Generated-asset usage audit — run-map cleanup

Audited 2026-07-31, immediately before/while the tile crawl (`src/core/dungeon/*`,
`src/ui/scenes/explore.ts`, `minimap.ts`, `exploreHud.ts`) is deleted per
[`docs/design/run-map-and-dm.md`](../design/run-map-and-dm.md).

Method: every id in all four manifests (`public/assets/gen/{,env/,items/,scenes/}manifest.json`)
cross-referenced against a full-text grep of `src/`, then re-checked against the *dynamic*
id constructions (`` `enemy:${id}` ``, `` `item:${defId}` ``, `` `scene:battle:${floorNum}` ``…),
which is how most ids are actually reached — a literal-grep miss is NOT evidence of death.

**Verdict policy.** KEEP everything in the cast / enemy / boss / portrait / item / equipment /
scene namespaces regardless of literal references, plus every id in the run-map shared asset
contract (`scene:map:1..6`, `node:*`) — the run-map UI is being written concurrently.
DELETE only what the tile crawl alone consumed.

## Summary

| | files | bytes |
|---|---:|---:|
| deleted (`tile:*`, `token:*`) | 14 | 5,595,556 |
| added (`scene:map:*`, `node:*`) | 15 | 1,669,378 |
| **net** | **+1** | **−3,926,178** |

`public/assets/gen/` went from 41,509,912 B to 37,592,674 B (−9.5 %).

## Deleted — dead with the tile crawl

Nine seamless dungeon tiles and five top-down map tokens. Every one of them was referenced
from exactly one place, `src/ui/scenes/explore.ts` (plus `exploreAtmosphere.ts` for
`tile:wall`), both of which the run-map change removes. Nothing else in `src/` — and nothing
in the run-map contract — can consume a seamless 512² floor texture or a top-down party token.

| id | file | size | was referenced by |
|---|---|---:|---|
| `tile:floor` | env/tile-floor.png | 426 KB | ui/scenes/explore.ts |
| `tile:floor2` | env/tile-floor2.png | 422 KB | ui/scenes/explore.ts |
| `tile:floor3` | env/tile-floor3.png | 437 KB | ui/scenes/explore.ts |
| `tile:wall` | env/tile-wall.png | 493 KB | ui/scenes/explore.ts, exploreAtmosphere.ts |
| `tile:door` | env/tile-door.png | 420 KB | ui/scenes/explore.ts |
| `tile:doorBoss` | env/tile-doorBoss.png | 488 KB | ui/scenes/explore.ts |
| `tile:stairsUp` | env/tile-stairsUp.png | 512 KB | ui/scenes/explore.ts |
| `tile:stairsDown` | env/tile-stairsDown.png | 476 KB | ui/scenes/explore.ts |
| `tile:nook` | env/tile-nook.png | 385 KB | ui/scenes/explore.ts |
| `token:party` | env/token-party.png | 192 KB | ui/scenes/explore.ts |
| `token:vermin` | env/token-vermin.png | 292 KB | `` `token:${look.family}` `` — explore.ts |
| `token:bird` | env/token-bird.png | 362 KB | `` `token:${look.family}` `` — explore.ts |
| `token:beast` | env/token-beast.png | 283 KB | `` `token:${look.family}` `` — explore.ts |
| `token:construct` | env/token-construct.png | 277 KB | `` `token:${look.family}` `` — explore.ts |

Files removed from disk and entries removed from `public/assets/gen/env/manifest.json`.

## Kept on purpose — `prop:*` (all four)

These are alpha-keyed illustrated objects, not grid furniture: nothing about them assumes a
tile crawl, and each has a concrete home in the new shape of the game.

| id | size | why it survives |
|---|---:|---|
| `prop:chest` | 269 KB | the closed-chest beat of a `treasure` node — shown in the encounter panel before the player opens it (the `node:treasure` medallion is the map marker, this is the object itself) |
| `prop:chestOpen` | 344 KB | the same node after the loot roll, and the loot overlay's header art (`ui/overlays/loot.ts` already draws item art there) |
| `prop:hoardChest` | 419 KB | the boss-lair hoard, which `floors.ts` still awards on floors 3 and 6; it is a distinct, richer chest and belongs on the post-boss reward screen |
| `prop:eventSparkle` | 201 KB | the "something is here" glow — a pulsing decoration on unvisited `event` nodes on the run map, exactly the pulse it already had in explore |

If the run-map author ends up not wanting any of them, `prop:*` is 1.2 MB and can go in one
commit; they are kept because deleting art that a half-written scene may want back is the more
expensive mistake.

## Full manifest inventory

### root — cast, bosses, portraits, title

| id | file | size | referenced by | verdict |
|---|---|---:|---|---|
| `cat:bruno` | cat-bruno.png | 817 KB | `cat:${classId}` — core/combat/setup.ts, ui/widgets.ts | KEEP |
| `cat:pixel` | cat-pixel.png | 788 KB | `cat:${classId}` — core/combat/setup.ts, ui/widgets.ts | KEEP |
| `cat:mora` | cat-mora.png | 738 KB | `cat:${classId}` — core/combat/setup.ts, ui/widgets.ts | KEEP |
| `cat:baguette` | cat-baguette.png | 793 KB | `cat:${classId}` — core/combat/setup.ts, ui/widgets.ts | KEEP |
| `portrait:bruno` | portrait-bruno.png | 155 KB | `portrait:<name>` — ui/widgets.ts | KEEP |
| `portrait:pixel` | portrait-pixel.png | 142 KB | `portrait:<name>` — ui/widgets.ts | KEEP |
| `portrait:mora` | portrait-mora.png | 145 KB | `portrait:<name>` — ui/widgets.ts | KEEP |
| `portrait:baguette` | portrait-baguette.png | 114 KB | `portrait:<name>` — ui/widgets.ts | KEEP |
| `enemy:ratThug` | enemy-ratThug.png | 754 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `enemy:sewerBat` | enemy-sewerBat.png | 725 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `enemy:dustBunny` | enemy-dustBunny.png | 727 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `enemy:crowShaman` | enemy-crowShaman.png | 850 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `enemy:roombaScout` | enemy-roombaScout.png | 615 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `enemy:sprinklerImp` | enemy-sprinklerImp.png | 709 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `enemy:yarnGolem` | enemy-yarnGolem.png | 843 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `enemy:porcelainHound` | enemy-porcelainHound.png | 742 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `enemy:laserGhost` | enemy-laserGhost.png | 737 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `enemy:trashPanda` | enemy-trashPanda.png | 730 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `enemy:sockWraith` | enemy-sockWraith.png | 696 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `enemy:elderStray` | enemy-elderStray.png | 693 KB | `enemy:*` — ui/widgets.ts | KEEP |
| `boss:vacuumKing` | boss-vacuumKing.png | 860 KB | `boss:*` — ui/widgets.ts | KEEP |
| `boss:dogfather` | boss-dogfather.png | 807 KB | `boss:*` — ui/widgets.ts | KEEP |
| `boss:ratPrince` | boss-ratPrince.png | 814 KB | `boss:*` — ui/widgets.ts | KEEP |
| `title:hero` | title-hero.png | 3282 KB | `ui/scenes/title.ts`, `ui/sprites.ts` | KEEP |

### env/ — props + run-map nodes

| id | file | size | referenced by | verdict |
|---|---|---:|---|---|
| `prop:chest` | prop-chest.png | 269 KB | `ui/scenes/explore.ts` | KEEP |
| `prop:chestOpen` | prop-chestOpen.png | 344 KB | `ui/scenes/explore.ts` | KEEP |
| `prop:eventSparkle` | prop-eventSparkle.png | 201 KB | `ui/scenes/explore.ts` | KEEP |
| `prop:hoardChest` | prop-hoardChest.png | 419 KB | `ui/scenes/explore.ts` | KEEP |
| `node:fight` | node-fight.png | 110 KB | `node:<type>` (contract) — run-map scene, in flight | **NEW** |
| `node:elite` | node-elite.png | 124 KB | `node:<type>` (contract) — run-map scene, in flight | **NEW** |
| `node:event` | node-event.png | 114 KB | `node:<type>` (contract) — run-map scene, in flight | **NEW** |
| `node:shop` | node-shop.png | 115 KB | `node:<type>` (contract) — run-map scene, in flight | **NEW** |
| `node:rest` | node-rest.png | 108 KB | `node:<type>` (contract) — run-map scene, in flight | **NEW** |
| `node:treasure` | node-treasure.png | 119 KB | `node:<type>` (contract) — run-map scene, in flight | **NEW** |
| `node:boss` | node-boss.png | 121 KB | `node:<type>` (contract) — run-map scene, in flight | **NEW** |
| `node:locked` | node-locked.png | 104 KB | `node:<type>` (contract) — run-map scene, in flight | **NEW** |
| `node:visited` | node-visited.png | 100 KB | `node:<type>` (contract) — run-map scene, in flight | **NEW** |

### items/ — item &amp; equipment icons

| id | file | size | referenced by | verdict |
|---|---|---:|---|---|
| `equip:appliesAlwaysHit` | equip-appliesAlwaysHit.png | 509 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:cardboardCuirass` | equip-cardboardCuirass.png | 431 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:catPileDouble` | equip-catPileDouble.png | 460 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:chimeBell` | equip-chimeBell.png | 410 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:critOffBalance` | equip-critOffBalance.png | 388 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:driedLuckyBeetle` | equip-driedLuckyBeetle.png | 437 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:fluffyCollar` | equip-fluffyCollar.png | 436 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:healsGrantMending` | equip-healsGrantMending.png | 458 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:mittsOfMenace` | equip-mittsOfMenace.png | 471 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:moverOffBalance` | equip-moverOffBalance.png | 487 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:ninthBell` | equip-ninthBell.png | 460 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:poiseChip2` | equip-poiseChip2.png | 502 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:ribbonRapier` | equip-ribbonRapier.png | 348 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:spikedCollar` | equip-spikedCollar.png | 388 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:startEnergy6` | equip-startEnergy6.png | 519 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:tangleTalisman` | equip-tangleTalisman.png | 476 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:tinBell` | equip-tinBell.png | 347 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `equip:yarnBangle` | equip-yarnBangle.png | 442 KB | `equip:${art}` — ui/overlays/inventoryPanel.ts, ui/widgets.ts | KEEP |
| `item:bagOfFleas` | item-bagOfFleas.png | 382 KB | `item:${defId}` — ui/overlays/loot.ts, ui/overlays/inventoryPanel.ts, ui/scenes/battle.ts, ui/scenes/exploreHud.ts, ui/scenes/landing.ts | KEEP |
| `item:canOpenerRecording` | item-canOpenerRecording.png | 448 KB | `item:${defId}` — ui/overlays/loot.ts, ui/overlays/inventoryPanel.ts, ui/scenes/battle.ts, ui/scenes/exploreHud.ts, ui/scenes/landing.ts | KEEP |
| `item:cardboardBox` | item-cardboardBox.png | 407 KB | `item:${defId}` — ui/overlays/loot.ts, ui/overlays/inventoryPanel.ts, ui/scenes/battle.ts, ui/scenes/exploreHud.ts, ui/scenes/landing.ts | KEEP |
| `item:catnip` | item-catnip.png | 411 KB | `item:${defId}` — ui/overlays/loot.ts, ui/overlays/inventoryPanel.ts, ui/scenes/battle.ts, ui/scenes/exploreHud.ts, ui/scenes/landing.ts | KEEP |
| `item:featherWand` | item-featherWand.png | 394 KB | `item:${defId}` — ui/overlays/loot.ts, ui/overlays/inventoryPanel.ts, ui/scenes/battle.ts, ui/scenes/exploreHud.ts, ui/scenes/landing.ts | KEEP |
| `item:sardineTin` | item-sardineTin.png | 510 KB | `item:${defId}` — ui/overlays/loot.ts, ui/overlays/inventoryPanel.ts, ui/scenes/battle.ts, ui/scenes/exploreHud.ts, ui/scenes/landing.ts | KEEP |
| `item:shinies` | item-shinies.png | 438 KB | `item:${defId}` — ui/overlays/loot.ts, ui/overlays/inventoryPanel.ts, ui/scenes/battle.ts, ui/scenes/exploreHud.ts, ui/scenes/landing.ts | KEEP |
| `item:squeakyToy` | item-squeakyToy.png | 392 KB | `item:${defId}` — ui/overlays/loot.ts, ui/overlays/inventoryPanel.ts, ui/scenes/battle.ts, ui/scenes/exploreHud.ts, ui/scenes/landing.ts | KEEP |
| `item:theCucumber` | item-theCucumber.png | 457 KB | `item:${defId}` — ui/overlays/loot.ts, ui/overlays/inventoryPanel.ts, ui/scenes/battle.ts, ui/scenes/exploreHud.ts, ui/scenes/landing.ts | KEEP |
| `item:tunaSnack` | item-tunaSnack.png | 453 KB | `item:${defId}` — ui/overlays/loot.ts, ui/overlays/inventoryPanel.ts, ui/scenes/battle.ts, ui/scenes/exploreHud.ts, ui/scenes/landing.ts | KEEP |
| `item:warmMilk` | item-warmMilk.png | 350 KB | `item:${defId}` — ui/overlays/loot.ts, ui/overlays/inventoryPanel.ts, ui/scenes/battle.ts, ui/scenes/exploreHud.ts, ui/scenes/landing.ts | KEEP |

### scenes/ — wide scene art

| id | file | size | referenced by | verdict |
|---|---|---:|---|---|
| `scene:event:yarnBall` | event-yarnBall.webp | 117 KB | `scene:event:${event.id}` — ui/scenes/event.ts | KEEP |
| `scene:event:suspiciousHuman` | event-suspiciousHuman.webp | 127 KB | `scene:event:${event.id}` — ui/scenes/event.ts | KEEP |
| `scene:event:cursedPost` | event-cursedPost.webp | 122 KB | `scene:event:${event.id}` — ui/scenes/event.ts | KEEP |
| `scene:event:shrineOfNine` | event-shrineOfNine.webp | 108 KB | `scene:event:${event.id}` — ui/scenes/event.ts | KEEP |
| `scene:event:perfectBox` | event-perfectBox.webp | 91 KB | `scene:event:${event.id}` — ui/scenes/event.ts | KEEP |
| `scene:event:milkBowl` | event-milkBowl.webp | 105 KB | `scene:event:${event.id}` — ui/scenes/event.ts | KEEP |
| `scene:event:redDot` | event-redDot.webp | 123 KB | `scene:event:${event.id}` — ui/scenes/event.ts | KEEP |
| `scene:event:dormantRoomba` | event-dormantRoomba.webp | 144 KB | `scene:event:${event.id}` — ui/scenes/event.ts | KEEP |
| `scene:event:catnipPatch` | event-catnipPatch.webp | 154 KB | `scene:event:${event.id}` — ui/scenes/event.ts | KEEP |
| `scene:event:elderStray` | event-elderStray.webp | 159 KB | `scene:event:${event.id}` — ui/scenes/event.ts | KEEP |
| `scene:landing` | landing.webp | 162 KB | `ui/scenes/landing.ts` | KEEP |
| `scene:victory` | victory.webp | 185 KB | `ui/scenes/results.ts` | KEEP |
| `scene:defeat` | defeat.webp | 90 KB | `ui/scenes/results.ts` | KEEP |
| `scene:battle:1` | battle-1.webp | 139 KB | `scene:battle:${floorNum}` — ui/scenes/battleWidgets.ts | KEEP |
| `scene:battle:2` | battle-2.webp | 108 KB | `scene:battle:${floorNum}` — ui/scenes/battleWidgets.ts | KEEP |
| `scene:battle:3` | battle-3.webp | 71 KB | `scene:battle:${floorNum}` — ui/scenes/battleWidgets.ts | KEEP |
| `scene:battle:4` | battle-4.webp | 110 KB | `scene:battle:${floorNum}` — ui/scenes/battleWidgets.ts | KEEP |
| `scene:battle:5` | battle-5.webp | 129 KB | `scene:battle:${floorNum}` — ui/scenes/battleWidgets.ts | KEEP |
| `scene:battle:6` | battle-6.webp | 83 KB | `scene:battle:${floorNum}` — ui/scenes/battleWidgets.ts | KEEP |
| `scene:map:1` | map-1.webp | 82 KB | `scene:map:${floorNum}` (contract) — run-map scene, in flight | **NEW** |
| `scene:map:2` | map-2.webp | 72 KB | `scene:map:${floorNum}` (contract) — run-map scene, in flight | **NEW** |
| `scene:map:3` | map-3.webp | 93 KB | `scene:map:${floorNum}` (contract) — run-map scene, in flight | **NEW** |
| `scene:map:4` | map-4.webp | 176 KB | `scene:map:${floorNum}` (contract) — run-map scene, in flight | **NEW** |
| `scene:map:5` | map-5.webp | 80 KB | `scene:map:${floorNum}` (contract) — run-map scene, in flight | **NEW** |
| `scene:map:6` | map-6.webp | 111 KB | `scene:map:${floorNum}` (contract) — run-map scene, in flight | **NEW** |
| `npc:peddler` | npc-peddler.png | 622 KB | `ui/scenes/landing.ts` | KEEP |

## Notes on the reference columns

- Most ids are reached through a template literal, so the "referenced by" column names the
  construction site, not a literal string match. Verified constructions: `cat:${classId}`
  (`core/combat/setup.ts`), `portrait:*` / `enemy:*` / `boss:*` (`ui/widgets.ts`),
  `item:${defId}` and `equip:${art}` (`ui/overlays/inventoryPanel.ts`, `ui/overlays/loot.ts`,
  `ui/scenes/battle.ts`, `ui/scenes/exploreHud.ts`, `ui/scenes/landing.ts`),
  `scene:event:${sel.event.id}` (`ui/scenes/event.ts`), `scene:battle:${floorNum}`
  (`ui/scenes/battleWidgets.ts`).
- `scene:map:*` and `node:*` have **no** references yet by design — they are the published
  half of the shared asset contract for the run-map scene, which another agent is writing.
  `src/ui/sprites.ts` is fail-soft per manifest directory, so an id that nobody asks for
  costs nothing but disk.
- No orphan files: every file under `public/assets/gen/**` is listed in its directory's
  manifest, and every manifest entry resolves to a file on disk (asserted programmatically
  after the edit).
