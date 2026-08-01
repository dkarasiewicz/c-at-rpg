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
import type { MetaProfile, RunOverlay } from "./types.js";
import { newRun, PARTY_ORDER } from "../run/runState.js";
import { descendingCats, runCats } from "./roster.js";
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
 * How `startRun` is told who is going down (roster-and-persistence.md §3).
 * `meta` is the whole point: the party is READ from the town roster, in the
 * order the roster screen put it, rather than drawn at the door.
 */
export interface StartRunOpts {
  /** A party-creator run: the kits ARE the party. */
  customParty?: CustomCatKit[];
  /** The town profile. Absent ⇒ the legacy four-Strays draw. */
  meta?: MetaProfile;
}

/**
 * Begin a descent from Cat Town: a fresh run for `seed`, with everything the
 * town has unlocked already folded in, carrying the cats the player chose.
 * Deterministic — same seed + same overlay + same roster ⇒ the same run.
 *
 * WHO GOES: `descendingCats(meta, capacity)` — the roster screen's pick,
 * repaired against the living roster and clamped to the run's capacity. They
 * descend as themselves, at the level the most experienced of them has
 * reached (`runCats`), and the whole party is fielded: there is no bench,
 * because the choosing already happened where the player could see it.
 *
 * WITHOUT a `meta` (tests, the party creator, the `?smoke=` direct starts)
 * this is the pre-roster behaviour exactly: four Strays in `cats`, Bruno plus
 * one drawn from the seed in the formation.
 */
export function startRun(
  seed: string,
  overlay: RunOverlay,
  opts?: StartRunOpts | CustomCatKit[],
): RunState {
  const o: StartRunOpts = Array.isArray(opts)
    ? { customParty: opts }
    : (opts ?? {});
  const customParty = o.customParty;
  const custom = (customParty?.length ?? 0) > 0;

  // The town's class pool is stamped onto the run as a record of what the
  // player COULD have fielded (see RunState.eligibleClasses). A custom
  // (party-creator) run is exempt: the kits are the party, and they were
  // never described into the town's catalog.
  const allowed = custom
    ? PARTY_ORDER
    : (eligibleClasses(overlay).filter((c): c is ClassId =>
        (PARTY_ORDER as readonly string[]).includes(c),
      ) as ClassId[]);

  const chosen =
    !custom && o.meta
      ? descendingCats(o.meta, overlay.partyCapacity)
      : undefined;

  let run: RunState;
  if (chosen && chosen.length > 0) {
    const party = runCats(chosen);
    run = newRun(seed, customParty, {
      partyCapacity: overlay.partyCapacity,
      cats: party.cats,
      eligibleClasses: allowed,
    });
    run = { ...run, xp: party.xp, level: party.level };
  } else {
    run = newRun(seed, customParty, {
      partyCapacity: overlay.partyCapacity,
      ...(custom ? {} : { roster: startingRoster(seed, overlay) as ClassId[] }),
      eligibleClasses: allowed,
    });
  }
  return applyOverlayToRun(run, overlay);
}
