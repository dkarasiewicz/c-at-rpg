/**
 * c(at)rpg — loot roll engine (loot.md §5, value formulas §3).
 *
 * Pure functions: every roll comes from the caller-provided `Rng`
 * (chestSeed / victorySeed / eventSeed / shop streams — ARCHITECTURE.md §4).
 * Roll order per loot.md §5e — unneeded rolls are SKIPPED, not burned:
 *   ① Shinies variance (fights only) → ② drop-chance rolls (§5a) →
 *   ③ category/draw roll → ④ rarity → ⑤ slot → ⑥ def pick →
 *   ⑦ Sleek secondary pick. Stat values are formulas (§3) — no rolls.
 *
 * EquipInstance uids are assigned sequentially starting at `ctx.nextUid`;
 * inventory.applyGrant bumps the stored counter past the highest granted uid.
 */
import type {
  ClassId,
  EquipDef,
  EquipInstance,
  EquipSlot,
  ItemId,
  LootGrant,
  MewHookId,
  Rarity,
  Rng,
  StatKey,
} from "../types.js";
import { pickWeighted, roundHalfUp } from "../util.js";
import {
  filterDreamed,
  pickDreamed,
  type DreamedChoice,
  type DreamedOrigin,
} from "./dreamed.js";
import { EQUIP_DEFS, RARITY_TABLE } from "../../content/equipment.js";
import {
  BOSS_CONSUMABLE_ROLLS,
  BOSS_RARITY,
  BUNDLES,
  CHEST_DRAWS,
  CONSUMABLE_WEIGHTS,
  EQUIP_SLOT_WEIGHTS,
  FIGHT_DROPS,
  RARITY_WEIGHTS,
  SHINY_INCOME,
  type LootBundle,
} from "../../content/lootTables.js";

/** Weighted-pick order for rarity rolls (loot.md §3 table order). */
export const RARITY_ORDER: readonly Rarity[] = [
  "stray",
  "sleek",
  "pedigree",
  "mewthical",
];

/** Trinket def pick pool, in loot.md §2 table order (content table order). */
const TRINKET_DEFS = Object.values(EQUIP_DEFS).filter(
  (d) => d.slot === "trinket",
);

/** Collar def pick pool (progression.md §4), content table order. */
const COLLAR_DEFS = Object.values(EQUIP_DEFS).filter(
  (d) => d.slot === "collar",
);

/** Weapon def lookup by class. */
const WEAPON_BY_CLASS = new Map(
  Object.values(EQUIP_DEFS)
    .filter((d) => d.slot === "weapon")
    .map((d) => [d.classId as ClassId, d]),
);

/** Context every grant roll needs (caller = scene / run-state layer). */
export interface LootCtx {
  /** Floor number `n` (1..6). Shop rolls pass the floor just cleared. */
  floor: number;
  /**
   * Living cats' classes, in the fixed party order — the §5 weapon-class
   * pick pool (a dead class's weapon never drops again).
   */
  livingClasses: ClassId[];
  /** Mewthical uniques already dropped this run (unique-or-downgrade rule). */
  uniquesDropped: MewHookId[];
  /** First uid to assign to granted EquipInstances. */
  nextUid: number;
  /** Current wallet — required for the TITHE bundle's `min(current, …)`. */
  currentShinies?: number;
  /**
   * THE DREAMING (core/loot/dreamed.ts): equipment other people's runs put in
   * the shared pool, already validated by `services/pool.ts` and narrowed to
   * this floor, plus the pool size that sets `p = min(0.7, size/200)`.
   *
   * OMITTED IS THE OFFLINE GAME. Absent or empty, step ⑥ below is exactly the
   * roll it has always been and not one extra draw is taken from the stream.
   */
  dreamed?: DreamedChoice<EquipDef>;
  /**
   * Called once for every drop that came out of the pool instead of the
   * shipped tables, with the uid it was granted under. An observer only —
   * it cannot influence a roll — so the scene can tag the drop on screen
   * ("dreamed by another stray") and a smoke can quote the row id.
   */
  onDreamed?: (uid: number, origin: DreamedOrigin) => void;
}

/* ------------------------------------------------------------------ */
/* §3 value formulas                                                   */
/* ------------------------------------------------------------------ */

/** Rarity-weight floor band (loot.md §5): floors 1-2 / 3-4 / 5-6. */
export function floorBand(floor: number): "f12" | "f34" | "f56" {
  return floor <= 2 ? "f12" : floor <= 4 ? "f34" : "f56";
}

/**
 * Per-stat base value by item level L (loot.md §3). `atk` differs by slot:
 * weapon `1+L`, everything else `ceil((1+L)/2)` (the reduced trinket-atk
 * base; collars never roll `atk` at all — progression.md §4).
 */
export function baseValue(stat: StatKey, L: number, slot: EquipSlot): number {
  switch (stat) {
    case "atk":
      return slot === "weapon" ? 1 + L : Math.ceil((1 + L) / 2);
    case "hp":
      return 3 + 2 * L;
    case "crt":
      return 3 + L;
    case "def":
    case "spd":
    case "enMax":
      return L <= 3 ? 1 : 2;
  }
}

/** `max(1, round(base · rarityMult))` — round half up (loot.md §3). */
export function primaryValue(
  stat: StatKey,
  L: number,
  rarity: Rarity,
  slot: EquipSlot,
): number {
  return Math.max(
    1,
    roundHalfUp(baseValue(stat, L, slot) * RARITY_TABLE[rarity].mult),
  );
}

/** `max(1, round(0.5 · base · rarityMult))` (loot.md §3). */
export function secondaryValue(
  stat: StatKey,
  L: number,
  rarity: Rarity,
  slot: EquipSlot,
): number {
  return Math.max(
    1,
    roundHalfUp(0.5 * baseValue(stat, L, slot) * RARITY_TABLE[rarity].mult),
  );
}

/**
 * Build a fully-resolved EquipInstance (stats are formulas, no rolls).
 * `sleekSecondary` is required for sleek (the one rolled line); pedigree /
 * mewthical take the whole pool; stray has none. Mewthical carries the def's
 * hook — callers enforce the unique-or-downgrade rule BEFORE calling this.
 */
export function makeEquipInstance(
  uid: number,
  defId: ItemId,
  itemLevel: number,
  rarity: Rarity,
  sleekSecondary?: StatKey,
  /**
   * The def to price against, for a DREAMED drop whose def is registered by
   * `services/pool.ts` rather than shipped. Omitted = the shipped table, which
   * is every authored path. Passing it means a dream can never depend on
   * registration having already happened.
   */
  dreamedDef?: EquipDef,
): EquipInstance {
  const def = dreamedDef ?? EQUIP_DEFS[defId];
  const stats: Partial<Record<StatKey, number>> = {
    [def.primary]: primaryValue(def.primary, itemLevel, rarity, def.slot),
  };
  const lines = RARITY_TABLE[rarity].secondaryLines;
  if (lines === 1) {
    if (sleekSecondary === undefined) {
      throw new Error("makeEquipInstance: sleek needs its rolled secondary");
    }
    stats[sleekSecondary] = secondaryValue(
      sleekSecondary,
      itemLevel,
      rarity,
      def.slot,
    );
  } else if (lines === 2) {
    for (const s of def.secondaryPool) {
      stats[s] = secondaryValue(s, itemLevel, rarity, def.slot);
    }
  }
  const inst: EquipInstance = { uid, defId, itemLevel, rarity, stats };
  if (rarity === "mewthical" && def.uniqueId) inst.hook = def.uniqueId;
  return inst;
}

/* ------------------------------------------------------------------ */
/* §5 equipment roll ladder (steps ④-⑦)                                */
/* ------------------------------------------------------------------ */

/** Def pick pool per slot (step ⑥). */
function poolFor(slot: EquipSlot): typeof TRINKET_DEFS {
  return slot === "collar" ? COLLAR_DEFS : TRINKET_DEFS;
}

/**
 * Options for the equipment ladder (both optional — omitted = loot.md §5
 * behaviour extended with the collar band, EQUIP_SLOT_WEIGHTS).
 */
export interface EquipRollOpts {
  /** Override the ⑤ slot table (the Peddler's gear slot keeps the 2-slot one). */
  slotWeights?: readonly { slot: EquipSlot; weight: number }[];
  /** Force a slot and SKIP the ⑤ roll entirely (the Peddler's collar slot). */
  slot?: EquipSlot;
}

function rollEquipInternal(
  rng: Rng,
  L: number,
  rarityWeights: Record<Rarity, number>,
  livingClasses: ClassId[],
  dropped: Set<MewHookId>,
  uid: number,
  opts: EquipRollOpts = {},
  dreamed?: DreamedChoice<EquipDef>,
  onDreamed?: (uid: number, origin: DreamedOrigin) => void,
): EquipInstance {
  // ④ rarity (one d100 against cumulative weights, §3 table order)
  let rarity = pickWeighted(rng, RARITY_ORDER, (r) => rarityWeights[r]);
  // ⑤ slot: weapon 40 / trinket 40 / collar 20 (skipped when forced)
  let slot: EquipSlot =
    opts.slot ??
    pickWeighted(rng, opts.slotWeights ?? EQUIP_SLOT_WEIGHTS, (s) => s.weight)
      .slot;
  if (slot === "weapon" && livingClasses.length === 0) slot = "trinket"; // degenerate guard
  // ⑥ def pick, POOL-FIRST. The dreamed candidates are narrowed to the slot
  // that was just rolled — and, for a weapon, to a class that is still alive,
  // because the §5 rule that a dead class's weapon never drops again applies
  // to somebody else's weapon exactly as it does to ours. Nothing left after
  // that narrowing means no gate roll at all (dreamed.ts draw contract), so
  // the shipped pick below keeps its stream position.
  const dream = pickDreamed(
    rng,
    filterDreamed(
      dreamed,
      (d) =>
        d.slot === slot &&
        (slot !== "weapon" ||
          (d.classId !== undefined && livingClasses.includes(d.classId))),
    ),
  );
  // Shipped fallback: weapon uniform over LIVING classes; trinket/collar
  // uniform over their pool.
  const def =
    dream?.value ??
    (slot === "weapon"
      ? WEAPON_BY_CLASS.get(
          livingClasses[rng.int(0, livingClasses.length - 1)],
        )!
      : poolFor(slot)[rng.int(0, poolFor(slot).length - 1)]);
  if (dream) onDreamed?.(uid, dream.origin);
  // Mewthical rule: the drop IS the def's unique — or downgrades to Pedigree
  // if the unique already dropped this run / the def has no unique (§5).
  if (rarity === "mewthical") {
    if (def.uniqueId && !dropped.has(def.uniqueId)) {
      dropped.add(def.uniqueId);
    } else {
      rarity = "pedigree";
    }
  }
  // ⑦ Sleek secondary pick (1 roll, uniform over the pool of 2); other
  // rarities take none/both — no roll (skipped, not burned).
  const sleekSecondary =
    rarity === "sleek" ? def.secondaryPool[rng.int(0, 1)] : undefined;
  return makeEquipInstance(uid, def.id, L, rarity, sleekSecondary, def);
}

/**
 * One equipment drop (steps ④-⑦), e.g. for the GEAR bundles or shop stock.
 * Pass `rarityWeights` explicitly (floor band, boss 70/30, shop split, …).
 */
export function rollOneEquip(
  rng: Rng,
  L: number,
  rarityWeights: Record<Rarity, number>,
  ctx: LootCtx,
  opts: EquipRollOpts = {},
): EquipInstance {
  return rollEquipInternal(
    rng,
    L,
    rarityWeights,
    ctx.livingClasses,
    new Set(ctx.uniquesDropped),
    ctx.nextUid,
    opts,
    ctx.dreamed,
    ctx.onDreamed,
  );
}

/* ------------------------------------------------------------------ */
/* grant rolls                                                         */
/* ------------------------------------------------------------------ */

function shiny(income: { base: number; perFloor: number }, n: number): number {
  return income.base + income.perFloor * n;
}

/** One roll on the §7 consumable table (weights sum to 100). Exactly 1 draw. */
export function rollConsumable(rng: Rng): ItemId {
  return pickWeighted(rng, CONSUMABLE_WEIGHTS, (c) => c.weight).id;
}

interface GrantBuilder {
  shinies: number;
  equips: EquipInstance[];
  consumables: { defId: ItemId; count: number }[];
}

function addConsumable(g: GrantBuilder, defId: ItemId, count = 1): void {
  const existing = g.consumables.find((c) => c.defId === defId);
  if (existing) existing.count += count;
  else g.consumables.push({ defId, count });
}

/**
 * Chest open (loot.md §5b): shinies `15+8n`, then 2 independent draws on the
 * chest table. Caller seeds the Rng from the chest's stored `chestSeed`
 * (one fresh mulberry32 per open — ARCHITECTURE §4).
 */
export function rollChest(rng: Rng, ctx: LootCtx): LootGrant {
  const n = ctx.floor;
  const g: GrantBuilder = {
    shinies: shiny(SHINY_INCOME.chest, n),
    equips: [],
    consumables: [],
  };
  const dropped = new Set(ctx.uniquesDropped);
  let uid = ctx.nextUid;
  for (let d = 0; d < 2; d++) {
    // ③ category/draw roll
    const draw = pickWeighted(rng, CHEST_DRAWS, (c) => c.weight).kind;
    if (draw === "consumable") {
      addConsumable(g, rollConsumable(rng));
    } else if (draw === "equipment") {
      g.equips.push(
        rollEquipInternal(
          rng,
          n,
          RARITY_WEIGHTS[floorBand(n)],
          ctx.livingClasses,
          dropped,
          uid++,
          {},
          ctx.dreamed,
          ctx.onDreamed,
        ),
      );
    } else {
      g.shinies += shiny(SHINY_INCOME.shinyPile, n); // no roll
    }
  }
  return g;
}

/**
 * Regular fight victory (loot.md §5a), seeded from the victory stream:
 * ① shinies `8+4n+rngInt(0,4)` → ② drop-chance rolls (consumable 25%,
 * equipment 10%, both always drawn) → content rolls for whichever hit.
 */
export function rollVictory(rng: Rng, ctx: LootCtx): LootGrant {
  const n = ctx.floor;
  const g: GrantBuilder = {
    shinies:
      shiny(SHINY_INCOME.fight, n) + rng.int(0, SHINY_INCOME.fight.variance),
    equips: [],
    consumables: [],
  };
  const consumableHit = rng.float() < FIGHT_DROPS.consumableChance;
  const equipmentHit = rng.float() < FIGHT_DROPS.equipmentChance;
  if (consumableHit) addConsumable(g, rollConsumable(rng));
  if (equipmentHit) {
    g.equips.push(
      rollEquipInternal(
        rng,
        n,
        RARITY_WEIGHTS[floorBand(n)],
        ctx.livingClasses,
        new Set(ctx.uniquesDropped),
        ctx.nextUid,
        {},
        ctx.dreamed,
        ctx.onDreamed,
      ),
    );
  }
  return g;
}

/**
 * Floor boss (loot.md §5c) — guaranteed, in the §5c list order:
 * shinies `60+25n` → 1 equipment (`L = floor+1`, pedigree 70 / mewthical 30)
 * → 2 consumable rolls.
 */
export function rollBossLoot(rng: Rng, ctx: LootCtx): LootGrant {
  const n = ctx.floor;
  const g: GrantBuilder = {
    shinies: shiny(SHINY_INCOME.boss, n),
    equips: [],
    consumables: [],
  };
  g.equips.push(
    rollEquipInternal(
      rng,
      n + 1,
      BOSS_RARITY,
      ctx.livingClasses,
      new Set(ctx.uniquesDropped),
      ctx.nextUid,
      {},
      ctx.dreamed,
      ctx.onDreamed,
    ),
  );
  for (let i = 0; i < BOSS_CONSUMABLE_ROLLS; i++) {
    addConsumable(g, rollConsumable(rng));
  }
  return g;
}

/** Bundle ids rollBundle accepts (MOULT lives in inventory.applyMoult). */
export type GrantBundleId =
  "SNACK_STASH" | "SHINY_HOARD" | "GEAR" | "GEAR_FANCY" | "TITHE";

/**
 * Event loot bundles (loot.md §5d). TITHE returns NEGATIVE shinies, already
 * clamped to `ctx.currentShinies` (`min(current, 20+5n)`). MOULT is not a
 * grant — call inventory.applyMoult instead.
 */
export function rollBundle(
  rng: Rng,
  bundleId: GrantBundleId,
  ctx: LootCtx,
): LootGrant {
  const bundle: LootBundle = BUNDLES[bundleId];
  const n = ctx.floor;
  const g: GrantBuilder = { shinies: 0, equips: [], consumables: [] };
  switch (bundle.kind) {
    case "consumableRolls":
      for (let i = 0; i < bundle.rolls; i++)
        addConsumable(g, rollConsumable(rng));
      break;
    case "shinies":
      g.shinies = bundle.base + bundle.perFloor * n; // no roll
      break;
    case "gear": {
      const L = bundle.level === "floorPlus1" ? n + 1 : n;
      const weights =
        bundle.rarity === "band" ? RARITY_WEIGHTS[floorBand(n)] : bundle.rarity;
      g.equips.push(
        rollEquipInternal(
          rng,
          L,
          weights,
          ctx.livingClasses,
          new Set(ctx.uniquesDropped),
          ctx.nextUid,
          {},
          ctx.dreamed,
          ctx.onDreamed,
        ),
      );
      break;
    }
    case "tithe": {
      const loss = bundle.base + bundle.perFloor * n;
      g.shinies = -Math.min(ctx.currentShinies ?? loss, loss); // no roll
      break;
    }
    case "moult":
      throw new Error("rollBundle: MOULT is applied via inventory.applyMoult");
  }
  return g;
}
