/**
 * c(at)rpg — headless balance harness (docs/design/balance-and-meta.md §1).
 *
 *   npm run sim            # every floor, 300 trials each
 *   npm run sim -- --floors=1,2 --trials=1000 --chain=4
 *   npm run sim -- --party=4 --json
 *
 * It drives the REAL engine — `createBattle` / `startRound` / `resolveAction`
 * / `takeEnemyTurn`, the real content tables, the real seeded RNG — with an
 * AI playing BOTH sides, so every number it prints is a number the game can
 * actually produce. Nothing in here is a model of combat; it is combat.
 *
 * One trial = one floor "chain": a floor-appropriate party at full HP fights
 * `chain` seeded encounters back to back with HP persisting between them
 * (attrition is the point — a 92% per-battle win rate is a 72% floor).
 *
 * `chain` defaults to 3, which is what one WALK across a floor actually costs:
 * the run map is 4-7 columns and the party takes a single path through it, so
 * roughly half the nodes it touches are fights. It is still a pessimistic
 * number — the chain has no rest node, no shop and no consumables, so a real
 * floor is kinder than these clear rates. Raise it to stress-test attrition.
 *
 * Reported per floor:
 *   win%      per-BATTLE win rate
 *   clear%    trials that survived the whole chain
 *   rounds    mean rounds per battle
 *   stale%    battles still ongoing at MAX_ROUNDS (40) — neither side could
 *             finish. The ENGINE has no round cap; only this harness does, so
 *             anything above zero here is a fight a player could sit in
 *    *   OB%       Off-Balance uptime: share of (living enemy × round) slots in
 *             which that enemy carried Off-Balance at any observed point
 *   pile/bt   Cat Piles executed per battle
 *   lives     mean Lives burned per trial
 *   share     damage dealt to enemies, per cat + the Cat Pile / DoT buckets
 *
 * Determinism: every trial derives its stream from
 * `mulberry32(hash(seed, floor, trial, battleIndex))`, so a table is
 * reproducible from its seed alone. The cat policy below draws from that same
 * stream only through the engine — it never rolls dice of its own.
 */
import type {
  BattleAction,
  BattleEvent,
  BattleSetup,
  BattleState,
  ClassId,
  Combatant,
  EnemyId,
  Rng,
  Skill,
  TraitId,
} from "../src/core/types.js";
import { hash, mulberry32 } from "../src/core/rng.js";
import { CLASSES } from "../src/content/classes.js";
import { SKILLS } from "../src/content/skills.js";
import { FLOORS } from "../src/content/floors.js";
import { rollPack } from "../src/core/map/encounter.js";
import { growthStats, knownSkills, traitTier } from "../src/core/run/party.js";
import { createBattle } from "../src/core/combat/setup.js";
import {
  byId,
  canUseFrom,
  hasStatus,
  legalActions,
  living,
  nextActor,
  previewDamage,
  wouldMoveDistance,
} from "../src/core/combat/state.js";
import { resolveAction } from "../src/core/combat/resolve.js";
import { startRound } from "../src/core/combat/turns.js";
import { takeEnemyTurn } from "../src/core/combat/ai.js";

/* ------------------------------------------------------------------ */
/* the party the sim fields on each floor                              */
/* ------------------------------------------------------------------ */

/**
 * What the run is expected to be carrying when it walks onto a floor
 * (balance-and-meta.md §2: two cats at the start, a third mid-run, a fourth
 * only if Cat Town unlocked it). `--party=N` overrides the size everywhere —
 * that is how the pre-change BASELINE table was taken at a flat four.
 */
export interface FloorPlan {
  size: number;
  level: number;
}

/**
 * Sizes follow `DEFAULT_PARTY_CAPACITY` (3): two cats to start, the third on
 * the floor-3 descent. A Cat Town run that unlocked the fourth slot is
 * `--party=4`.
 *
 * Levels are derived from what the XP table actually pays out, not from
 * wishful thinking: a floor is ~6-8 fights of ~3 bodies at 10-35 xp each, so
 * against XP_TO_LEVEL = [0,30,70,130,210,310,430,570] the party clears floor
 * 1 around L4 and is at the L8 cap from floor 5. An earlier version of this
 * table guessed L4 on floor 4 and made the back half look unwinnable — the
 * harness was measuring a party that cannot exist.
 */
export const FLOOR_PLAN: readonly FloorPlan[] = [
  { size: 2, level: 2 }, // 1 — The Cellar
  { size: 2, level: 4 }, // 2 — The Drains
  { size: 3, level: 5 }, // 3 — Appliance Graveyard (recruit + first boss)
  { size: 3, level: 7 }, // 4 — The Undergarden
  { size: 3, level: 8 }, // 5 — The Cold Pantry
  { size: 3, level: 8 }, // 6 — The Hollow Throne
];

/** Slot order — also `recruitCat`'s pick order for the bench. */
const SLOT_ORDER: readonly ClassId[] = [
  "bruiser",
  "trickster",
  "hexer",
  "medic",
];

/** The three Bruno can be paired with at run start (runState SECOND_CAT_POOL). */
const SECOND_POOL: readonly ClassId[] = ["trickster", "hexer", "medic"];

/**
 * The formation this trial fields, built the way the engine builds it:
 * Bruno + a seeded second (`newRun`), then the bench taken in SLOT order
 * (`recruitCat`) until the roster reaches `size`.
 *
 * This matters more than it looks. Fixing the roster to the first N slots
 * silently benches the Medic in every 3-cat trial, and a four-fight chain
 * with no healing at all is not the game — it is the worst case pretending
 * to be the average. Rotating the pairing measures the real distribution.
 */
function rosterFor(size: number, rng: Rng): ClassId[] {
  const second = SECOND_POOL[rng.int(0, SECOND_POOL.length - 1)];
  const roster: ClassId[] = ["bruiser", second];
  for (const id of SLOT_ORDER) {
    if (roster.length >= size) break;
    if (!roster.includes(id)) roster.push(id);
  }
  return roster.slice(0, size);
}

function buildCats(
  roster: readonly ClassId[],
  level: number,
): BattleSetup["cats"] {
  return roster.map((classId) => {
    const cls = CLASSES[classId];
    const stats = growthStats(classId, level);
    const tier = traitTier(classId, level);
    const traits: TraitId[] =
      tier >= 2 ? [cls.trait.id, cls.trait.id] : [cls.trait.id];
    return {
      classId,
      name: cls.catName,
      stats,
      hp: stats.hp,
      lives: 9,
      skills: knownSkills(classId, level).slice(0, 4),
      traits,
      hooks: [],
      startEnergyBonus: 0,
    };
  });
}

/* ------------------------------------------------------------------ */
/* the cat policy — a competent-but-not-clairvoyant player              */
/* ------------------------------------------------------------------ */

/**
 * Score-and-pick, deliberately mirroring the enemy AI's shape (combat.md §10)
 * so neither side is measured against a strawman. It knows five things a
 * human knows on turn one: kill shots end fights, heals matter below half,
 * a KO'd friend is worth six energy, a shove is only worth spending on a
 * target that can actually be destabilised, and energy is for spending.
 *
 * It deliberately does NOT know: what the RNG will do, what the enemy will
 * pick, or how to sequence a Cat Pile two rounds out. A harness that plays
 * perfectly measures the ceiling; this one measures the floor a real player
 * stands on.
 */
function takeCatTurn(actor: Combatant, state: BattleState): BattleAction {
  const la = legalActions(state);
  // Collected, then reduced — rather than kept in a `let` the closure writes,
  // which TypeScript's control-flow analysis cannot follow (it narrows the
  // variable to `never` at the return and the pick does not compile).
  const offers: { action: BattleAction; score: number }[] = [];
  const offer = (action: BattleAction, score: number): void => {
    offers.push({ action, score });
  };

  for (const opt of la.skills) {
    if (!opt.ok) continue;
    const sk: Skill | undefined = SKILLS[opt.skillId];
    if (!sk || !canUseFrom(state, actor, sk)) continue;
    const spend = sk.cost * 1.5; // energy is not free

    // revive: always the best thing a Medic can be doing
    if (sk.revivePct !== undefined) {
      for (const id of opt.targetIds) {
        offer({ type: "skill", skillId: sk.id, targetId: id }, 400 - spend);
      }
      continue;
    }

    // self / row skills take no targetId
    if (sk.target.side === "self" || sk.target.pattern === "row") {
      let score = 0;
      if (sk.kind === "damage") {
        const hits = opt.targetIds.length;
        let dmg = 0;
        for (const id of opt.targetIds) {
          dmg += previewDamage(state, sk.id, actor.id, id);
        }
        score = 18 + dmg * 2 + (hits >= 2 ? 12 : 0);
        if (sk.moveTarget)
          score += shoveValue(state, opt.targetIds, sk.moveTarget);
      } else if (sk.kind === "heal") {
        const need = healNeed(state, opt.targetIds);
        if (need <= 0) continue;
        score = 20 + need * 60;
      } else {
        // utility (Hiss, Bin Lid Bulwark, Warm Loaf Press…)
        score = 14 + 40 * partyHurt(state);
      }
      offer({ type: "skill", skillId: sk.id }, score - spend);
      continue;
    }

    for (const id of opt.targetIds) {
      const t = byId(state, id);
      let score = 0;
      if (sk.kind === "damage") {
        const dmg = previewDamage(state, sk.id, actor.id, id);
        score = 18 + dmg * 2;
        if (dmg >= t.hp) score += 70; // kill shot
        if (hasStatus(t, "offBalance")) score += 10; // cash the window
        if (sk.moveTarget) score += shoveValue(state, [id], sk.moveTarget);
      } else if (sk.kind === "heal") {
        const need = 1 - t.hp / t.stats.hp;
        if (need <= 0.15) continue;
        score = 20 + need * 90;
      } else {
        score = 12;
      }
      offer({ type: "skill", skillId: sk.id, targetId: id }, score - spend);
    }
  }

  // Guard: the fallback, and a real choice when the tank is topped up and
  // poor. Scored low enough that any live skill beats it.
  if (la.canGuard) offer({ type: "guard" }, actor.energy <= 1 ? 22 : 8);

  // FIRST offer wins a tie, exactly as the `score > best.score` this replaced.
  let best: { action: BattleAction; score: number } | null = null;
  for (const candidate of offers) {
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best ? best.action : { type: "guard" };
}

/**
 * Worth of a shove. Nothing against something already down, already Braced,
 * or standing where the §8 clamp would move it zero ranks — that last one
 * matters enormously in the small packs of floors 1-2, where half of every
 * push lands on the back rank and accomplishes nothing.
 */
function shoveValue(
  state: BattleState,
  targetIds: string[],
  delta: number,
): number {
  let v = 0;
  const marked = new Set<string>();
  for (const id of targetIds) {
    const t = byId(state, id);
    if (t.traits.includes("heavy")) {
      v += t.poiseMax !== undefined ? 14 : 0; // Poise chip is worth it
      continue;
    }
    if (hasStatus(t, "offBalance") || hasStatus(t, "braced")) continue;
    if (wouldMoveDistance(state, t, delta) < 1) continue; // clamps to nothing
    v += 14;
    marked.add(t.id);
  }
  // "Pile or pick" (§8): a shove that completes the set is worth far more
  // than a shove that just adds one mark. Without this the harness models a
  // player who never sets a Cat Pile up on purpose — which is a strawman to
  // measure Cat Pile frequency against.
  if (marked.size > 0) {
    const rest = living(state, "enemy").filter((e) => !marked.has(e.id));
    if (rest.every((e) => hasStatus(e, "offBalance"))) v += 40;
  }
  return v;
}

function healNeed(state: BattleState, ids: string[]): number {
  let worst = 0;
  for (const id of ids) {
    const t = byId(state, id);
    worst = Math.max(worst, 1 - t.hp / t.stats.hp);
  }
  return worst > 0.25 ? worst : 0;
}

function partyHurt(state: BattleState): number {
  const cats = living(state, "cat");
  if (cats.length === 0) return 0;
  const frac = cats.reduce((s, c) => s + c.hp / c.stats.hp, 0) / cats.length;
  return 1 - frac;
}

/**
 * "Pile or pick" (combat.md §8): take the flat damage when it converts —
 * it kills something, or hardly any cats are left to cash the window the
 * normal way. Otherwise decline and keep the marks.
 */
function shouldPile(state: BattleState, damageEach: number): boolean {
  const enemies = living(state, "enemy");
  if (enemies.some((e) => e.hp <= damageEach)) return true;
  const unacted = state.queue.filter(
    (q) => !q.acted && byId(state, q.combatantId).side === "cat",
  ).length;
  return unacted < 2;
}

/* ------------------------------------------------------------------ */
/* metrics                                                             */
/* ------------------------------------------------------------------ */

interface Acc {
  battles: number;
  wins: number;
  trials: number;
  clears: number;
  rounds: number;
  piles: number;
  livesLost: number;
  /** damage dealt TO enemies, bucketed by the cat that caused it */
  dmgBy: Map<string, number>;
  dmgTotal: number;
  /**
   * Total enemy damage in the battles each bucket was PRESENT for. A cat is
   * not in every roster (`rosterFor` rotates Bruno's partner), so dividing a
   * cat's damage by the grand total understates whoever sits out most —
   * Baguette appears in a third of 3-cat rosters and her raw share reads a
   * third of what she actually contributes when fielded. The ≤40% target in
   * balance-and-meta.md §1 is a claim about a cat IN a party, so it has to be
   * measured against the damage of the parties she was in.
   */
  dmgWhilePresent: Map<string, number>;
  /** battles each bucket was fielded for (denominator sanity) */
  battlesPresent: Map<string, number>;
  /**
   * Enemy damage by `"<cat>/<skillId>"` — the diagnostic that turns "Pixel is
   * too strong" into "Pounce is too strong". Printed by `--skills`.
   */
  dmgBySkill: Map<string, number>;
  obEnemyRounds: number;
  obHitRounds: number;
  stalemates: number;
  /** forced moves the cats actually landed (≥1 rank) */
  shoves: number;
  /** Off-Balance applications that stuck */
  obApplied: number;
  /** applications lost to Braced or the tier roll */
  obDenied: number;
}

const newAcc = (): Acc => ({
  battles: 0,
  wins: 0,
  trials: 0,
  clears: 0,
  rounds: 0,
  piles: 0,
  livesLost: 0,
  dmgBy: new Map(),
  dmgTotal: 0,
  dmgWhilePresent: new Map(),
  battlesPresent: new Map(),
  dmgBySkill: new Map(),
  obEnemyRounds: 0,
  obHitRounds: 0,
  stalemates: 0,
  shoves: 0,
  obApplied: 0,
  obDenied: 0,
});

const MAX_ROUNDS = 40;

/** Run one battle to its end, folding everything measurable into `acc`. */
function runBattle(
  setup: BattleSetup,
  rng: Rng,
  acc: Acc,
  roster: readonly ClassId[],
): BattleState {
  let bs = createBattle(setup);
  acc.battles += 1;
  /** enemy damage in THIS battle, for the presence-conditioned share */
  let battleDmg = 0;

  // per-round Off-Balance sampling
  let aliveAtRoundStart: string[] = [];
  let sawOffBalance = new Set<string>();
  const closeRound = (): void => {
    acc.obEnemyRounds += aliveAtRoundStart.length;
    acc.obHitRounds += sawOffBalance.size;
  };
  const sample = (s: BattleState): void => {
    for (const e of living(s, "enemy")) {
      if (hasStatus(e, "offBalance")) sawOffBalance.add(e.id);
    }
  };

  const attribute = (events: BattleEvent[], actorId: string | null): void => {
    for (const ev of events) {
      if (ev.t === "damage") {
        const victim = byId(bs, ev.id);
        if (victim.side !== "enemy") continue;
        const bucket =
          ev.source === "catPile"
            ? "catPile"
            : ev.source === "scratched"
              ? "bleed"
              : (actorId ?? "other");
        if (
          bucket.startsWith("cat:") ||
          bucket === "catPile" ||
          bucket === "bleed"
        ) {
          acc.dmgBy.set(bucket, (acc.dmgBy.get(bucket) ?? 0) + ev.amount);
          acc.dmgTotal += ev.amount;
          battleDmg += ev.amount;
          const sk = `${prettyKey(bucket)}/${ev.source}`;
          acc.dmgBySkill.set(sk, (acc.dmgBySkill.get(sk) ?? 0) + ev.amount);
        }
      } else if (ev.t === "statusApplied" && ev.status === "offBalance") {
        if (byId(bs, ev.id).side === "enemy") acc.obApplied += 1;
      } else if (ev.t === "moved" && ev.forced) {
        if (byId(bs, ev.id).side === "enemy") acc.shoves += 1;
      } else if (ev.t === "log" && ev.text.includes("keeps its footing")) {
        acc.obDenied += 1;
      } else if (ev.t === "catPile") {
        acc.piles += 1;
      } else if (ev.t === "lifeLost") {
        acc.livesLost += 1;
      }
    }
  };

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const r = startRound(bs, rng);
    bs = r.state;
    attribute(r.events, null);
    if (bs.outcome !== "ongoing") break;

    aliveAtRoundStart = living(bs, "enemy").map((e) => e.id);
    sawOffBalance = new Set<string>();
    sample(bs);

    for (;;) {
      if (bs.catPilePrompt) {
        const dmg = catPileDamage(bs);
        const res = resolveAction(
          bs,
          { type: "catPile", accept: shouldPile(bs, dmg) },
          rng,
        );
        bs = res.state;
        attribute(res.events, "catPile");
        sample(bs);
        if (bs.outcome !== "ongoing") break;
        continue;
      }
      const actor = nextActor(bs);
      if (!actor) break;
      const action =
        actor.side === "cat"
          ? takeCatTurn(actor, bs)
          : takeEnemyTurn(actor, bs, rng);
      const res = resolveAction(bs, action, rng);
      bs = res.state;
      attribute(res.events, actor.side === "cat" ? actor.id : null);
      sample(bs);
      if (bs.outcome !== "ongoing") break;
    }

    closeRound();
    acc.rounds += 1;
    if (bs.outcome !== "ongoing") break;
    if (round === MAX_ROUNDS) acc.stalemates += 1;
  }
  if (bs.outcome === "victory") acc.wins += 1;

  // Presence bookkeeping: the buckets that could have contributed here.
  for (const key of [...roster.map((c) => `cat:${c}`), "catPile", "bleed"]) {
    acc.dmgWhilePresent.set(
      key,
      (acc.dmgWhilePresent.get(key) ?? 0) + battleDmg,
    );
    acc.battlesPresent.set(key, (acc.battlesPresent.get(key) ?? 0) + 1);
  }
  return bs;
}

/** Cat Pile damage without importing the resolver's private helper twice. */
function catPileDamage(s: BattleState): number {
  let sum = 0;
  for (const c of living(s, "cat")) {
    sum += c.stats.atk;
    if (c.hooks.includes("catPileDouble")) sum += c.stats.atk;
  }
  return Math.floor(0.3 * sum);
}

/* ------------------------------------------------------------------ */
/* the floor loop                                                      */
/* ------------------------------------------------------------------ */

export interface FloorReport {
  floor: number;
  name: string;
  partySize: number;
  level: number;
  winPct: number;
  clearPct: number;
  avgRounds: number;
  /** Battles that hit the round cap without either side winning. */
  stalematePct: number;
  obUptimePct: number;
  pilesPerBattle: number;
  avgLivesLost: number;
  /**
   * `pct` = share of ALL enemy damage on the floor. `fieldedPct` = share of
   * the damage done by the parties this bucket was actually in — the number
   * the ≤40% target is about. `evenPct` = 100 / partySize, the no-skew
   * baseline, so `fieldedPct / evenPct` is the concentration ratio.
   */
  share: { key: string; pct: number; fieldedPct: number }[];
  evenPct: number;
  /** `"<cat>/<skillId>"` → % of all enemy damage on this floor */
  skillShare: { key: string; pct: number }[];
  avgPackSize: number;
  shovesPerBattle: number;
  obAppliedPerBattle: number;
  obDeniedPerBattle: number;
}

export function simulateFloor(
  floorNum: number,
  trials: number,
  chain: number,
  seed: string,
  partyOverride?: number,
  rosterOverride?: readonly ClassId[],
): FloorReport {
  const cfg = FLOORS[floorNum - 1];
  const plan = FLOOR_PLAN[floorNum - 1];
  const size = rosterOverride?.length ?? partyOverride ?? plan.size;
  const acc = newAcc();
  let packBodies = 0;

  for (let trial = 0; trial < trials; trial++) {
    const roster =
      rosterOverride ??
      rosterFor(size, mulberry32(hash(seed, floorNum, trial, "roster")));
    const cats = buildCats(roster, plan.level);
    let cleared = true;
    acc.trials += 1;
    for (let b = 0; b < chain; b++) {
      const packRng = mulberry32(hash(seed, floorNum, trial, b, "pack"));
      const enemies: EnemyId[] = rollPack(
        packRng,
        cfg.pool,
        cfg.budgetLo,
        cfg.budgetHi,
      );
      packBodies += enemies.length;
      const rng = mulberry32(hash(seed, floorNum, trial, b, "battle"));
      const setup: BattleSetup = {
        cats: cats.map((c) => ({ ...c, stats: { ...c.stats } })),
        enemies,
        encounterIndex: b,
        canFlee: false,
        floor: floorNum,
      };
      const end = runBattle(setup, rng, acc, roster);
      if (end.outcome !== "victory") {
        cleared = false;
        break;
      }
      // HP persists across the floor (combat.md §12) — carry it forward.
      for (const c of cats) {
        const after = end.combatants.find(
          (x) => x.side === "cat" && x.classId === c.classId,
        );
        if (after) c.hp = Math.max(1, after.hp);
      }
    }
    if (cleared) acc.clears += 1;
  }

  const share: { key: string; pct: number; fieldedPct: number }[] = [];
  for (const [k, v] of acc.dmgBy) {
    const present = acc.dmgWhilePresent.get(k) ?? 0;
    share.push({
      key: k,
      pct: acc.dmgTotal ? (100 * v) / acc.dmgTotal : 0,
      fieldedPct: present ? (100 * v) / present : 0,
    });
  }
  share.sort((a, b) => b.fieldedPct - a.fieldedPct);

  return {
    floor: floorNum,
    name: cfg.name,
    partySize: size,
    level: plan.level,
    winPct: (100 * acc.wins) / Math.max(1, acc.battles),
    clearPct: (100 * acc.clears) / Math.max(1, acc.trials),
    avgRounds: acc.rounds / Math.max(1, acc.battles),
    stalematePct: (100 * acc.stalemates) / Math.max(1, acc.battles),
    obUptimePct: (100 * acc.obHitRounds) / Math.max(1, acc.obEnemyRounds),
    pilesPerBattle: acc.piles / Math.max(1, acc.battles),
    avgLivesLost: acc.livesLost / Math.max(1, acc.trials),
    shovesPerBattle: acc.shoves / Math.max(1, acc.battles),
    obAppliedPerBattle: acc.obApplied / Math.max(1, acc.battles),
    obDeniedPerBattle: acc.obDenied / Math.max(1, acc.battles),
    share,
    evenPct: 100 / size,
    skillShare: [...acc.dmgBySkill]
      .map(([key, v]) => ({
        key,
        pct: acc.dmgTotal ? (100 * v) / acc.dmgTotal : 0,
      }))
      .sort((a, b) => b.pct - a.pct),
    avgPackSize: packBodies / Math.max(1, acc.battles),
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const pad = (s: string, n: number): string => s.padStart(n);
const fmt = (v: number, d = 1): string => v.toFixed(d);

function main(): void {
  const trials = Number(arg("trials", "300"));
  const chain = Number(arg("chain", "3"));
  const seed = arg("seed", "SIM-1");
  const partyArg = arg("party", "");
  const party = partyArg ? Number(partyArg) : undefined;
  // `--roster=bruiser,trickster,hexer` pins the composition. The default
  // rotates Bruno's partner, which mixes two different 3-cat parties into one
  // damage-share column; pinning is how you find out whether a share is a
  // cat being strong or a support cat being absent.
  const rosterArg = arg("roster", "");
  const roster = rosterArg
    ? (rosterArg.split(",").map((s) => s.trim()) as ClassId[])
    : undefined;
  const floors = arg("floors", "1,2,3,4,5,6")
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => n >= 1 && n <= FLOORS.length);
  const json = process.argv.includes("--json");

  const reports = floors.map((f) =>
    simulateFloor(f, trials, chain, seed, party, roster),
  );

  if (json) {
    process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
    return;
  }

  const label = roster
    ? `roster=${roster.join("+")} (pinned)`
    : party
      ? `party=${party} (forced)`
      : "party=per-floor plan";
  process.stdout.write(
    `\nc(at)rpg balance sim — seed=${seed} trials=${trials} chain=${chain} ${label}\n\n`,
  );
  process.stdout.write(
    "fl  party lvl  pack   win%  clear%  rounds  stale%   OB%  pile/bt  lives  shove/bt  OB+/bt  res/bt\n",
  );
  process.stdout.write(
    "--  ----- ---  ----  -----  ------  ------  ------  ----  -------  -----  --------  ------  ------\n",
  );
  for (const r of reports) {
    process.stdout.write(
      [
        pad(String(r.floor), 2),
        pad(String(r.partySize), 6),
        pad(String(r.level), 3),
        pad(fmt(r.avgPackSize, 1), 6),
        pad(fmt(r.winPct), 6),
        pad(fmt(r.clearPct), 7),
        pad(fmt(r.avgRounds), 7),
        pad(fmt(r.stalematePct, 1), 7),
        pad(fmt(r.obUptimePct), 6),
        pad(fmt(r.pilesPerBattle, 2), 8),
        pad(fmt(r.avgLivesLost, 2), 7),
        pad(fmt(r.shovesPerBattle, 2), 10),
        pad(fmt(r.obAppliedPerBattle, 2), 8),
        pad(fmt(r.obDeniedPerBattle, 2), 8),
      ].join("") + "\n",
    );
  }
  process.stdout.write(
    "\ndamage share — % of the damage done by the parties that cat was FIELDED in\n" +
      "(×N = concentration vs an even split; ≤40% target lives here, not in the raw column)\n",
  );
  process.stdout.write(
    "---------------------------------------------------------------------------\n",
  );
  for (const r of reports) {
    const parts = r.share
      .map(
        (s) =>
          `${prettyKey(s.key)} ${fmt(s.fieldedPct)}% (${fmt(
            s.fieldedPct / r.evenPct,
            2,
          )}×)`,
      )
      .join("  ");
    process.stdout.write(`fl${r.floor}  even=${fmt(r.evenPct)}%  ${parts}\n`);
  }

  if (process.argv.includes("--skills")) {
    process.stdout.write(
      "\ndamage by skill (% of all damage dealt to enemies, top 8)\n" +
        "---------------------------------------------------------\n",
    );
    for (const r of reports) {
      const parts = r.skillShare
        .slice(0, 8)
        .map((s) => `${s.key} ${fmt(s.pct)}%`)
        .join("  ");
      process.stdout.write(`fl${r.floor}  ${parts}\n`);
    }
  }
  process.stdout.write("\n");
}

function prettyKey(k: string): string {
  if (k === "catPile") return "CatPile";
  if (k === "bleed") return "bleed";
  const id = k.replace(/^cat:/, "") as ClassId;
  return CLASSES[id]?.catName ?? k;
}

main();
