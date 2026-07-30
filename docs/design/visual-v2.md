# Visual Direction v2 — "Nine Lives, Bizarre Basement"

Supersedes `ui-art.md`'s procedural-only art direction. The procedural Graphics
renderers stay in the codebase as **fallbacks** (and for tiles/UI chrome), but
characters, Stands, enemies and key illustrations become **AI-generated assets**
produced with the Masonry CLI (see `.claude/skills/sprite-generation/SKILL.md`).

## Theme pivot

Cats × bizarre-adventure shonen energy:

- Every cat and every enemy has a **Stand** (spectral patron) — a translucent
  figure looming behind them that embodies their power. Skills are Stand
  abilities; the Cat Pile becomes a synchronized Stand barrage.
- Tone: dramatic, over-the-top, slightly absurd. Menacing auras, dramatic poses,
  named attacks announced in the battle log ("THE DUMPSTER KING descends!").
- Player-imagined cats: at run start the player can describe their cats and
  powers in free text; the GM service (see `gm-system.md`) turns them into
  legal kits and Masonry generates their portraits/sprites. The four default
  strays (Bruno/Pixel/Mora/Baguette) remain as the offline/instant option,
  rethemed with canonical Stands.

## Art style bible

- Anime cel-shading, bold ink outlines, dramatic rim light, gritty 90s OVA
  flavor; subtle menacing-aura sparks. NOT chibi, NOT pixel art, NOT flat vector.
- Characters: cat solid and crisp in front; Stand translucent purple/gold energy
  looming behind. Single character (cat+Stand pair) per battle sprite.
- Background in generated assets: flat `#1a1626` (PAL.void) for clean keying.
- Model findings (pilot 2026-07): **Nano Banana Pro / NB2** for original
  character design quality; **GPT Image 2** for anchor-faithful edits and layout
  obedience (use it when generating variants/animation strips FROM an approved
  anchor). Wide aspect for strips, never 1:1.

## Asset list (initial batch)

| Asset | Count | Source |
|---|---|---|
| Default cat battle sprites (cat+Stand) | 4 | NB Pro, from approved style anchor |
| Cat portraits (head, for HUD) | 4 | crop or dedicated gen |
| Enemy sprites per species (+ Stand for elites/bosses) | ~11 | NB Pro |
| Boss sprites (Vacuum King, Dogfather + escort) | 3 | NB Pro |
| Title hero illustration | 1 | NB Pro |
| Event scene illustrations | 10 (one per event) | NB Pro, generated lazily |
| Item icons | on the fly | GM + Masonry at runtime (see gm-system.md) |

Runtime-generated content (player stands, GM items/events) gets its art
generated server-side via Masonry and cached in the shared content pool.

## Pipeline

1. Generate at 1024×1024 on `#1a1626`, key out background → transparent PNG.
2. Downscale to in-game size (battle sprites ~340px tall @2x for 170px slots).
3. Store under `public/assets/gen/` with a `manifest.json` (id → file, size,
   anchor). Load via `Assets.load`.
4. `src/ui/draw/*` renderers become fallback when an asset id is missing —
   the game must remain fully playable with zero generated assets.

## Integration points

- `drawCat`/`drawEnemy` call sites go through a new `spriteFor(id, pose)`
  resolver: generated texture if present, procedural fallback otherwise.
- Idle/hit animation: gentle code-driven motion (breathing scale, tilt, aura
  pulse via additive-blend glow) instead of frame strips for v1; strips are a
  later upgrade using the GPT Image 2 anchored-strip pipeline.
