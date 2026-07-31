/**
 * Style contract invariants (docs/design/visual-v2.md §Style contract):
 * one versioned source of truth for BOTH batch pipelines and the runtime DM,
 * plus the prompt composition that consumes it.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ART_STYLE, type ArtCategory } from "../src/content/artStyle.js";
import { composeArtPrompt } from "../src/services/artPrompt.js";

const CATEGORIES: ArtCategory[] = ["battleSprite", "icon", "tile", "scene"];

describe("ART_STYLE contract", () => {
  it("is versioned (v1) so every asset row can record styleVersion", () => {
    expect(ART_STYLE.version).toBe(1);
    expect(Number.isInteger(ART_STYLE.version)).toBe(true);
  });

  it("carries a non-empty cel-shading basePrompt with the keying background", () => {
    expect(ART_STYLE.basePrompt.length).toBeGreaterThan(50);
    expect(ART_STYLE.basePrompt).toMatch(/cel-shading/i);
    expect(ART_STYLE.basePrompt).toMatch(/#1a1626/);
    expect(ART_STYLE.negative.trim().length).toBeGreaterThan(0);
  });

  it("pins the model pair from the visual-v2 pilot findings", () => {
    expect(ART_STYLE.model).toBe("gpt-image-2");
    expect(ART_STYLE.fallbackModel).toBe("gemini-3-pro-image-preview");
  });

  it("palette entries are #rrggbb hexes and include the keying background", () => {
    const entries = Object.entries(ART_STYLE.palette);
    expect(entries.length).toBeGreaterThan(0);
    for (const [, hex] of entries) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(ART_STYLE.palette.background).toBe("#1a1626");
  });

  it("has a framing prompt for all four categories", () => {
    for (const category of CATEGORIES) {
      expect(ART_STYLE.framing[category].trim().length).toBeGreaterThan(20);
    }
  });

  it("anchorUrl points at the deployed style anchor, and the file deploys", () => {
    expect(ART_STYLE.anchorUrl).toBe("/art/style-anchor-bruno.png");
    // public/ is served at the site root, so the URL resolves iff this exists:
    const deployed = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "public",
      "art",
      "style-anchor-bruno.png",
    );
    expect(existsSync(deployed)).toBe(true);
  });
});

describe("composeArtPrompt", () => {
  it("builds subject + category framing + basePrompt + negatives", () => {
    for (const category of CATEGORIES) {
      const prompt = composeArtPrompt(category, "a tin bell on a red ribbon.");
      expect(prompt.startsWith("a tin bell on a red ribbon.")).toBe(true);
      expect(prompt).toContain(ART_STYLE.framing[category]);
      expect(prompt).toContain(ART_STYLE.basePrompt);
      expect(prompt).toContain(ART_STYLE.negative);
    }
  });

  it("normalizes trailing punctuation so prompts never double up periods", () => {
    const a = composeArtPrompt("icon", "a chewed sock");
    const b = composeArtPrompt("icon", "a chewed sock.  ");
    expect(a).toBe(b);
    expect(a).not.toContain("..");
  });
});
