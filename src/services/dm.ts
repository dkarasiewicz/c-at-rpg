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
 *  - OFFLINE-FIRST IS A HARD RULE. With `VITE_DM_URL` unset `probeDm()`
 *    short-circuits to false WITHOUT a request, ever; when the probe is false
 *    the typed-action UI is not built at all and the game plays exactly as it
 *    does today. A SUCCESSFUL probe is cached for the session; a FAILED one is
 *    retried on a later scene mount, at most `DM_PROBE_ATTEMPTS` times and
 *    never within `DM_PROBE_RETRY_MS` of the last miss — one slow cold request
 *    must not mute the DM for a whole session (see `markDmUnreachable`, which
 *    makes the same argument for turns).
 *  - responses are NEVER trusted: the verdicts come back as `unknown` and the
 *    caller re-lints them through `services/tabletop.ts` before the engine
 *    sees a single number.
 *
 * §4b ("the DM is present, not summoned") adds a second half to this module:
 * the PRESENCE layer at the bottom of the file. It is pure — a budget, a
 * cooldown, a beat table, a validator and a run-carried ledger — so the
 * policy that decides when the DM speaks unprompted is unit-testable with no
 * network and no pixi (tests/dm-presence.spec.ts).
 */
import type { EffectSpec } from "../core/combat/powerTypes.js";
import { EFFECT_CAPS } from "../core/combat/powers.js";
import type {
  BattleState,
  Combatant,
  Effect,
  RunState,
} from "../core/types.js";
import { CLASSES } from "../content/classes.js";
import {
  MAX_ENERGY_COST,
  MAX_NARRATION,
  MAX_PROMPT,
  floorDamageCap,
  floorHealCap,
  validateEncounterVerdict,
  type DmSessionHandle,
  type TabletopRun,
} from "./tabletop.js";

/** One turn of the DM, including a subagent delegation. */
export const DM_TURN_TIMEOUT_MS = 35_000;
/**
 * The liveness probe. Short, because a slow DM is an absent DM as far as the
 * first frame is concerned — but not 3s, which was too short to survive the
 * FIRST cross-origin request of a session: DNS + TLS + a cold Vercel function
 * routinely spends longer than that, and the probe then aborted and the game
 * silently played the whole session with no DM. Measured warm from a browser:
 * ~0.9s. This is generous enough for a cold start and still an eighth of the
 * turn budget.
 */
export const DM_PROBE_TIMEOUT_MS = 6_000;
/**
 * How long to wait before a FAILED probe may be retried, and how many times.
 *
 * `markDmUnreachable` below already argues that one bad turn must not kill the
 * DM for the rest of the run. The same is true of the first probe, and it was
 * worse there: `probeResult` cached the failure forever, so a single slow cold
 * request meant no typed action for the entire session with no way back. A
 * failed probe is now retried on a later scene mount — bounded, so an
 * genuinely absent DM costs at most PROBE_ATTEMPTS requests per session and
 * never a burst.
 */
export const DM_PROBE_RETRY_MS = 5_000;
export const DM_PROBE_ATTEMPTS = 3;

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
  probeAttempts = 0;
  lastProbeFailedAt = 0;
}

export function dmBaseUrl(): string {
  return baseUrl;
}

/* ------------------------------------------------------------------------ */
/* Reachability — probed once per session, cached                            */
/* ------------------------------------------------------------------------ */

let probeResult: Promise<boolean> | null = null;
let reachable = false;
/** How many times this session has actually asked (see `DM_PROBE_ATTEMPTS`). */
let probeAttempts = 0;
let lastProbeFailedAt = 0;

/**
 * Is a DM reachable? `GET /eve/v1/info` — an inspection route that makes no
 * model call. Any non-2xx, non-JSON body, or timeout means "no DM", which is
 * indistinguishable (by design) from the player choosing not to use one.
 *
 * NOT `/eve/v1/health`, even though that is the documented liveness probe:
 * eve serves it from the workflow runtime, OUTSIDE the eve channel's CORS
 * middleware, so it answers 200 with no `Access-Control-Allow-Origin` header.
 * A browser therefore cannot read it cross-origin, the probe fails, and the
 * game silently decides the DM is offline — a failure that looks exactly like
 * success from the server side and only ever reproduces in a real browser.
 * `/eve/v1/info` is served by the channel and does carry the CORS headers.
 */
export function probeDm(): Promise<boolean> {
  // No DM configured is a CONFIGURATION, not a failure: no request, ever, and
  // nothing to retry. This is the offline-first hard rule.
  if (baseUrl === "") return Promise.resolve(false);
  if (probeResult === null && probeAttempts > 0) {
    // A previous attempt failed. Retry — but only on a later scene mount, and
    // only a few times, so an absent DM never becomes a request storm.
    if (probeAttempts >= DM_PROBE_ATTEMPTS) return Promise.resolve(false);
    if (Date.now() - lastProbeFailedAt < DM_PROBE_RETRY_MS) {
      return Promise.resolve(false);
    }
  }
  probeResult ??= (async () => {
    probeAttempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DM_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/eve/v1/info`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`probe ${res.status}`);
      const isJson =
        res.headers.get("content-type")?.includes("application/json") ?? false;
      if (!isJson) throw new Error("probe: not json");
      await res.json();
      reachable = true;
      return true;
    } catch {
      // Drop the cached verdict so a LATER mount can ask again. Callers
      // already holding this promise still get false — this turn has no DM.
      lastProbeFailedAt = Date.now();
      probeResult = null;
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
 * Consecutive transport failures. ONE bad turn must not kill the DM for the
 * rest of the run: a player reported the typed-action button and the narration
 * area both vanishing mid-session, and the cause was a single turn exceeding
 * the client budget while the deployed agent legitimately takes 13-21s. The
 * affordance disappearing is correct when the DM is genuinely gone and
 * infuriating when it is merely slow, and from the player's side those look
 * identical — so require corroboration before giving up.
 */
let consecutiveFailures = 0;
const FAILURES_BEFORE_GIVING_UP = 2;

/**
 * Report a failed turn. The DM is only written off after
 * `FAILURES_BEFORE_GIVING_UP` in a row; a single timeout or blip is forgiven,
 * because the next turn usually succeeds.
 */
export function markDmUnreachable(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures < FAILURES_BEFORE_GIVING_UP) return;
  reachable = false;
  // Clear the cached verdict rather than pinning it to `false`.
  //
  // Pinning it defeated the probe's own retry, which only re-asks when
  // `probeResult === null` — so a write-off was permanent in practice even
  // after the retry existed, and scenes probe once when they mount. That is
  // the mechanism behind "I don't see custom action during fight": one slow
  // turn at an event removed the affordance from every later battle in the
  // session. Nulling it hands the decision to the ONE retry policy
  // (`DM_PROBE_ATTEMPTS` / `DM_PROBE_RETRY_MS`) instead of having two that
  // disagree, and stamping the failure time keeps the backoff honest.
  probeResult = null;
  lastProbeFailedAt = Date.now();
}

/** A turn came back. Forgive the earlier stumbles. */
export function markDmAlive(): void {
  consecutiveFailures = 0;
  reachable = true;
}

/** Test hook: forget the cached probe verdict. */
export function resetDmProbe(): void {
  probeResult = null;
  reachable = false;
  probeAttempts = 0;
  lastProbeFailedAt = 0;
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
  type === "session.failed" ||
  // `turn.failed` MUST end the read. eve emits it when a turn errors — most
  // often OUTPUT_SCHEMA_NOT_FULFILLED — and does not always follow it with a
  // session-level event, so a reader waiting only for `session.*` sits on an
  // open stream until its own timeout. Measured on the deployed agent: party
  // generation stopped producing events at 14s and the creator kept spinning
  // "The GM shuffles the deck" for the full 120s budget. The turn was over in
  // seconds; only the client did not know. Failing fast turns a two-minute
  // hang into a prompt fallback.
  type === "turn.failed";

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

/**
 * The outermost JSON object in a blob of assistant prose, or undefined.
 *
 * Only ever used as a FALLBACK when a schema'd turn produced no structured
 * result (see `sendDmTurn`). It scans for the first `{` and brace-matches to
 * its partner, ignoring braces inside strings, so a fenced ```json block, a
 * bare object, or an object with a sentence in front of it all parse.
 */
/** One tool the agent invoked during a turn, as seen on the event stream. */
export interface DmToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Harvest tool calls out of any stream event that carries an `actions` array
 * (eve reports them on `step.started` / `step.completed`).
 */
export function collectToolCalls(
  d: Record<string, unknown>,
  out: DmToolCall[],
): void {
  const actions = d.actions;
  if (!Array.isArray(actions)) return;
  for (const a of actions) {
    if (!isRecord(a)) continue;
    const name = typeof a.toolName === "string" ? a.toolName : "";
    if (name === "") continue;
    out.push({ name, input: isRecord(a.input) ? a.input : {} });
  }
}

/** One `subagent.completed` seen on the parent stream. */
export interface DmSubagentOutput {
  name: string;
  /** The child's answer, serialised by eve (`output: string`). */
  output: string;
}

/**
 * Harvest a `subagent.completed` event.
 *
 * eve lowers every delegation into a child session whose result comes back up
 * the PARENT stream as `{ type: "subagent.completed", data: { subagentName,
 * output } }` (eve `subagents` §"What the parent sees"). When the child ran in
 * task mode — which is what a declared `outputSchema` means — `output` is that
 * structured object, JSON-stringified by the runtime.
 *
 * This is the only channel a structured one-shot has. The client cannot address
 * a subagent directly (the eve HTTP channel routes to the root session and
 * nowhere else), and the parent will not answer a schema itself, so the answer
 * has to be read in transit.
 */
export function collectSubagentOutput(
  d: Record<string, unknown>,
  out: DmSubagentOutput[],
): void {
  const name = typeof d.subagentName === "string" ? d.subagentName : "";
  const output = typeof d.output === "string" ? d.output : "";
  if (name === "" || output === "") return;
  out.push({ name, output });
}

/**
 * The LAST answer `name` returned this turn, parsed. Undefined when it was
 * never called, answered with prose, or answered with something unparseable.
 *
 * Last wins for the same reason eve's own `result()` takes the most recent
 * `result.completed`: if the parent delegated twice, the retry is the answer.
 * `parseEmbeddedJson` rather than a bare `JSON.parse` because a child that
 * failed its own schema falls back to text, and an object wrapped in prose is
 * still worth more than nothing — the caller re-lints either way.
 */
export function subagentResult(
  outputs: readonly DmSubagentOutput[],
  name: string,
): unknown {
  for (let i = outputs.length - 1; i >= 0; i--) {
    const entry = outputs[i];
    if (entry === undefined || entry.name !== name) continue;
    try {
      return JSON.parse(entry.output) as unknown;
    } catch {
      return parseEmbeddedJson(entry.output);
    }
  }
  return undefined;
}

/** Does this schema describe an encounter verdict (allowed + narration)? */
export function wantsVerdict(schema: Record<string, unknown>): boolean {
  const props = schema.properties;
  if (!isRecord(props)) return false;
  return "allowed" in props && "narration" in props;
}

/**
 * Reconstruct an encounter verdict from the tools the agent called.
 *
 * WHY THIS EXISTS. The DM's system prompt is emphatically tools-first ("you may
 * only change the world through your tools"), and that instruction reliably
 * beats a requested `outputSchema`: measured against the deployed agent, 0 of 5
 * structured turns produced a schema result — every one ended on `narrate` or
 * an effect tool instead, and eve then failed the turn with
 * OUTPUT_SCHEMA_NOT_FULFILLED. Upgrading the model did not help (Sonnet 5 was
 * also 0/5, just slower and more consistently tool-happy), because a stronger
 * model follows the dominant instruction *better*.
 *
 * The tool calls, however, carry exactly the information the verdict needs. So
 * rather than fight the agent's nature, read what it actually did. Everything
 * here is re-linted by the caller (`validateEncounterVerdict`), so a wrong
 * guess costs precisely what a dropped turn costs — nothing extra.
 */
export function verdictFromToolCalls(
  calls: readonly DmToolCall[],
  text: string,
): unknown {
  if (calls.length === 0) return undefined;
  const narrateCall = calls.find((c) => c.name === "narrate");
  const narration =
    typeof narrateCall?.input.text === "string" && narrateCall.input.text !== ""
      ? narrateCall.input.text
      : text.trim();
  if (narration === "") return undefined;

  const effects: unknown[] = [];
  for (const call of calls) {
    if (effects.length >= 3) break;
    if (call.name === "apply_effect" && Array.isArray(call.input.effects)) {
      // Already the engine's improvised-effect shape; the caller re-lints.
      effects.push(...call.input.effects.slice(0, 3 - effects.length));
    } else if (call.name === "adjust_shinies") {
      const amount = call.input.amount;
      // Only gains: the verdict's `shinies` member is non-negative, and a
      // silently-dropped loss is safer than a sign flip that pays the player.
      if (typeof amount === "number" && amount > 0) {
        effects.push({ kind: "shinies", amount: Math.round(amount) });
      }
    }
  }

  // `narrate` carries the refusal signal in its tone.
  const allowed = narrateCall?.input.tone !== "refusal";
  return { allowed, narration, effects };
}

export function parseEmbeddedJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export interface DmTurn {
  /** What the DM is told. The whole snapshot goes here — a declared subagent
   *  inherits nothing, so context cannot be implied. */
  message: string;
  /** JSON Schema for the structured result (`result.completed`). */
  outputSchema?: unknown;
  /**
   * The declared subagent this turn's answer is expected to come from.
   *
   * Set it and the turn's payload is read off the parent stream's
   * `subagent.completed` for that name (see `subagentResult`) instead of the
   * parent's own `result.completed` — the route every structured ONE-SHOT
   * takes, because the parent cannot be made to answer a schema itself.
   * A turn that names a subagent should NOT also pass an `outputSchema`: the
   * specialist declares its own, and asking the parent for one on top only
   * buys a second, slower copy of the same object.
   */
  subagent?: string;
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
  /** Every delegation that finished during the turn, in order. */
  subagents: readonly DmSubagentOutput[];
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
    const toolCalls: DmToolCall[] = [];
    const subagentOutputs: DmSubagentOutput[] = [];
    for await (const ev of ndjson(stream)) {
      read += 1;
      const d = ev.data ?? {};
      collectToolCalls(d, toolCalls);
      if (ev.type === "subagent.completed")
        collectSubagentOutput(d, subagentOutputs);
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
    // A turn routed to a subagent takes its answer from the delegation, not
    // from the parent. The parent is a relay: it never had the schema, and
    // whatever it says afterwards is a slower copy at best. Prefer the child's
    // output whenever it exists, and fall back to the parent's own result only
    // if the delegation never happened.
    if (turn.subagent !== undefined) {
      const fromChild = subagentResult(subagentOutputs, turn.subagent);
      if (fromChild !== undefined) data = fromChild;
    }
    // A turn that asked for a schema and got no `result.completed` is not
    // necessarily a failed turn: the model sometimes answers the schema in the
    // ASSISTANT TEXT instead of through the structured channel (observed once
    // in three against the deployed agent on the resonance one-shot). Reading
    // the object back out of the prose is strictly better than discarding a
    // correct answer — the caller re-lints it either way, so a wrong guess
    // costs exactly what a missing result costs.
    if (
      data === undefined &&
      (turn.outputSchema !== undefined || turn.subagent !== undefined)
    ) {
      data = parseEmbeddedJson(text);
      // The tool-call reconstruction below can only produce a VERDICT, so it
      // must only run for a verdict request. A party or resonance one-shot
      // asks for a completely different shape, and handing its lint a verdict
      // would waste a regeneration round on data that was never going to fit.
      if (
        data === undefined &&
        isRecord(turn.outputSchema) &&
        wantsVerdict(turn.outputSchema)
      ) {
        data = verdictFromToolCalls(toolCalls, text);
      }
    }
    markDmAlive(); // a turn came back: forgive any earlier stumble
    return { data, text, session: next, subagents: subagentOutputs };
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
    // `enum: [kind]`, not `const: kind`. They mean the same thing, but the
    // discriminator sits inside an `anyOf`, and constrained decoders support
    // enum far more reliably than const there — a `const` discriminator is one
    // of the ways this schema comes back OUTPUT_SCHEMA_NOT_FULFILLED.
    properties: { kind: { type: "string", enum: [kind] }, ...props },
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

/**
 * What the party can see from where they are standing on the run map. This is
 * the EXPLORATION context (run-map-and-dm.md §4b): "scout ahead, talk among
 * yourselves, try something with a node before committing, ask the DM about
 * the floor". Nothing is under time pressure, so the situation is written as
 * a table would describe it — the map, then the routes, then the party.
 */
export function mapSituation(req: {
  floor: number;
  floorName: string;
  standingOn: string;
  routes: string[];
  cleared: boolean;
}): string {
  const routes =
    req.routes.length === 0
      ? "Nothing ahead but the way down."
      : `From here the routes on offer are: ${req.routes.join("; ")}.`;
  return [
    `ON THE RUN MAP — floor ${req.floor}, "${req.floorName}".`,
    `The party is standing on ${req.standingOn}.`,
    routes,
    req.cleared ? "The way down is already open." : "",
  ]
    .filter((l) => l.length > 0)
    .join(" ");
}

/**
 * Adjudicate one typed line on the RUN MAP. Same bounded vocabulary and same
 * null-on-failure contract as an event; only the framing differs, because the
 * answer here may legitimately be nothing but talk.
 */
export async function requestExplorationVerdict(
  session: DmSessionHandle,
  req: {
    floor: number;
    prompt: string;
    situation: string;
    shinies: number;
    partyHp: number[];
    onDelta?: (delta: string, soFar: string) => void;
  },
): Promise<DmTurnResult | null> {
  const message = [
    req.situation,
    `Party HP front-to-back: ${req.partyHp.join(", ")}. Shinies: ${req.shinies}.`,
    "",
    `The player types: "${req.prompt.slice(0, MAX_PROMPT)}"`,
    "",
    "This is the table between fights: nothing is under time pressure. They",
    "may be scouting ahead, talking among themselves, poking at a node before",
    "committing, or just asking you about the floor. Answer in character.",
    "Telling them what they can see is a complete answer and needs no effect.",
    "Authorise at most one small, bounded consequence; saying no is fine.",
  ].join("\n");
  const res = await sendDmTurn(session, {
    message,
    outputSchema: encounterVerdictSchema(),
    ...(req.onDelta ? { onDelta: req.onDelta } : {}),
  });
  if (!res) markDmUnreachable();
  return res;
}

/* ====================================================================== */
/* §4b The DM is present, not summoned                                     */
/* ====================================================================== */

/**
 * The authored beats an interjection may fire on (run-map-and-dm.md §4b):
 * arriving somewhere, a spike in the fight, or a run state that is dramatic
 * on its own. Nothing else is a beat — the DM does not speak "sometimes".
 */
export const DM_BEATS = [
  "arriveNode",
  "descend",
  "bossLair",
  "ko",
  "catPile",
  "finishingCrit",
  "nearDeath",
  "lastLife",
  "broke",
  "benched",
] as const;

export type DmBeat = (typeof DM_BEATS)[number];

/**
 * How dramatic each beat is, 0..1. This is the WEIGHTING the design asks for:
 * the budget is spent cheapest-first, and every spend raises the bar (see
 * `dramaThreshold`), so a run's later interjections can only be earned by the
 * loud moments. Arriving at a node is worth one interjection per run, at
 * most, and only if it is the first thing that happens.
 */
export const BEAT_DRAMA: Record<DmBeat, number> = {
  arriveNode: 0.1,
  broke: 0.25,
  descend: 0.35,
  benched: 0.5,
  catPile: 0.55,
  ko: 0.6,
  nearDeath: 0.7,
  finishingCrit: 0.75,
  lastLife: 0.85,
  bossLair: 1,
};

/** One line telling the DM what just happened. Interpolated into the ask. */
export const BEAT_BRIEF: Record<DmBeat, string> = {
  arriveNode: "the party has just arrived somewhere on the floor",
  descend: "the party has just come down a floor",
  bossLair: "the party is standing at the mouth of a boss lair",
  ko: "a cat has just been knocked out",
  catPile: "the whole clowder just piled on at once",
  finishingCrit: "a critical hit just ended the fight",
  nearDeath: "a cat is one hit from going down",
  lastLife: "somebody is down to their last life",
  broke: "the party is out of shinies",
  benched: "a cat is out of lives and is riding the bench",
};

/** Beats that mean something once per FLOOR rather than once per run. */
const PER_FLOOR_BEATS: readonly DmBeat[] = ["descend", "bossLair"];

/** Beats that describe a run STATE, and so may only land once per run. */
const ONCE_PER_RUN_BEATS: readonly DmBeat[] = [
  "arriveNode",
  "lastLife",
  "broke",
  "benched",
];

/**
 * The dedupe key a beat occupies once spent, or null when the beat is a
 * momentary spike (a KO, a Cat Pile, a finishing crit, a near-death) that may
 * legitimately recur — those are governed by the budget and the cooldown
 * alone.
 */
export function beatKey(beat: DmBeat, floor: number): string | null {
  if (ONCE_PER_RUN_BEATS.includes(beat)) return beat;
  if (PER_FLOOR_BEATS.includes(beat)) return `${beat}@${floor}`;
  return null;
}

/**
 * "Target a handful per run." Five is the handful: enough that the DM is a
 * presence, few enough that none of them is wallpaper.
 */
export const INTERJECTION_BUDGET = 5;

/**
 * Nothing unprompted inside this window, whatever happens. A fight that KOs
 * two cats in three rounds gets ONE interjection, not two.
 */
export const INTERJECTION_COOLDOWN_MS = 75_000;

/** Ledger ceilings — a run is finite, but a save must never grow unbounded. */
export const MAX_INTERJECTION_LOG = 40;
export const MAX_GENERATED_RECORDS = 40;
/** Interjections that landed while the screen was busy, awaiting delivery. */
export const MAX_QUEUED_INTERJECTIONS = 2;

/** Longest "well?" the card will render under the DM's line. */
export const MAX_INVITE = 90;

/**
 * The bar a beat must clear to be worth an interjection, given how much of
 * the budget is already gone: 0, 0.2, 0.4, 0.6, 0.8. The first interjection
 * of a run can be anything; the last one has to be a boss lair or somebody's
 * final life.
 */
export function dramaThreshold(used: number): number {
  return Math.max(0, Math.min(1, used / INTERJECTION_BUDGET));
}

/** What kind of thing the DM did, unprompted. */
export const INTERJECTION_KINDS = [
  "narration",
  "offer",
  "complication",
  "gift",
  "warning",
] as const;

export type InterjectionKind = (typeof INTERJECTION_KINDS)[number];

/**
 * The events `Effect` union spelled out at runtime, typed against the union
 * itself so a seventh member is a compile error here rather than a silently
 * unrecognised kind. `fight` is listed because it must be RECOGNISED in order
 * to be REFUSED (`validateEncounterVerdict` rejects it: the run map authors
 * encounters, not the DM).
 */
const EVENT_EFFECT_KINDS: ReadonlySet<Effect["kind"]> = new Set<Effect["kind"]>(
  [
    "heal",
    "damage",
    "shinies",
    "buff",
    "giveItem",
    "takeItem",
    "restoreLife",
    "energyNextBattle",
    "fight",
    "nothing",
  ],
);

/** One unprompted beat, already validated and linted. */
export interface Interjection {
  beat: DmBeat;
  kind: InterjectionKind;
  /** The DM's line. */
  narration: string;
  /** The invitation to answer, or null. An interjection is not a cutscene. */
  invite: string | null;
  /** Bounded, out-of-combat effects. Empty unless the lint passed. */
  effects: Effect[];
  /** Did the effects survive the client-side lint? */
  applied: boolean;
  /** Why not. Recorded, never shown. */
  problems: string[];
}

/** One interjection as recorded in the run log. */
export interface InterjectionEntry extends Interjection {
  seq: number;
  floor: number;
  nodeId: number | null;
  /** Did the player actually see it, or did it land on a busy screen? */
  delivered: boolean;
  /**
   * RNG draws it consumed. An interjection's effects run through the same
   * conditionless single-outcome path a verdict does, so this is 0 — recorded
   * because §3's replay contract names it.
   */
  rngDraws: number;
}

/** Content the DM authored mid-run, recorded so a replay never re-asks. */
export interface GeneratedRecord {
  seq: number;
  floor: number;
  /** What was made: an item id, an event id, a line of enemy flavour. */
  kind: "item" | "event" | "flavour";
  /** The id or key it was published under in the shared pool. */
  ref: string;
  /** The style contract it was authored against. */
  styleVersion: number;
  /** Where it came from, e.g. `dm:interjection`. */
  provenance: string;
  /** Did the shared-pool write succeed? */
  published: boolean;
}

/**
 * Everything the presence layer carries on a run. Like `dm` and `tabletop`
 * this is NOT declared in `core/types.ts`: the save round-trips it for free
 * (`serializeRun` spreads the run), so it survives a reload and an older save
 * simply loads with the field `undefined`.
 */
export interface DmPresenceState {
  /** Interjections SPENT this run (spent at ask time, not at delivery). */
  used: number;
  /** When the last one was spent. 0 = never. */
  lastAtMs: number;
  /** Dedupe keys already spent (see `beatKey`). */
  fired: string[];
  /** The floor the presence layer last saw — how a descent is detected. */
  lastFloor: number;
  /** Landed but not yet rendered; the next quiet screen delivers them. */
  queued: Interjection[];
  /** The run log of everything the DM said unprompted. */
  log: InterjectionEntry[];
  /** The run log of everything the DM generated. */
  generated: GeneratedRecord[];
}

export type PresenceRun = TabletopRun & { dmPresence?: DmPresenceState };

export function emptyPresence(): DmPresenceState {
  return {
    used: 0,
    lastAtMs: 0,
    fired: [],
    lastFloor: 0,
    queued: [],
    log: [],
    generated: [],
  };
}

/** The run's presence state, or an empty one. Never returns undefined. */
export function presenceOf(run: PresenceRun | null): DmPresenceState {
  const p = run?.dmPresence;
  if (!p) return emptyPresence();
  return {
    used: p.used ?? 0,
    lastAtMs: p.lastAtMs ?? 0,
    fired: p.fired ?? [],
    lastFloor: p.lastFloor ?? 0,
    queued: p.queued ?? [],
    log: p.log ?? [],
    generated: p.generated ?? [],
  };
}

/* ---- the policy ------------------------------------------------------- */

export type BeatRefusal =
  /** no DM is reachable — the presence layer does not exist at all */
  | "offline"
  /** the run's handful is spent */
  | "budget"
  /** too soon after the last one */
  | "cooldown"
  /** this beat already had its turn */
  | "repeat"
  /** the beat is not loud enough for what is left of the budget */
  | "undramatic"
  /** nothing was offered */
  | "none";

export interface BeatDecision {
  /** The beat to interject on, or null. */
  beat: DmBeat | null;
  /** Why not, when `beat` is null; "none" when it is not. */
  reason: BeatRefusal;
}

/**
 * Should the DM speak, and about what? PURE — this is the whole rate limit,
 * and it is a budget and a cooldown, not vibes.
 *
 * Candidates are considered MOST DRAMATIC FIRST, so a boss lair reached on
 * one life interjects about the lair, not about the wallet.
 */
export function planInterjection(
  state: DmPresenceState,
  candidates: readonly DmBeat[],
  opts: { nowMs: number; floor: number; available: boolean },
): BeatDecision {
  if (!opts.available) return { beat: null, reason: "offline" };
  if (candidates.length === 0) return { beat: null, reason: "none" };
  if (state.used >= INTERJECTION_BUDGET)
    return { beat: null, reason: "budget" };
  if (
    state.lastAtMs > 0 &&
    opts.nowMs - state.lastAtMs < INTERJECTION_COOLDOWN_MS
  ) {
    return { beat: null, reason: "cooldown" };
  }
  const bar = dramaThreshold(state.used);
  const seen = new Set(state.fired);
  const ranked = [...new Set(candidates)].sort(
    (a, b) => BEAT_DRAMA[b] - BEAT_DRAMA[a],
  );
  let reason: BeatRefusal = "none";
  for (const beat of ranked) {
    const key = beatKey(beat, opts.floor);
    if (key !== null && seen.has(key)) {
      if (reason === "none") reason = "repeat";
      continue;
    }
    if (BEAT_DRAMA[beat] < bar) {
      reason = "undramatic";
      continue;
    }
    return { beat, reason: "none" };
  }
  return { beat: null, reason };
}

/**
 * Spend one interjection. Called SYNCHRONOUSLY, before the request goes out,
 * so two beats firing in the same frame cannot both slip through the budget —
 * and so a DM that stops answering stops being asked.
 */
export function withBeatSpent(
  run: PresenceRun,
  beat: DmBeat,
  nowMs: number,
): PresenceRun {
  const p = presenceOf(run);
  const key = beatKey(beat, run.floorNum);
  return {
    ...run,
    dmPresence: {
      ...p,
      used: p.used + 1,
      lastAtMs: nowMs,
      fired:
        key === null || p.fired.includes(key) ? p.fired : [...p.fired, key],
    },
  };
}

/** Remember the floor the presence layer last saw (descent detection). */
export function withPresenceFloor(run: PresenceRun): PresenceRun {
  const p = presenceOf(run);
  if (p.lastFloor === run.floorNum) return { ...run, dmPresence: p };
  return { ...run, dmPresence: { ...p, lastFloor: run.floorNum } };
}

/** Did the party come DOWN into this floor since the DM last looked? */
export function didDescend(run: PresenceRun): boolean {
  const p = presenceOf(run);
  return p.lastFloor > 0 && p.lastFloor < run.floorNum;
}

/** What is dramatic about the run state right now (run-map-and-dm.md §4b). */
export function dramaticStateBeats(run: RunState): DmBeat[] {
  const beats: DmBeat[] = [];
  const living = run.cats.filter((c) => c.lives > 0);
  if (living.some((c) => c.lives === 1)) beats.push("lastLife");
  if (run.inventory.shinies === 0) beats.push("broke");
  if (run.cats.some((c) => c.lives <= 0)) beats.push("benched");
  return beats;
}

/* ---- the run log ------------------------------------------------------ */

const tail = <T>(rows: T[], max: number): T[] =>
  rows.length > max ? rows.slice(rows.length - max) : rows;

const nextSeq = (rows: { seq: number }[]): number =>
  (rows[rows.length - 1]?.seq ?? 0) + 1;

export type InterjectionDraft = Omit<InterjectionEntry, "seq" | "rngDraws">;

/**
 * Record one interjection into the run log. Pure: returns a NEW run, so the
 * caller assigns it back and lets the ordinary autosave carry it. Every
 * interjection is recorded — delivered, queued or dropped — so a replay reads
 * the run from the log and never re-consults a model (§3, §4b).
 */
export function withInterjectionRecorded(
  run: PresenceRun,
  draft: InterjectionDraft,
): PresenceRun {
  const p = presenceOf(run);
  const entry: InterjectionEntry = {
    ...draft,
    seq: nextSeq(p.log),
    rngDraws: 0,
  };
  return {
    ...run,
    dmPresence: { ...p, log: tail([...p.log, entry], MAX_INTERJECTION_LOG) },
  };
}

/** Park an interjection that landed on a busy screen. Pure. */
export function withQueuedInterjection(
  run: PresenceRun,
  interjection: Interjection,
): PresenceRun {
  const p = presenceOf(run);
  return {
    ...run,
    dmPresence: {
      ...p,
      queued: tail([...p.queued, interjection], MAX_QUEUED_INTERJECTIONS),
    },
  };
}

/** Take the oldest queued interjection, if any. Pure. */
export function takeQueuedInterjection(
  run: PresenceRun,
): { interjection: Interjection; run: PresenceRun } | null {
  const p = presenceOf(run);
  const [first, ...rest] = p.queued;
  if (!first) return null;
  return {
    interjection: first,
    run: { ...run, dmPresence: { ...p, queued: rest } },
  };
}

/** Record a piece of content the DM authored mid-run. Pure. */
export function withGeneratedRecord(
  run: PresenceRun,
  draft: Omit<GeneratedRecord, "seq">,
): PresenceRun {
  const p = presenceOf(run);
  const entry: GeneratedRecord = { ...draft, seq: nextSeq(p.generated) };
  return {
    ...run,
    dmPresence: {
      ...p,
      generated: tail([...p.generated, entry], MAX_GENERATED_RECORDS),
    },
  };
}

/* ---- the wire ---------------------------------------------------------- */

/**
 * The interjection schema. The effects member is LIFTED from
 * `encounterVerdictSchema()` rather than restated, so an unprompted twist can
 * never reach for a wider vocabulary than an answered one.
 */
export function interjectionSchema(): Record<string, unknown> {
  const verdict = encounterVerdictSchema();
  const props = verdict.properties as Record<string, unknown>;
  return {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [...INTERJECTION_KINDS],
        description:
          "narration = words only (the usual answer); offer / complication / " +
          "gift / warning = a small twist, which may carry ONE bounded effect.",
      },
      narration: {
        type: "string",
        minLength: 1,
        maxLength: MAX_NARRATION,
        description:
          "1-2 sentences, unprompted, in the DM voice. Call back to what " +
          "this party has already done when you can.",
      },
      invite: {
        ...nullableString(MAX_INVITE),
        description:
          "a short question inviting them to answer, or null. This is not a " +
          "cutscene.",
      },
      effects: props.effects,
    },
    required: ["kind", "narration", "invite", "effects"],
  };
}

/**
 * Re-lint an interjection CLIENT-SIDE. The effects go through the SAME
 * `validateEncounterVerdict` an answered line does (defence in depth), so a
 * tampered or over-budget twist degrades to pure narration and the DM simply
 * said something. Returns null only when the payload was not an interjection
 * at all.
 */
export function validateInterjection(
  raw: unknown,
  floor: number,
  beat: DmBeat,
): Interjection | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const r = raw as Record<string, unknown>;
  const narration =
    typeof r.narration === "string"
      ? r.narration.trim().slice(0, MAX_NARRATION)
      : "";
  if (narration.length === 0) return null;
  const kind: InterjectionKind = INTERJECTION_KINDS.includes(
    r.kind as InterjectionKind,
  )
    ? (r.kind as InterjectionKind)
    : "narration";
  const invite =
    typeof r.invite === "string" && r.invite.trim().length > 0
      ? r.invite.trim().slice(0, MAX_INVITE)
      : null;

  // No effects claimed ⇒ nothing to lint; it is a line of narration.
  const rawEffects = Array.isArray(r.effects) ? r.effects : [];
  if (rawEffects.length === 0) {
    return {
      beat,
      kind,
      narration,
      invite,
      effects: [],
      applied: false,
      problems: [],
    };
  }
  // The closed events `Effect` union, checked by NAME before anything else.
  // `validateEvents` is a validator for already-typed content and walks its
  // members by kind, so an invented kind would pass structurally and then be
  // a silent no-op in `resolveOption`. An unprompted twist gets the tighter
  // reading: a kind the game does not have is not a twist, it is noise.
  const unknownKinds = rawEffects.filter(
    (e) =>
      typeof e !== "object" ||
      e === null ||
      !EVENT_EFFECT_KINDS.has((e as { kind?: unknown }).kind as Effect["kind"]),
  );
  if (unknownKinds.length > 0) {
    return {
      beat,
      kind,
      narration,
      invite,
      effects: [],
      applied: false,
      problems: ["effect outside the events union"],
    };
  }
  const check = validateEncounterVerdict(
    { allowed: true, narration, effects: rawEffects },
    floor,
  );
  return {
    beat,
    kind,
    narration,
    invite,
    effects: check.applied ? (check.verdict?.effects ?? []) : [],
    applied: check.applied,
    problems: check.problems,
  };
}

/** One unprompted turn. Short: an interjection nobody waited for is late. */
export const DM_INTERJECT_TIMEOUT_MS = 12_000;

export interface InterjectionRequest {
  beat: DmBeat;
  /** Where the party is / what just happened, in a line or two. */
  situation: string;
}

/**
 * Ask the DM for one unprompted beat. NEVER blocking from the caller's side:
 * scenes fire this without awaiting it on the gameplay path, and a null
 * (offline, timeout, garbage) is simply silence.
 *
 * Returns the advanced session handle so the caller can persist it exactly as
 * it does for an answered line.
 */
export async function requestInterjection(
  run: PresenceRun,
  req: InterjectionRequest,
): Promise<{ interjection: Interjection; session: DmSessionHandle } | null> {
  if (!isDmAvailable()) return null;
  const ensured = await ensureDmSession(run);
  if (!ensured) return null;
  const floor = run.floorNum;
  const partyHp = run.cats.filter((c) => c.lives > 0).map((c) => c.hp);
  const message = [
    `UNPROMPTED BEAT — floor ${floor}. Nobody asked you anything.`,
    req.situation,
    `Party HP front-to-back: ${partyHp.join(", ")}. Shinies: ${run.inventory.shinies}.`,
    "",
    `The beat: ${BEAT_BRIEF[req.beat]}.`,
    "",
    "Interrupt. One or two sentences, in your own voice, and make it land —",
    "you get a handful of these per run and this is one of them. Call back to",
    "something this party has already done if you have one. It may be pure",
    "narration (usually it should be) or ONE small twist: an offer, a",
    "complication, a gift, a warning. Then invite them to answer.",
  ].join("\n");
  const res = await sendDmTurn(ensured.session, {
    message,
    outputSchema: interjectionSchema(),
    timeoutMs: DM_INTERJECT_TIMEOUT_MS,
  });
  if (!res) {
    markDmUnreachable();
    return null;
  }
  const interjection = validateInterjection(res.data, floor, req.beat);
  if (!interjection) return null;
  return { interjection, session: res.session };
}
