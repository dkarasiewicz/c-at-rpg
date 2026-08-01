/**
 * The one-shot DM capabilities: party generation and Stand resonance.
 *
 * These were `POST /api/gm/party` and `POST /api/gm/resonance` — two stateless
 * Vercel functions that owned a model credential, a prompt, a lint and a
 * memo store. Two declared subagents own the prompt now
 * (`agent/subagents/party/`, `agent/subagents/resonance/`) and the model
 * credential with it, so what is left for the client is exactly the half that
 * was never the model's job:
 *
 *   1. the **routing** — which specialist owns this shape, and reading its
 *      answer off the parent stream (`sendDmTurn({ subagent })`). The SCHEMA
 *      itself is no longer here: it is declared on the subagent that answers,
 *      because a schema the root DM was asked for was a schema the root DM
 *      ignored (see "THE SHAPE IS NOT HERE ANY MORE" below);
 *   2. the **lint** — `contentLint.ts` + `powerLint.ts`, the same functions
 *      the endpoints ran server-side, now run in the browser before a single
 *      generated number reaches the engine;
 *   3. the **derivation** — `completeBaseStats` and `trimGrowthRow`. Sums are
 *      arithmetic, and arithmetic that matters is never the model's: `hp` is
 *      not even in the party schema, and a growth row over budget is trimmed
 *      rather than sent back;
 *   4. the **salvage and regenerate-on-invalid loop** that
 *      `api/_lib/generate.ts` used to own — powers over budget become stock
 *      powers in place, and only a kit-level failure spends one retry;
 *   5. the **budget stamp** — `normalizePower()`. A model never computes its
 *      own budget; whoever consumes the payload recomputes it. That used to be
 *      the endpoint and is now this module.
 *   6. the **art-style composition** — the DM returns a subject, the house
 *      style is appended here (`artPrompt.ts`).
 *
 * Offline-first is unchanged: every function returns `null` on ANY failure (no
 * DM configured, unreachable, timeout, malformed, failed lint) and the caller
 * falls back to authored content. With `VITE_DM_URL` unset nothing is even
 * requested.
 */
import type {
  GeneratedCatKit,
  InteractionRule,
  PowerScript,
} from "./gmTypes.js";
import { composeArtPrompt } from "./artPrompt.js";
import { lintParty } from "./contentLint.js";
import {
  BUDGET_CAPS,
  POWER_FRAMEWORK_VERSION,
  lintInteractionRule,
  lintPowerScript,
  normalizePower,
  resonancePairKey,
  STOCK_POWERS,
} from "./powerLint.js";
import { markDmUnreachable, probeDm, sendDmTurn } from "./dm.js";
import type { Stats } from "../core/types.js";
import { MAX_GROWTH_ROW_TOTAL, ROLE_STAT_TOTALS, STAT_BOUNDS } from "./caps.js";

export { resonancePairKey };

/**
 * PER TURN of party generation. A party is at most `1 + PARTY_RETRIES` turns,
 * so two of these is the worst case — and in measurement it is one.
 *
 * SIZED FROM THE TAIL, NOT FROM OPTIMISM. Four kits × four skills × a Power
 * Script is a lot of schema-constrained tokens and the forge takes as long as
 * it takes: twenty timed turns against the deployed subagent ran 41, 43, 45,
 * 65, 71, 71, 72, 72, 75, 75, 77, 77, 79, 79, 81, 82, 93, 95, 96, 105, 106 and
 * 116 seconds. 150s sits ~30% above the worst of those.
 *
 * It is a REDUCTION from the 180s this briefly needed, and the reduction was
 * bought rather than wished for: with `hp` and growth rows derived client-side
 * and powers salvaged in place, a party is one turn, so the budget only has to
 * cover one. What a player actually waits is the median — 65s.
 *
 * Do not tighten it to the median. At 120s, two of five end-to-end runs were
 * not slow answers but the offline path: the creator said "GM offline, using
 * the Strays" for a party the forge was still writing — the same class of bug
 * as the flat 8s budget `src/services/gm.ts` used to use.
 *
 * Overrunning this is still not a bug, it is the offline path: the creator
 * toasts and starts a normal run with the four canonical strays.
 */
export const DM_PARTY_TIMEOUT_MS = 150_000;

/** Compiling one resonance is a small ask, and nobody is waiting for it. */
export const DM_RESONANCE_TIMEOUT_MS = 25_000;

/* ------------------------------------------------------------------------ */
/* The one-shot queue                                                        */
/* ------------------------------------------------------------------------ */

/**
 * One-shots are SERIALISED but not CONVERSATIONAL.
 *
 * They used to share one durable eve session, so that a retry could be "the
 * next turn of the same conversation". That is no longer what a retry is: the
 * answer comes from a subagent, and a subagent starts every delegation with an
 * empty context, so there is no conversation to continue. What the shared
 * session did carry was the previous answer — a ~10 kB party arrives in the
 * ROOT's history as the delegation's tool result — and it made every subsequent
 * turn slower. Measured: first turns 78-106s, retries on the same session over
 * 120s, i.e. straight past the budget and into the offline path. Two of five
 * end-to-end runs failed that way and neither failure was the model's.
 *
 * So each one-shot turn opens a fresh session. The queue stays: it is what
 * keeps a battle that fans out twenty resonance pairs from opening twenty
 * requests at once.
 */
let queue: Promise<unknown> = Promise.resolve();

/** Test hook: drain the one-shot queue. */
export function resetOneshotSession(): void {
  queue = Promise.resolve();
}

/**
 * One one-shot turn, answered by a declared subagent.
 * `null` = the DM did not answer at all.
 *
 * NO `outputSchema` GOES OVER THE WIRE HERE, and that is the whole fix. Asking
 * the root DM for a schema loses to its own "you may only change the world
 * through your tools" — 0 of 5 measured, on two model tiers. The schema now
 * lives on the specialist (`agent/subagents/party`, `agent/subagents/resonance`
 * declare it in their `agent.ts`), the root's only job is to relay the brief it
 * is handed, and the answer is read off the parent stream as
 * `subagent.completed`. Passing a schema on top would just make the relay
 * re-type four cat kits it has no schema for.
 */
type Turn = (req: {
  message: string;
  /** The declared subagent that owns this shape. */
  subagent: string;
  timeoutMs: number;
}) => Promise<unknown>;

const turn: Turn = async ({ message, subagent, timeoutMs }) => {
  const res = await sendDmTurn(null, { message, subagent, timeoutMs });
  if (!res) {
    markDmUnreachable();
    return null;
  }
  return res.data;
};

/**
 * Run `job` after every earlier one-shot has finished. Failures never poison
 * the queue — the next job still runs.
 *
 * `job` gets the turn function rather than a single message because a party is
 * up to two turns: answer, lint, and if the lint found something a retry can
 * actually fix, brief the forge again (below).
 */
async function enqueue<T>(
  job: (send: Turn) => Promise<T | null>,
): Promise<T | null> {
  const run = (): Promise<T | null> => job(turn);
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/* ------------------------------------------------------------------------ */
/* Party — the shape                                                         */
/* ------------------------------------------------------------------------ */

/**
 * THE SHAPE IS NOT HERE ANY MORE, AND THAT IS THE POINT.
 *
 * This module used to carry a hand-written JSON Schema (`PARTY_SCHEMA`) and
 * send it with every turn, because `session.send({ outputSchema })` is how a
 * client asks the root DM for structured data. That never worked: the DM's own
 * instructions outrank a per-message schema, so the turn ended on a tool call
 * and eve failed it with OUTPUT_SCHEMA_NOT_FULFILLED — 0 of 5, on haiku and on
 * Sonnet 5 alike.
 *
 * The schema now lives on the agent that answers, `agent/subagents/party/
 * agent.ts`, as `partyOutputSchema` from `agent/lib/oneshot.ts` — a zod schema
 * with compile-time parity assertions against `src/core/types.ts` and
 * `src/services/gmTypes.ts`, which the duplicate here never had. One schema, on
 * the side that can be held to it.
 *
 * What stays on this side is the half that was never the model's job: the lint,
 * the retry, the salvage, and the budget stamp, all below.
 */

/* ------------------------------------------------------------------------ */
/* Party — lint, retry, salvage (was api/gm/party.ts + generateValidated)    */
/* ------------------------------------------------------------------------ */

/**
 * Every L1 cat starts with the same energy ceiling (`contentLint`: "enMax must
 * be exactly 10"). Derived, never authored.
 */
const START_EN_MAX = 10;

/**
 * Fill in the two stats the DM does not author: `hp` and `enMax`.
 *
 * `hp` is whatever makes the role's total come out EXACTLY right —
 * `ROLE_STAT_TOTALS[role] − (atk + def + spd + crt)`. The model picks the four
 * stats that say something about the cat; the sum is arithmetic, and arithmetic
 * that matters is the engine's job (docs/design/run-map-and-dm.md §3). Doing it
 * here rather than asking for it made "stat total 63 != 64" — the most common
 * lint failure across live generations, and a ~90s regeneration every time —
 * structurally impossible.
 *
 * If the four authored stats leave `hp` outside its own bound, points are moved
 * through the other four rather than through a ~80s regeneration — `crt` first
 * (the widest band and the least load-bearing at level 1), then `def`, `spd`
 * and finally `atk`, which is the last thing about a cat worth quietly
 * rewriting. Repairing through `crt` ALONE was not enough: measured, three of
 * six live parties landed a kit on `base.hp=23` — one point under the floor,
 * with `crt` already sitting on its own — and each of those cost the whole
 * party. Only when all four donors are exhausted is the kit left as-is for
 * `lintParty` to reject in the ordinary way.
 */
const HP_DONORS = ["crt", "def", "spd", "atk"] as const;

function completeBaseStats(kit: GeneratedCatKit): GeneratedCatKit {
  const authored = kit.base as Partial<Stats> | undefined;
  const total = ROLE_STAT_TOTALS[kit.role];
  if (!authored || total === undefined) return kit;
  const base: Record<(typeof HP_DONORS)[number], number> = {
    crt: authored.crt ?? 0,
    def: authored.def ?? 0,
    spd: authored.spd ?? 0,
    atk: authored.atk ?? 0,
  };
  const [hpMin, hpMax] = STAT_BOUNDS.hp;
  const hp = (): number => total - (base.crt + base.def + base.spd + base.atk);

  for (const stat of HP_DONORS) {
    const [lo, hi] = STAT_BOUNDS[stat];
    // hp too high ⇒ too little spent elsewhere ⇒ spend more (donor goes up)
    if (hp() > hpMax) base[stat] += Math.min(hp() - hpMax, hi - base[stat]);
    // hp too low ⇒ too much spent elsewhere ⇒ spend less (donor comes down)
    else if (hp() < hpMin)
      base[stat] -= Math.min(hpMin - hp(), base[stat] - lo);
    else break;
  }

  return {
    ...kit,
    base: { ...(authored as Stats), ...base, hp: hp(), enMax: START_EN_MAX },
  };
}

/**
 * Trim a growth row to the shipped `1..MAX_GROWTH_ROW_TOTAL` budget.
 *
 * Same principle as `hp`, one level down: WHICH stats a cat grows is character
 * and belongs to the DM; HOW MUCH it may grow per level is a budget and belongs
 * here. The schema bounds each entry but cannot bound their sum, and measured,
 * a live party came back with three rows totalling 7 against a cap of 6 — one
 * point over, three times, and it cost the whole party.
 *
 * Over-budget rows lose from their biggest entry first (the smaller ones are
 * what make the row read as a character); an empty row gets a point of hp so
 * the cat still levels.
 */
function trimGrowthRow(row: Record<string, number>): Record<string, number> {
  const out = { ...row };
  const keys = Object.keys(out);
  let sum = keys.reduce((n, k) => n + (out[k] ?? 0), 0);
  while (sum > MAX_GROWTH_ROW_TOTAL) {
    const biggest = keys.reduce((a, b) =>
      (out[b] ?? 0) > (out[a] ?? 0) ? b : a,
    );
    if ((out[biggest] ?? 0) <= 0) break;
    out[biggest] = (out[biggest] ?? 0) - 1;
    sum -= 1;
  }
  if (sum <= 0) out.hp = (out.hp ?? 0) + 1;
  return out;
}

/**
 * The four kits out of a raw payload, with everything derivable derived — or
 * undefined when the payload is not a party at all.
 *
 * Completion happens HERE, before the lint, so `lintParty` judges the numbers
 * the engine will actually receive rather than the ones the model typed.
 */
function readKits(raw: unknown): GeneratedCatKit[] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const root = raw as { kits?: unknown };
  if (!Array.isArray(root.kits)) return undefined;
  return (root.kits as GeneratedCatKit[]).map((kit) => {
    const complete = completeBaseStats(kit);
    return Array.isArray(complete.growth)
      ? {
          ...complete,
          growth: complete.growth.map((row) =>
            trimGrowthRow(row as Record<string, number>),
          ),
        }
      : complete;
  });
}

/** Stamp server-computed budgets and compose the house art style. */
function finishKits(kits: GeneratedCatKit[]): GeneratedCatKit[] {
  return kits.map((kit) => ({
    ...kit,
    power: normalizePower(kit.power),
    stand: {
      ...kit.stand,
      visualPrompt: composeArtPrompt("battleSprite", kit.stand.visualPrompt),
    },
  }));
}

/** A party lint: `value` present iff `errors` is empty. */
export interface PartyLint {
  value?: GeneratedCatKit[];
  errors: string[];
}

/**
 * Re-lint a generated party CLIENT-SIDE, exactly as `/api/gm/party` did
 * server-side: `lintParty` for the classes.md budgets, then `lintPowerScript`
 * for each Stand power at `BUDGET_CAPS.cat`. On a clean pass the budgets are
 * stamped and the art style composed.
 *
 * The errors are returned, not swallowed, because they are the retry prompt.
 */
export function lintPartyPayload(raw: unknown): PartyLint {
  const kits = readKits(raw);
  if (!kits) return { errors: ['root must be {"kits": [...]}'] };
  const errors = lintParty(kits);
  kits.forEach((kit, i) => {
    errors.push(
      ...lintPowerScript(
        kit.power,
        BUDGET_CAPS.cat,
        `kit ${i} (${kit.catName || "?"}) power '${String(kit.power?.id)}'`,
      ),
    );
  });
  return errors.length > 0 ? { errors } : { value: finishKits(kits), errors };
}

/**
 * Repair an answer whose KITS are legal and whose only failures are Stand
 * POWERS over budget: swap each offending power for the stock power of that
 * kit's role (stand-powers.md Layer 2, "Invalid → fallback to a stock power").
 * A kit-level failure is unsalvageable and returns undefined.
 *
 * WHEN THIS RUNS IS THE POINT. It used to be the last resort, reached only
 * after every retry was spent. But a power budget is a product of trigger
 * frequency, effect costs and condition discounts — arithmetic no model does in
 * its head, and the measured failure was not marginal (budget 25.2, 32, 27
 * against a cap of 12). Regenerating the whole party to fix it costs another
 * ~90s and lands on the same arithmetic, while the player watches a spinner.
 *
 * So `requestDmParty` reaches for this FIRST whenever the kits themselves came
 * back clean. The player keeps the four cats they described — names, Stands,
 * skills, stats, flavour, all of it — and the one thing they lose is a bespoke
 * Stand power, replaced by the role's stock power, which is exactly the
 * documented fallback. A retry is spent only on failures a retry can actually
 * fix.
 */
export function salvagePartyPowers(
  raw: unknown,
): GeneratedCatKit[] | undefined {
  const kits = readKits(raw);
  if (!kits) return undefined;
  if (lintParty(kits).length > 0) return undefined;
  return finishKits(
    kits.map((kit) =>
      lintPowerScript(kit.power, BUDGET_CAPS.cat).length === 0
        ? kit
        : { ...kit, power: STOCK_POWERS[kit.role] },
    ),
  );
}

/**
 * The subagent that owns the party shape, and the marker the root DM relays on.
 *
 * `agent/instructions.md` §"Briefs" says: a message opening with this line is
 * not the player talking — pass the WHOLE thing to `party` unchanged and add
 * nothing. Every party message below therefore starts with it.
 */
export const PARTY_SUBAGENT = "party";
const PARTY_BRIEF = "PARTY BRIEF — pass this whole message to `party`.";

function describedCats(descriptions: string[]): string {
  return descriptions.map((d, i) => `${i + 1}. ${d}`).join("\n");
}

function buildPartyMessage(descriptions: string[]): string {
  return [
    PARTY_BRIEF,
    "",
    "Build a party. Player-described cats (invent the rest yourself so all",
    "four roles are covered; keep player intent for the ones they described):",
    "",
    describedCats(descriptions),
  ].join("\n");
}

/**
 * How many regenerate-on-invalid turns a party gets.
 *
 * ONE, down from two, because a retry is now the LAST thing tried rather than
 * the reflex. The failures a retry used to exist for are gone at the source:
 * every bound a schema can express is on the answering subagent, `hp` is
 * derived instead of authored, and a power over budget is salvaged in place.
 * What is left for a retry is a kit-level failure — a duplicate skill id, a
 * skill-cost total — which is rare and which a fresh generation genuinely does
 * fix.
 *
 * It is also what the player is paying for. A party turn measures 78-106s
 * against the deployed forge; two retries meant a five-minute spinner for a
 * result that, measured, was no likelier to be legal than the first.
 */
export const PARTY_RETRIES = 1;

/** The identity of one kit — everything a retry must NOT change. */
function kitIdentity(kit: unknown, i: number): string {
  const k = (kit ?? {}) as Partial<GeneratedCatKit>;
  const stand = k.stand?.name ?? "?";
  return (
    `${i + 1}. role ${k.role ?? "?"} — ${k.catName ?? "?"}, ` +
    `the ${k.className ?? "?"} (${k.epithet ?? "?"}), Stand \u300c${stand}\u300d`
  );
}

/**
 * The regenerate-on-invalid brief.
 *
 * IT REPEATS THE WHOLE JOB, because the forge is a subagent and a subagent
 * "never sees the parent's history" (eve `subagents` §"The isolation
 * boundary"): every delegation starts from an empty context, so "fix what you
 * just wrote" would be addressed to somebody who never wrote anything. The
 * original descriptions come back, the identities the last attempt invented
 * come back so the player keeps the cats they were shown, and the violations
 * are stated as the thing to fix.
 *
 * Only the identities are carried over, never the whole rejected party: the
 * root DM has to relay this message verbatim, and a 10 kB JSON blob is not
 * something a relay copies reliably. Names are cheap to carry; numbers are
 * exactly what needs redoing anyway.
 */
function retryNote(
  descriptions: string[],
  previous: unknown,
  errors: string[],
): string {
  const kits = (previous as { kits?: unknown } | null)?.kits;
  const identities = Array.isArray(kits) ? kits.map(kitIdentity) : [];
  return [
    PARTY_BRIEF,
    "",
    "A previous attempt at this party violated these HARD mechanical",
    "constraints:",
    ...errors.slice(0, 12).map((e) => `- ${e}`),
    "",
    "Build the party AGAIN, complete, fixing every violation and introducing",
    "no new ones. The player-described cats were:",
    "",
    describedCats(descriptions),
    ...(identities.length > 0
      ? [
          "",
          "Keep these four cats exactly as they are — same roles, names,",
          "classes, epithets and Stands. Only the numbers were wrong:",
          "",
          ...identities,
        ]
      : []),
    "",
    "Before you answer, check each kit yourself:",
    "1. skill ids are camelCase and unique WITHIN the kit;",
    "2. exactly one cost-0 skill per kit, and the other three costs sum to 16",
    "   or less;",
    "3. each growth row's values sum to between 1 and 6;",
    "4. the Power Script is cheap enough: fewer effects, smaller numbers, or",
    "   a rarer trigger / a `chance` condition / `perBattle` charges.",
  ].join("\n");
}

/**
 * Generate 4 legal CatClass-shaped kits from 1–4 free-text cat descriptions.
 * Null on any failure — the caller falls back to the four default strays.
 */
export async function requestDmParty(
  descriptions: string[],
): Promise<GeneratedCatKit[] | null> {
  const clean = descriptions
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .slice(0, 4)
    .map((d) => d.slice(0, 500));
  if (clean.length === 0) return null;
  if (!(await probeDm())) return null;
  return enqueue(async (send) => {
    let raw = await send({
      message: buildPartyMessage(clean),
      subagent: PARTY_SUBAGENT,
      timeoutMs: DM_PARTY_TIMEOUT_MS,
    });
    for (let attempt = 0; ; attempt++) {
      if (raw === null) return null; // the DM stopped answering
      const lint = lintPartyPayload(raw);
      if (lint.value) return lint.value;
      // A party whose KITS are legal and whose only fault is a Stand power over
      // budget is a party, not a failure. Take it now with the stock power
      // rather than spending ~90s of the player's spinner regenerating four
      // cats to fix arithmetic the model cannot do either way.
      const salvaged = salvagePartyPowers(raw);
      if (salvaged || attempt >= PARTY_RETRIES) return salvaged ?? null;
      raw = await send({
        message: retryNote(clean, raw, lint.errors),
        subagent: PARTY_SUBAGENT,
        timeoutMs: DM_PARTY_TIMEOUT_MS,
      });
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Resonance (was api/gm/resonance.ts)                                       */
/* ------------------------------------------------------------------------ */

/**
 * The subagent that owns the resonance shape (`resonanceOutputSchema` in
 * `agent/lib/oneshot.ts`, declared on `agent/subagents/resonance/agent.ts`).
 */
export const RESONANCE_SUBAGENT = "resonance";

/**
 * A definitive verdict for one power pair. `rule: null` means "these two
 * powers do not resonate" — an answer, not a failure.
 */
export interface ResonanceVerdict {
  pairKey: string;
  rule: InteractionRule | null;
  flavor: string;
  announce: string;
}

/**
 * Re-lint a resonance verdict and stamp its envelope: `pairKey`, `version`
 * and the recomputed `budget` are the caller's to fill in, never the model's
 * (stand-powers.md Layer 3).
 */
export function readResonanceVerdict(
  raw: unknown,
  pairKey: string,
): ResonanceVerdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const root = raw as {
    hasResonance?: unknown;
    rule?: unknown;
    flavor?: unknown;
    announce?: unknown;
  };
  if (typeof root.flavor !== "string" || root.flavor.length > 200) return null;
  if (typeof root.announce !== "string" || root.announce.length > 200) {
    return null;
  }
  if (root.hasResonance !== true || root.rule === null) {
    // no resonance — a valid, cacheable verdict
    return { pairKey, rule: null, flavor: root.flavor, announce: "" };
  }
  const body = root.rule as Pick<
    InteractionRule,
    "trigger" | "conditions" | "effects"
  >;
  if (lintInteractionRule(body).length > 0) return null;
  if (!root.flavor.trim()) return null;
  if (!root.announce.trim().startsWith("STAND RESONANCE DISCOVERED:")) {
    return null;
  }
  const rule: InteractionRule = {
    pairKey,
    version: POWER_FRAMEWORK_VERSION,
    trigger: body.trigger,
    conditions: body.conditions,
    effects: body.effects,
    flavor: root.flavor,
    announce: root.announce,
    budget: normalizePower({
      id: "power:resonanceCandidate",
      version: POWER_FRAMEWORK_VERSION,
      name: "RESONANCE",
      flavor: root.flavor,
      trigger: body.trigger,
      conditions: body.conditions,
      effects: body.effects,
    }).budget,
  };
  return { pairKey, rule, flavor: root.flavor, announce: root.announce };
}

function buildResonanceMessage(
  pairKey: string,
  powers: [PowerScript, PowerScript],
): string {
  return [
    "RESONANCE BRIEF — pass this whole message to `resonance`.",
    "",
    "Judge this Stand power pair for resonance.",
    `Pair key: ${pairKey}`,
    `Power A: ${JSON.stringify(powers[0])}`,
    `Power B: ${JSON.stringify(powers[1])}`,
  ].join("\n");
}

/**
 * Compile (or refuse) the resonance of one power pair. Null is a TRANSPORT
 * failure; a returned verdict with `rule: null` is a definitive "no".
 */
export async function requestDmResonance(
  pairKey: string,
  powers: [PowerScript, PowerScript],
): Promise<ResonanceVerdict | null> {
  return enqueue(async (send) => {
    const data = await send({
      message: buildResonanceMessage(pairKey, powers),
      subagent: RESONANCE_SUBAGENT,
      timeoutMs: DM_RESONANCE_TIMEOUT_MS,
    });
    return data === null ? null : readResonanceVerdict(data, pairKey);
  });
}

/* ------------------------------------------------------------------------ */
/* Resonance cache (session-scoped, fire-and-forget)                         */
/* ------------------------------------------------------------------------ */

/**
 * Definitive verdicts by pairKey (a stored `rule: null` is a definitive "no
 * resonance"), for the life of this browser session.
 *
 * NOTE: `/api/gm/resonance` backed this with a keyed pool row so a verdict was
 * memoized ACROSS players, forever (stand-powers.md Layer 3). The agent has no
 * such store — DM-DEPLOY.md is explicit that memoisation belongs to the caller,
 * and a browser cannot own a shared one. See docs/DM-DEPLOY.md "What the agent
 * does not cover".
 */
const resonanceVerdicts = new Map<string, ResonanceVerdict>();
const resonanceInFlight = new Set<string>();

/**
 * The cached verdict for a pair, or undefined when it has not been fetched
 * (yet). Battle setup attaches `rule` when present; a `rule: null` verdict
 * means the pair definitively does not resonate.
 */
export function getCachedResonance(
  pairKey: string,
): ResonanceVerdict | undefined {
  return resonanceVerdicts.get(pairKey);
}

/**
 * Fire-and-forget resonance compilation for a power pair. Never awaited by
 * battle setup (zero latency added); a failure simply clears the in-flight
 * mark so the NEXT battle retries. The compiled rule applies from the next
 * battle featuring the pair (stand-powers.md L3).
 *
 * Gated on the reachability probe, like every other DM call: with no DM this
 * costs zero requests and the battle runs on base rules.
 */
export function prefetchResonance(a: PowerScript, b: PowerScript): void {
  const pairKey = resonancePairKey(a.id, b.id, a.version);
  if (resonanceVerdicts.has(pairKey) || resonanceInFlight.has(pairKey)) return;
  resonanceInFlight.add(pairKey);
  void probeDm()
    .then(async (up) => {
      if (!up) return;
      const res = await requestDmResonance(pairKey, [a, b]);
      if (res) resonanceVerdicts.set(pairKey, res);
    })
    .finally(() => {
      resonanceInFlight.delete(pairKey);
    });
}

/** Test hook: drop every cached verdict and in-flight mark. */
export function resetResonanceCache(): void {
  resonanceVerdicts.clear();
  resonanceInFlight.clear();
}
