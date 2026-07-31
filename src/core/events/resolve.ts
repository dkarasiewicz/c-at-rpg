/**
 * c(at)rpg — event resolution (events.md §2.3, ARCHITECTURE.md WP-06).
 *
 * `resolveOption` is a pure function: RunState in → new RunState out
 * (structural sharing; the input is never mutated). RNG draw order is the
 * events.md §2.2 contract:
 *
 *   1. selection roll        (select.ts — already spent before we get here)
 *   2. player picks option   (no draw)
 *   3. outcome roll          (1 float, SKIPPED when the option has 1 outcome)
 *   4. per-effect `random` target draws, in effect array order
 *      (1 int(0, living-1) each — two `random` effects may hit different cats)
 *
 * A `fight` effect never resolves here: it is handed up as `fightRequest`
 * (the battle uses the combat layer's own stream). `onWinEffects` are applied
 * later on the victory screen via `applyEventEffects`, continuing the same
 * eventRng sequence.
 */
import type {
  BuffStat,
  Effect,
  EnemyId,
  EventOption,
  GameEvent,
  Inventory,
  InventorySlot,
  ItemId,
  Outcome,
  Requirement,
  ResultLine,
  Rng,
  RunState,
  Scalar,
  TargetSel,
  TempMod,
} from "../types.js";
import { clamp, pickWeightedFloat } from "../util.js";
import { CLASSES } from "../../content/classes.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { EQUIP_DEFS } from "../../content/equipment.js";

/* ------------------------------------------------------------------------ */
/* Public shapes                                                             */
/* ------------------------------------------------------------------------ */

/** A `fight` effect handed up unresolved (events.md §2.4). */
export interface FightRequest {
  eventId: string;
  /** front-to-back enemy ids */
  encounter: EnemyId[];
  loot: "none" | "normal" | "bonus";
  /** applied on the victory screen via applyEventEffects */
  onWinEffects: Effect[];
  /** gate context carried through so onWinEffects can target `gateCat` */
  gateCatIndex: number | null;
}

export interface ResolveOutput {
  state: RunState;
  outcomeIndex: number;
  outcome: Outcome;
  results: ResultLine[];
  fightRequest: FightRequest | null;
}

/* ------------------------------------------------------------------------ */
/* Scalars & effective stats                                                 */
/* ------------------------------------------------------------------------ */

/** Floor-scaled number: value(floor) = base + perFloor · floorNum. */
export function resolveScalar(s: Scalar, floorNum: number): number {
  return typeof s === "number" ? s : s.base + s.perFloor * floorNum;
}

/**
 * Effective gate stat (events.md §1): base + growth rows up to the current
 * level + equipment + temp mods. spd floors at 1; def/crt at 0 (atk too —
 * a negative attack stat is meaningless).
 */
export function effectiveGateStat(
  run: RunState,
  catIndex: number,
  stat: "atk" | "def" | "spd" | "crt",
): number {
  const cat = run.cats[catIndex];
  const cls = CLASSES[cat.classId];
  let v = cls.base[stat];
  for (let i = 0; i < run.level - 1 && i < cls.growth.length; i++) {
    v += cls.growth[i][stat] ?? 0;
  }
  for (const eq of [cat.weapon, cat.trinket]) {
    if (eq) v += eq.stats[stat] ?? 0;
  }
  for (const m of cat.tempMods) {
    if (m.stat === stat) v += m.amount;
  }
  return stat === "spd" ? Math.max(1, v) : Math.max(0, v);
}

/** Effective max HP: base hp + growth + equipment hp + `hpMax` temp mods (min 1). */
export function effectiveMaxHp(run: RunState, catIndex: number): number {
  const cat = run.cats[catIndex];
  const cls = CLASSES[cat.classId];
  let v = cls.base.hp;
  for (let i = 0; i < run.level - 1 && i < cls.growth.length; i++) {
    v += cls.growth[i].hp ?? 0;
  }
  for (const eq of [cat.weapon, cat.trinket]) {
    if (eq) v += eq.stats.hp ?? 0;
  }
  for (const m of cat.tempMods) {
    if (m.stat === "hpMax") v += m.amount;
  }
  return Math.max(1, v);
}

/* ------------------------------------------------------------------------ */
/* Requirements & availability                                               */
/* ------------------------------------------------------------------------ */

/** Cat indices of living cats (lives > 0), front→back marching order. */
function livingCatIndices(run: RunState): number[] {
  const out: number[] = [];
  for (const classId of run.marchingOrder) {
    const i = run.cats.findIndex((c) => c.classId === classId);
    if (i >= 0 && run.cats[i].lives > 0 && !out.includes(i)) out.push(i);
  }
  return out;
}

function countItem(slots: readonly InventorySlot[], defId: ItemId): number {
  let n = 0;
  for (const slot of slots) {
    if (!slot) continue;
    if ("count" in slot) {
      if (slot.defId === defId) n += slot.count;
    } else if (slot.defId === defId) n += 1;
  }
  return n;
}

/** Is the option's requirement met? (events.md §1 Requirement semantics.) */
export function requirementMet(run: RunState, req: Requirement): boolean {
  const living = livingCatIndices(run);
  switch (req.kind) {
    case "class":
      return living.some((i) => run.cats[i].classId === req.class);
    case "stat":
      return living.some((i) => effectiveGateStat(run, i, req.stat) >= req.min);
    case "item":
      return countItem(run.inventory.slots, req.item) >= (req.count ?? 1);
    case "shinies":
      return run.inventory.shinies >= resolveScalar(req.cost, run.floorNum);
  }
}

/**
 * Runtime availability for the UI (grayed-but-visible) and the resolver
 * guard: the requirement must be met, and — invariant 7 — options containing
 * a `restoreLife` effect are disabled when no living cat is below 9 Lives.
 */
export function isOptionAvailable(run: RunState, option: EventOption): boolean {
  if (option.requires && !requirementMet(run, option.requires)) return false;
  const hasRestore = option.outcomes.some((o) =>
    o.effects.some((e) => e.kind === "restoreLife"),
  );
  if (hasRestore) {
    const living = livingCatIndices(run);
    if (!living.some((i) => run.cats[i].lives < 9)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------------ */
/* Internal draft helpers                                                    */
/* ------------------------------------------------------------------------ */

/** Cloned-on-entry working copy so the input RunState is never mutated. */
function draftRun(run: RunState): RunState {
  return {
    ...run,
    cats: run.cats.map((c) => ({ ...c, tempMods: [...c.tempMods] })),
    inventory: {
      ...run.inventory,
      slots: run.inventory.slots.map((s) => (s && "count" in s ? { ...s } : s)),
    },
    score: { ...run.score },
    firedEventIds: [...run.firedEventIds],
    floorFiredEventIds: [...run.floorFiredEventIds],
  };
}

function itemName(id: ItemId): string {
  return CONSUMABLES[id]?.name ?? EQUIP_DEFS[id]?.name ?? id;
}

function catName(run: RunState, catIndex: number): string {
  return CLASSES[run.cats[catIndex].classId].catName;
}

const STAT_LABEL: Record<BuffStat, string> = {
  atk: "ATK",
  def: "DEF",
  spd: "SPD",
  crt: "CRT",
  hpMax: "Max HP",
};

function durLabel(duration: "floor" | "run"): string {
  return duration === "floor" ? "this floor" : "this run";
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/** Add `count` of a consumable to the inventory (stacks of 5, 16 slots). */
function addItem(inv: Inventory, defId: ItemId, count: number): number {
  let left = count;
  for (const slot of inv.slots) {
    if (left <= 0) break;
    if (slot && "count" in slot && slot.defId === defId && slot.count < 5) {
      const take = Math.min(5 - slot.count, left);
      slot.count += take;
      left -= take;
    }
  }
  for (let i = 0; i < inv.slots.length && left > 0; i++) {
    if (inv.slots[i] === null) {
      const take = Math.min(5, left);
      inv.slots[i] = { defId, count: take };
      left -= take;
    }
  }
  return count - left; // actually added (rest lost to a full inventory)
}

/** Remove up to `count` of an item; no-op past what is present. */
function removeItem(inv: Inventory, defId: ItemId, count: number): number {
  let left = count;
  for (let i = 0; i < inv.slots.length && left > 0; i++) {
    const slot = inv.slots[i];
    if (!slot || slot.defId !== defId) continue;
    if ("count" in slot) {
      const take = Math.min(slot.count, left);
      slot.count -= take;
      left -= take;
      if (slot.count === 0) inv.slots[i] = null;
    } else {
      inv.slots[i] = null;
      left -= 1;
    }
  }
  return count - left; // actually removed
}

/** Resolve a TargetSel to cat indices; `random` costs exactly 1 int draw. */
function resolveTargets(
  run: RunState,
  sel: TargetSel,
  gateCatIndex: number | null,
  rng: Rng,
): number[] {
  const living = livingCatIndices(run);
  switch (sel) {
    case "party":
      return living;
    case "random": {
      if (living.length === 0) return [];
      const i = rng.int(0, living.length - 1); // always 1 draw per effect
      return [living[i]];
    }
    case "lowestHp": {
      let best = -1;
      for (const i of living) {
        if (best === -1 || run.cats[i].hp < run.cats[best].hp) best = i;
      }
      return best === -1 ? [] : [best];
    }
    case "lowestLives": {
      let best = -1;
      for (const i of living) {
        if (run.cats[i].lives >= 9) continue;
        if (best === -1 || run.cats[i].lives < run.cats[best].lives) best = i;
      }
      return best === -1 ? [] : [best];
    }
    case "gateCat":
      return gateCatIndex === null ? [] : [gateCatIndex];
  }
}

/* ------------------------------------------------------------------------ */
/* Effect application                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Apply a list of event effects, in array order, to a DRAFT run (mutates the
 * draft — callers pass a `draftRun` clone). Emits one result line per actual
 * delta; a `fight` effect is captured as a FightRequest instead of resolving.
 */
function applyEffectsToDraft(
  draft: RunState,
  effects: readonly Effect[],
  eventId: string,
  gateCatIndex: number | null,
  rng: Rng,
  results: ResultLine[],
): FightRequest | null {
  let fightRequest: FightRequest | null = null;
  const floorNum = draft.floorNum;

  for (const eff of effects) {
    switch (eff.kind) {
      case "heal": {
        const amount = resolveScalar(eff.amount, floorNum);
        for (const ci of resolveTargets(draft, eff.target, gateCatIndex, rng)) {
          const cat = draft.cats[ci];
          const max = effectiveMaxHp(draft, ci);
          const actual = Math.max(0, Math.min(amount, max - cat.hp));
          cat.hp += actual;
          results.push({
            text: `${catName(draft, ci)} +${actual} HP`,
            tone: "gain",
          });
        }
        break;
      }
      case "damage": {
        const amount = resolveScalar(eff.amount, floorNum);
        for (const ci of resolveTargets(draft, eff.target, gateCatIndex, rng)) {
          const cat = draft.cats[ci];
          // ignores def; HP clamps at 1 — event damage never KOs (pillar 2)
          const actual = Math.max(0, Math.min(amount, cat.hp - 1));
          cat.hp -= actual;
          results.push({
            text: `${catName(draft, ci)} -${actual} HP`,
            tone: "loss",
          });
        }
        break;
      }
      case "buff": {
        const targets = resolveTargets(draft, eff.target, gateCatIndex, rng);
        for (const ci of targets) {
          const cat = draft.cats[ci];
          const mod: TempMod = {
            stat: eff.stat,
            amount: eff.amount,
            duration: eff.duration,
            sourceEventId: eventId,
          };
          cat.tempMods.push(mod);
          if (eff.stat === "hpMax") {
            // hpMax buffs raise current HP by the same amount when applied;
            // shrinks clamp current HP to the new max (min 1). events.md §1.
            if (eff.amount > 0) cat.hp += eff.amount;
            cat.hp = clamp(cat.hp, 1, effectiveMaxHp(draft, ci));
          }
        }
        const tone: ResultLine["tone"] = eff.amount >= 0 ? "buff" : "loss";
        const delta = `${STAT_LABEL[eff.stat]} ${signed(eff.amount)} (${durLabel(eff.duration)})`;
        if (eff.target === "party") {
          results.push({ text: `Party: ${delta}`, tone });
        } else {
          for (const ci of targets) {
            results.push({ text: `${catName(draft, ci)}: ${delta}`, tone });
          }
        }
        break;
      }
      case "shinies": {
        const amount = resolveScalar(eff.amount, floorNum);
        const next = clamp(draft.inventory.shinies + amount, 0, 999);
        const actual = next - draft.inventory.shinies;
        draft.inventory.shinies = next;
        if (actual > 0) draft.score.shiniesCollected += actual;
        results.push({
          text: `${signed(actual)} ✦`,
          tone: actual > 0 ? "gain" : actual < 0 ? "loss" : "neutral",
        });
        break;
      }
      case "giveItem": {
        const wanted = eff.count ?? 1;
        const added = addItem(draft.inventory, eff.item, wanted);
        if (added > 0) {
          results.push({
            text: `Received: ${itemName(eff.item)} ×${added}`,
            tone: "gain",
          });
        } else {
          results.push({
            text: `${itemName(eff.item)} lost — inventory full`,
            tone: "neutral",
          });
        }
        break;
      }
      case "takeItem": {
        const removed = removeItem(draft.inventory, eff.item, eff.count ?? 1);
        if (removed > 0) {
          results.push({
            text: `Lost: ${itemName(eff.item)} ×${removed}`,
            tone: "loss",
          });
        }
        break;
      }
      case "restoreLife": {
        for (const ci of resolveTargets(draft, eff.target, gateCatIndex, rng)) {
          const cat = draft.cats[ci];
          const actual = Math.min(eff.amount, 9 - cat.lives); // cap 9 per cat
          cat.lives += actual;
          results.push({
            text: `${catName(draft, ci)} regains ${actual} ${actual === 1 ? "Life" : "Lives"}`,
            tone: "gain",
          });
        }
        break;
      }
      case "energyNextBattle": {
        const targets = resolveTargets(draft, eff.target, gateCatIndex, rng);
        for (const ci of targets) {
          const cat = draft.cats[ci];
          // Next battle starts at 4 energy, cap 10 total → bonus caps at 6.
          cat.energyNextBattle = Math.min(cat.energyNextBattle + eff.amount, 6);
        }
        const line = `${signed(eff.amount)} Energy next battle`;
        if (eff.target === "party") {
          results.push({ text: `Party: ${line}`, tone: "buff" });
        } else {
          for (const ci of targets) {
            results.push({
              text: `${catName(draft, ci)}: ${line}`,
              tone: "buff",
            });
          }
        }
        break;
      }
      case "fight": {
        // Handed upward unresolved; the battle scene uses the combat layer's
        // own stream. `fight` is the last effect of its outcome (invariant 3).
        fightRequest = {
          eventId,
          encounter: [...eff.encounter],
          loot: eff.loot,
          onWinEffects: eff.onWinEffects ? [...eff.onWinEffects] : [],
          gateCatIndex,
        };
        break;
      }
      case "nothing":
        break; // flavor only — the outcome text carries it
    }
  }
  return fightRequest;
}

/**
 * Apply a standalone effect list (the victory screen's `onWinEffects` path).
 * Continues the SAME eventRng sequence: pass the same Rng instance that
 * resolved the option. Pure: returns a new RunState.
 */
export function applyEventEffects(
  run: RunState,
  effects: readonly Effect[],
  eventId: string,
  rng: Rng,
  gateCatIndex: number | null = null,
): {
  state: RunState;
  results: ResultLine[];
  fightRequest: FightRequest | null;
} {
  const draft = draftRun(run);
  const results: ResultLine[] = [];
  const fightRequest = applyEffectsToDraft(
    draft,
    effects,
    eventId,
    gateCatIndex,
    rng,
    results,
  );
  return { state: draft, results, fightRequest };
}

/* ------------------------------------------------------------------------ */
/* resolveOption                                                             */
/* ------------------------------------------------------------------------ */

/** The cat that satisfied a class/stat gate (events.md §1 `gateCat`). */
function resolveGateCat(
  run: RunState,
  req: Requirement | undefined,
): number | null {
  if (!req) return null;
  const living = livingCatIndices(run);
  if (req.kind === "class") {
    for (const i of living) if (run.cats[i].classId === req.class) return i;
    return null;
  }
  if (req.kind === "stat") {
    let best = -1;
    let bestV = -Infinity;
    for (const i of living) {
      const v = effectiveGateStat(run, i, req.stat);
      if (v > bestV) {
        best = i;
        bestV = v; // ties: lowest rank (first in marching order) wins
      }
    }
    return best === -1 ? null : best;
  }
  return null; // item/shinies gates have no gate cat (validator invariant 4)
}

/**
 * events.md §2.3, in order:
 *   1. pay the requirement (items consumed / shinies deducted; gates free)
 *   2. roll the outcome (skipped for single-outcome options)
 *   3. apply effects in order, emitting result lines; `fight` is handed up
 *   4. mark the event fired (run + floor lists) — ALWAYS, even on a pure
 *      `nothing` outcome and even if the upcoming fight is fled: curiosity
 *      spends the tile.
 */
export function resolveOption(
  run: RunState,
  event: GameEvent,
  optionIndex: number,
  rng: Rng,
): ResolveOutput {
  const option = event.options[optionIndex];
  if (!option) {
    throw new Error(`resolveOption: ${event.id} has no option ${optionIndex}`);
  }
  if (!isOptionAvailable(run, option)) {
    throw new Error(
      `resolveOption: option ${optionIndex} of ${event.id} is not available`,
    );
  }

  const draft = draftRun(run);
  const results: ResultLine[] = [];

  // 1. Pay the requirement (no rng draws).
  const req = option.requires;
  if (req?.kind === "item") {
    const n = req.count ?? 1;
    removeItem(draft.inventory, req.item, n);
    results.push({ text: `Used: ${itemName(req.item)} ×${n}`, tone: "loss" });
  } else if (req?.kind === "shinies") {
    const cost = resolveScalar(req.cost, draft.floorNum);
    draft.inventory.shinies -= cost;
    results.push({ text: `-${cost} ✦`, tone: "loss" });
  }

  // 2. Outcome roll — one float() draw, skipped when there is one outcome.
  let outcomeIndex = 0;
  if (option.outcomes.length > 1) {
    const indexed = option.outcomes.map((o, i) => ({ o, i }));
    outcomeIndex = pickWeightedFloat(rng, indexed, (x) => x.o.weight).i;
  }
  const outcome = option.outcomes[outcomeIndex];

  // 3. Apply effects in order (gate cat resolved from PRE-effect state).
  const gateCatIndex = resolveGateCat(run, req);
  const fightRequest = applyEffectsToDraft(
    draft,
    outcome.effects,
    event.id,
    gateCatIndex,
    rng,
    results,
  );

  // 4. Fired-id bookkeeping — unconditional (events.md §2.3 step 4).
  if (!draft.firedEventIds.includes(event.id)) {
    draft.firedEventIds.push(event.id);
  }
  if (!draft.floorFiredEventIds.includes(event.id)) {
    draft.floorFiredEventIds.push(event.id);
  }

  return { state: draft, outcomeIndex, outcome, results, fightRequest };
}
