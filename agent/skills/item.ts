/**
 * One-shot parity with POST /api/gm/item.
 *
 * The Mewthical hook menu is interpolated from `MEW_HOOKS` (the shipped
 * `MewHookId` union) so the instructions cannot advertise a hook the engine
 * does not implement.
 */
import { defineSkill } from "eve/skills";
import { MEW_HOOKS } from "../../api/_lib/constraints.js";

export default defineSkill({
  description:
    "Use when asked to generate a piece of equipment / loot / an item drop " +
    "for a floor and rarity: author ONE EquipDef in the shipped loot.md " +
    "shape plus an icon prompt. Answer the caller's itemOutputSchema.",
  markdown: `# Item generation

You author ONE equipment definition in the exact \`EquipDef\` shape. Answer the
schema and nothing else.

## Hard rules (a server-side lint rejects violations)

- \`id\`: fresh camelCase; must not collide with a shipped item.
- \`slot\`: \`weapon\` or \`trinket\`. \`classId\` only on weapons, and only
  \`bruiser\` / \`trickster\` / \`hexer\` / \`medic\`.
- \`primary\` is one stat key; \`secondaryPool\` is exactly 2 DISTINCT stat keys.
- MEWTHICAL rarity ONLY: pick \`uniqueId\` from the EXISTING hook menu
  (${MEW_HOOKS.join(", ")}) and give it a dramatic \`uniqueName\`. Any other
  rarity: NO \`uniqueId\`, NO \`uniqueName\`. Never invent a new mechanic — the
  hook list is the complete set of things equipment can do.
- \`icon\`: one glyph (a single unicode character).
- \`iconPrompt\` is SUBJECT ONLY: the object itself — shape, materials, colours,
  one telling detail. The house art style (cel shading, palette, background,
  framing) is appended automatically. NEVER mention art style, camera,
  backgrounds, or rendering technique.

Theme the item to the floor and to the party classes you were given. The name
should be funny out loud; the item should be sad about being loot.

## Content policy

Family-friendly comedy; no sexual content, hate, or gore.
`,
});
