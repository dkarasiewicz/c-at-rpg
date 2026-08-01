import { describe, expect, it } from "vitest";
import { verdictFromToolCalls } from "../src/services/dm.js";
import { validateEncounterVerdict } from "../src/services/tabletop.js";

describe("a DM answer expressed as TOOL CALLS reaches the engine", () => {
  it("translates a combat-shaped apply_effect into an applied event effect", () => {
    // exactly what the deployed agent does out of combat
    const calls = [
      {
        name: "narrate",
        input: {
          text: "The grate gives with a shriek of rust.",
          tone: "ominous",
        },
      },
      {
        name: "apply_effect",
        input: {
          floor: 2,
          reason: "prying",
          effects: [
            { kind: "damage", target: "self", pct: 20 },
            { kind: "status", target: "self", status: "scratched", value: 1 },
          ],
        },
      },
    ];
    const raw = verdictFromToolCalls(calls, "");
    const check = validateEncounterVerdict(raw, 2);
    // Before the translation the `status` member made the WHOLE verdict
    // illegal, so the damage beside it was thrown away too.
    expect(check.resolved).toBe(true);
    expect(check.applied).toBe(true);
    expect(check.verdict?.effects.length).toBeGreaterThan(0);
    expect(check.verdict?.effects[0]?.kind).toBe("damage");
  });

  it("a shinies gain survives the whole chain", () => {
    const raw = verdictFromToolCalls(
      [
        {
          name: "narrate",
          input: {
            text: "Six shinies plink into the puddle.",
            tone: "deadpan",
          },
        },
        {
          name: "adjust_shinies",
          input: { floor: 2, amount: 6, reason: "loose fitting" },
        },
      ],
      "",
    );
    const check = validateEncounterVerdict(raw, 2);
    expect(check.applied).toBe(true);
    expect(check.verdict?.effects.some((e) => e.kind === "shinies")).toBe(true);
  });

  it("a refusal still does not resolve", () => {
    const raw = verdictFromToolCalls(
      [
        {
          name: "narrate",
          input: { text: "You cannot fly. You are a cat.", tone: "refusal" },
        },
      ],
      "",
    );
    const check = validateEncounterVerdict(raw, 1);
    expect(check.resolved).toBe(false);
  });
});
