/**
 * CAT TOWN — the run-start seam.
 *
 * `startRun(seed, overlay)` is the ONE call Cat Town makes to begin a
 * descent. `newRun` keeps its meta-free signature; this module is the only
 * place that knows both halves.
 *
 * What the overlay does to a fresh run:
 *   ROSTER    the starting formation is Bruno plus one cat drawn from the
 *             ones the town actually has (`startingRoster`), passed to
 *             `newRun` as `opts.roster`. With nothing unlocked that is the
 *             vanilla Bruno + Pixel pairing.
 *   CAPACITY  `opts.partyCapacity` — three by default (the third cat joins
 *             mid-run), four once the fourth bowl is bought.
 *   WALLET    `startingShinies` on top of the STARTING_KIT tin.
 *   GEAR      `gear:<defId>` unlocks arrive as stray L1 instances in the
 *             backpack (not equipped — the player chooses).
 * `maxBiome`, `shopUpgrades` and the content pools ride along on the overlay
 * for the map, Peddler and loot code to read as they grow support for them.
 */
import type { ClassId, EquipInstance, RunState } from "../types.js";
import type { CustomCatKit } from "../run/runState.js";
import type { RunOverlay } from "./types.js";
import { newRun, PARTY_ORDER } from "../run/runState.js";
import { applyGrant } from "../loot/inventory.js";
import { makeEquipInstance } from "../loot/roll.js";
import { EQUIP_DEFS } from "../../content/equipment.js";
import { eligibleClasses, startingRoster } from "./overlay.js";

/**
 * Fold the parts of an overlay that are pure RunState edits (wallet, starting
 * gear, the capacity field). Total: an overlay naming content this build does
 * not ship is ignored rather than fatal.
 */
export function applyOverlayToRun(
  run: RunState,
  overlay: RunOverlay,
): RunState {
  let next: RunState =
    run.partyCapacity === overlay.partyCapacity
      ? run
      : { ...run, partyCapacity: overlay.partyCapacity };

  const equips: EquipInstance[] = [];
  let uid = next.inventory.nextUid;
  for (const defId of overlay.gear) {
    if (!EQUIP_DEFS[defId]) continue; // content this build does not ship
    equips.push(makeEquipInstance(uid, defId, 1, "stray"));
    uid += 1;
  }
  if (overlay.startingShinies > 0 || equips.length > 0) {
    const { inv } = applyGrant(
      { ...next.inventory, nextUid: uid },
      { shinies: overlay.startingShinies, equips, consumables: [] },
    );
    next = { ...next, inventory: inv };
  }
  return next;
}

/**
 * Begin a descent from Cat Town: a fresh run for `seed`, with everything the
 * town has unlocked already folded in. Deterministic — same seed + same
 * overlay ⇒ the same run, every time.
 */
export function startRun(
  seed: string,
  overlay: RunOverlay,
  customParty?: CustomCatKit[],
): RunState {
  // ROSTER GATE: the town's class pool is stamped onto the run so the mid-run
  // recruit (`recruitCat`, floor 3) can only ever hand over a cat Cat Town
  // actually houses — otherwise the stoop's `class:*` unlocks buy nothing.
  //
  // A custom (party-creator) run is exempt on both counts: the kits ARE the
  // party, so the formation is the engine's own draw and every slot stays
  // recruitable rather than being benched against a catalog the player never
  // described their cats into.
  const custom = (customParty?.length ?? 0) > 0;
  const allowed = custom
    ? PARTY_ORDER
    : (eligibleClasses(overlay).filter((c): c is ClassId =>
        (PARTY_ORDER as readonly string[]).includes(c),
      ) as ClassId[]);
  const run = newRun(seed, customParty, {
    partyCapacity: overlay.partyCapacity,
    ...(custom ? {} : { roster: startingRoster(seed, overlay) as ClassId[] }),
    eligibleClasses: allowed,
  });
  return applyOverlayToRun(run, overlay);
}
