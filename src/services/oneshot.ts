/**
 * The one-shot DM capabilities: party generation and Stand resonance.
 *
 * These were `POST /api/gm/party` and `POST /api/gm/resonance` — two stateless
 * Vercel functions that owned a model credential, a prompt, a lint and a
 * memo store. The agent owns the prompt now (`agent/skills/party.ts`,
 * `agent/skills/resonance.ts`) and the model credential with it, so what is
 * left for the client is exactly the half that was never the model's job:
 *
 *   1. the **output schema** the answer must satisfy
 *      (`session.send({ outputSchema })`, DM-DEPLOY.md "Structured calls");
 *   2. the **lint** — `contentLint.ts` + `powerLint.ts`, the same functions
 *      the endpoints ran server-side, now run in the browser before a single
 *      generated number reaches the engine;
 *   3. the **regenerate-on-invalid loop** that `api/_lib/generate.ts` used to
 *      own. Nothing in the agent checks its own arithmetic, so a failed lint
 *      is handed back as the next turn of the same session, up to
 *      `PARTY_RETRIES` times, and only then salvaged;
 *   4. the **budget stamp** — `normalizePower()`. A model never computes its
 *      own budget; whoever consumes the payload recomputes it. That used to be
 *      the endpoint and is now this module.
 *   5. the **art-style composition** — the DM returns a subject, the house
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
  INTERACTION_RULE_SCHEMA,
  POWER_FRAMEWORK_VERSION,
  POWER_SCHEMA,
  lintInteractionRule,
  lintPowerScript,
  normalizePower,
  resonancePairKey,
  STOCK_POWERS,
} from "./powerLint.js";
import { markDmUnreachable, probeDm, sendDmTurn } from "./dm.js";
import type { DmSessionHandle } from "./tabletop.js";

export { resonancePairKey };

/**
 * PER TURN of party generation — and a party is up to `1 + PARTY_RETRIES`
 * turns, so the worst case is three times this.
 *
 * It is deliberately enormous next to `DM_TURN_TIMEOUT_MS`. Four kits × four
 * skills × a Power Script is a lot of schema-constrained tokens: measured
 * against the deployed haiku agent, ONE turn came in at 39s, 60s, 68s and once
 * over 90s. `src/services/gm.ts` used a flat 8s for every call, which the old
 * `/api/gm/party` (Sonnet, `maxDuration: 60`) cannot ever have beaten — the
 * creator's "GM offline, using the Strays" path was doing double duty as its
 * timeout path, silently.
 *
 * Overrunning this is not a bug, it is the offline path: the creator toasts and
 * starts a normal run with the four canonical strays.
 */
export const DM_PARTY_TIMEOUT_MS = 120_000;

/** Compiling one resonance is a small ask, and nobody is waiting for it. */
export const DM_RESONANCE_TIMEOUT_MS = 25_000;

/* ------------------------------------------------------------------------ */
/* The one-shot session                                                      */
/* ------------------------------------------------------------------------ */

/**
 * One eve session for every one-shot in this browser session.
 *
 * A run's conversational session lives on the run (`run.dm`); these calls
 * happen either BEFORE a run exists (party generation, from the creator) or
 * beside one, dozens at a time (resonance, once per cross-side power pair at
 * battle setup). Opening a session per call would strand a durable session per
 * pair, so they share one and are SERIALISED through it: eve advances a
 * session a turn at a time, and the queue doubles as the rate limit on a
 * battle that fans out twenty pairs at once.
 */
let oneshotSession: DmSessionHandle | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Test hook: forget the shared one-shot session. */
export function resetOneshotSession(): void {
  oneshotSession = null;
  queue = Promise.resolve();
}

/** One turn on the shared session. `null` = the DM did not answer. */
type Turn = (
  message: string,
  outputSchema: Record<string, unknown>,
  timeoutMs: number,
) => Promise<unknown>;

const turn: Turn = async (message, outputSchema, timeoutMs) => {
  const res = await sendDmTurn(oneshotSession, {
    message,
    outputSchema,
    timeoutMs,
  });
  if (!res) {
    markDmUnreachable();
    return null;
  }
  oneshotSession = res.session;
  return res.data;
};

/**
 * Run `job` after every earlier one-shot has finished, on the shared session.
 * Failures never poison the queue — the next job still runs.
 *
 * `job` gets the turn function rather than a single message because party
 * generation is a CONVERSATION: answer, lint, and if the lint failed, hand the
 * violations back on the same session and let it fix them (below).
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
/* Party — the shape (was api/gm/party.ts PARTY_SCHEMA)                      */
/* ------------------------------------------------------------------------ */

const STATS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hp", "atk", "def", "spd", "crt", "enMax"],
  properties: {
    hp: { type: "integer" },
    atk: { type: "integer" },
    def: { type: "integer" },
    spd: { type: "integer" },
    crt: { type: "integer" },
    enMax: { type: "integer" },
  },
};

const GROWTH_ROW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    hp: { type: "integer" },
    atk: { type: "integer" },
    def: { type: "integer" },
    spd: { type: "integer" },
    crt: { type: "integer" },
  },
};

const STATUS_ENUM = [
  "scratched",
  "frazzled",
  "offBalance",
  "guarded",
  "provoked",
  "mending",
];

const SKILL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "desc",
    "cost",
    "usableFrom",
    "target",
    "power",
    "kind",
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    desc: { type: "string" },
    cost: { type: "integer" },
    usableFrom: { type: "array", items: { type: "integer" } },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["side", "ranks", "pattern"],
      properties: {
        side: { enum: ["enemy", "ally", "self"] },
        ranks: { type: "array", items: { type: "integer" } },
        pattern: { enum: ["single", "row"] },
      },
    },
    power: { type: "integer" },
    kind: { enum: ["damage", "heal", "utility"] },
    moveTarget: { type: "integer" },
    moveSelf: { type: "integer" },
    applies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["status", "chance"],
        properties: {
          status: { enum: STATUS_ENUM },
          chance: { type: "number" },
          value: { type: "integer" },
          to: { enum: ["target", "self", "allEnemies"] },
        },
      },
    },
    cleanses: { type: "array", items: { enum: STATUS_ENUM } },
    revivePct: { type: "number" },
    oncePerBattle: { type: "boolean" },
    energyGain: { type: "integer" },
  },
};

const KIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "role",
    "catName",
    "className",
    "epithet",
    "base",
    "growth",
    "skills",
    "trait",
    "stand",
    "power",
    "flavor",
  ],
  properties: {
    role: { enum: ["tank", "striker", "control", "support"] },
    catName: { type: "string" },
    className: { type: "string" },
    epithet: { type: "string" },
    base: STATS_SCHEMA,
    growth: { type: "array", items: GROWTH_ROW_SCHEMA },
    skills: { type: "array", items: SKILL_SCHEMA },
    trait: {
      type: "object",
      additionalProperties: false,
      required: ["name", "desc"],
      properties: { name: { type: "string" }, desc: { type: "string" } },
    },
    stand: {
      type: "object",
      additionalProperties: false,
      required: ["name", "visualPrompt"],
      properties: {
        name: { type: "string" },
        visualPrompt: { type: "string" },
      },
    },
    power: POWER_SCHEMA,
    flavor: {
      type: "object",
      additionalProperties: false,
      required: ["bio", "barks"],
      properties: {
        bio: { type: "string" },
        barks: {
          type: "object",
          additionalProperties: false,
          required: ["crit", "ko", "catPile"],
          properties: {
            crit: { type: "string" },
            ko: { type: "string" },
            catPile: { type: "string" },
          },
        },
      },
    },
  },
};

/** Mirrors `partyOutputSchema` in `agent/lib/oneshot.ts`. */
export const PARTY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["kits"],
  properties: { kits: { type: "array", items: KIT_SCHEMA } },
};

/* ------------------------------------------------------------------------ */
/* Party — lint, retry, salvage (was api/gm/party.ts + generateValidated)    */
/* ------------------------------------------------------------------------ */

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
  if (typeof raw !== "object" || raw === null) {
    return { errors: ['root must be {"kits": [...]}'] };
  }
  const root = raw as { kits?: unknown };
  if (!Array.isArray(root.kits)) {
    return { errors: ['root must be {"kits": [...]}'] };
  }
  const kits = root.kits as GeneratedCatKit[];
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
 * Last-resort repair for the SECOND invalid answer (stand-powers.md Layer 2:
 * "Invalid → one regenerate → fallback to a stock power"): when the kits
 * themselves are legal and only the powers failed the budget, swap each failing
 * power for the stock power of the kit's role instead of losing the party the
 * player just described. A KIT-level failure is unsalvageable.
 */
export function salvagePartyPowers(
  raw: unknown,
): GeneratedCatKit[] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const root = raw as { kits?: unknown };
  if (!Array.isArray(root.kits)) return undefined;
  const kits = root.kits as GeneratedCatKit[];
  if (lintParty(kits).length > 0) return undefined;
  return finishKits(
    kits.map((kit) =>
      lintPowerScript(kit.power, BUDGET_CAPS.cat).length === 0
        ? kit
        : { ...kit, power: STOCK_POWERS[kit.role] },
    ),
  );
}

function buildPartyMessage(descriptions: string[]): string {
  const lines = descriptions.map((d, i) => `${i + 1}. ${d}`).join("\n");
  return [
    "Build a party. Player-described cats (invent the rest yourself so all",
    "four roles are covered; keep player intent for the ones they described):",
    "",
    lines,
    "",
    "Answer the party output schema and nothing else.",
  ].join("\n");
}

/**
 * How many regenerate-on-invalid turns a party gets before the salvage.
 *
 * `/api/gm/party` allowed exactly one, because each was a fresh, stateless
 * generation on a Sonnet-class model. Here every retry is the NEXT TURN of a
 * conversation with a haiku-class DM that can see its own answer and the exact
 * arithmetic it got wrong, which is both cheaper and a different failure mode:
 * the first answer is usually near-legal, and what it misses is a sum.
 */
export const PARTY_RETRIES = 2;

/**
 * The regenerate-on-invalid turn — the piece of `api/_lib/generate.ts` the
 * agent has no equivalent for. `agent/skills/party.ts` states the budgets, but
 * nothing makes the DM check its own arithmetic (only the `encounter` subagent
 * has a self-correcting tool). Measured against the deployed agent, a first
 * party answer routinely busts a per-stat bound or prices a power over
 * `BUDGET_CAPS.cat`; WITHOUT these turns, party generation is worse than the
 * endpoint it replaced.
 */
function retryNote(errors: string[]): string {
  return [
    "That party violates these HARD mechanical constraints:",
    ...errors.slice(0, 12).map((e) => `- ${e}`),
    "",
    "Answer the party output schema again with the COMPLETE party, fixing",
    "every violation and INTRODUCING NO NEW ONES. Keep the cats, the names,",
    "the Stands and the flavour you already wrote — change only numbers.",
    "",
    "Before you answer, check each kit yourself:",
    "1. add up hp+atk+def+spd+crt and compare it to the total its role",
    "   requires — it must be EXACTLY equal, not close;",
    "2. every stat inside its own bound (hp 24..40, atk 9..12, def 0..3,",
    "   spd 4..8, crt 5..15), and enMax exactly 10;",
    "3. any skill whose target pattern is `row` has power <= 60;",
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
    let raw = await send(
      buildPartyMessage(clean),
      PARTY_SCHEMA,
      DM_PARTY_TIMEOUT_MS,
    );
    for (let attempt = 0; ; attempt++) {
      if (raw === null) return null; // the DM stopped answering
      const lint = lintPartyPayload(raw);
      if (lint.value) return lint.value;
      if (attempt >= PARTY_RETRIES) {
        // out of turns: keep the party if only its POWERS are illegal
        return salvagePartyPowers(raw) ?? null;
      }
      raw = await send(
        retryNote(lint.errors),
        PARTY_SCHEMA,
        DM_PARTY_TIMEOUT_MS,
      );
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Resonance (was api/gm/resonance.ts)                                       */
/* ------------------------------------------------------------------------ */

/** Mirrors `resonanceOutputSchema` in `agent/lib/oneshot.ts`. */
export const RESONANCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["hasResonance", "rule", "flavor", "announce"],
  properties: {
    hasResonance: { type: "boolean" },
    /** null when the pair does not resonate (the common case). */
    rule: { anyOf: [INTERACTION_RULE_SCHEMA, { type: "null" }] },
    flavor: { type: "string" },
    announce: { type: "string" },
  },
};

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
    "Judge this Stand power pair for resonance.",
    `Pair key: ${pairKey}`,
    `Power A: ${JSON.stringify(powers[0])}`,
    `Power B: ${JSON.stringify(powers[1])}`,
    "Answer the resonance output schema and nothing else.",
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
    const data = await send(
      buildResonanceMessage(pairKey, powers),
      RESONANCE_SCHEMA,
      DM_RESONANCE_TIMEOUT_MS,
    );
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
