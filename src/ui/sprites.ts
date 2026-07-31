/**
 * Visual v2 — generated-sprite registry (docs/design/visual-v2.md).
 *
 * Loads ALL FOUR asset manifests once at boot — the root
 * `public/assets/gen/manifest.json` plus the `env/`, `items/` and `scenes/`
 * sub-manifests — and resolves every listed file through pixi `Assets.load`
 * into one id → texture registry. The manifest contract (shared with the
 * asset packages) is, per directory:
 *
 *   { "version": 1, "sprites": { "<id>": { "file": "x.png", "w": 512, "h": 512 } } }
 *
 * Id namespaces: root `cat:* portrait:* enemy:* boss:* title:hero`,
 * env `tile:* prop:* token:*`, items `item:* equip:*`, scenes `scene:*`.
 * Root/battle images are square PNGs on flat #1a1626 (PAL.bgDeep); env
 * tiles are opaque 512² squares, props/tokens are alpha-keyed.
 *
 * EVERYTHING here is fail-soft, each manifest independently: a missing
 * manifest, a 404'd file or a malformed entry just means "no sprite" —
 * accessors return null and the procedural draw/* renderers stay in
 * charge. This module never throws.
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

/** The four manifest directories, relative to `assets/gen/`. */
const MANIFEST_DIRS = ["", "env/", "items/", "scenes/"] as const;

/**
 * Fetch one directory's manifest and load every referenced texture into
 * the shared registry. Tolerates 404 / network failure / bad JSON —
 * resolves either way, never rejects.
 */
async function loadManifestDir(dir: string): Promise<void> {
  let sprites: Record<string, ManifestSprite> = {};
  try {
    const res = await fetch(`${base()}assets/gen/${dir}manifest.json`, {
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
    return; // absent/unreachable manifest = procedural fallback for this dir
  }
  await Promise.all(
    Object.entries(sprites).map(async ([id, s]) => {
      if (!s || typeof s.file !== "string" || s.file === "") return;
      try {
        const tex = await Assets.load<Texture>(
          `${base()}assets/gen/${dir}${s.file}`,
        );
        if (tex instanceof Texture) textures.set(id, tex);
      } catch {
        /* one bad file never blocks the rest */
      }
    }),
  );
}

/**
 * Load all four manifests (root + env + items + scenes), each fail-soft
 * independently. Call once from main.ts before the first scene mounts.
 * Never rejects.
 */
export async function initSprites(): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  await Promise.all(MANIFEST_DIRS.map((d) => loadManifestDir(d)));
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
