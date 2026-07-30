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
import type { GameEvent, Skill, Stats } from "../core/types";
import { validateEvents } from "../core/events/validate";
import type {
  GeneratedCatKit,
  GeneratedEquip,
  GmEventRequest,
  GmItemRequest,
  GmPartyRequest,
  GmSteerNudges,
  GmSteerRequest,
} from "./gmTypes";

const TIMEOUT_MS = 8000;

let baseUrl: string =
  (import.meta.env?.VITE_GM_URL as string | undefined) ?? "/api";

/** Point the client at a non-default GM deployment (tests, previews). */
export function setGmBaseUrl(url: string): void {
  baseUrl = url.replace(/\/$/, "");
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
  return true;
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
