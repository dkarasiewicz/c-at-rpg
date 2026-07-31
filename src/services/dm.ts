/**
 * DM service client — the browser half of the persistent Dungeon Master
 * (docs/design/run-map-and-dm.md §4, docs/DM-DEPLOY.md "HTTP surface").
 *
 * The DM is a Vercel **eve** agent with ONE DURABLE SESSION PER RUN, so it
 * remembers the whole adventure. This module speaks its HTTP protocol
 * directly with `fetch` — `eve/client` is a server-and-tooling SDK and the
 * game is not going to ship it (or zod) into the browser bundle for four
 * routes:
 *
 *   POST /eve/v1/session                 { message, outputSchema? }
 *                                        → { sessionId, continuationToken }
 *   POST /eve/v1/session/:id             { message, continuationToken, … }
 *   GET  /eve/v1/session/:id/stream      NDJSON, one event per line
 *   GET  /eve/v1/health                  liveness (no model call)
 *
 * Contract with callers — identical in spirit to `gm.ts`, which this sits
 * BESIDE and never replaces:
 *
 *  - every function returns `null` on ANY failure (no DM configured, network,
 *    timeout, non-2xx, malformed body, schema-less result), so a caller can
 *    always fall back to authored content;
 *  - one hard timeout per turn, one for the probe; nothing is unbounded;
 *  - OFFLINE-FIRST IS A HARD RULE. `probeDm()` runs at most once per session
 *    and its answer is cached; when it is false the typed-action UI is not
 *    built at all and the game plays exactly as it does today. With
 *    `VITE_DM_URL` unset the probe short-circuits to false WITHOUT a request.
 *  - responses are NEVER trusted: the verdicts come back as `unknown` and the
 *    caller re-lints them through `services/tabletop.ts` before the engine
 *    sees a single number.
 */
import type { EffectSpec } from "../core/combat/powerTypes.js";
import { EFFECT_CAPS } from "../core/combat/powers.js";
import type { BattleState, Combatant, RunState } from "../core/types.js";
import { CLASSES } from "../content/classes.js";
import {
  MAX_ENERGY_COST,
  MAX_NARRATION,
  MAX_PROMPT,
  floorDamageCap,
  floorHealCap,
  type DmSessionHandle,
  type TabletopRun,
} from "./tabletop.js";

/** One turn of the DM, including a subagent delegation. */
export const DM_TURN_TIMEOUT_MS = 20_000;
/** The liveness probe. Short: a slow DM is an absent DM. */
export const DM_PROBE_TIMEOUT_MS = 3_000;

/**
 * Where the agent lives. It is a SEPARATE Vercel project from the game
 * (DM-DEPLOY.md "The Vercel-project conflict"), so this is an absolute
 * origin, not a path. Unset ⇒ no DM, no requests, no typed-action UI.
 */
let baseUrl: string =
  (import.meta.env?.VITE_DM_URL as string | undefined) ?? "";

/** Point the client at a DM deployment (tests, previews, local `eve dev`). */
export function setDmBaseUrl(url: string): void {
  baseUrl = url.replace(/\/$/, "");
  probeResult = null; // a new base invalidates the reachability verdict
}

export function dmBaseUrl(): string {
  return baseUrl;
}

/* ------------------------------------------------------------------------ */
/* Reachability — probed once per session, cached                            */
/* ------------------------------------------------------------------------ */

let probeResult: Promise<boolean> | null = null;
let reachable = false;

/**
 * Is a DM reachable? `GET /eve/v1/health` — a liveness route that makes no
 * model call. Any non-2xx, non-JSON body, or timeout means "no DM", which is
 * indistinguishable (by design) from the player choosing not to use one.
 */
export function probeDm(): Promise<boolean> {
  probeResult ??= (async () => {
    if (baseUrl === "") return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DM_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/eve/v1/health`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!res.ok) return false;
      const isJson =
        res.headers.get("content-type")?.includes("application/json") ?? false;
      if (!isJson) return false;
      await res.json();
      reachable = true;
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();
  return probeResult;
}

/**
 * Synchronous "is the DM believed up?" — false until the probe has resolved
 * true, and false again the moment a turn fails. UI built on this hides the
 * typed-action affordance rather than showing a broken one.
 */
export function isDmAvailable(): boolean {
  return reachable;
}

/**
 * Give up on the DM for the rest of the session (a turn timed out, a session
 * 404'd, the deployment vanished mid-run). The affordance disappears; the
 * encounter carries on with authored content.
 */
export function markDmUnreachable(): void {
  reachable = false;
  probeResult = Promise.resolve(false);
}

/** Test hook: forget the cached probe verdict. */
export function resetDmProbe(): void {
  probeResult = null;
  reachable = false;
}

/* ------------------------------------------------------------------------ */
/* The eve wire protocol                                                     */
/* ------------------------------------------------------------------------ */

interface EveEvent {
  type: string;
  data?: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** eve's turn boundary (`isCurrentTurnBoundaryEvent` in the runtime). */
const isBoundary = (type: string): boolean =>
  type === "session.waiting" ||
  type === "session.completed" ||
  type === "session.failed";

/**
 * Read an NDJSON body line by line. Falls back to buffering the whole body
 * when the environment has no streaming reader (jsdom, some test doubles) —
 * the result is identical, only the deltas arrive all at once.
 */
async function* ndjson(res: Response): AsyncGenerator<EveEvent> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    for (const line of (await res.text()).split("\n")) {
      const ev = parseEvent(line);
      if (ev) yield ev;
    }
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const ev = parseEvent(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (ev) yield ev;
      nl = buffer.indexOf("\n");
    }
  }
  const tail = parseEvent(buffer);
  if (tail) yield tail;
}

function parseEvent(line: string): EveEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
    return {
      type: parsed.type,
      data: isRecord(parsed.data) ? parsed.data : {},
    };
  } catch {
    return null;
  }
}

export interface DmTurn {
  /** What the DM is told. The whole snapshot goes here — a declared subagent
   *  inherits nothing, so context cannot be implied. */
  message: string;
  /** JSON Schema for the structured result (`result.completed`). */
  outputSchema?: unknown;
  /** Streamed assistant text, delta by delta. */
  onDelta?: (delta: string, soFar: string) => void;
  timeoutMs?: number;
}

export interface DmTurnResult {
  /** The structured payload, UNVALIDATED — the caller re-lints it. */
  data: unknown;
  /** The assistant's plain text for the turn (may be empty). */
  text: string;
  /** The advanced session handle; persist it on the run. */
  session: DmSessionHandle;
}

/**
 * Send one turn to the run's session and read its stream to the turn
 * boundary. `session === null` starts a new durable session.
 *
 * Returns null on ANY failure. A failure also marks the DM unreachable: mid-
 * run the affordance disappears rather than offering a button that hangs.
 */
export async function sendDmTurn(
  session: DmSessionHandle | null,
  turn: DmTurn,
): Promise<DmTurnResult | null> {
  if (baseUrl === "") return null;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    turn.timeoutMs ?? DM_TURN_TIMEOUT_MS,
  );
  try {
    const body: Record<string, unknown> = { message: turn.message };
    if (turn.outputSchema !== undefined) body.outputSchema = turn.outputSchema;
    if (session?.continuationToken !== undefined) {
      body.continuationToken = session.continuationToken;
    }
    const url =
      session === null
        ? `${baseUrl}/eve/v1/session`
        : `${baseUrl}/eve/v1/session/${encodeURIComponent(session.sessionId)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const posted: unknown = await res.json();
    if (!isRecord(posted)) return null;
    const sessionId =
      typeof posted.sessionId === "string"
        ? posted.sessionId
        : (session?.sessionId ?? "");
    if (sessionId === "") return null;

    const next: DmSessionHandle = {
      sessionId,
      streamIndex: session?.sessionId === sessionId ? session.streamIndex : 0,
    };
    if (typeof posted.continuationToken === "string") {
      next.continuationToken = posted.continuationToken;
    }

    // ---- read the turn off the durable stream --------------------------
    const streamUrl =
      `${baseUrl}/eve/v1/session/${encodeURIComponent(sessionId)}/stream` +
      `?startIndex=${next.streamIndex}`;
    const stream = await fetch(streamUrl, {
      method: "GET",
      signal: controller.signal,
    });
    if (!stream.ok) return null;

    let data: unknown = undefined;
    let text = "";
    let read = 0;
    for await (const ev of ndjson(stream)) {
      read += 1;
      const d = ev.data ?? {};
      switch (ev.type) {
        case "message.appended": {
          const delta =
            typeof d.messageDelta === "string" ? d.messageDelta : "";
          const soFar =
            typeof d.messageSoFar === "string" ? d.messageSoFar : text + delta;
          text = soFar;
          if (delta.length > 0) turn.onDelta?.(delta, soFar);
          break;
        }
        case "message.completed":
          if (typeof d.message === "string") text = d.message;
          break;
        case "result.completed":
          // the LAST result wins (eve: "result() returns the most recent")
          data = d.result;
          break;
        case "session.waiting":
          if (typeof d.continuationToken === "string") {
            next.continuationToken = d.continuationToken;
          }
          break;
        default:
          break;
      }
      if (isBoundary(ev.type)) break;
    }
    next.streamIndex += read;
    return { data, text, session: next };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------ */
/* Sessions: one per run                                                     */
/* ------------------------------------------------------------------------ */

const partyLine = (run: RunState): string =>
  run.cats
    .filter((c) => c.lives > 0)
    .map((c) => {
      const cls = CLASSES[c.classId];
      return `${cls.catName} the ${cls.className} (${c.lives} lives)`;
    })
    .join(", ");

/**
 * The opening beat of a run: who the party is, where they are, what the DM's
 * job is. Sent once, when the session is created.
 */
export function runIntro(run: RunState): string {
  return [
    `A new run begins. Seed ${run.runSeed}, floor ${run.floorNum} of 6.`,
    `The clowder: ${partyLine(run)}.`,
    "You are their Dungeon Master for the whole run. Remember what they do;",
    "call back to it later. When they type an action in a fight, delegate to",
    "the `encounter` subagent and return its verdict verbatim.",
  ].join(" ");
}

/**
 * The run's durable session, started on first use and then reused forever.
 *
 * Ideally this is called once at RUN START; calling it lazily is equivalent
 * and keeps scene ownership clean — either way the handle is written onto the
 * run, rides the ordinary autosave, and a reload rejoins the SAME session
 * with the same memory instead of starting a fresh DM.
 *
 * Returns the handle and (when it changed) the run to store back.
 */
export async function ensureDmSession(
  run: TabletopRun,
): Promise<{ session: DmSessionHandle; run: TabletopRun } | null> {
  if (run.dm?.sessionId) return { session: run.dm, run };
  const started = await sendDmTurn(null, {
    message: runIntro(run),
    timeoutMs: DM_TURN_TIMEOUT_MS,
  });
  if (!started) {
    markDmUnreachable();
    return null;
  }
  return { session: started.session, run: { ...run, dm: started.session } };
}

/* ------------------------------------------------------------------------ */
/* Output schemas (raw JSON Schema — eve rehydrates them server-side)        */
/* ------------------------------------------------------------------------ */

const nullableString = (max: number): Record<string, unknown> => ({
  anyOf: [{ type: "string", maxLength: max }, { type: "null" }],
});

const targetSel = {
  type: "string",
  enum: ["self", "other", "allies", "enemies"],
  description: "who it lands on; `other` is the named target",
};

const statusId = {
  type: "string",
  enum: [
    "scratched",
    "frazzled",
    "offBalance",
    "guarded",
    "provoked",
    "mending",
  ],
};

/**
 * The engine's `EffectSpec` union as JSON Schema, with THIS FLOOR'S ceilings
 * baked into the damage/heal bounds — the model is shown the tightest legal
 * numbers rather than being corrected afterwards. The client re-checks all of
 * it anyway (`validateCombatVerdict`).
 */
function effectSpecJsonSchema(floor: number): Record<string, unknown> {
  const member = (
    kind: EffectSpec["kind"],
    extra: Record<string, unknown>,
  ): Record<string, unknown> => ({
    type: "object",
    properties: {
      kind: { type: "string", const: kind },
      target: targetSel,
      ...extra,
    },
    required: [
      "kind",
      "target",
      ...Object.keys(extra).filter((k) => k !== "value"),
    ],
  });
  return {
    anyOf: [
      member("damage", {
        pct: { type: "integer", minimum: 1, maximum: floorDamageCap(floor) },
      }),
      member("heal", {
        pct: { type: "integer", minimum: 1, maximum: floorHealCap(floor) },
      }),
      member("status", {
        status: statusId,
        value: {
          type: "integer",
          minimum: 0,
          maximum: EFFECT_CAPS.statusValue,
        },
      }),
      member("move", {
        delta: {
          type: "integer",
          minimum: -EFFECT_CAPS.moveDelta,
          maximum: EFFECT_CAPS.moveDelta,
        },
      }),
      member("energy", {
        amount: {
          type: "integer",
          minimum: -EFFECT_CAPS.energyAbs,
          maximum: EFFECT_CAPS.energyAbs,
        },
      }),
      member("cleanse", { status: statusId }),
    ],
  };
}

/** Mirrors `agent/subagents/encounter/lib/verdict.ts`. */
export function combatVerdictSchema(floor: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      allowed: {
        type: "boolean",
        description:
          "false = it does not happen (impossible, out of fiction, or a " +
          "cheat). effects must then be empty and energyCost 0. Saying no " +
          "in character is a legitimate answer.",
      },
      narration: {
        type: "string",
        minLength: 1,
        maxLength: MAX_NARRATION,
        description: "1-2 sentences in the DM voice describing what happens.",
      },
      effects: {
        type: "array",
        maxItems: 3,
        items: effectSpecJsonSchema(floor),
        description: "0-3 effects from the engine's closed menu, in order.",
      },
      energyCost: {
        type: "integer",
        minimum: 0,
        maximum: MAX_ENERGY_COST,
        description: "energy the actor spends, priced like a skill.",
      },
      target: {
        ...nullableString(64),
        description: "combatant id the `other` selector resolves to, or null.",
      },
    },
    required: ["allowed", "narration", "effects", "energyCost", "target"],
  };
}

const scalar = {
  anyOf: [
    { type: "integer" },
    {
      type: "object",
      properties: {
        base: { type: "integer" },
        perFloor: { type: "integer" },
      },
      required: ["base", "perFloor"],
    },
  ],
};

const eventTargetSel = {
  type: "string",
  enum: ["party", "random", "lowestHp", "lowestLives", "gateCat"],
};

/**
 * The out-of-combat vocabulary: the events `Effect` union, minus `fight`
 * (the run map authors encounters, not the DM — run-map-and-dm.md §2).
 */
export function encounterVerdictSchema(): Record<string, unknown> {
  const member = (
    kind: string,
    props: Record<string, unknown>,
    required: string[] = Object.keys(props),
  ): Record<string, unknown> => ({
    type: "object",
    properties: { kind: { type: "string", const: kind }, ...props },
    required: ["kind", ...required],
  });
  return {
    type: "object",
    properties: {
      allowed: { type: "boolean" },
      narration: { type: "string", minLength: 1, maxLength: MAX_NARRATION },
      effects: {
        type: "array",
        maxItems: 3,
        items: {
          anyOf: [
            member("heal", { target: eventTargetSel, amount: scalar }),
            member("damage", { target: eventTargetSel, amount: scalar }),
            member("shinies", { amount: scalar }),
            member("buff", {
              target: eventTargetSel,
              stat: {
                type: "string",
                enum: ["atk", "def", "spd", "crt", "hpMax"],
              },
              amount: { type: "integer" },
              duration: { type: "string", enum: ["floor", "run"] },
            }),
            member(
              "giveItem",
              { item: { type: "string" }, count: { type: "integer" } },
              ["item"],
            ),
            member(
              "takeItem",
              { item: { type: "string" }, count: { type: "integer" } },
              ["item"],
            ),
            member("restoreLife", {
              target: { type: "string", const: "lowestLives" },
              amount: { type: "integer" },
            }),
            member("energyNextBattle", {
              target: eventTargetSel,
              amount: { type: "integer" },
            }),
            member("nothing", {}),
          ],
        },
      },
    },
    required: ["allowed", "narration", "effects"],
  };
}

/* ------------------------------------------------------------------------ */
/* The two calls the scenes make                                             */
/* ------------------------------------------------------------------------ */

const statusText = (c: Combatant): string =>
  c.statuses.length === 0
    ? "-"
    : c.statuses
        .map((s) => `${s.id}${s.value ? `(${s.value})` : ""}`)
        .join("+");

/**
 * The whole battle, in text. A declared subagent starts with a fresh context
 * and shares no state with the parent (eve subagents "isolation boundary"),
 * so everything it needs to adjudicate has to be in the message.
 */
export function battleSnapshot(
  state: BattleState,
  actorId: string,
  floor: number,
): string {
  const line = (c: Combatant): string =>
    `  ${c.id} "${c.name}" rank ${c.rank} hp ${c.hp}/${c.stats.hp}` +
    (c.side === "cat" ? ` energy ${c.energy}/${c.stats.enMax}` : "") +
    ` statuses ${statusText(c)}${c.ko ? " [KO]" : ""}` +
    (c.id === actorId ? "  <- acting now" : "");
  const cats = state.combatants.filter((c) => c.side === "cat").map(line);
  const foes = state.combatants.filter((c) => c.side === "enemy").map(line);
  return [
    `BATTLE SNAPSHOT — floor ${floor}, round ${state.round}.`,
    "Cats (rank 1 = front):",
    ...cats,
    "Enemies (rank 1 = front):",
    ...foes,
    `Improvisation budget for floor ${floor}: damage <= ${floorDamageCap(floor)}%, ` +
      `heal <= ${floorHealCap(floor)}% of the actor's atk.`,
  ].join("\n");
}

/**
 * Adjudicate one typed line inside a fight. Returns the RAW structured
 * payload — `validateCombatVerdict` is what decides whether the engine ever
 * sees it.
 */
export async function requestCombatVerdict(
  session: DmSessionHandle,
  req: {
    state: BattleState;
    actorId: string;
    floor: number;
    prompt: string;
    onDelta?: (delta: string, soFar: string) => void;
  },
): Promise<DmTurnResult | null> {
  const actor = req.state.combatants.find((c) => c.id === req.actorId);
  const message = [
    battleSnapshot(req.state, req.actorId, req.floor),
    "",
    `${actor?.name ?? "The cat"} is the acting cat. The player types:`,
    `"${req.prompt.slice(0, MAX_PROMPT)}"`,
    "",
    "Delegate this to the `encounter` subagent and return its verdict.",
  ].join("\n");
  const res = await sendDmTurn(session, {
    message,
    outputSchema: combatVerdictSchema(req.floor),
    ...(req.onDelta ? { onDelta: req.onDelta } : {}),
  });
  if (!res) markDmUnreachable();
  return res;
}

/**
 * Adjudicate one typed line OUTSIDE a fight (an event, a node the party is
 * poking at). Same null-on-failure contract.
 */
export async function requestEncounterVerdict(
  session: DmSessionHandle,
  req: {
    floor: number;
    prompt: string;
    /** What the party is looking at, in one or two lines. */
    situation: string;
    shinies: number;
    partyHp: number[];
    onDelta?: (delta: string, soFar: string) => void;
  },
): Promise<DmTurnResult | null> {
  const message = [
    `OUT OF COMBAT — floor ${req.floor}.`,
    req.situation,
    `Party HP front-to-back: ${req.partyHp.join(", ")}. Shinies: ${req.shinies}.`,
    "",
    `The player types: "${req.prompt.slice(0, MAX_PROMPT)}"`,
    "",
    "Answer in character. Authorise at most a small, bounded consequence,",
    "or none at all. Saying no is a legitimate answer.",
  ].join("\n");
  const res = await sendDmTurn(session, {
    message,
    outputSchema: encounterVerdictSchema(),
    ...(req.onDelta ? { onDelta: req.onDelta } : {}),
  });
  if (!res) markDmUnreachable();
  return res;
}
