/**
 * Durable run memory — the reason the DM is an agent and not six endpoints.
 *
 * `defineState` is per-session and survives workflow step boundaries, cold
 * starts, redeploys and a player leaving the tab for an hour, which is exactly
 * the lifetime of a run (docs/design/run-map-and-dm.md §4). One eve session ==
 * one run.
 *
 * Two things live here:
 *
 *  - the FACT LEDGER: what the DM promised, learned, or owes. This is what
 *    makes floor-5 callbacks to a floor-2 bribe possible.
 *  - the EMISSION LEDGER: every effect / item / shiny the DM authorised this
 *    run. Tools append to it and return the same record, so the client can read
 *    authorisations either off the tool-call stream (`action.result`) or in one
 *    lump via `session.send({ message, outputSchema })`. It is also the audit
 *    trail the run log needs for the deterministic-replay contract
 *    (docs/design/run-map-and-dm.md §3 "Determinism & replay").
 *
 * State is NEVER shared with subagents (eve `guides/state`), so the encounter
 * adjudicator gets what it needs packed into its `message` instead.
 */
import { defineState } from "eve/context";
import type { EffectSpec } from "../../src/core/combat/powerTypes.js";

/** Run-map node kinds (docs/design/run-map-and-dm.md §2). */
export const NODE_TYPES = [
  "fight",
  "elite",
  "event",
  "shop",
  "rest",
  "treasure",
  "boss",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

/** Something the DM must be able to call back to later. */
export interface RunFact {
  /** monotonic, so the client can diff what it has already seen */
  seq: number;
  text: string;
  floor: number;
  tags: string[];
}

/** One authorised mechanical consequence, already lint-approved. */
export interface EffectEmission {
  seq: number;
  floor: number;
  reason: string;
  effects: EffectSpec[];
  /** `powerBudget()` of the effects at authorisation time. */
  budget: number;
}

export interface ItemEmission {
  seq: number;
  floor: number;
  item: string;
  count: number;
  reason: string;
}

export interface ShiniesEmission {
  seq: number;
  floor: number;
  amount: number;
  reason: string;
}

/** A nudge for the next map node. Advisory — the run map may ignore it. */
export interface EncounterBias {
  seq: number;
  floor: number;
  nodeType: NodeType;
  theme: string;
  note: string;
}

export interface RunMemory {
  seq: number;
  facts: RunFact[];
  effects: EffectEmission[];
  items: ItemEmission[];
  shinies: ShiniesEmission[];
  /** The most recent bias; a new one replaces it. */
  bias: EncounterBias | null;
}

/**
 * Ledger ceilings. A run is finite (six floors); these exist so a pathological
 * session cannot grow the durable state without bound.
 */
export const MAX_FACTS = 80;
export const MAX_EMISSIONS = 200;

export const runMemory = defineState<RunMemory>("catrpg.dm.run", () => ({
  seq: 0,
  facts: [],
  effects: [],
  items: [],
  shinies: [],
  bias: null,
}));

/** Keep the newest `max` entries. */
function tail<T>(rows: T[], max: number): T[] {
  return rows.length > max ? rows.slice(rows.length - max) : rows;
}

/** Next sequence number, allocated inside a single `update`. */
export function appendFact(fact: Omit<RunFact, "seq">): RunFact {
  let stamped!: RunFact;
  runMemory.update((m) => {
    stamped = { ...fact, seq: m.seq + 1 };
    return {
      ...m,
      seq: stamped.seq,
      facts: tail([...m.facts, stamped], MAX_FACTS),
    };
  });
  return stamped;
}

export function appendEffect(e: Omit<EffectEmission, "seq">): EffectEmission {
  let stamped!: EffectEmission;
  runMemory.update((m) => {
    stamped = { ...e, seq: m.seq + 1 };
    return {
      ...m,
      seq: stamped.seq,
      effects: tail([...m.effects, stamped], MAX_EMISSIONS),
    };
  });
  return stamped;
}

export function appendItem(e: Omit<ItemEmission, "seq">): ItemEmission {
  let stamped!: ItemEmission;
  runMemory.update((m) => {
    stamped = { ...e, seq: m.seq + 1 };
    return {
      ...m,
      seq: stamped.seq,
      items: tail([...m.items, stamped], MAX_EMISSIONS),
    };
  });
  return stamped;
}

export function appendShinies(
  e: Omit<ShiniesEmission, "seq">,
): ShiniesEmission {
  let stamped!: ShiniesEmission;
  runMemory.update((m) => {
    stamped = { ...e, seq: m.seq + 1 };
    return {
      ...m,
      seq: stamped.seq,
      shinies: tail([...m.shinies, stamped], MAX_EMISSIONS),
    };
  });
  return stamped;
}

export function setBias(bias: Omit<EncounterBias, "seq">): EncounterBias {
  let stamped!: EncounterBias;
  runMemory.update((m) => {
    stamped = { ...bias, seq: m.seq + 1 };
    return { ...m, seq: stamped.seq, bias: stamped };
  });
  return stamped;
}
