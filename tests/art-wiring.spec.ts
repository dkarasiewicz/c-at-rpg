/**
 * ART ↔ CALL-SITE WIRING.
 *
 * The UI derives its manifest ids from CONTENT ids, by hand, in string
 * templates that no compiler can check:
 *
 *   skill card icon   `skill:${skill.id}`      (ui/scenes/battle.ts,
 *                                               ui/overlays/progressPanel.ts)
 *   status chip glyph `status:${statusId}`     (ui/widgets.ts statusSpriteId)
 *   gear icon         `equip:${defId}`         (ui/overlays/inventoryPanel.ts
 *                                               itemSpriteId)
 *   unknown bestiary  `bestiary:unknown`       (ui/widgets.ts)
 *
 * A typo, a renamed skill or a new collar silently becomes "no art" —
 * fail-soft by design, invisible in a test run, and a whole icon pack turning
 * into dead weight in the repo. So this spec walks both directions: every id
 * a call site can ask for is in the manifest with a file on disk, and every
 * `skill:`/`status:` id in the manifest is one some call site can ask for.
 *
 * (Rendering stays fail-soft regardless — nothing here runs in the browser.
 * This is a contract on what the repo SHIPS, not a runtime requirement.)
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKILLS } from "../src/content/skills.js";
import { EQUIP_DEFS } from "../src/content/equipment.js";
import type { StatusId } from "../src/core/types.js";

/**
 * `StatusId` is a bare union with no runtime list beside it, and the one
 * table that enumerates it (`ui/widgets.ts` STATUS_STYLE) drags pixi into a
 * headless run. So the list lives here, and the `Record<StatusId, true>`
 * below makes the COMPILER fail the moment a status is added without a
 * glyph id — the exhaustiveness check is the point of it.
 */
const STATUS_IDS = [
  "scratched",
  "frazzled",
  "offBalance",
  "guarded",
  "provoked",
  "mending",
  "braced",
] as const satisfies readonly StatusId[];
const _exhaustive: Record<StatusId, true> = {
  scratched: true,
  frazzled: true,
  offBalance: true,
  guarded: true,
  provoked: true,
  mending: true,
  braced: true,
};
void _exhaustive;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ITEMS_DIR = path.join(ROOT, "public", "assets", "gen", "items");

interface ManifestSprite {
  file: string;
  w: number;
  h: number;
}

const manifest = (): Record<string, ManifestSprite> => {
  const raw = readFileSync(path.join(ITEMS_DIR, "manifest.json"), "utf8");
  const data = JSON.parse(raw) as {
    version: number;
    sprites: Record<string, ManifestSprite>;
  };
  expect(data.version).toBe(1);
  return data.sprites;
};

describe("generated icons ↔ the ids the UI asks for", () => {
  it("every skill has a `skill:<skillId>` icon (battle cards + The Den)", () => {
    const sprites = manifest();
    const missing = Object.keys(SKILLS).filter(
      (id) => sprites[`skill:${id}`] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("no `skill:*` icon names a skill that does not exist", () => {
    const orphans = Object.keys(manifest())
      .filter((k) => k.startsWith("skill:"))
      .map((k) => k.slice("skill:".length))
      .filter((id) => SKILLS[id] === undefined);
    expect(orphans).toEqual([]);
  });

  it("every status has a `status:<statusId>` glyph, and no glyph is orphaned", () => {
    const sprites = manifest();
    const missing = STATUS_IDS.filter(
      (id) => sprites[`status:${id}`] === undefined,
    );
    expect(missing).toEqual([]);
    const known = new Set<string>(STATUS_IDS);
    const orphans = Object.keys(sprites)
      .filter((k) => k.startsWith("status:"))
      .map((k) => k.slice("status:".length))
      .filter((id) => !known.has(id));
    expect(orphans).toEqual([]);
  });

  it("every equipment def has an `equip:<defId>` icon (weapons, trinkets, collars)", () => {
    const sprites = manifest();
    const missing = Object.keys(EQUIP_DEFS).filter(
      (id) => sprites[`equip:${id}`] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("every Mewthical uniqueId also has art — that is the id `itemSpriteId` swaps to", () => {
    const sprites = manifest();
    const missing = Object.values(EQUIP_DEFS)
      .map((d) => d.uniqueId)
      .filter((u): u is string => typeof u === "string" && u !== "")
      .filter((u) => sprites[`equip:${u}`] === undefined);
    expect(missing).toEqual([]);
  });

  it("the bestiary silhouette is published", () => {
    expect(manifest()["bestiary:unknown"]).toBeDefined();
  });

  it("every file the items manifest declares is actually on disk", () => {
    const sprites = manifest();
    const gone = Object.entries(sprites)
      .filter(([, s]) => !existsSync(path.join(ITEMS_DIR, s.file)))
      .map(([id]) => id);
    expect(gone).toEqual([]);
  });
});
