/**
 * c(at)rpg — dev-time event authoring invariants (events.md §1, WP-06).
 *
 * Run in tests and at dev boot. `validateEvents` returns human-readable
 * error strings (empty array = valid); `assertValidEvents` throws on any.
 *
 * The 7 invariants:
 *  1. 2–4 options; 1–4 outcomes per option; all weights > 0.
 *  2. Every event has at least one requirement-free option whose outcomes
 *     contain no `damage` and no `fight` — the walk-away rule.
 *  3. `fight` is the last effect of its outcome; at most one per outcome
 *     (checked recursively through `onWinEffects`).
 *  4. `gateCat` targets appear only on options with a class/stat requirement.
 *  5. All `encounter` ids exist in the enemy roster; all item ids exist in
 *     the item tables (consumables + equipment).
 *  6. Scalar damage/heal amounts and shinies costs resolve to >= 0 on every
 *     floor the event can fire on.
 *  7. `restoreLife` amounts are >= 1 (its runtime graying — disabled when no
 *     living cat is below 9 Lives — lives in resolve.isOptionAvailable).
 */
import type { Effect, EventOption, GameEvent } from "../types.js";
import { resolveScalar } from "./resolve.js";
import { ENEMIES } from "../../content/enemies.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { EQUIP_DEFS } from "../../content/equipment.js";

export interface ValidateDeps {
  enemyIds?: ReadonlySet<string>;
  itemIds?: ReadonlySet<string>;
}

/** Every effect in an option, recursing into fight.onWinEffects. */
function* allEffects(effects: readonly Effect[]): Generator<Effect> {
  for (const e of effects) {
    yield e;
    if (e.kind === "fight" && e.onWinEffects) yield* allEffects(e.onWinEffects);
  }
}

function checkFightPlacement(
  effects: readonly Effect[],
  where: string,
  errors: string[],
): void {
  const fights = effects.filter((e) => e.kind === "fight");
  if (fights.length > 1) {
    errors.push(`${where}: more than one fight effect in one outcome`);
  }
  if (fights.length > 0 && effects[effects.length - 1].kind !== "fight") {
    errors.push(`${where}: fight is not the last effect of its outcome`);
  }
  for (const e of effects) {
    if (e.kind === "fight" && e.onWinEffects) {
      checkFightPlacement(e.onWinEffects, `${where}.onWinEffects`, errors);
    }
  }
}

function isSafeWalkAway(opt: EventOption): boolean {
  if (opt.requires) return false;
  for (const outcome of opt.outcomes) {
    for (const e of allEffects(outcome.effects)) {
      if (e.kind === "damage" || e.kind === "fight") return false;
    }
  }
  return true;
}

export function validateEvents(
  events: readonly GameEvent[],
  deps: ValidateDeps = {},
): string[] {
  const enemyIds = deps.enemyIds ?? new Set(Object.keys(ENEMIES));
  const itemIds =
    deps.itemIds ??
    new Set([...Object.keys(CONSUMABLES), ...Object.keys(EQUIP_DEFS)]);
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const ev of events) {
    const at = `event '${ev.id}'`;

    if (seenIds.has(ev.id)) errors.push(`${at}: duplicate event id`);
    seenIds.add(ev.id);

    // ── invariant 1: shape & weights ─────────────────────────────────────
    if (ev.weight <= 0) errors.push(`${at}: event weight must be > 0`);
    if (ev.options.length < 2 || ev.options.length > 4) {
      errors.push(`${at}: must have 2-4 options (has ${ev.options.length})`);
    }
    // floors the event can fire on (run is floors 1-6)
    const floorLo = Math.max(1, ev.floors[0]);
    const floorHi = Math.min(6, ev.floors[1]);

    ev.options.forEach((opt, oi) => {
      const oat = `${at} option ${oi}`;
      if (opt.outcomes.length < 1 || opt.outcomes.length > 4) {
        errors.push(
          `${oat}: must have 1-4 outcomes (has ${opt.outcomes.length})`,
        );
      }
      opt.outcomes.forEach((outcome, ci) => {
        const cat = `${oat} outcome ${ci}`;
        if (outcome.weight <= 0) {
          errors.push(`${cat}: outcome weight must be > 0`);
        }

        // ── invariant 3: fight placement ───────────────────────────────
        checkFightPlacement(outcome.effects, cat, errors);

        for (const eff of allEffects(outcome.effects)) {
          // ── invariant 4: gateCat only behind class/stat gates ────────
          if (
            "target" in eff &&
            eff.target === "gateCat" &&
            opt.requires?.kind !== "class" &&
            opt.requires?.kind !== "stat"
          ) {
            errors.push(
              `${cat}: gateCat target on an option without a class/stat requirement`,
            );
          }
          // ── invariant 5: id cross-references ─────────────────────────
          if (eff.kind === "fight") {
            for (const id of eff.encounter) {
              if (!enemyIds.has(id)) {
                errors.push(`${cat}: unknown enemy id '${id}' in encounter`);
              }
            }
          }
          if (
            (eff.kind === "giveItem" || eff.kind === "takeItem") &&
            !itemIds.has(eff.item)
          ) {
            errors.push(`${cat}: unknown item id '${eff.item}'`);
          }
          // ── invariant 6: scalars >= 0 on every firing floor ──────────
          if (eff.kind === "damage" || eff.kind === "heal") {
            for (let f = floorLo; f <= floorHi; f++) {
              if (resolveScalar(eff.amount, f) < 0) {
                errors.push(
                  `${cat}: ${eff.kind} amount resolves below 0 on floor ${f}`,
                );
                break;
              }
            }
          }
          // ── invariant 7 (static facet): restoreLife amount >= 1 ──────
          if (eff.kind === "restoreLife" && eff.amount < 1) {
            errors.push(`${cat}: restoreLife amount must be >= 1`);
          }
        }
      });

      // requirement-side id / scalar checks (invariants 5 & 6)
      const req = opt.requires;
      if (req?.kind === "item" && !itemIds.has(req.item)) {
        errors.push(`${oat}: unknown item id '${req.item}' in requirement`);
      }
      if (req?.kind === "shinies") {
        for (let f = floorLo; f <= floorHi; f++) {
          if (resolveScalar(req.cost, f) < 0) {
            errors.push(`${oat}: shinies cost resolves below 0 on floor ${f}`);
            break;
          }
        }
      }
    });

    // ── invariant 2: the walk-away rule ──────────────────────────────────
    if (!ev.options.some(isSafeWalkAway)) {
      errors.push(
        `${at}: no requirement-free option free of damage/fight (walk-away rule)`,
      );
    }
  }
  return errors;
}

/** Throws with all violations listed; used at dev boot and in tests. */
export function assertValidEvents(
  events: readonly GameEvent[],
  deps: ValidateDeps = {},
): void {
  const errors = validateEvents(events, deps);
  if (errors.length > 0) {
    throw new Error(`Event validation failed:\n${errors.join("\n")}`);
  }
}
