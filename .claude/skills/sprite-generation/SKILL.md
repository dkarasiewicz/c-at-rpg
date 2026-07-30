---
name: sprite-generation
description: Generate AI sprite animation strips for c(at)rpg characters/enemies from a single anchor frame using the Masonry CLI (Nano Banana 2/Pro, GPT Image, etc.). Use when asked to generate sprites, animation strips, spritesheets, or AI art assets for the game. Triggers on - sprite, spritesheet, animation strip, anchor frame, masonry, nano banana, generate assets.
---

# Sprite generation for c(at)rpg

The key insight: **generate full animation strips from a single anchor frame, not frame-by-frame.** Frame-by-frame generation causes character drift.

## Project specifics

- Anchor frames come from the shipped procedural sprites: run the dev server and open `http://localhost:5173/?gallery=1` (`src/ui/draw/glyphs.ts` gallery renders every cat class in sit/battle/KO poses, every enemy family × size grade, and props). Screenshot with Playwright (installed) and crop the target sprite with PIL.
- Image generation goes through the **Masonry CLI** (`~/.local/bin/masonry`, see `~/.claude/skills/masonry*` for full docs). Anchor-based strips use img2img: `masonry image "<prompt>" -i <canvas.png> --model <key> --aspect 1:1`, then `masonry job wait <id> --download -o <out.png>` (or `wait-many --download --download-dir` for batches).
- Model shortlist: `gemini-3.1-flash-image-preview` (Nano Banana 2 — default, best consistency/price), `gemini-3-pro-image-preview` (Nano Banana Pro — higher fidelity), `gpt-image-2` (good anchor-based editing). Community reports: NB2 beats GPT Image for sprite-sheet consistency; ≤9 objects per request reduces hallucinations.
- **Pilot results (2026-07, Bruno idle strip test):** `gpt-image-2` was the only model that followed layout instructions (single row, anchor kept near-pixel-identical, subtle per-frame motion) — best for anchor-faithful strips. NB2/NB Pro both redesigned the character into their own (nicer) style and produced a 2×2 grid despite explicit one-row instructions — best for *original* character design, not anchoring. For one-row strips use a WIDE canvas/aspect, not 1:1 (models fill square canvases as grids). Free plan = 1 concurrent generation; premium allows parallel jobs.

## Core workflow

### 1. Start from a shipped seed frame

Anchor the model to an actual production sprite, not a loose concept. This locks in palette, proportions, line weight, and shading direction.

### 2. Build a reference canvas

Don't send the raw sprite directly. Upscale with **nearest-neighbor** (PIL `Image.NEAREST`) and place into a larger canvas (1024×1024) with reserved frame slots — e.g. a row of 4 × 256px slots with the anchor in slot 1. The larger canvas gives the model room to generate multi-frame sequences.

### 3. Generate full strips, not individual frames

Request the entire animation strip in one prompt:

```
Generate a [N]-frame [animation_type] animation strip of this character.
Keep the character consistent across all frames.
Arrange frames left-to-right in a single row.
Maintain the same art style, proportions, and color palette.
```

Limit strips to **4–8 frames** per generation for best consistency.

### 4. Normalize into game-ready frames

- Detect individual sprite components in the strip (PIL: background-diff + connected bounding boxes, or fixed slot grid).
- Use the anchor image to compute a **shared scale** for all frames.
- Optionally lock frame 1 to the exact shipped idle frame.
- Export to standard frame size with transparency padding (key out the flat background `#1a1626` / PAL.void).

### 5. Handle complex poses

When one pose is taller than another (sword-up attack vs neutral):
- Use **one global scale** for the entire strip.
- Let pose differences show as extra height inside the frame.
- **Never scale individual frames independently** (causes size inconsistency).

## Tips

- Isometric sprites: still an open challenge — no established best practice.
- Video-to-sprite alternative: image-to-video (e.g. `masonry video -i anchor.png`), then slice frames and realign with OpenCV/PIL.
- In-engine preview before production: PixiJS `AnimatedSprite` from the sliced frames (see pixijs-scene-sprite skill); assets go to `public/assets/`, loaded via `Assets.load`.

## Verification checklist

1. Anchor frame matches the shipped production sprite exactly.
2. All frames share the same global scale.
3. Frame 1 is locked to the original idle sprite.
4. Preview in-engine before marking production-ready.
5. Check for palette drift between first and last frames.
