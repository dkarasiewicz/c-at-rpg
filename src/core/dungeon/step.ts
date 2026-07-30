/**
 * c(at)rpg — the exploration step loop (ARCHITECTURE.md §1: core/dungeon/step.ts).
 *
 * dungeon.md §9.3 — one discrete simulation step per party move:
 *   1. resolve the move (wall bump consumes NO step; chest bump opens it and
 *      consumes the step; otherwise the party moves)
 *   2. recompute visibility, accumulate explored
 *   3. roamers act in entity-id order (roamers.ts)
 *   4. contact check: Manhattan ≤ 1 → battle (lowest entity id wins)
 *   5. tile triggers under the party (boss-lair entry / event / stairs)
 *   6. stepCount++
 *
 * Zero RNG at runtime; the FloorState is mutated in place and the returned
 * StepTrigger tells the UI what to react to. Post-battle re-entry is
 * applyVictory / applyFlee (+ contactCheck for chained fights, §14).
 */
import { Tile } from "../types";
import type { Entity, FloorState, Roamer, StepTrigger } from "../types";
import { idx, inBounds, recomputeVisibility } from "./floor";
import { advanceRoamers } from "./roamers";

export type StepDir = "N" | "E" | "S" | "W";

const DIR_VEC: Record<StepDir, readonly [number, number]> = {
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
};

/** How long a fled-from pack stays stunned, in party-steps (§9.3). */
export const FLEE_STUN_STEPS = 5;

const isPack = (e: Entity): e is Roamer =>
  e.kind === "roamer" || e.kind === "boss";

const battleTrigger = (r: Roamer): StepTrigger => ({
  t: "battle",
  roamerId: r.id,
  encounterIndex: r.encounterIndex,
  enemies: r.enemies,
  isBoss: r.kind === "boss",
});

/**
 * Step-loop phase 4 (also called by the UI after a battle to chain fights,
 * dungeon.md §14): any living, non-stunned pack at Manhattan distance ≤ 1
 * from the party triggers battle — lowest entity id if several.
 */
export function contactCheck(f: FloorState): StepTrigger | null {
  for (const e of f.entities) {
    // entity-id order → the first hit IS the lowest id
    if (!isPack(e) || e.dead || e.state === "stunned") continue;
    if (Math.abs(e.x - f.party.x) + Math.abs(e.y - f.party.y) <= 1) {
      return battleTrigger(e);
    }
  }
  return null;
}

/** Tile triggers under the party (phase 5): lair entry, event, stairs. */
function tileTrigger(f: FloorState): StepTrigger | null {
  const { x, y } = f.party;
  // Boss-lair entry: first step onto any lair tile while the boss lives (§8.4).
  for (const e of f.entities) {
    if (e.kind !== "boss" || e.dead) continue;
    const lair = f.rooms[e.homeRoom];
    if (
      x >= lair.x &&
      x < lair.x + lair.w &&
      y >= lair.y &&
      y < lair.y + lair.h
    ) {
      return battleTrigger(e);
    }
  }
  for (const e of f.entities) {
    if (e.kind === "event" && !e.used && e.x === x && e.y === y) {
      e.used = true; // entity consumed regardless of outcome (§9.5)
      return { t: "event", eventId: e.id, eventSeed: e.eventSeed };
    }
  }
  if (f.tiles[idx(f.w, x, y)] === Tile.StairsDown) {
    return { t: "stairs", locked: f.stairsLocked };
  }
  return null;
}

/**
 * Advance the simulation by one party step in direction `dir`.
 * Mutates `f` in place; returns the single trigger the UI must react to.
 */
export function step(f: FloorState, dir: StepDir): StepTrigger {
  const [dx, dy] = DIR_VEC[dir];
  const tx = f.party.x + dx;
  const ty = f.party.y + dy;

  // Phase 1 — resolve the move.
  if (!inBounds(f.w, f.h, tx, ty) || f.tiles[idx(f.w, tx, ty)] === Tile.Wall) {
    return { t: "bump" }; // bump animation, NO step consumed
  }
  let openedChest: number | null = null;
  for (const e of f.entities) {
    if (e.kind === "chest" && !e.opened && e.x === tx && e.y === ty) {
      e.opened = true; // step consumed, party stays put
      openedChest = e.id;
      break;
    }
  }
  if (openedChest === null) {
    f.party.x = tx;
    f.party.y = ty;
  }

  // Phase 2 — visibility.
  recomputeVisibility(f);

  // Phase 3 — roamers act (entity-id order, zero RNG).
  advanceRoamers(f);

  // Phases 4–5 — triggers. A chest open reports the chest (its loot popup);
  // an adjacent pack still stands there and re-triggers on the next step.
  const contact = contactCheck(f);
  let trigger: StepTrigger;
  if (openedChest !== null) trigger = { t: "chest", chestId: openedChest };
  else if (contact) trigger = contact;
  else trigger = tileTrigger(f) ?? { t: "moved" };

  // Phase 6.
  f.stepCount++;
  return trigger;
}

/**
 * Post-battle victory: the pack dies; a boss kill unlocks the stairs (§8.5).
 * Surviving roamers stay alive; the UI should call `contactCheck` afterwards
 * to chain immediately-adjacent fights (§14).
 */
export function applyVictory(f: FloorState, roamerId: number): void {
  const e = f.entities[roamerId];
  if (!e || !isPack(e)) return;
  e.dead = true;
  if (e.kind === "boss") f.stairsLocked = false;
}

/**
 * Post-battle flee (Scatter!): the party keeps the tile it occupied when
 * contact triggered (it never moved during the battle) and the pack is
 * stunned for 5 party-steps — no movement, no contact trigger (§9.3, §14).
 * Enemy HP reset on re-engage is combat's concern, not the dungeon's.
 */
export function applyFlee(f: FloorState, roamerId: number): void {
  const e = f.entities[roamerId];
  if (!e || !isPack(e)) return;
  e.state = "stunned";
  e.stunnedFor = FLEE_STUN_STEPS;
  e.lostSightFor = 0;
}
