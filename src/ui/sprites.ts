/**
 * Visual v2 — generated-sprite registry (docs/design/visual-v2.md).
 *
 * Loads `public/assets/gen/manifest.json` once at boot and resolves every
 * listed file through pixi `Assets.load`. The manifest contract (shared with
 * the asset package) is:
 *
 *   { "version": 1, "sprites": { "<id>": { "file": "x.png", "w": 1024, "h": 1024 } } }
 *
 * with ids `cat:bruno|pixel|mora|baguette`, `portrait:<same>`,
 * `enemy:<enemyId>`, `boss:<bossId>`, `title:hero`. Images are square PNGs on
 * flat #1a1626 (PAL.bgDeep) so they blend into scene backgrounds untouched.
 *
 * EVERYTHING here is fail-soft: a missing manifest, a 404'd file or a
 * malformed entry just means "no sprite" — accessors return null and the
 * procedural draw/* renderers stay in charge. This module never throws.
 */
import { Assets, Texture } from "pixi.js";
import type { ClassId } from "../core/types";
import { CLASSES } from "../content/classes";
import { ENEMIES } from "../content/enemies";

interface ManifestSprite {
  file: string;
  w: number;
  h: number;
}

const textures = new Map<string, Texture>();
let initStarted = false;

const base = (): string => {
  const b: unknown = import.meta.env?.BASE_URL;
  return typeof b === "string" ? b : "/";
};

/**
 * Fetch the manifest and load every referenced texture. Call once from
 * main.ts before the first scene mounts. Tolerates 404 / network failure /
 * bad JSON — resolves either way, never rejects.
 */
export async function initSprites(): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  let sprites: Record<string, ManifestSprite> = {};
  try {
    const res = await fetch(`${base()}assets/gen/manifest.json`, {
      cache: "no-cache",
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      version?: unknown;
      sprites?: unknown;
    };
    if (
      !data ||
      data.version !== 1 ||
      typeof data.sprites !== "object" ||
      data.sprites === null
    ) {
      return;
    }
    sprites = data.sprites as Record<string, ManifestSprite>;
  } catch {
    return; // absent/unreachable manifest = fully procedural game
  }
  await Promise.all(
    Object.entries(sprites).map(async ([id, s]) => {
      if (!s || typeof s.file !== "string" || s.file === "") return;
      try {
        const tex = await Assets.load<Texture>(`${base()}assets/gen/${s.file}`);
        if (tex instanceof Texture) textures.set(id, tex);
      } catch {
        /* one bad file never blocks the rest */
      }
    }),
  );
}

/** Is a generated texture available for this manifest id? */
export function hasSprite(id: string): boolean {
  return textures.has(id);
}

/** The loaded texture for a manifest id, or null when absent. */
export function spriteTextureFor(id: string): Texture | null {
  return textures.get(id) ?? null;
}

/** Manifest ids are keyed by cat NAME ('cat:bruno'), not class id. */
const catKey = (classId: ClassId): string =>
  CLASSES[classId].catName.toLowerCase();

/** Battle sprite for a cat class ('cat:bruno' …), or null. */
export function catTexture(classId: ClassId): Texture | null {
  return spriteTextureFor(`cat:${catKey(classId)}`);
}

/** HUD portrait for a cat class ('portrait:bruno' …), or null. */
export function portraitTexture(classId: ClassId): Texture | null {
  return spriteTextureFor(`portrait:${catKey(classId)}`);
}

/**
 * Battle sprite for an enemy species. Bosses publish under 'boss:<id>'
 * (with 'enemy:<id>' accepted as a fallback), everyone else under
 * 'enemy:<id>'.
 */
export function enemyTexture(speciesId: string): Texture | null {
  if (speciesId === "") return null;
  const def = ENEMIES[speciesId];
  const isBoss = def?.boss !== undefined || def?.look.sizeGrade === "boss";
  if (isBoss) {
    return (
      spriteTextureFor(`boss:${speciesId}`) ??
      spriteTextureFor(`enemy:${speciesId}`)
    );
  }
  return spriteTextureFor(`enemy:${speciesId}`);
}
