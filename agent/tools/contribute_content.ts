/**
 * `contribute_content` — the WRITE half of the Dreaming.
 *
 * Everything the DM authors that is worth keeping lands in `catrpg.content`
 * with its payload, style version, floor band and provenance
 * (docs/design/roster-and-persistence.md §5 "The Dreaming"; run-map-and-dm.md
 * §4b; gm-system.md "Persistence: the content pool is the system of record").
 *
 * The one-shot generators (`agent/skills/item.ts`, `agent/skills/event.ts`)
 * answer a schema because the CALLER is the game asking for one, and the game
 * keeps what it asked for. This tool is the other half: when the DM invents
 * something in the middle of a beat — an item it just handed over, an event
 * card it just sketched, a Stand, a cat, an enemy, a floor's backdrop — that
 * content is kept for LATER RUNS AND OTHER PLAYERS, not just this session.
 * That is what makes "the more you play, the more there is" literally true.
 *
 * Four guarantees, in this order:
 *
 *  1. **Validated with the SHIPPED validators.** Events go through `lintEvent`
 *     (= `core/events/validate` + the per-floor `EVENT_CAPS`); items through
 *     `lintItem`; powers through the engine's own `lintPowerScript`. Nothing
 *     bespoke is invented here.
 *  2. **Budget-linted.** Anything carrying mechanical effects is priced by the
 *     same per-floor lint an `apply_effect` request is, so the pool can never
 *     accumulate content stronger than the game allows a DM to author.
 *  3. **Stamped.** Every row carries `styleVersion` (the visual-v2 style
 *     contract it was authored against), a floor band, and `provenance`
 *     (`dm:<reason>`), so a later style bump can find and retire it.
 *  4. **The picture is MADE AND KEPT.** Given an `artUrl` from a generator it
 *     is downloaded and put in the public `catrpg-art` bucket; given only an
 *     `artPrompt` (the usual case — the DM's one-shots return subjects, not
 *     images) the picture is GENERATED here, through `agent/lib/art.ts`, and
 *     then stored the same way. Either road ends at a public bucket URL on the
 *     row, because pointing a row at a generator URL is not persistence — that
 *     picture 404s in a month and the dream is then remembered wrong. Both are
 *     best-effort: no picture never blocks the contribution.
 *
 * A refusal is RETURNED, never thrown: `{ published: false, problems: [...] }`,
 * and the DM narrates what actually happened. A pool that is unreachable is
 * also a refusal — the run continues; publishing is never on the hot path.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { lintEvent, lintItem } from "../../src/services/contentLint.js";
import {
  lintPowerScript,
  normalizePower,
} from "../../src/services/powerLint.js";
import { BUDGET_CAPS } from "../../src/core/combat/powers.js";
import { getPool, type ContentRow, type PoolKind } from "../lib/pool.js";
import { dreamArt, type DreamedArt } from "../lib/art.js";
import { ART_STYLE, type ArtCategory } from "../../src/content/artStyle.js";
import type { GameEvent, Rarity } from "../../src/core/types.js";
import type {
  GeneratedEquip,
  PowerScript,
} from "../../src/services/gmTypes.js";
import { floorSchema } from "../lib/effects.js";

/**
 * The shipped `Rarity` union (loot.md), spelled out for the model. Typed
 * against `Rarity` itself, so a fifth rarity is a compile error here rather
 * than a silently unpublishable contribution.
 */
const RARITIES: [Rarity, ...Rarity[]] = [
  "stray",
  "sleek",
  "pedigree",
  "mewthical",
];

/**
 * What the DM may contribute. `flavour` is kept as the historical spelling for
 * enemy colour and maps to the `enemy` kind; everything else is one-to-one
 * with the `content.kind` CHECK constraint in `supabase/001_init.sql`.
 */
const CONTRIB_KINDS = [
  "item",
  "event",
  "flavour",
  "stand",
  "enemy",
  "encounter",
  "cat",
  "power",
  "background",
] as const;
type ContribKind = (typeof CONTRIB_KINDS)[number];

const KIND_TO_POOL: Record<ContribKind, PoolKind> = {
  item: "items",
  event: "events",
  flavour: "enemies",
  stand: "stands",
  enemy: "enemies",
  encounter: "encounters",
  cat: "cats",
  power: "powers",
  background: "backgrounds",
};

/**
 * Which framing paragraph a contributed thing is drawn with
 * (`ART_STYLE.framing`), so a dreamed item reads as an item icon and a dreamed
 * event reads as a wide event illustration — the same categories the shipped
 * batches used.
 */
const ART_CATEGORY: Record<ContribKind, ArtCategory> = {
  item: "icon",
  power: "icon",
  event: "scene",
  encounter: "scene",
  background: "scene",
  stand: "battleSprite",
  cat: "battleSprite",
  enemy: "battleSprite",
  flavour: "battleSprite",
};

/** Shape check for the kinds with no shipped validator of their own. */
function lintNarrative(
  body: Record<string, unknown>,
  requiredName: string,
): string[] {
  const problems: string[] = [];
  if (typeof body.id !== "string" || !/^[A-Za-z][\w:-]{1,60}$/.test(body.id)) {
    problems.push(`${requiredName} needs an 'id' (2..61 chars, no spaces)`);
  }
  if (
    typeof body.name !== "string" ||
    body.name.trim().length === 0 ||
    body.name.length > 80
  ) {
    problems.push(`${requiredName} needs a 'name' of 1..80 chars`);
  }
  const desc = body.description ?? body.desc ?? body.text;
  if (
    typeof desc !== "string" ||
    desc.trim().length === 0 ||
    desc.length > 600
  ) {
    problems.push(`${requiredName} needs a 'description' of 1..600 chars`);
  }
  return problems;
}

export default defineTool({
  description:
    "Publish something you authored during play into the SHARED pool, so " +
    "later runs and other players get it too — a Stand, a cat, an item, an " +
    "event card, an enemy, an encounter, a power, a floor's backdrop. It is " +
    "validated with the game's own validators and budget-linted before it is " +
    "stored; { published: false } means it did not pass and the world simply " +
    "does not keep it — narrate the beat anyway. This never changes THIS " +
    "run: `grant_item` / `apply_effect` are what touch the party.",
  inputSchema: z.object({
    floor: floorSchema,
    reason: z
      .string()
      .min(1)
      .max(200)
      .describe("what in this run produced it, in one line"),
    kind: z.enum(CONTRIB_KINDS).describe("what you are contributing"),
    /** Free-form JSON body. Shape is checked per `kind` below. */
    payload: z
      .string()
      .min(2)
      .max(6000)
      .describe(
        "the content itself as a JSON string: an EquipDef+iconPrompt for " +
          "'item', a GameEvent for 'event', a PowerScript for 'power', " +
          '{"subject":"<enemy or species id>","text":"<1-2 sentences>"} for ' +
          "'flavour', and { id, name, description, ... } for 'stand' / " +
          "'cat' / 'enemy' / 'encounter' / 'background'",
      ),
    rarity: z
      .enum(RARITIES)
      .optional()
      .describe("required for 'item' — the rarity the item is priced at"),
    floorMax: floorSchema
      .optional()
      .describe(
        "highest floor this belongs on; defaults to the floor it was born " +
          "on for events (which carry their own band) and to 6 otherwise",
      ),
    artUrl: z
      .string()
      .url()
      .max(2000)
      .optional()
      .describe(
        "a generated image for this thing. It is downloaded and re-hosted " +
          "in the game's own art bucket, so the dream keeps its picture.",
      ),
    artPrompt: z
      .string()
      .max(1000)
      .optional()
      .describe("the subject-only prompt the image was generated from"),
  }),
  async execute({
    floor,
    reason,
    kind,
    payload,
    rarity,
    floorMax,
    artUrl,
    artPrompt,
  }) {
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return {
        kind: "contribution" as const,
        published: false,
        problems: ["payload is not valid JSON"],
      };
    }
    if (typeof body !== "object" || body === null) {
      return {
        kind: "contribution" as const,
        published: false,
        problems: ["payload must be a JSON object"],
      };
    }
    const obj = body as Record<string, unknown>;

    // ---- validate with the SHIPPED validators --------------------------
    const problems: string[] = [];
    const poolKind = KIND_TO_POOL[kind];
    let ref = "?";
    let bandMin = floor;
    let bandMax = floorMax ?? 6;
    let stored: unknown = obj;

    switch (kind) {
      case "item": {
        if (!rarity) {
          return {
            kind: "contribution" as const,
            published: false,
            problems: ["'item' contributions must declare a rarity"],
          };
        }
        const equip = obj as unknown as GeneratedEquip;
        problems.push(...lintItem(equip, rarity));
        ref = typeof equip?.id === "string" ? equip.id : "?";
        stored = { rarity, equip };
        break;
      }
      case "event": {
        const event = obj as unknown as GameEvent;
        problems.push(...lintEvent(event));
        // §4b keeps DM-authored events inside the floor band they were born
        // in: an event written for the laundromat has no business surfacing
        // in the sunbeam.
        if (
          !Array.isArray(event?.floors) ||
          event.floors[0] > floor ||
          floor > event.floors[1]
        ) {
          problems.push(`event's floors do not cover floor ${floor}`);
        } else {
          bandMin = event.floors[0];
          bandMax = event.floors[1];
        }
        ref = typeof event?.id === "string" ? event.id : "?";
        break;
      }
      case "power": {
        // The engine's own pricing, at the most generous shipped cap; the
        // client re-lints against the *specific* owner's cap at battle setup.
        const normalized = normalizePower(obj as unknown as PowerScript);
        problems.push(
          ...lintPowerScript(
            normalized,
            Math.max(BUDGET_CAPS.cat, BUDGET_CAPS.enemyByTier[3]),
          ),
        );
        ref = normalized.id;
        stored = normalized;
        break;
      }
      case "flavour": {
        const f = obj as { subject?: unknown; text?: unknown };
        if (typeof f?.subject !== "string" || f.subject.length === 0) {
          problems.push("flavour needs a 'subject'");
        }
        if (
          typeof f?.text !== "string" ||
          f.text.trim().length === 0 ||
          f.text.length > 400
        ) {
          problems.push("flavour 'text' must be 1..400 chars");
        }
        ref = typeof f?.subject === "string" ? f.subject : "?";
        stored = { flavour: f };
        break;
      }
      default: {
        // stand / cat / enemy / encounter / background — narrative content the
        // engine renders but does not execute, so a shape check plus the
        // stamping below is the whole contract.
        problems.push(...lintNarrative(obj, kind));
        ref = typeof obj.id === "string" ? obj.id : "?";
        break;
      }
    }
    if (bandMax < bandMin) bandMax = bandMin;
    if (problems.length > 0) {
      return { kind: "contribution" as const, published: false, problems };
    }

    // ---- art: make it ours before the row is written ---------------------
    const pool = getPool();
    const provenance = `dm:${reason}`.slice(0, 240);
    const artKey = `${kind === "flavour" ? "enemy" : kind}:${ref}`;
    // A subject-only description to draw from. `artPrompt` is what the DM
    // passes deliberately; `iconPrompt` / `visualPrompt` are what the shipped
    // one-shot schemas already produce, so an item authored by
    // `agent/skills/item.ts` gets a picture without the DM doing anything new.
    const subject =
      artPrompt ??
      (typeof obj.iconPrompt === "string" ? obj.iconPrompt : undefined) ??
      (typeof obj.visualPrompt === "string" ? obj.visualPrompt : undefined);

    let hostedArt: string | null = null;
    let generated: DreamedArt | null = null;
    if (artUrl) {
      hostedArt = await pool.rehostArt(
        `${poolKind}/${ref.replace(/[^\w.-]+/g, "_")}-v${ART_STYLE.version}.png`,
        artUrl,
      );
    } else if (subject) {
      // No image was handed over, only words. Draw it — otherwise this row
      // lands with `art_url = null` forever and the dream has no face.
      generated = await dreamArt(pool, {
        key: artKey,
        category: ART_CATEGORY[kind],
        subject,
      });
      hostedArt = generated?.url ?? null;
    }

    // ---- stamp and store ------------------------------------------------
    const row: ContentRow = {
      id: `${kind === "flavour" ? "enemy" : kind}:${ref}`.slice(0, 200),
      kind: poolKind,
      payload: {
        ...(stored as object),
        styleVersion: ART_STYLE.version,
        provenance,
        floor,
      },
      artUrl: hostedArt,
      // The FULL composed prompt when we drew it ourselves (that is what would
      // redraw it), the DM's subject line otherwise.
      artPrompt: generated?.prompt ?? subject ?? null,
      styleVersion: ART_STYLE.version,
      floorMin: bandMin,
      floorMax: bandMax,
      provenance,
    };

    let ok = false;
    try {
      ok = await pool.addContent(row);
    } catch {
      ok = false;
    }
    if (!ok) {
      // The pool is best-effort: a run must never fail because a shared store
      // was unreachable (gm-system.md "no hard dependency").
      return {
        kind: "contribution" as const,
        published: false,
        problems: ["the shared pool is unreachable right now"],
      };
    }
    return {
      kind: "contribution" as const,
      published: true,
      problems: [] as string[],
      pool: poolKind,
      id: row.id,
      ref,
      floors: [bandMin, bandMax] as [number, number],
      artUrl: hostedArt,
      artRehosted: Boolean(artUrl) && hostedArt !== null,
      artGenerated: generated !== null,
      durable: pool.durable,
      styleVersion: ART_STYLE.version,
      provenance,
    };
  },
});
