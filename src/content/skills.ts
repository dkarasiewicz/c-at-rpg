/**
 * WP-02a — SKILLS: every skill id referenced anywhere in content.
 *
 * One namespace, one shape (ARCHITECTURE.md §2.2 `Skill`):
 *  - Claw Swipe + the 12 class skills, verbatim from classes.md §§3-7
 *    (which reproduce combat.md §4's reference set with zero number changes).
 *  - Enemy skills for the dungeon.md §7.1 roster + events.md's `elderStray`
 *    (`grizzledCuff` is spelled in events.md §4; `shiv`/`hex`/`ram`/`spray`
 *    derive from the roster notes; `peck` from combat.md §13).
 *  - Boss skills for vacuumKing / dogfather / ratPrince per GDD §6 flags
 *    (`maxSuction` pulls cats forward; `theBigBark` is the telegraphed
 *    2-slot 200-power row nuke, combat.md §11.4).
 *
 * Cats are gated by `cost` (energy); enemies by `cooldown` (0 = every turn).
 * Consumable battle payloads live on their `ConsumableDef.battleSkill`
 * (content/consumables.ts), per ARCHITECTURE.md §1's file responsibilities.
 */
import type { Skill, SkillId } from "../core/types";

export const SKILLS: Record<SkillId, Skill> = {
  /* ---------------------------------------------------------------------- */
  /* Shared basic (classes.md §3)                                            */
  /* ---------------------------------------------------------------------- */
  clawSwipe: {
    id: "clawSwipe",
    name: "Claw Swipe",
    desc: "A quick rake. Banks +1 Energy.",
    cost: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
    energyGain: 1,
  },

  /* ---------------------------------------------------------------------- */
  /* Bruiser — Bruno (classes.md §4)                                         */
  /* ---------------------------------------------------------------------- */
  bodySlam: {
    id: "bodySlam",
    name: "Body Slam",
    desc: "Hit first, hurl second. The landing is your teammates’ problem.",
    cost: 4,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 120,
    kind: "damage",
    moveTarget: 2,
  },
  hiss: {
    id: "hiss",
    name: "Hiss",
    desc: "Arch, fluff, dare them. Everyone swings at Bruno; Bruno barely feels it.",
    cost: 2,
    usableFrom: [1, 2],
    target: { side: "self", ranks: [1, 2, 3, 4], pattern: "single" },
    power: 0,
    kind: "utility",
    applies: [
      { status: "guarded", chance: 1.0, to: "self" },
      { status: "provoked", chance: 1.0, to: "allEnemies" },
    ],
  },
  dumpsterDunk: {
    id: "dumpsterDunk",
    name: "Dumpster Dunk",
    desc: "Pick it up. Slam-dunk it into the bins at the back. Two points.",
    cost: 6,
    usableFrom: [1],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 150,
    kind: "damage",
    moveTarget: 3,
  },

  /* ---------------------------------------------------------------------- */
  /* Trickster — Pixel (classes.md §5)                                       */
  /* ---------------------------------------------------------------------- */
  pounce: {
    id: "pounce",
    name: "Pounce",
    desc: "Wind up the butt-wiggle, delete a face, deal with the seating chart later.",
    cost: 3,
    usableFrom: [3, 4],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 150,
    kind: "damage",
    moveSelf: -2,
  },
  tripWire: {
    id: "tripWire",
    name: "Trip Wire",
    desc: "A stretched string of yarn. The whole front row eats pavement.",
    cost: 4,
    usableFrom: [2, 3],
    target: { side: "enemy", ranks: [1, 2], pattern: "row" },
    power: 60,
    kind: "damage",
    moveTarget: 1,
  },
  boxAmbush: {
    id: "boxAmbush",
    name: "Box Ambush",
    desc: "She vanishes into a cardboard box. The box reappears ANYWHERE.",
    cost: 6,
    usableFrom: [1, 2, 3, 4],
    target: { side: "enemy", ranks: [1, 2, 3, 4, 5], pattern: "single" },
    power: 150,
    kind: "damage",
  },

  /* ---------------------------------------------------------------------- */
  /* Hexer — Mora (classes.md §6)                                            */
  /* ---------------------------------------------------------------------- */
  yankOfYarn: {
    id: "yankOfYarn",
    name: "Yank of Yarn",
    desc: "A thread of fate around the ankle. Front and center, please.",
    cost: 3,
    usableFrom: [3, 4],
    target: { side: "enemy", ranks: [2, 3, 4], pattern: "single" },
    power: 60,
    kind: "damage",
    moveTarget: -2,
  },
  hairballHex: {
    id: "hairballHex",
    name: "Hairball Hex",
    desc: "A cursed hairball takes up residence. It itches. Everywhere. Forever.",
    cost: 3,
    usableFrom: [2, 3, 4],
    target: { side: "enemy", ranks: [1, 2, 3], pattern: "single" },
    power: 40,
    kind: "damage",
    applies: [{ status: "scratched", chance: 0.9, value: 3 }],
  },
  phantomCucumber: {
    id: "phantomCucumber",
    name: "Phantom Cucumber",
    desc: "She conjures the IDEA of a cucumber directly behind them.",
    cost: 5,
    usableFrom: [3, 4],
    target: { side: "enemy", ranks: [1, 2, 3], pattern: "single" },
    power: 30,
    kind: "damage",
    applies: [{ status: "frazzled", chance: 0.8 }],
  },

  /* ---------------------------------------------------------------------- */
  /* Medic — Baguette (classes.md §7)                                        */
  /* ---------------------------------------------------------------------- */
  soothingPurr: {
    id: "soothingPurr",
    name: "Soothing Purr",
    desc: "A directed rumble at healing frequency. Also dislodges cursed hairballs.",
    cost: 4,
    usableFrom: [3, 4],
    target: { side: "ally", ranks: [1, 2, 3, 4], pattern: "single" },
    power: 120,
    kind: "heal",
    cleanses: ["scratched"],
  },
  nineLivesNudge: {
    id: "nineLivesNudge",
    name: "Nine Lives Nudge",
    desc: 'A firm boop on the forehead. "Not yet. Up."',
    cost: 6,
    usableFrom: [3, 4],
    target: { side: "ally", ranks: [1, 2, 3, 4], pattern: "single" },
    power: 0,
    kind: "utility",
    revivePct: 0.3,
    oncePerBattle: true,
  },
  purrquake: {
    id: "purrquake",
    name: "Purrquake",
    desc: "The floor hums. Everyone’s fur settles. Everything is briefly okay.",
    cost: 6,
    usableFrom: [3, 4],
    target: { side: "ally", ranks: [1, 2, 3, 4], pattern: "row" },
    power: 60,
    kind: "heal",
    applies: [{ status: "mending", chance: 1.0, value: 3 }],
  },

  /* ---------------------------------------------------------------------- */
  /* Enemy skills — tier 1 (dungeon.md §7.1 roster)                          */
  /* ---------------------------------------------------------------------- */
  // ratThug — "Shiv, usableFrom [1,2]". Worked example (combat.md §13):
  // base 7 with ATK 7 → power 100.
  shiv: {
    id: "shiv",
    name: "Shiv",
    desc: "A sharpened bottle cap, held with bad intent.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
  },
  // sewerBat — fast, fragile; strafes from mid ranks.
  swoop: {
    id: "swoop",
    name: "Swoop",
    desc: "A leathery dive-bomb out of the dark.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2, 3],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
  },
  // dustBunny — slow chaff.
  nibble: {
    id: "nibble",
    name: "Nibble",
    desc: "Mostly lint. Some teeth.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
  },
  // crowShaman — "Peck usableFrom [1,2]" (combat.md §13): base 8.0 with
  // ATK 8 → power 100.
  peck: {
    id: "peck",
    name: "Peck",
    desc: "A spiteful jab of the beak.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
  },
  // crowShaman — "hex usableFrom [2,3,4] — shove it to rank 1 to silence it".
  hex: {
    id: "hex",
    name: "Hex",
    desc: "A croaked curse that reaches any rank and leaves it bleeding.",
    cost: 0,
    cooldown: 2,
    usableFrom: [2, 3, 4],
    target: { side: "enemy", ranks: [1, 2, 3, 4], pattern: "single" },
    power: 70,
    kind: "damage",
    applies: [{ status: "scratched", chance: 0.9, value: 2 }],
    aiWeight: 14,
  },

  /* ---------------------------------------------------------------------- */
  /* Enemy skills — tier 2                                                   */
  /* ---------------------------------------------------------------------- */
  // roombaScout — "rams: `moveTarget +1` skill (shoves cats)".
  ram: {
    id: "ram",
    name: "Ram",
    desc: "Full speed ahead. Obstacle rescheduled to the next rank.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
    moveTarget: 1,
  },
  // sprinklerImp — "row-hitting spray, cooldown 2".
  spray: {
    id: "spray",
    name: "Spray",
    desc: "A fanning arc of cold water. Cats HATE this.",
    cost: 0,
    cooldown: 2,
    usableFrom: [2, 3, 4],
    target: { side: "enemy", ranks: [1, 2, 3], pattern: "row" },
    power: 70,
    kind: "damage",
    aiWeight: 15,
  },
  // sprinklerImp — filler poke while spray recharges.
  squirt: {
    id: "squirt",
    name: "Squirt",
    desc: "One pressurized spit while the tank refills.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2, 3, 4],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 80,
    kind: "damage",
  },
  // yarnGolem — heavy elite; big slow swings.
  yarnSlam: {
    id: "yarnSlam",
    name: "Yarn Slam",
    desc: "A fist of wound-up yarn, dense as regret.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 120,
    kind: "damage",
  },

  /* ---------------------------------------------------------------------- */
  /* Enemy skills — tier 3                                                   */
  /* ---------------------------------------------------------------------- */
  // porcelainHound — "hits hard, shoves (`moveTarget +1`)".
  bite: {
    id: "bite",
    name: "Bite",
    desc: "Porcelain teeth close and shove. Both hurt.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 110,
    kind: "damage",
    moveTarget: 1,
  },
  // laserGhost — back-line glass cannon: reaches every cat rank.
  laserZap: {
    id: "laserZap",
    name: "Laser Zap",
    desc: "The red dot, weaponized. It can find you anywhere.",
    cost: 0,
    cooldown: 0,
    usableFrom: [2, 3, 4],
    target: { side: "enemy", ranks: [1, 2, 3, 4], pattern: "single" },
    power: 100,
    kind: "damage",
  },
  // trashPanda — mini-boss statline: lid shove on a short cooldown…
  lidBash: {
    id: "lidBash",
    name: "Lid Bash",
    desc: "A trash-can lid, swung like a door slamming shut.",
    cost: 0,
    cooldown: 1,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 110,
    kind: "damage",
    moveTarget: 1,
    aiWeight: 12,
  },
  // …and a plain rummage-and-throw filler.
  trashToss: {
    id: "trashToss",
    name: "Trash Toss",
    desc: "Whatever was in the can. It is heavier than it looks.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
  },
  // sockWraith — Laundromancer/ratPrince-style summon chaff.
  dampSlap: {
    id: "dampSlap",
    name: "Damp Slap",
    desc: "A cold, wet sock across the face. Deeply insulting.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
  },
  // elderStray — "his `Grizzled Cuff` is a `moveTarget: +1` skill"
  // (events.md §4).
  grizzledCuff: {
    id: "grizzledCuff",
    name: "Grizzled Cuff",
    desc: "An open-pawed lesson from someone who has taught it before.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 110,
    kind: "damage",
    moveTarget: 1,
  },

  /* ---------------------------------------------------------------------- */
  /* Boss skills — Vacuum King (floor 3; GDD §6)                             */
  /* ---------------------------------------------------------------------- */
  hoseWhack: {
    id: "hoseWhack",
    name: "Hose Whack",
    desc: "The nozzle comes down like a riding crop.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
  },
  dustBlast: {
    id: "dustBlast",
    name: "Dust Blast",
    desc: "Reverse thrust. A bag's worth of grit, everywhere at once.",
    cost: 0,
    cooldown: 2,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "row" },
    power: 60,
    kind: "damage",
    aiWeight: 15,
  },
  // Phase 2 "MAX SUCTION" — pulls all cats 1 rank forward each turn
  // (forced movement: the boss weaponizes Off-Paw back at the party).
  maxSuction: {
    id: "maxSuction",
    name: "MAX SUCTION",
    desc: "Every hatch open, every motor screaming. The room leans toward it.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [2, 3, 4], pattern: "row" },
    power: 40,
    kind: "damage",
    moveTarget: -1,
    aiWeight: 20,
  },

  /* ---------------------------------------------------------------------- */
  /* Boss skills — The Dogfather (floor 6; GDD §6)                           */
  /* ---------------------------------------------------------------------- */
  maul: {
    id: "maul",
    name: "Maul",
    desc: "Nothing personal. Strictly business.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 110,
    kind: "damage",
  },
  junkyardToss: {
    id: "junkyardToss",
    name: "Junkyard Toss",
    desc: "Picked up by the scruff. Filed at the back with the other problems.",
    cost: 0,
    cooldown: 2,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 90,
    kind: "damage",
    moveTarget: 2,
    aiWeight: 15,
  },
  // Telegraphed 2-slot windup nuke (combat.md §11.4): row, power 200,
  // cooldown 3; the charge turn is boss.ts's job, this is the release.
  theBigBark: {
    id: "theBigBark",
    name: "The Big Bark",
    desc: "One bark. The whole front of the room stops existing politely.",
    cost: 0,
    cooldown: 3,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "row" },
    power: 200,
    kind: "damage",
    aiWeight: 40,
  },

  /* ---------------------------------------------------------------------- */
  /* Boss skills — The Rat Prince (SHOULD-tier floor-3 alternate; GDD §6)    */
  /* ---------------------------------------------------------------------- */
  scepterBonk: {
    id: "scepterBonk",
    name: "Scepter Bonk",
    desc: "Royal assent, administered directly to the skull.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
  },
  // Summon skill (combat.md §11.5): boss.ts spawns the minion into the
  // lowest empty enemy rank via BossData.summon; the skill itself is inert.
  summonVermin: {
    id: "summonVermin",
    name: "Summon Vermin",
    desc: "A squeak of command. The walls answer.",
    cost: 0,
    cooldown: 3,
    usableFrom: [1, 2],
    target: { side: "self", ranks: [1, 2], pattern: "single" },
    power: 0,
    kind: "utility",
    aiWeight: 25,
  },
};
