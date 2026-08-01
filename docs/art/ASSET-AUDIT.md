# THE ASSET AUDIT

> **This document is no longer written by hand.** It records the output of
> `npm run audit` (`scripts/audit-assets.mjs`), which is the source of truth.
> Re-run it rather than trusting the numbers below; if they disagree, the
> script is right and this file is stale.

Last run **2026-08-01**, after the oversize pass this document also records.

## Run it

```bash
npm run audit          # human report; exits 1 on any finding
npm run audit -- --json    # machine-readable
npm run audit:fix      # scripts/downscale-assets.mjs — resample + rewrite manifests
```

## What it checks

Every id declared in the four manifests
(`public/assets/gen/{,env/,items/,scenes/}manifest.json`) against every
reference in `src/` and `agent/`:

| finding | meaning |
|---|---|
| **unreferenced** | a declared id no code path can ever ask for |
| **missing** | a declared id whose file is not on disk |
| **declared size wrong** | manifest `w`/`h` disagrees with the actual pixels |
| **orphan** | a file under `public/assets/gen/**` no manifest declares |
| **duplicate** | an id declared twice, or two ids sharing one file |
| **oversized** | art stored far larger than the biggest box it draws into |

## The prefix problem (why a naive audit is wrong)

Most sprite ids are **never written out in full**. They are built at the call
site from a prefix:

```ts
spriteTextureFor(`enemy:${speciesId}`)      // ui/sprites.ts
makeSpriteIcon(`item:${item.defId}`, 22)    // ui/scenes/battle.ts
sceneBackdrop(`scene:map:${floorNum}`, …)   // ui/scenes/runMap.ts
iconTile(`skill:${skillId}`, ART)           // ui/overlays/progressPanel.ts
spriteTextureFor(`equip:${art}`)            // ui/overlays/inventoryPanel.ts
```

A grep for the literal `"scene:map:3"` finds nothing. **An earlier audit
stopped there and condemned 32 shipping assets as dead.** The script therefore
extracts the *static head* of every template literal (`` `scene:map:${n}` `` →
`scene:map:`) and treats it as a wildcard covering every declared id beneath
it. Plain `"cat:"`-shaped literals count too, because `id.startsWith("cat:")`
and `"item:" + defId` are the same construction in different syntax.

The 26 live prefixes as of this run:

```
background:  biome:  boss:  cat:  class:  color:  constraints:  custom:
dm:  enemy:  equip:  gear:  gmpool:  gmpool:h:  item:  node:  pool:
portrait:  scene:battle:  scene:event:  scene:map:  shinies:  shop:
skill:  slot:  status:
```

**The honest limit:** because `skill:${id}` covers the whole namespace, this
audit cannot prove one `skill:*` id dead — only a whole *namespace*. That is
the correct limit, not a weakness: an id under a live prefix becomes reachable
the moment a content table names it.

## The oversize rule

`RENDER_BUDGET` in the script records, per prefix, the largest on-screen box
that art is ever drawn into, in design px on the 1280×720 stage — **with the
call site that sets it.** The stage renders at up to 2× design px, so 2×
budget is right-sized and past 3× is waste. Nothing above 64² gets a pass;
below 64² the rule stops, because the saving is noise and the smallest boxes
are the likeliest to grow.

Those numbers are not taken on faith. `SOURCE_CHECKS` re-reads all eleven
cited constants (`CAT_HEIGHT`, `UNIT_HEIGHT`, `R_BOSS`, `CELL`, `MARK_ART`,
`EMBLEM_SIZE`, `EMBLEM_H`, `DESIGN_W`, `SUBJECT_TOP`/`FOOT`) out of the source
and **fails the audit** if one moves without this table moving with it.

| prefix | drawn at | from |
|---|---:|---|
| `cat:` | 330 | `CAT_HEIGHT` 198 ÷ `SUBJECT_SPAN` 0.6 |
| `enemy:` | 387 | `UNIT_HEIGHT.large` 232 ÷ 0.6 |
| `boss:` | 510 | `UNIT_HEIGHT.boss` 306 ÷ 0.6 |
| `portrait:` | 88 | `avatar(classId, 88)` — battleWidgets |
| `title:hero` | 1280 | full-bleed backdrop on `DESIGN_W` |
| `title:logo` | 256 | `emblem(EMBLEM_H)` — boot |
| `node:` | 84 | `R_BOSS` 42 × 2 — runMap |
| `prop:` | 84 | `EMBLEM_SIZE` — loot |
| `item:` `equip:` | 54 | `CELL` 64 − 10 — inventoryPanel |
| `skill:` | 44 | `ART` — battleWidgets |
| `status:` | 16 | `makeStatusChip` default — widgets |
| `bestiary:` | 148 | `enemyAvatar(id, 148)` — catTown |
| `npc:` | 176 | `makeSpriteIcon("npc:peddler", 176)` — landing |
| `town:` | 76 | `MARK_ART` — catTown |
| `scene:` | 1280 | full-bleed backdrop on `DESIGN_W` |

## Result of this run

```
182 ids in 4 manifests · 182 files · 23.48 MiB
scanned 112 source files in src/agent: 62 id literals, 26 id prefixes

OK   manifests parse            OK   orphan files
OK   budget citations current   OK   unreferenced ids
OK   duplicate ids              OK   oversized art
OK   declared files present     OK   declared sizes true
```

- **Nothing unreferenced.** All 182 ids are reachable — 62 by literal, the
  rest under one of the 26 prefixes.
- **No orphans, no duplicates, nothing missing**, and every manifest `w`/`h`
  matches its pixels (the downscaler rewrites them).
- Ids per manifest: root 40, `env/` 11, `items/` 93, `scenes/` 38.

### Three ids the code asks for that no manifest declares

Reported as a NOTE, not a failure — the loader is fail-soft, so an id with no
texture just means the procedural renderer stays in charge.

| id | asked for in | verdict |
|---|---|---|
| `scene:boot` | `ui/scenes/boot.ts` | deliberate: `hasSprite("scene:boot") ? … : "title:hero"` is a designed fallback, not a bug |
| `scene:title` | `ui/scenes/title.ts` | same shape — the title falls through to `title:hero` |
| `cat:bruiser` | `core/types.ts`, `core/combat/powerTypes.ts` | **not a sprite at all** — `cat:<classId>` is the COMBATANT id from `combat/setup.ts`. Sprite ids are keyed by cat *name* (`cat:bruno`). Collision of namespace, not a missing asset |

## The oversize pass — bytes before and after

`npm run audit:fix` resampled 129 files with progressive halving in Chromium
(512→256→128, `imageSmoothingQuality: "high"` at each step), keeping each
file's container. Manifest `w`/`h` rewritten to match.

| namespace | n | before | after | change | stored |
|---|---:|---:|---:|---:|---|
| `skill:` | 48 | 19,770,328 | 1,623,431 | **−91.8%** | 512² → 128² |
| `equip:` | 26 | 10,499,724 | 657,839 | **−93.7%** | 512² → 128² |
| `item:` | 11 | 4,753,111 | 264,865 | **−94.4%** | 512² → 128² |
| `portrait:` | 19 | 4,291,808 | 1,642,218 | −61.7% | 320² → 192² |
| `node:` | 9 | 931,325 | 548,798 | −41.1% | 256² → 192² |
| `bestiary:` | 1 | 395,844 | 182,756 | −53.8% | 512² → 320² |
| `status:` | 7 | 309,304 | 34,923 | **−88.7%** | 256² → 64² |
| `prop:` | 2 | 209,697 | 131,377 | −37.3% | 256² → 192² |
| `town:` | 6 | 80,830 | 52,310 | −35.3% | 256² → 192² (webp q0.92) |
| `enemy:` | 12 | 6,843,638 | 6,843,638 | — | 636-724 × 617-900, in budget |
| `scene:` | 31 | 3,938,870 | 3,938,870 | — | 1600×900/907, in budget |
| `title:` | 2 | 3,828,061 | 3,828,061 | — | 1792×1015 + 512², in budget |
| `cat:` | 4 | 2,635,871 | 2,635,871 | — | 635-728 × 737-782, in budget |
| `boss:` | 3 | 1,996,721 | 1,996,721 | — | 643-662 × 882-900, in budget |
| `npc:` | 1 | 235,706 | 235,706 | — | 384², in budget |
| **total** | **182** | **60,720,838** | **24,617,384** | **−59.5%** | |

**60,720,838 → 24,617,384 bytes. 36,103,454 saved (57.91 MiB → 23.48 MiB).**

Nothing was deleted — there were no orphans to delete. Every byte saved is
resolution nobody could see.

### Visual verification

`docs/art/downscale-before-after.png` — ten samples spanning every touched
namespace, each drawn into its **real** on-screen box at 2× device pixels
(the size a player actually sees) before and after, then nearest-neighbour
zoomed. They are indistinguishable. That check was run *before* the resample
was applied, not after.

### The generator was moved too

`scripts/trim-sprites.mjs` regenerates `portrait:*` from
`assets-src/portraits/`. Its `PORTRAIT_SIZE` was 320 and is now **192**, so
re-running it cannot silently undo this pass. Raising it without raising the
`portrait:` budget in `audit-assets.mjs` makes `npm run audit` fail, which is
the intended coupling.

### What was deliberately left alone

- **`title:hero` at 1792×1015** — it is a full-bleed backdrop on a 1280-wide
  stage, so 2× design is 2560. It is *under*-sized, not over.
- **The 1600×900 webp backdrops** — same reason. `scene:event:*` at 1600 wide
  covers the 800-wide event panel at exactly 2×.
- **Battle sprites (`cat:` `enemy:` `boss:`)** — 635-728 px frames for
  330-510 px draw boxes. Inside budget, and they carry the Stand aura that
  `spriteFrame.ts` deliberately does not count as subject height.
- **`status:*` at 64²** — 4× a 16 px chip, so nominally over. The rule stops
  at 64² on purpose: shrinking to 32² would save 17 KiB and break the first
  time anyone passes `opts.size: 24`.
