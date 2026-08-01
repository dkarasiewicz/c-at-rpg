/**
 * CONDITIONS — the engine behind hunger, scars and quirks
 * (docs/design/roster-and-persistence.md §3).
 *
 * A condition is a persisted fact about ONE cat that outlives the run it was
 * earned in. This module is the whole of it:
 *
 *   READ    `conditionMods` turns a cat's conditions into `TempMod`s — the
 *           EXISTING events.md §1 vocabulary, folded by `effectiveStats`
 *           through the existing clamps. Nothing here is a new mechanic.
 *   EARN    `afterRun` is what a descent costs: hunger rises, a cat that
 *           burned a Life comes back scarred, and at most one quirk is earned
 *           from what actually happened.
 *   SPEND   `feedCost` / `fed` — the town's side of hunger, priced in shinies
 *           so a bowl of food competes with the unlock catalog.
 *
 * PURE. No rng (every pick is derived from a hash of things the run already
 * carries), no clock, no I/O — the same cat, run and seed always produce the
 * same scar.
 *
 * ── WHY `CatCondition` IS DECLARED HERE AS WELL ────────────────────────────
 * `core/meta/types.ts` declares an identical `CatCondition` for `MetaCat`, and
 * that one is the contract the roster screen prints. This module cannot import
 * it: ARCHITECTURE.md §0 forbids `core/run` from importing `core/meta` (the
 * dependency runs the other way). The two shapes are structurally identical
 * and therefore assignable in both directions — `tests/conditions.spec.ts`
 * asserts exactly that, so the day one of them grows a field the build fails
 * instead of drifting.
 */
import type { CatRunState, TempMod } from "../types.js";
import {
  CONDITION_DEFS,
  FEED_COST_PER_POINT,
  HUNGER_ID,
  HUNGER_MAX,
  HUNGER_ON_DEFEAT,
  HUNGER_PER_RUN,
  HUNGER_STAGES,
  MAX_CONDITIONS,
  QUIRKS,
  SCARS,
  type ConditionDef,
  type ConditionMod,
  type HungerStage,
  type QuirkTrigger,
} from "../../content/conditions.js";
import { hash } from "../rng.js";

/**
 * One condition a cat carries. The structural twin of
 * `core/meta/types.ts`'s `CatCondition` — see the header for why there are two.
 */
export interface CatCondition {
  /** `'hunger'`, `'scar:tailTip'`, `'quirk:bond'` — namespaced like unlocks. */
  id: string;
  /** What the roster screen prints. Short — it sits under a name. */
  label: string;
  /** Magnitude, where the condition has one (hunger level). */
  value?: number;
  /** Whatever else the owning system needs; carried verbatim by the save. */
  data?: Readonly<Record<string, number | string | boolean>>;
}

/*
 * A cat ON A DESCENT carries the conditions it left town with, because the
 * camp fire acts on them (eat, tend a scar, sit up talking) and the results
 * screen carries them home again.
 *
 * Additive and OPTIONAL, in the same `declare module` style `runState.ts` uses
 * for `customParty` and the run map uses for `resolvedNodes`: a run built by a
 * fixture, the party creator or a `?smoke=` hook has no conditions at all and
 * serialises byte-for-byte as it did before this file existed.
 */
declare module "../types" {
  interface CatRunState {
    /** §3 conditions, carried down and back. Absent ⇒ a cat with none. */
    conditions?: CatCondition[];
  }
}

/** `sourceEventId` every condition-derived tempMod carries. */
export const CONDITION_SOURCE = "condition";

/** `sourceEventId` of the floor-long relief a camp fire buys (`tend`). */
export const TEND_SOURCE = "tend";

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

const list = (cs?: readonly CatCondition[]): readonly CatCondition[] =>
  cs ?? [];

/** The authored def behind a condition id (hunger has none — it is a stage). */
export function conditionDef(id: string): ConditionDef | undefined {
  return CONDITION_DEFS.find((d) => d.id === id);
}

/** How hungry this cat is, 0..HUNGER_MAX. A cat with no entry is fed. */
export function hungerOf(cs?: readonly CatCondition[]): number {
  const c = list(cs).find((x) => x.id === HUNGER_ID);
  return clampHunger(c?.value ?? 0);
}

const clampHunger = (v: number): number =>
  Math.max(0, Math.min(HUNGER_MAX, Math.floor(Number.isFinite(v) ? v : 0)));

/** The stage a hunger value sits in (the highest `at` it has reached). */
export function hungerStage(value: number): HungerStage {
  const v = clampHunger(value);
  let out = HUNGER_STAGES[0];
  for (const s of HUNGER_STAGES) if (v >= s.at) out = s;
  return out;
}

/** The label hunger carries on a card: `"hungry"`, `"starving"`. */
export function hungerLabel(value: number): string {
  return hungerStage(value).label;
}

/** Set (or clear) hunger on a condition list. Pure. */
export function withHunger(
  cs: readonly CatCondition[] | undefined,
  value: number,
): CatCondition[] {
  const v = clampHunger(value);
  const rest = list(cs).filter((c) => c.id !== HUNGER_ID);
  if (v <= 0) return rest.map(copy);
  return [
    { id: HUNGER_ID, label: hungerLabel(v), value: v },
    ...rest.map(copy),
  ];
}

const copy = (c: CatCondition): CatCondition => ({
  id: c.id,
  label: c.label,
  ...(c.value !== undefined ? { value: c.value } : {}),
  ...(c.data ? { data: { ...c.data } } : {}),
});

/** Does this cat already carry `id`? */
export function hasCondition(
  cs: readonly CatCondition[] | undefined,
  id: string,
): boolean {
  return list(cs).some((c) => c.id === id);
}

/** Every scar this cat wears, oldest first. */
export function scarsOf(cs?: readonly CatCondition[]): CatCondition[] {
  return list(cs)
    .filter((c) => c.id.startsWith("scar:"))
    .map(copy);
}

/** Every quirk this cat wears, oldest first. */
export function quirksOf(cs?: readonly CatCondition[]): CatCondition[] {
  return list(cs)
    .filter((c) => c.id.startsWith("quirk:"))
    .map(copy);
}

/**
 * THE ONE LINE a card prints: `"hungry · Notched Ear · Bonded"`, or
 * `"rested"` when the cat is carrying nothing at all.
 */
export function conditionLine(cs?: readonly CatCondition[]): string {
  const cats = list(cs);
  if (cats.length === 0) return "rested";
  return cats.map((c) => c.label).join(" · ");
}

/** The story line behind one condition, for a tooltip or the camp panel. */
export function conditionBlurb(c: CatCondition): string {
  if (c.id === HUNGER_ID) return hungerStage(c.value ?? 0).blurb;
  return conditionDef(c.id)?.blurb ?? c.label;
}

/* ------------------------------------------------------------------ */
/* the stat cost — the existing vocabulary, nothing more               */
/* ------------------------------------------------------------------ */

/** The raw stat deltas one condition contributes. */
export function modsOf(c: CatCondition): readonly ConditionMod[] {
  if (c.id === HUNGER_ID) return hungerStage(c.value ?? 0).mods;
  return conditionDef(c.id)?.mods ?? [];
}

/**
 * Every condition a cat carries, as run-scoped `TempMod`s — the shape a
 * cursed shrine or a warm bowl of milk already produces (events.md §1).
 *
 * `duration: 'run'` because a condition is a fact about the CAT, not about the
 * floor: descending must not shake off a scar (`expireFloorMods` keeps run
 * mods). The tempMods are rebuilt from the conditions on every descent, so
 * feeding a cat in town is felt on the very next run and never on this one.
 */
export function conditionMods(cs?: readonly CatCondition[]): TempMod[] {
  const out: TempMod[] = [];
  for (const c of list(cs)) {
    for (const m of modsOf(c)) {
      if (m.amount === 0) continue;
      out.push({
        stat: m.stat,
        amount: m.amount,
        duration: "run",
        sourceEventId: `${CONDITION_SOURCE}:${c.id}`,
      });
    }
  }
  return out;
}

/**
 * The floor-long relief a camp fire buys for ONE scar: the scar's own mods,
 * inverted, expiring on the stairs down. The scar is still there — permanent
 * means permanent — it just stops pulling for a while.
 */
export function tendMods(c: CatCondition): TempMod[] {
  return modsOf(c)
    .filter((m) => m.amount !== 0)
    .map((m) => ({
      stat: m.stat,
      amount: -m.amount,
      duration: "floor" as const,
      sourceEventId: `${TEND_SOURCE}:${c.id}`,
    }));
}

/** Is this scar already tended on this floor? */
export function isTended(cat: CatRunState, id: string): boolean {
  return cat.tempMods.some((m) => m.sourceEventId === `${TEND_SOURCE}:${id}`);
}

/* ------------------------------------------------------------------ */
/* town: feeding (§3 — it competes with unlocks for the same wallet)   */
/* ------------------------------------------------------------------ */

/** What it costs to feed this cat all the way back to `fed`. 0 when fed. */
export function feedCost(cs?: readonly CatCondition[]): number {
  return hungerOf(cs) * FEED_COST_PER_POINT;
}

/**
 * Feed a cat with `shinies` to spend: as many points as the wallet covers,
 * cheapest-first. Returns the new conditions and what it actually cost, so a
 * half-affordable meal is still a meal.
 */
export function fed(
  cs: readonly CatCondition[] | undefined,
  shinies: number,
): { conditions: CatCondition[]; spent: number; points: number } {
  const have = hungerOf(cs);
  const afford = Math.max(0, Math.floor(shinies / FEED_COST_PER_POINT));
  const points = Math.min(have, afford);
  return {
    conditions: withHunger(cs, have - points),
    spent: points * FEED_COST_PER_POINT,
    points,
  };
}

/* ------------------------------------------------------------------ */
/* earning: what a descent does to a cat                               */
/* ------------------------------------------------------------------ */

/** What the run did, as far as one cat's conditions are concerned. */
export interface RunConditionCtx {
  /** The run seed — half of the deterministic pick. */
  seed: string;
  /** The cat's instance id — the other half. */
  catId: string;
  /** Lives this cat burned on this descent. >0 ⇒ it comes back marked. */
  livesLost: number;
  /** Did the run end in a win? */
  victory: boolean;
  /** Deepest floor the run reached. */
  floorsReached: number;
  /** Bosses the run put down. */
  bossesDefeated: number;
  /** Descents this cat had already survived (keeps repeat picks apart). */
  runs: number;
}

/** Floor 5 or deeper earns `deep`. */
export const DEEP_FLOOR = 5;

/** A run that fell apart on floor 1-2 earns `routed`. */
export const ROUT_FLOOR = 2;

/**
 * WHAT A DESCENT COSTS — the one call the town makes when a cat comes home
 * (`bankCat`, core/meta/roster.ts).
 *
 *   1. hunger rises: one point per descent, two if the run fell apart.
 *   2. a cat that burned a Life takes ONE scar, permanently. Which scar is
 *      derived from `hash(seed, catId, runs)` over the scars it does not
 *      already wear, so it is reproducible and never repeats until the table
 *      is exhausted.
 *   3. at most ONE quirk, from the first trigger that fires in `QUIRKS` order.
 *      Quirks are a career, not an afternoon.
 *
 * Total and idempotent-ish: nothing is granted twice, and the list is clamped
 * to `MAX_CONDITIONS` (dropping the OLDEST non-hunger entry) so a twenty-run
 * veteran still has a readable card and a bounded stat drift.
 */
export function afterRun(
  cs: readonly CatCondition[] | undefined,
  ctx: RunConditionCtx,
): CatCondition[] {
  const hunger =
    hungerOf(cs) + HUNGER_PER_RUN + (ctx.victory ? 0 : HUNGER_ON_DEFEAT);
  let out = withHunger(cs, hunger);

  if (ctx.livesLost > 0) {
    const scar = pickScar(out, ctx);
    if (scar) out = [...out, scar];
  }

  const quirk = pickQuirk(out, ctx);
  if (quirk) out = [...out, quirk];

  return trim(out);
}

/** The scar this near-death leaves, or undefined when the table is spent. */
function pickScar(
  cs: readonly CatCondition[],
  ctx: RunConditionCtx,
): CatCondition | undefined {
  const open = SCARS.filter((s) => !hasCondition(cs, s.id));
  if (open.length === 0) return undefined;
  const i = hash(ctx.seed, ctx.catId, ctx.runs, "scar") % open.length;
  const def = open[i];
  return { id: def.id, label: def.label };
}

/** Which triggers this run fired, in the order `QUIRKS` declares them. */
export function firedTriggers(ctx: RunConditionCtx): QuirkTrigger[] {
  const out: QuirkTrigger[] = [];
  if (ctx.bossesDefeated > 0) out.push("boss");
  if (ctx.victory) out.push("victory");
  if (ctx.floorsReached >= DEEP_FLOOR) out.push("deep");
  if (ctx.livesLost > 0) out.push("mauled");
  if (!ctx.victory && ctx.floorsReached <= ROUT_FLOOR) out.push("routed");
  return out;
}

function pickQuirk(
  cs: readonly CatCondition[],
  ctx: RunConditionCtx,
): CatCondition | undefined {
  const fired = new Set(firedTriggers(ctx));
  for (const q of QUIRKS) {
    // `camp` quirks are granted AT the fire, never here.
    if (q.trigger === "camp") continue;
    if (!fired.has(q.trigger)) continue;
    if (hasCondition(cs, q.id)) continue;
    return { id: q.id, label: q.label };
  }
  return undefined;
}

/**
 * Clamp a condition list to `MAX_CONDITIONS`. Hunger always survives (it is
 * the one the player can actually act on); otherwise the oldest goes, so what
 * a cat carries is what it did most recently.
 */
export function trim(cs: readonly CatCondition[]): CatCondition[] {
  const kept = cs.map(copy);
  if (kept.length <= MAX_CONDITIONS) return kept;
  const hunger = kept.filter((c) => c.id === HUNGER_ID);
  const rest = kept.filter((c) => c.id !== HUNGER_ID);
  const room = Math.max(0, MAX_CONDITIONS - hunger.length);
  return [...hunger, ...rest.slice(rest.length - room)];
}

/**
 * Grant one condition to a cat ON A DESCENT (the camp fire's job). Returns the
 * SAME cat when it already carries it, so callers can fire and forget.
 */
export function grantCondition(cat: CatRunState, c: CatCondition): CatRunState {
  if (hasCondition(cat.conditions, c.id)) return cat;
  const conditions = trim([...list(cat.conditions), copy(c)]);
  return {
    ...cat,
    conditions,
    // the gift is felt IMMEDIATELY: the mods are rebuilt from the new list
    tempMods: [
      ...cat.tempMods.filter(
        (m) => !m.sourceEventId.startsWith(`${CONDITION_SOURCE}:`),
      ),
      ...conditionMods(conditions),
    ],
  };
}

/** Set a cat's conditions mid-run and re-derive its condition tempMods. */
export function withConditions(
  cat: CatRunState,
  conditions: readonly CatCondition[],
): CatRunState {
  const next = trim(conditions);
  return {
    ...cat,
    conditions: next,
    tempMods: [
      ...cat.tempMods.filter(
        (m) => !m.sourceEventId.startsWith(`${CONDITION_SOURCE}:`),
      ),
      ...conditionMods(next),
    ],
  };
}
