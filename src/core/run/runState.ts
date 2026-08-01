/**
 * c(at)rpg — run-state lifecycle (ARCHITECTURE.md WP-07: core/run/runState.ts).
 *
 * newRun(seed) → the starting party & kit; run-map generation entry points;
 * descend (floor-mod expiry + catnap heal + map gen); applyBattleResult
 * write-back (hp/lives, XP/level-ups, deaths + grief loot, score counters);
 * loot-grant application; fired-event & Mewthical-unique bookkeeping.
 *
 * Convention: run-level functions return a NEW RunState (structural
 * sharing). The run map is immutable data — traversal state lives on the
 * RunState itself as `currentNodeId` / `visitedNodeIds` (core/map/traverse.ts).
 */
import type {
  BattleResult,
  CatClass,
  CatId,
  CatRunState,
  ClassId,
  EquipDef,
  EquipInstance,
  FloorConfig,
  FloorMap,
  LootGrant,
  RunState,
  ScoreCounters,
  Skill,
  Stats,
} from "../types.js";
import type { PowerScript } from "../combat/powerTypes.js";
import { CLASSES } from "../../content/classes.js";
import { CAT_POWERS } from "../../content/powers.js";
import { EQUIP_DEFS } from "../../content/equipment.js";
import { FLOORS } from "../../content/floors.js";
import { STARTING_KIT } from "../../content/lootTables.js";
import { generateFloorMap } from "../map/generate.js";
import { hash, mulberry32 } from "../rng.js";
import {
  addConsumables,
  addShinies,
  applyGrant,
  applyGriefLoot,
  emptyInventory,
} from "../loot/inventory.js";
import { makeEquipInstance } from "../loot/roll.js";
import {
  applyLevelUps,
  expireFloorMods,
  levelForXp,
  maxHp,
  XP_CAP,
} from "./party.js";

/**
 * The four authored classes, in display order (classes.md §9). This is NO
 * LONGER the shape of `RunState.cats` — since roster-and-persistence.md §1 a
 * run carries the cat INSTANCES that descended, however many that is, and
 * class is an attribute of each. What survives here is what the name always
 * meant underneath: the canonical ordering of the class table, used by the
 * party creator's slot mapping and by the town when it seeds a roster.
 */
export const PARTY_ORDER: readonly ClassId[] = [
  "bruiser",
  "trickster",
  "hexer",
  "medic",
];

/* ------------------------------------------------------------------ */
/* Variable party size (docs/design/balance-and-meta.md §2)            */
/* ------------------------------------------------------------------ */

/** A run starts with TWO cats. The clowder is earned, not issued. */
export const STARTING_PARTY_SIZE = 2;

/**
 * How many cats a run may field at most. Three by default — the third joins
 * mid-run. The FOURTH slot is a Cat Town meta unlock (§4): the hub passes
 * `partyCapacity: 4` into `newRun` and everything downstream follows, because
 * the roster is read from run state and nothing hardcodes a party size.
 */
export const DEFAULT_PARTY_CAPACITY = 3;
export const MAX_PARTY_CAPACITY = 4;

/** The floor whose descent hands the party its third cat (see `descend`). */
export const RECRUIT_FLOOR = 3;

/** Bruno is always the first cat; the run rolls its second from these. */
const SECOND_CAT_POOL: readonly ClassId[] = ["trickster", "hexer", "medic"];

/** This run's ceiling on fielded cats (absent ⇒ the default three). */
export function partyCapacity(run: RunState): number {
  return clampInt(
    run.partyCapacity ?? DEFAULT_PARTY_CAPACITY,
    STARTING_PARTY_SIZE,
    MAX_PARTY_CAPACITY,
  );
}

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(v)));

/** THE lookup — every classId-keyed `find` in the old engine became this. */
export function catById(run: RunState, id: CatId): CatRunState | undefined {
  return run.cats.find((c) => c.id === id);
}

/** The cats actually in the formation, front→back (== `marchingOrder`). */
export function fieldedCats(run: RunState): CatRunState[] {
  const out: CatRunState[] = [];
  for (const id of run.marchingOrder) {
    const cat = catById(run, id);
    if (cat && cat.lives > 0) out.push(cat);
  }
  return out;
}

/**
 * The CLASSES represented on this descent. Kept because several screens ask
 * "does the party contain a hexer?" — a class question, which class-as-an-
 * attribute answers by scanning the instances instead of consulting a table.
 */
export function rosterClasses(run: RunState): readonly ClassId[] {
  const seen: ClassId[] = [];
  for (const c of run.cats) {
    if (c.lives > 0 && !seen.includes(c.classId)) seen.push(c.classId);
  }
  return seen;
}

/**
 * Cats that came along but are not in the formation. Normally EMPTY: since
 * the roster screen (roster-and-persistence.md §3) the player picks who
 * descends in town, so everyone who descended is fielded. It stays non-empty
 * for exactly two cases, and both matter:
 *   - a v3 save migrated forward, which carried all four class slots;
 *   - a cat pushed past capacity by a custom party.
 */
export function benchedCats(run: RunState): CatRunState[] {
  return run.cats.filter(
    (c) => c.lives > 0 && !run.marchingOrder.includes(c.id),
  );
}

/** Is there room in the formation for one more cat? */
export function hasRoom(run: RunState): boolean {
  return fieldedCats(run).length < partyCapacity(run);
}

/** Is there both room in the formation and somebody left to fill it? */
export function canRecruit(run: RunState): boolean {
  return hasRoom(run) && benchedCats(run).length > 0;
}

/**
 * THE recruit API — the seam a recruit encounter (or a migrated save's
 * mid-run join) calls, and the one that had ZERO call sites before the
 * roster screen existed (roster-and-persistence.md §0).
 *
 * `who` is either a cat ALREADY in `run.cats` (by id) or a brand-new
 * instance to add to the descent — the shape a "a stray follows you home"
 * encounter hands over. Omitted takes the first benched cat. Returns the run
 * untouched with `recruited: null` when the formation is full, the cat is
 * unknown/dead, or it is already marching, so callers can fire and forget.
 *
 * The recruit joins at FULL HP for the party's current level: a cat that
 * shows up on floor 3 is a floor-3 cat, not a level-1 one.
 */
export function recruitCat(
  run: RunState,
  who?: CatId | CatRunState,
): { run: RunState; recruited: CatId | null } {
  if (!hasRoom(run)) return { run, recruited: null };

  // a fresh instance: it joins the descent AND the formation
  if (who !== undefined && typeof who !== "string") {
    if (catById(run, who.id)) return recruitCat(run, who.id);
    const joined: CatRunState = { ...who, hp: maxHp(who, run.level) };
    return {
      run: {
        ...run,
        cats: [...run.cats, joined],
        marchingOrder: [...run.marchingOrder, joined.id],
      },
      recruited: joined.id,
    };
  }

  const bench = benchedCats(run);
  const pick = who !== undefined ? bench.find((c) => c.id === who) : bench[0];
  if (!pick) return { run, recruited: null };
  const cats = run.cats.map((c) =>
    c.id === pick.id ? { ...c, hp: maxHp(c, run.level) } : c,
  );
  return {
    run: { ...run, cats, marchingOrder: [...run.marchingOrder, pick.id] },
    recruited: pick.id,
  };
}

/* ------------------------------------------------------------------ */
/* Custom party (GM party creator — docs/design/gm-system.md)          */
/* ------------------------------------------------------------------ */

/**
 * A GM-generated cat kit, snapshotted into the run at creation. Composed of
 * core types only (the ui-layer party creator maps the wire-shape
 * `GeneratedCatKit` from src/services/gmTypes.ts into this — core never
 * imports from services). Each kit occupies one of the four fixed ClassId
 * slots (role-mapped: tank→bruiser, striker→trickster, control→hexer,
 * support→medic) so every classId-keyed system keeps working; the ui layer
 * overlays the kit's stats/skills/flavor onto the content tables for the
 * duration of the run.
 */
export interface CustomCatKit {
  /** The fixed party slot this kit occupies. */
  classId: ClassId;
  role: "tank" | "striker" | "control" | "support";
  catName: string;
  className: string;
  epithet: string;
  /** L1 stats (GM budget-linted per role). */
  base: Stats;
  /** 7 rows, applied at L2..L8. */
  growth: Partial<Stats>[];
  /** Exactly 4 full Skill defs (ids namespaced, not in content/skills.ts). */
  skills: Skill[];
  /** Prose-only in v1 — custom trait hooks are not executable. */
  trait: { name: string; desc: string };
  /** Dramatic ALL-CAPS Stand name. */
  standName: string;
  /** Masonry image prompt kept for future sprite generation (no art yet). */
  visualPrompt: string;
  /** Budget-linted Power Script (stand-powers.md Layer 2). */
  power: PowerScript;
  flavor: CatClass["flavor"];
}

// Additive, optional extension of the frozen §2.9 RunState contract: a run
// started from the party creator carries its generated kits (they serialize
// with the save via serializeRun's rest-spread). Absent = the four Strays.
declare module "../types" {
  interface RunState {
    /** GM-generated custom party (party creator); absent = default Strays. */
    customParty?: CustomCatKit[];
    /**
     * Ceiling on FIELDED cats for this run (balance-and-meta.md §2/§4).
     * Absent ⇒ `DEFAULT_PARTY_CAPACITY` (3). Cat Town raises it to 4.
     */
    partyCapacity?: number;
    /**
     * Which classes the TOWN houses, stamped in by `core/meta/startRun` —
     * informational since the roster became instance-based (who descends is
     * `run.cats`, decided in town, not derived from a class gate). Kept
     * because the DM and the event layer ask "what could this player have
     * fielded?", and because dropping it would break v3 saves for nothing.
     */
    eligibleClasses?: ClassId[];
  }
}

export const FLOOR_COUNT = FLOORS.length; // 6
/** Landing catnap: free `floor(0.25 × maxHP)` per living cat (GDD §7). */
export const CATNAP_PCT = 0.25;

const zeroScore = (): ScoreCounters => ({
  floorsCleared: 0,
  floorsReached: 0,
  enemiesDefeated: 0,
  bossesDefeated: 0,
  catPiles: 0,
  shiniesCollected: 0,
});

/** Every equipment uid a cat is wearing (0 when it wears nothing). */
const equipUids = (cat: CatRunState): number[] =>
  [cat.weapon, cat.trinket, cat.collar ?? null]
    .filter((e): e is EquipInstance => e !== null && e !== undefined)
    .map((e) => e.uid);

function weaponDefFor(classId: ClassId): EquipDef {
  const def = Object.values(EQUIP_DEFS).find(
    (d) => d.slot === "weapon" && d.classId === classId,
  );
  if (!def) throw new Error(`no class weapon def for ${classId}`);
  return def;
}

/**
 * The Stand a Stray carries. Reads the stock Power table so the town and the
 * battle log can never disagree about what a cat's Stand is called.
 */
export function standNameFor(classId: ClassId): string | undefined {
  return CAT_POWERS[classId]?.name;
}

/**
 * A freshly minted L1 instance of a class, wearing its Stray L1 class weapon
 * (`atk +2`, fixed — no rolls, loot.md §6). `id`/`name` default to the class
 * (see `CatId`): one of each is what a fresh town houses.
 */
export function makeCat(
  classId: ClassId,
  opts?: { id?: CatId; name?: string; standName?: string; weaponUid?: number },
): CatRunState {
  const uid = opts?.weaponUid ?? PARTY_ORDER.indexOf(classId) + 1;
  const stand = opts?.standName ?? standNameFor(classId);
  const cat: CatRunState = {
    id: opts?.id ?? classId,
    name: opts?.name ?? CLASSES[classId].catName,
    ...(stand !== undefined ? { standName: stand } : {}),
    classId,
    hp: 0,
    lives: 9,
    weapon: makeEquipInstance(uid, weaponDefFor(classId).id, 1, "stray"),
    trinket: null,
    tempMods: [],
    energyNextBattle: 0,
  };
  cat.hp = maxHp(cat, 1);
  return cat;
}

/**
 * A fresh run (gameloop RUN_INIT). The run map is NOT generated yet —
 * FLOORGEN calls `generateCurrentFloorMap` (floorNum starts at 1,
 * floorsReached counts it as entered); starting kit 20 ✦ + 2 Tuna Snacks +
 * 1 Cardboard Box.
 *
 * WHO DESCENDS is `opts.cats` — the instances Cat Town's roster screen chose
 * (roster-and-persistence.md §3), already levelled and geared, in marching
 * order. THEY ARE THE WHOLE PARTY: nobody sits on a bench any more, because
 * the choice happened in town where the player could see it.
 *
 * With `opts.cats` ABSENT this is the pre-instance engine, byte for byte: all
 * four Strays exist in `cats` at level 1 with 9 Lives, and the formation is
 * Bruno plus one drawn from `hash(runSeed, 'roster')` — its own stream, so
 * the draw can never shift the map or battle sequences. That path is what the
 * fixtures, the party creator and every direct-start smoke hook still use.
 *
 * `customParty` (optional, additive): a party-creator run records its
 * GM-generated kits. NOTE the caller must have overlaid the kits onto the
 * content tables BEFORE calling (ui/scenes/partyCreator.ts applyPartyContent)
 * so starting HP derives from the custom base stats.
 *
 * `opts.partyCapacity` is Cat Town's hook (§4); `opts.roster` names the exact
 * starting formation on the legacy path.
 */
export function newRun(
  runSeed: string,
  customParty?: CustomCatKit[],
  opts?: {
    partyCapacity?: number;
    /** THE roster: the instances that descend, front→back. */
    cats?: readonly CatRunState[];
    /** Legacy path only — which of the four Strays start fielded. */
    roster?: readonly ClassId[];
    /** The classes the town houses (informational — see `RunState`). */
    eligibleClasses?: readonly ClassId[];
  },
): RunState {
  let inventory = emptyInventory();
  inventory = addShinies(inventory, STARTING_KIT.shinies);
  for (const c of STARTING_KIT.consumables) {
    inventory = addConsumables(inventory, c.defId, c.count).inv;
  }

  const chosen = opts?.cats;
  const cats: CatRunState[] = chosen
    ? chosen.map((c) => ({ ...c }))
    : PARTY_ORDER.map((classId) => makeCat(classId));
  // Town-supplied cats bring their own gear with their own uids; the four
  // seeded Strays consumed uid 1..4 above.
  inventory = {
    ...inventory,
    nextUid: chosen
      ? Math.max(1, ...cats.flatMap(equipUids)) + 1
      : PARTY_ORDER.length + 1,
  };

  const score = zeroScore();
  score.floorsReached = 1;

  // The starting formation. Town-chosen cats ARE the formation; otherwise
  // Bruno plus one of the other three, drawn from the roster stream (an
  // explicit `opts.roster` overrides the draw entirely).
  const second =
    SECOND_CAT_POOL[
      mulberry32(hash(runSeed, "roster")).int(0, SECOND_CAT_POOL.length - 1)
    ];
  const marchingOrder: CatId[] = chosen
    ? cats.map((c) => c.id)
    : opts?.roster
      ? opts.roster.filter((id) => PARTY_ORDER.includes(id)).slice()
      : ["bruiser", second];

  return {
    runSeed,
    floorNum: 1,
    cats,
    marchingOrder,
    xp: 0,
    level: 1,
    inventory,
    score,
    firedEventIds: [],
    floorFiredEventIds: [],
    uniquesDropped: [],
    floorMap: null,
    currentNodeId: null,
    visitedNodeIds: [],
    playTimeMs: 0,
    ...(customParty && customParty.length > 0 ? { customParty } : {}),
    ...(opts?.partyCapacity !== undefined
      ? { partyCapacity: opts.partyCapacity }
      : {}),
    ...(opts?.eligibleClasses
      ? {
          eligibleClasses: PARTY_ORDER.filter((id) =>
            opts.eligibleClasses?.includes(id),
          ),
        }
      : {}),
  };
}

/** The FloorConfig for a 1-based floor number, or a hard error. */
export function floorConfig(floorNum: number): FloorConfig {
  const cfg = FLOORS[floorNum - 1];
  if (!cfg) throw new Error(`no floor config for floor ${floorNum}`);
  return cfg;
}

/**
 * Generate (or regenerate) the current floor's run map from the run seed —
 * the FLOORGEN state's core call. Deterministic: same seed + floorNum ⇒ the
 * same graph (run-map-and-dm.md §2). The party is placed on the entry node
 * and the entry counts as visited: it is where the floor's first encounter
 * happens, not a lobby.
 */
export function generateCurrentFloorMap(run: RunState): RunState {
  const map = generateFloorMap(
    run.runSeed,
    run.floorNum,
    floorConfig(run.floorNum),
  );
  return enterFloorMap(run, map);
}

/** Put the party on a map's entry node (fresh floor, or a migrated save). */
export function enterFloorMap(run: RunState, map: FloorMap): RunState {
  return {
    ...run,
    floorMap: map,
    currentNodeId: map.entryId,
    visitedNodeIds: [map.entryId],
  };
}

/**
 * Living cats (lives > 0) in slot order — INCLUDING the bench. For the cats
 * that actually fight, use `fieldedCats`.
 */
export function livingCats(run: RunState): CatRunState[] {
  return run.cats.filter((c) => c.lives > 0);
}

/**
 * Free landing catnap: every living cat heals `floor(0.25 × maxHP)`,
 * capped at max HP. Returns the healed amounts per cat index (0 for dead
 * or already-full cats) for the landing scene's floaters.
 */
export function catnapHeal(
  cats: readonly CatRunState[],
  level: number,
): { cats: CatRunState[]; healed: number[] } {
  const healed: number[] = [];
  const next = cats.map((cat) => {
    if (cat.lives <= 0) {
      healed.push(0);
      return cat;
    }
    const max = maxHp(cat, level);
    const hp = Math.min(max, cat.hp + Math.floor(CATNAP_PCT * max));
    healed.push(hp - cat.hp);
    return hp === cat.hp ? cat : { ...cat, hp };
  });
  return { cats: next, healed };
}

/**
 * Descend to the next floor (Landing → FLOORGEN n+1):
 *  1. floor-scoped tempMods expire (descending the stairs — events.md §1),
 *  2. free catnap heal `floor(0.25 × maxHP)` per living cat,
 *  3. floorNum+1, floorsReached+1, floor-scoped fired-event ids reset,
 *  4. the new floor's run map generates from the seed and the party is
 *     placed on its entry node (traversal state resets with the floor),
 *  5. arriving on `RECRUIT_FLOOR` with room in the formation AND somebody on
 *     the bench, that cat joins.
 * `energyNextBattle` grants persist — they are consumed by the next battle
 * setup, whenever that happens.
 *
 * Step 5 is now a NO-OP on a normal descent, and that is the point: the
 * player picks who comes along in town (roster-and-persistence.md §3), so
 * there is no bench for the dungeon to hand out from. It survives for the
 * one case that still has one — a v3 save migrated forward, which carried all
 * four class slots and expects its third cat on floor 3.
 */
export function descend(run: RunState): RunState {
  if (run.floorNum >= FLOOR_COUNT) {
    throw new Error("descend: already on the last floor");
  }
  const expired = run.cats.map((c) => expireFloorMods(c, run.level));
  const { cats } = catnapHeal(expired, run.level);
  const score = { ...run.score, floorsReached: run.score.floorsReached + 1 };
  const floorNum = run.floorNum + 1;
  let next: RunState = {
    ...run,
    cats,
    score,
    floorNum,
    floorFiredEventIds: [],
    floorMap: null,
    currentNodeId: null,
    visitedNodeIds: [],
  };
  if (floorNum >= RECRUIT_FLOOR && canRecruit(next)) {
    next = recruitCat(next).run;
  }
  return generateCurrentFloorMap(next);
}

/* ------------------------------------------------------------------ */
/* battle write-back                                                   */
/* ------------------------------------------------------------------ */

export interface ApplyBattleOutput {
  run: RunState;
  /**
   * The cats that hit 0 Lives in this battle. Gone for the run here, and
   * gone FOREVER once the town buries them (`buryRun`, core/meta/roster.ts) —
   * this is the event perma-death hangs off.
   */
  died: CatRunState[];
  /** their equipment, now in the shared inventory (grief loot) */
  griefLoot: EquipInstance[];
  /** grief pieces that found no inventory slot (dropped to the tile) */
  griefOverflow: EquipInstance[];
  /** party level after XP application (== run.level) */
  levelAfter: number;
}

/**
 * Write a finished battle back into the run (gameloop.md §1: battles write
 * back ONLY per-cat hp/lives, XP/level, score counters — everything else is
 * battle-scoped):
 *
 *  - per-cat `hp`/`lives` from the post-standup BattleResult values;
 *    `energyNextBattle` was consumed by this battle's setup and clears;
 *  - Ninth Bell: `hookSpent` latches on the equipped instance;
 *  - XP → level-ups (multi-level ok, delta-HP rule, surplus past 570
 *    ignored) applied to the written-back HP values;
 *  - cats at 0 Lives: removed from the marching order (compression) and
 *    their gear drops into the shared inventory (grief loot, WP-05 API);
 *  - score counters (enemies, cat piles, bosses);
 *  - on victory at the floor's TERMINAL node (`nodeId === floorMap.bossId`):
 *    `floorsCleared` ticks — the boss (or the pack guarding the stairs) is
 *    down and the way onward is open. Pass the node the fight belongs to;
 *    event fights and mid-floor packs pass their own id (or nothing) and
 *    never tick it.
 */
export function applyBattleResult(
  run: RunState,
  result: BattleResult,
  nodeId?: number,
): ApplyBattleOutput {
  // 1. hp/lives write-back (post-standup values), energyNextBattle cleared.
  //    Matched by INSTANCE id; a result row without one (a hand-built fixture
  //    from before instances) falls back to the class, which is unambiguous
  //    exactly when the run has one cat of that class — the fixture case.
  let cats: CatRunState[] = run.cats.map((cat) => {
    const r =
      result.cats.find((c) => c.catId === cat.id) ??
      result.cats.find(
        (c) => c.catId === undefined && c.classId === cat.classId,
      );
    if (!r) return cat;
    return { ...cat, hp: r.hp, lives: r.lives, energyNextBattle: 0 };
  });

  // 2. Ninth Bell crack: mark the equipped instance spent.
  if (result.ninthBellSpent) {
    cats = cats.map((cat) => {
      const t = cat.trinket;
      if (t && t.hook === "ninthBell" && !t.hookSpent) {
        return { ...cat, trinket: { ...t, hookSpent: true } };
      }
      return cat;
    });
  }

  // 3. XP + level-ups (victory only carries xp; flee/defeat report 0).
  const xp = Math.min(XP_CAP, run.xp + result.xpGained);
  const levelAfter = levelForXp(xp);
  cats = applyLevelUps(cats, run.level, levelAfter);

  // 4. deaths: marching-order compression + grief loot. The gear goes into
  //    the shared backpack, which is what carries it home — see `buryRun`:
  //    losing the cat is permanent, losing the gear too would make a small
  //    roster unrecoverable.
  const died: CatRunState[] = [];
  const griefLoot: EquipInstance[] = [];
  const griefOverflow: EquipInstance[] = [];
  let inventory = run.inventory;
  cats = cats.map((cat) => {
    if (cat.lives > 0) return cat;
    if (!run.marchingOrder.includes(cat.id)) return cat; // already gone
    const g = applyGriefLoot(cat, inventory);
    inventory = g.inv;
    griefLoot.push(...g.dropped);
    griefOverflow.push(...g.overflow);
    died.push(g.cat);
    return g.cat;
  });
  const deadIds = died.map((c) => c.id);
  const marchingOrder = run.marchingOrder.filter((id) => !deadIds.includes(id));

  // 5. score counters.
  const score: ScoreCounters = {
    ...run.score,
    enemiesDefeated: run.score.enemiesDefeated + result.enemiesDefeated,
    catPiles: run.score.catPiles + result.catPiles,
    bossesDefeated: run.score.bossesDefeated + (result.bossDefeated ? 1 : 0),
  };

  // 6. floor bookkeeping: clearing the terminal node clears the floor.
  if (
    result.outcome === "victory" &&
    nodeId !== undefined &&
    run.floorMap !== null &&
    nodeId === run.floorMap.bossId
  ) {
    score.floorsCleared += 1;
  }

  return {
    run: {
      ...run,
      cats,
      marchingOrder,
      xp,
      level: levelAfter,
      inventory,
      score,
    },
    died,
    griefLoot,
    griefOverflow,
    levelAfter,
  };
}

/* ------------------------------------------------------------------ */
/* loot & event bookkeeping                                            */
/* ------------------------------------------------------------------ */

/**
 * Fold a LootGrant into the run: wallet (clamped 0..999; negatives = TITHE),
 * inventory slots (overflow returned for the Take/Leave modal), the
 * `shiniesCollected` score counter (positive gains only — punishments never
 * reduce score), and Mewthical unique bookkeeping (uniquesDropped).
 */
export function applyLootGrant(
  run: RunState,
  grant: LootGrant,
): {
  run: RunState;
  overflow: {
    equips: EquipInstance[];
    consumables: { defId: string; count: number }[];
  };
} {
  const { inv, overflow } = applyGrant(run.inventory, grant);
  const uniques = run.uniquesDropped.slice();
  for (const e of grant.equips) {
    if (e.hook && !uniques.includes(e.hook)) uniques.push(e.hook);
  }
  const score = {
    ...run.score,
    shiniesCollected: run.score.shiniesCollected + Math.max(0, grant.shinies),
  };
  return {
    run: { ...run, inventory: inv, uniquesDropped: uniques, score },
    overflow,
  };
}

/**
 * Record a fired event id: floor-scoped list (no repeat on this floor) and
 * the run-scoped list (`once` gating — events.md §2.1). Idempotent.
 */
export function markEventFired(run: RunState, eventId: string): RunState {
  const floorFiredEventIds = run.floorFiredEventIds.includes(eventId)
    ? run.floorFiredEventIds
    : [...run.floorFiredEventIds, eventId];
  const firedEventIds = run.firedEventIds.includes(eventId)
    ? run.firedEventIds
    : [...run.firedEventIds, eventId];
  return { ...run, firedEventIds, floorFiredEventIds };
}
