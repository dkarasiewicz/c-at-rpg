/**
 * GM service client — ui-layer wrapper around the /api/gm/* Vercel functions
 * (docs/design/gm-system.md "Client integration").
 *
 * Contract with callers:
 *  - every function returns `null` on ANY failure (network, timeout, non-2xx,
 *    malformed body) so callers always fall back to static content;
 *  - 8s hard timeout per request;
 *  - responses are re-validated with hand-rolled structural guards against
 *    the core types (no schema-library dependency) — a lying or truncated
 *    response is treated exactly like a network failure;
 *  - src/core stays network-free: this module lives in the ui-layer services
 *    package and is the ONLY place that talks to the GM.
 *
 * Not wired into any scene yet — see docs/GM-DEPLOY.md "UI wiring plan".
 */
import type { Effect, GameEvent, Skill, Stats } from "../core/types.js";
import { validateEvents } from "../core/events/validate.js";
import type {
  GeneratedCatKit,
  GeneratedEquip,
  GmEventRequest,
  GmEventResolveOutcome,
  GmEventResolveRequest,
  GmItemRequest,
  GmPartyRequest,
  GmResonanceRequest,
  GmResonanceResponse,
  GmSteerNudges,
  GmSteerRequest,
  InteractionRule,
  PowerScript,
} from "./gmTypes.js";

const TIMEOUT_MS = 8000;

let baseUrl: string =
  (import.meta.env?.VITE_GM_URL as string | undefined) ?? "/api";

/** Point the client at a non-default GM deployment (tests, previews). */
export function setGmBaseUrl(url: string): void {
  baseUrl = url.replace(/\/$/, "");
  probeResult = null; // a new base invalidates the reachability probe
}

/* ------------------------------------------------------------------------ */
/* Reachability probe                                                        */
/* ------------------------------------------------------------------------ */

let probeResult: Promise<boolean> | null = null;

/**
 * Is a GM deployment reachable? One cheap request (an empty POST that the
 * service answers with a JSON 400, no model call), cached for the rest of
 * the session. UI features that need the GM (the event free-text option)
 * appear only when this resolves true — offline the game is unchanged.
 */
export function probeGm(): Promise<boolean> {
  probeResult ??= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/gm/eventResolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      // any JSON answer (200/400/405/429) proves a live function; a dev
      // server without /api returns 404/HTML instead.
      const isJson =
        res.headers.get("content-type")?.includes("application/json") ?? false;
      return isJson && res.status !== 404;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();
  return probeResult;
}

/** Test hook: forget the cached probe verdict. */
export function resetGmProbe(): void {
  probeResult = null;
}

/* ------------------------------------------------------------------------ */
/* transport                                                                 */
/* ------------------------------------------------------------------------ */

async function post(path: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------ */
/* structural guards (hand-rolled, no deps)                                  */
/* ------------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStats(v: unknown): v is Stats {
  if (!isRecord(v)) return false;
  return (["hp", "atk", "def", "spd", "crt", "enMax"] as const).every((k) =>
    isFiniteNumber(v[k]),
  );
}

function isSkill(v: unknown): v is Skill {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.name)) return false;
  if (typeof v.desc !== "string") return false;
  if (!isFiniteNumber(v.cost) || !isFiniteNumber(v.power)) return false;
  if (v.kind !== "damage" && v.kind !== "heal" && v.kind !== "utility") {
    return false;
  }
  if (!Array.isArray(v.usableFrom) || !v.usableFrom.every(isFiniteNumber)) {
    return false;
  }
  const t = v.target;
  if (!isRecord(t)) return false;
  if (t.side !== "enemy" && t.side !== "ally" && t.side !== "self") {
    return false;
  }
  if (!Array.isArray(t.ranks) || !t.ranks.every(isFiniteNumber)) return false;
  if (t.pattern !== "single" && t.pattern !== "row") return false;
  return true;
}

function isGeneratedCatKit(v: unknown): v is GeneratedCatKit {
  if (!isRecord(v)) return false;
  if (
    v.role !== "tank" &&
    v.role !== "striker" &&
    v.role !== "control" &&
    v.role !== "support"
  ) {
    return false;
  }
  if (!isNonEmptyString(v.catName) || !isNonEmptyString(v.className)) {
    return false;
  }
  if (typeof v.epithet !== "string") return false;
  if (!isStats(v.base)) return false;
  if (!Array.isArray(v.growth) || v.growth.length !== 7) return false;
  if (!v.growth.every(isRecord)) return false;
  if (!Array.isArray(v.skills) || v.skills.length !== 4) return false;
  if (!v.skills.every(isSkill)) return false;
  const trait = v.trait;
  if (!isRecord(trait) || !isNonEmptyString(trait.name)) return false;
  const stand = v.stand;
  if (
    !isRecord(stand) ||
    !isNonEmptyString(stand.name) ||
    !isNonEmptyString(stand.visualPrompt)
  ) {
    return false;
  }
  const flavor = v.flavor;
  if (!isRecord(flavor) || !isRecord(flavor.barks)) return false;
  return isPowerScript(v.power);
}

function isRuleBody(v: unknown): v is InteractionRule {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.trigger)) return false;
  if (!Array.isArray(v.conditions) || !v.conditions.every(isRecord)) {
    return false;
  }
  if (
    !Array.isArray(v.effects) ||
    v.effects.length === 0 ||
    !v.effects.every(isRecord)
  ) {
    return false;
  }
  return true;
}

function isPowerScript(v: unknown): v is PowerScript {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.name)) return false;
  if (typeof v.flavor !== "string") return false;
  if (!isFiniteNumber(v.version) || !isFiniteNumber(v.budget)) return false;
  return isRuleBody(v);
}

function isGeneratedEquip(v: unknown): v is GeneratedEquip {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.name)) return false;
  if (typeof v.icon !== "string") return false;
  if (v.slot !== "weapon" && v.slot !== "trinket") return false;
  const statKeys = ["hp", "atk", "def", "spd", "crt", "enMax"];
  if (typeof v.primary !== "string" || !statKeys.includes(v.primary)) {
    return false;
  }
  if (
    !Array.isArray(v.secondaryPool) ||
    v.secondaryPool.length !== 2 ||
    !v.secondaryPool.every((k) => typeof k === "string" && statKeys.includes(k))
  ) {
    return false;
  }
  return isNonEmptyString(v.iconPrompt);
}

function isSteerNudges(v: unknown): v is GmSteerNudges {
  if (!isRecord(v)) return false;
  if (
    v.encounterBudgetDelta !== -1 &&
    v.encounterBudgetDelta !== 0 &&
    v.encounterBudgetDelta !== 1
  ) {
    return false;
  }
  if (
    v.shopBias !== "consumables" &&
    v.shopBias !== "equipment" &&
    v.shopBias !== "none"
  ) {
    return false;
  }
  return (
    typeof v.nextEventTheme === "string" && typeof v.floorIntro === "string"
  );
}

/* ------------------------------------------------------------------------ */
/* public API                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Generate 4 legal CatClass-shaped kits from 1–4 free-text cat descriptions.
 * Null on any failure — caller falls back to the four default strays.
 */
export async function requestGmParty(
  descriptions: string[],
): Promise<GeneratedCatKit[] | null> {
  const body: GmPartyRequest = { descriptions };
  const raw = await post("/gm/party", body);
  if (!isRecord(raw) || !Array.isArray(raw.kits)) return null;
  if (raw.kits.length !== 4 || !raw.kits.every(isGeneratedCatKit)) return null;
  return raw.kits;
}

/**
 * Generate (or draw from the shared pool) one narrative event for the given
 * run context. Null on any failure — caller draws from content/events.ts.
 */
export async function requestGmEvent(
  req: GmEventRequest,
): Promise<GameEvent | null> {
  const raw = await post("/gm/event", req);
  if (!isRecord(raw) || !isRecord(raw.event)) return null;
  const event = raw.event as unknown as GameEvent;
  // Full re-validation with the same validator the static content passes.
  try {
    if (validateEvents([event]).length > 0) return null;
  } catch {
    return null;
  }
  return event;
}

/**
 * Resolve a player's free-text event action into an Outcome-shaped verdict
 * (bounded effect menu, per-floor caps — linted server-side with the same
 * validator + caps the generated events pass). The returned effects are
 * re-validated here by wrapping them in a synthetic event and running the
 * shipped validator (structure, id cross-refs, gateCat ban). Null on any
 * failure — the caller returns to the untouched prompt.
 */
export async function requestGmEventResolve(
  req: GmEventResolveRequest,
): Promise<GmEventResolveOutcome | null> {
  const raw = await post("/gm/eventResolve", req);
  if (!isRecord(raw) || !isRecord(raw.outcome)) return null;
  const outcome = raw.outcome;
  if (!isNonEmptyString(outcome.text) || outcome.text.length > 400) return null;
  if (!Array.isArray(outcome.effects) || outcome.effects.length > 3) {
    return null;
  }
  const effects = outcome.effects as Effect[];
  // structural re-validation through the SAME validator static events pass:
  // a synthetic 2-option event (the verdict + a dummy walk-away).
  const synthetic: GameEvent = {
    id: "gmFreeTextVerdict",
    title: "verdict",
    prompt: "verdict",
    weight: 1,
    floors: [
      Math.max(1, Math.min(6, Math.floor(req.floor))),
      Math.max(1, Math.min(6, Math.floor(req.floor))),
    ],
    options: [
      {
        label: "do it",
        outcomes: [{ weight: 1, text: outcome.text, effects }],
      },
      {
        label: "walk away",
        outcomes: [{ weight: 1, text: "-", effects: [{ kind: "nothing" }] }],
      },
    ],
  };
  try {
    if (validateEvents([synthetic]).length > 0) return null;
  } catch {
    return null;
  }
  return { text: outcome.text, effects };
}

/**
 * Generate one themed EquipDef-shaped item (+ icon prompt). Null on any
 * failure — caller rolls from the static loot tables.
 */
export async function requestGmItem(
  req: GmItemRequest,
): Promise<GeneratedEquip | null> {
  const raw = await post("/gm/item", req);
  if (!isRecord(raw) || !isGeneratedEquip(raw.equip)) return null;
  return raw.equip;
}

/**
 * Client-side mirror of the server's canonical interaction key
 * (stand-powers.md Layer 3): sortedPair(A.id, B.id) + framework version.
 * Kept in sync with api/_lib/powers.ts `resonancePairKey` (asserted equal in
 * tests/gm.spec.ts) — src must not import runtime code from api/.
 */
export function resonancePairKey(
  aId: string,
  bId: string,
  version: number,
): string {
  return `${[aId, bId].sort().join("+")}@v${version}`;
}

/**
 * Ask for the memoized Stand resonance of a power pair (compiling it on
 * first global encounter). A response with `rule: null` is a DEFINITIVE
 * "no resonance" verdict; `null` from this function is a transport failure —
 * caller runs the battle on base rules either way and may retry next battle.
 */
export async function requestGmResonance(
  req: GmResonanceRequest,
): Promise<GmResonanceResponse | null> {
  const raw = await post("/gm/resonance", req);
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.pairKey)) return null;
  if (typeof raw.flavor !== "string" || typeof raw.announce !== "string") {
    return null;
  }
  if (raw.source !== "generated" && raw.source !== "pool") return null;
  if (raw.rule !== null && !isRuleBody(raw.rule)) return null;
  return {
    pairKey: raw.pairKey,
    rule: raw.rule as InteractionRule | null,
    flavor: raw.flavor,
    announce: raw.announce,
    firstDiscoveredBy: isNonEmptyString(raw.firstDiscoveredBy)
      ? raw.firstDiscoveredBy
      : undefined,
    source: raw.source,
  };
}

/* ------------------------------------------------------------------------ */
/* Resonance cache (run-scoped, fire-and-forget)                             */
/* ------------------------------------------------------------------------ */

/**
 * Definitive resonance verdicts by pairKey (a stored `rule: null` is a
 * definitive "no resonance"). Session-scoped: resonances are globally
 * memoized server-side, so keeping them across runs is free and correct.
 */
const resonanceVerdicts = new Map<string, GmResonanceResponse>();
const resonanceInFlight = new Set<string>();

/**
 * The cached verdict for a pair, or undefined when it has not been fetched
 * (yet). Battle setup attaches `rule` when present; a `rule: null` verdict
 * means the pair definitively does not resonate.
 */
export function getCachedResonance(
  pairKey: string,
): GmResonanceResponse | undefined {
  return resonanceVerdicts.get(pairKey);
}

/**
 * Fire-and-forget resonance lookup/compilation for a power pair. Never
 * awaited by battle setup (zero latency added); a transport failure simply
 * clears the in-flight mark so the NEXT battle retries. The compiled rule
 * applies from the next battle featuring the pair (stand-powers.md L3).
 *
 * Gated on the reachability probe, like every other GM call. Without this it
 * was the ONE request that went out to a deployment known to be absent, so an
 * offline player got a red 404 in the console on every battle that paired two
 * Stand powers. The probe is resolved once per session and cached, so when a
 * GM *is* up this costs nothing and the request goes out exactly as before.
 */
export function prefetchResonance(a: PowerScript, b: PowerScript): void {
  const pairKey = resonancePairKey(a.id, b.id, a.version);
  if (resonanceVerdicts.has(pairKey) || resonanceInFlight.has(pairKey)) return;
  resonanceInFlight.add(pairKey);
  void probeGm()
    .then(async (up) => {
      if (!up) return;
      const res = await requestGmResonance({ pairKey, powers: [a, b] });
      if (res && res.pairKey === pairKey) resonanceVerdicts.set(pairKey, res);
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

/**
 * Ask the director for floor-transition nudges. Null on any failure —
 * caller proceeds with the un-nudged defaults.
 */
export async function requestGmSteer(
  req: GmSteerRequest,
): Promise<GmSteerNudges | null> {
  const raw = await post("/gm/steer", req);
  if (!isRecord(raw) || !isSteerNudges(raw.nudges)) return null;
  return raw.nudges;
}
