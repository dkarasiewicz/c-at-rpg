/**
 * The one-shot resonance compiler (was POST /api/gm/resonance;
 * stand-powers.md Layer 3).
 *
 * The caps come from the shipped budget tables; the verdict is memoized
 * forever by the caller, which is why "no resonance" must be a first-class,
 * confident answer rather than a failure.
 */
import { defineSkill } from "eve/skills";
import { BUDGET_CAPS, EFFECT_CAPS } from "../../src/core/combat/powers.js";

export default defineSkill({
  description:
    "Use when asked whether two Stand powers RESONATE: judge one power pair " +
    "and return either a compiled extra rule in the Power Script DSL or a " +
    "definitive no. Answer the caller's resonanceOutputSchema.",
  markdown: `# Stand resonance

Two Stand powers meet in battle for the first time ANYWHERE in the world.
Decide whether they RESONATE — produce one extra deterministic rule in the same
Power Script DSL — or not. Your answer is memoized forever, so answer with
confidence and answer the schema only.

## Policy

Resonances are notable, NOT universal. Target roughly 1 pair in 3, judged on
thematic fit between the two powers. When the pairing is not genuinely
evocative, return \`hasResonance: false\` with \`rule: null\`. That is the
common, correct answer.

## When a resonance exists

- The rule reuses ONLY the existing DSL: one trigger, at most 3 conditions, 1-3
  effects from the closed menu (damage / heal / status / move / energy /
  cleanse). No new mechanics, ever.
- Caps: damage and heal pct <= ${EFFECT_CAPS.damagePct} (percent of the owner's
  atk), move delta within ±${EFFECT_CAPS.moveDelta}, energy within
  ±${EFFECT_CAPS.energyAbs}, status value <= ${EFFECT_CAPS.statusValue}. The
  computed budget must stay under the resonance cap
  ${BUDGET_CAPS.resonance} — a garnish, not a meal — so prefer conditions
  (\`chance\`, \`hpBelowPct\`) and small effects.
- \`flavor\`: one dramatic line (<= 200 chars) describing HOW the two powers
  interact.
- \`announce\`: the discovery banner, starting with
  \`STAND RESONANCE DISCOVERED:\` (<= 200 chars).

## When there is no resonance

\`hasResonance: false\`, \`rule: null\`, \`flavor\` one dry line on why the powers
ignore each other, \`announce\` an empty string.

## Content policy

Family-friendly comedy; no sexual content, hate, or gore.
`,
});
