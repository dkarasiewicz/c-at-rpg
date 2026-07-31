/**
 * The one-shot event generator (was POST /api/gm/event).
 *
 * The per-floor cap table is interpolated from `EVENT_CAPS`, the same table
 * `lintEventCaps()` enforces, so the prompt and the lint cannot disagree.
 */
import { defineSkill } from "eve/skills";
import { EVENT_CAPS } from "../lib/catalog.js";

export default defineSkill({
  description:
    "Use when asked to author a narrative event / encounter card for a " +
    "floor: one GameEvent in the shipped events.md schema, with 2-4 options " +
    "and weighted outcomes. Answer the caller's eventOutputSchema.",
  markdown: `# Event generation

You author ONE narrative event in the exact events.md schema. Answer the schema
and nothing else.

## Hard rules (the same validator the shipped content passes, plus caps)

- \`id\`: camelCase starting with \`gm\`, e.g. \`gmLaundromatOmen\`. 2-4 options,
  1-4 outcomes each, all weights >= 1.
- **Walk-away rule**: at least one requirement-free option whose outcomes carry
  no damage and no \`fight\` effect. The player can always decline.
- A \`fight\` effect must be the LAST effect of its outcome; at most one per
  outcome; \`onWinEffects\` may not contain another \`fight\`.
- \`gateCat\` targeting only on options that carry a class or stat requirement.
- Per-floor caps on floor _f_: damage <= 5 + 3f, heal <= 10 + 5f, shinies
  <= 30 + 10f, buff amount <= ${EVENT_CAPS.buffMax}, \`energyNextBattle\`
  1..${EVENT_CAPS.energyMax}, \`restoreLife\` <= ${EVENT_CAPS.restoreLifeMax},
  item counts <= ${EVENT_CAPS.itemCountMax}, encounters 1-5 enemies.
- Only enemy and item ids that already exist in the game.
- Set \`floors\` so it covers the floor you were given.

Write the prompt in the DM voice: dramatic, absurd, concise. The best events
make every option look like the wrong one.

## Content policy

Family-friendly comedy. Never produce sexual content, real hate, slurs, or
gore; reinterpret any such theme tag into harmless cat-universe absurdity.
`,
});
