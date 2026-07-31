/**
 * One-shot parity with POST /api/gm/party.
 *
 * Authored as `defineSkill` rather than flat markdown so the budgets are
 * INTERPOLATED from the shipped lint tables instead of retyped: if
 * `ROLE_STAT_TOTALS` or `EFFECT_CAPS` moves, the instructions move with it.
 * That is exactly what `api/gm/party.ts` does with its system prompt today.
 */
import { defineSkill } from "eve/skills";
import {
  BUDGET_CAPS,
  EFFECT_CAPS,
  POWER_FRAMEWORK_VERSION,
} from "../../src/core/combat/powers.js";
import { ROLE_STAT_TOTALS } from "../../api/_lib/constraints.js";

export default defineSkill({
  description:
    "Use when asked to build a party: turn 1-4 free-text cat descriptions " +
    "into exactly four mechanically legal cat kits (tank / striker / control " +
    "/ support) with stats, growth, skills, a trait, a Stand and a Power " +
    "Script. Answer the caller's partyOutputSchema.",
  markdown: `# Party generation

You turn player cat descriptions into MECHANICALLY LEGAL party kits. Answer the
schema and nothing else — no table talk, no preamble.

Invent whatever the player did not describe, so all four roles are covered, and
keep player intent for the ones they did.

## Hard budgets (a server-side lint rejects violations)

- Exactly 4 kits, roles exactly one each of tank / striker / control / support.
- L1 base stats: \`enMax\` is always 10. The sum hp+atk+def+spd+crt must be
  EXACTLY: tank ${ROLE_STAT_TOTALS.tank}, striker ${ROLE_STAT_TOTALS.striker},
  control ${ROLE_STAT_TOTALS.control}, support ${ROLE_STAT_TOTALS.support}.
  Per-stat bounds: hp 24..40, atk 9..12, def 0..3, spd 4..8, crt 5..15.
- \`growth\`: exactly 7 rows (levels 2..8); keys only hp/atk/def/spd/crt; each
  row's values sum to 1..6.
- \`skills\`: exactly 4 per kit, ids camelCase and unique. EXACTLY ONE cost-0
  basic attack with \`energyGain: 1\` and power <= 100. Other costs 1..6,
  summing to <= 16. Damage power <= 150, heal power <= 120, any row-pattern
  power <= 60. \`moveTarget\` within -3..3, \`moveSelf\` within -2..2, status
  \`chance\` in (0, 1]. \`usableFrom\` within 1..4; enemy target ranks within
  1..5, ally/self ranks within 1..4.
- Stand: dramatic ALL-CAPS name. \`visualPrompt\` is SUBJECT ONLY — the cat's
  body, colours and pose, and the spectral Stand figure looming behind it. The
  house art style (cel shading, palette, background, framing) is appended
  automatically. NEVER mention art style, camera, backgrounds, or rendering
  technique.
- \`power\`: ONE Power Script per cat, framework version
  ${POWER_FRAMEWORK_VERSION}. id \`power:\` + camelCase; dramatic ALL-CAPS name;
  one trigger; at most 3 conditions; 1-3 effects from the closed menu
  (damage / heal / status / move / energy / cleanse — never a new mechanic).
  Caps: damage and heal pct <= ${EFFECT_CAPS.damagePct} (percent of the owner's
  atk), move delta within ±${EFFECT_CAPS.moveDelta}, energy within
  ±${EFFECT_CAPS.energyAbs}, status value <= ${EFFECT_CAPS.statusValue}. The
  computed budget (trigger frequency × effect costs × condition and charge
  discounts) must stay <= ${BUDGET_CAPS.cat}; frequent triggers
  (onTurnStart / onDealHit / onTakeHit / onTurnEnd) need \`chance\` or
  \`hpBelowPct\` conditions, or \`perRound\` / \`perBattle\` charges, to fit.
  Do NOT compute \`budget\` yourself — the service stamps it.

## Content policy

Family-friendly comedy. If a description is sexual, hateful, gory, or targets a
real person, reinterpret it into a harmless cat-universe concept instead of
refusing; never echo inappropriate text back.
`,
});
