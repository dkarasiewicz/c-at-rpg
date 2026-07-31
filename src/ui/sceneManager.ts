/**
 * WP-09 — Scene/Overlay lifecycle (ARCHITECTURE.md §3): one SceneManager
 * owns the pixi stage. Full scene swaps (`goto` destroys the outgoing
 * scene), max ONE overlay (never stacked), ticker gating (the underlying
 * scene's update is skipped while an overlay is up and its layers get
 * `interactiveChildren = false`), and the gameloop.md §1 FSM transition
 * table as a static legality guard — illegal `goto` throws in dev, no-ops
 * in prod.
 *
 * This module is pixi-free at runtime (type-only imports) so the FSM is
 * unit-testable headless.
 */
import type { Container } from "pixi.js";
import type { MetaFile, RunState } from "../core/types.js";

/* ---------------------------------------------------------------------- */
/* Contract types (ARCHITECTURE.md §3.1 — UI-layer, not in core/types.ts)  */
/* ---------------------------------------------------------------------- */

export type SceneId =
  | "boot"
  | "title"
  | "partyCreator"
  | "floorgen"
  | "explore"
  | "battle"
  | "event"
  | "landing"
  | "results";

export type OverlayId = "loot" | "pause";

export interface GameCtx {
  /** THE shared mutable state; scenes communicate only through it. */
  run: RunState | null;
  scenes: SceneManager;
  /** core/run/save.ts wrapper — called at the 5 autosave points. */
  save(): void;
  meta: MetaFile;
}

export interface Scene {
  mount(root: Container, ctx: GameCtx, params?: unknown): void;
  /** MUST destroy all owned display objects + tickers. */
  unmount(): void;
  /** Called by the shared ticker while topmost. */
  update?(dtMs: number): void;
  /** true = consumed. */
  onKey?(key: string): boolean;
}

/** Overlays share the Scene lifecycle shape; they mount into `modal`. */
export type Overlay = Scene;

export interface SceneManager {
  /** Full swap: unmount old, mount new (any overlay is popped first). */
  goto(id: SceneId, params?: unknown): void;
  pushOverlay(id: OverlayId, params?: unknown): void;
  popOverlay(): void;
  current: SceneId;
  overlay: OverlayId | null;
}

export type SceneFactories = Record<SceneId, () => Scene>;
export type OverlayFactories = Record<OverlayId, () => Overlay>;

/* ---------------------------------------------------------------------- */
/* Layer stack (ARCHITECTURE.md §3.4 / ui-art §1)                          */
/* ---------------------------------------------------------------------- */

/** Children of root, bottom→top; scenes attach to these by label. */
export const LAYER_NAMES = [
  "bg",
  "world",
  "fx",
  "hud",
  "floaters",
  "modal",
  "flash",
] as const;

export type LayerName = (typeof LAYER_NAMES)[number];

/** Layers that stay interactive beneath an overlay. */
const OVERLAY_LAYERS: readonly string[] = ["modal", "flash"];

/** Look a named layer up on the root container (labels set by main.ts). */
export function layer(root: Container, name: LayerName): Container {
  const found = root.children.find((c) => c.label === name);
  if (!found) throw new Error(`missing layer '${name}' on root`);
  return found as Container;
}

/* ---------------------------------------------------------------------- */
/* FSM transition table (gameloop.md §1, LANDING per GDD §7 ruling)        */
/* ---------------------------------------------------------------------- */

/**
 * goto legality: `TRANSITIONS[from]` lists every legal target.
 *  - title → floorgen (New Run) | explore (Continue restores mid-floor) |
 *    partyCreator ([C] Create your party)
 *  - partyCreator → floorgen (accept / GM-offline fallback) | title (Esc)
 *  - explore → battle / event / landing, or results (Abandon via pause)
 *  - battle → explore (victory-after-loot / flee) | results (defeat, floor-6
 *    win, abandon)
 *  - event → explore | battle (ambush fight) | results (abandon)
 *  - landing → floorgen (Descend) | results (abandon)
 *  - results → floorgen (Again / New Seed) | title
 * LOOT and PAUSE are overlays, not states.
 */
export const TRANSITIONS: Record<SceneId, readonly SceneId[]> = {
  boot: ["title"],
  title: ["floorgen", "explore", "partyCreator"],
  partyCreator: ["floorgen", "title"],
  floorgen: ["explore"],
  explore: ["battle", "event", "landing", "results"],
  battle: ["explore", "results"],
  event: ["explore", "battle", "results"],
  landing: ["floorgen", "results"],
  results: ["floorgen", "title"],
};

/** Esc opens pause from every scene except these (§3.1; partyCreator has
 *  no run — its Esc navigates back to the title instead). */
export const PAUSE_BLOCKED: readonly SceneId[] = [
  "boot",
  "results",
  "partyCreator",
];

/* ---------------------------------------------------------------------- */
/* Implementation                                                          */
/* ---------------------------------------------------------------------- */

export interface SceneManagerHandle extends SceneManager {
  /** Wire the (circular) GameCtx after construction, before first goto. */
  bind(ctx: GameCtx): void;
  /** Shared-ticker hook: updates the topmost (overlay else scene). */
  update(dtMs: number): void;
  /**
   * Key routing (§3.3): overlay first (which swallows everything while up
   * — freeze semantics; its own Esc default is close), then the scene,
   * then the global Esc-opens-pause fallback.
   */
  handleKey(key: string): boolean;
}

export function createSceneManager(
  root: Container,
  scenes: SceneFactories,
  overlays: OverlayFactories,
  opts: { strict?: boolean } = {},
): SceneManagerHandle {
  const strict = opts.strict ?? !!import.meta.env?.DEV;
  let ctx: GameCtx | null = null;
  let scene: Scene | null = null;
  let overlayScene: Overlay | null = null;

  const requireCtx = (): GameCtx => {
    if (!ctx) throw new Error("SceneManager: bind(ctx) before use");
    return ctx;
  };

  const setFrozen = (frozen: boolean): void => {
    for (const child of root.children) {
      if (!OVERLAY_LAYERS.includes(child.label ?? "")) {
        (child as Container).interactiveChildren = !frozen;
      }
    }
  };

  const manager: SceneManagerHandle = {
    current: "boot",
    overlay: null,

    bind(c: GameCtx) {
      ctx = c;
    },

    goto(id: SceneId, params?: unknown) {
      if (scene !== null && !TRANSITIONS[manager.current].includes(id)) {
        if (strict) {
          throw new Error(`illegal transition ${manager.current} → ${id}`);
        }
        return; // prod: no-op
      }
      if (overlayScene) manager.popOverlay();
      scene?.unmount();
      manager.current = id;
      scene = scenes[id]();
      scene.mount(root, requireCtx(), params);
    },

    pushOverlay(id: OverlayId, params?: unknown) {
      // Max one overlay, never stacked; pause cannot open over loot (§3.1).
      if (overlayScene) return;
      manager.overlay = id;
      overlayScene = overlays[id]();
      setFrozen(true);
      overlayScene.mount(root, requireCtx(), params);
    },

    popOverlay() {
      if (!overlayScene) return;
      overlayScene.unmount();
      overlayScene = null;
      manager.overlay = null;
      setFrozen(false);
    },

    update(dtMs: number) {
      if (overlayScene) {
        overlayScene.update?.(dtMs);
      } else {
        scene?.update?.(dtMs);
      }
    },

    handleKey(key: string): boolean {
      if (overlayScene) {
        if (overlayScene.onKey?.(key)) return true;
        if (key === "esc") manager.popOverlay(); // loot closes first, etc.
        return true; // frozen scene never sees keys beneath an overlay
      }
      if (scene?.onKey?.(key)) return true;
      if (key === "esc" && !PAUSE_BLOCKED.includes(manager.current)) {
        manager.pushOverlay("pause");
        return true;
      }
      return false;
    },
  };

  return manager;
}
