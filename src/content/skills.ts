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
 * OFF-BALANCE APPLICATION CHANCE (`offBalanceChance`, balance-and-meta.md §1):
 * a forced move no longer guarantees the stagger. The knob prices the combo,
 * so energy buys reliability rather than just damage — and it is symmetric,
 * enemy shoves pay the same tax against cats:
 *
 *   0.60  scruffToss (3), yankOfYarn (3)        — the cheapest shoves
 *   0.70  bodySlam (4); ram / bite / lidBash / grizzledCuff (enemy mooks)
 *   0.75  maxSuction (boss row, every turn in phase 2)
 *   0.80  tripWire (4, row), snarlOfThreads (4, row) — the Cat Pile enablers
 *         keep the best odds short of a guarantee, because arming a pile is
 *         the one thing Off-Balance is still supposed to be FOR
 *   1.00  dumpsterDunk (6), trashCompactor (7), fullUnravel (8),
 *         junkyardToss (boss, cooldown 2), whiskerFeint (pure setup, via
 *         `applies`) — the expensive setup skills keep their guarantee, which
 *         is the whole reason to pay for them.
 *
 * A chance of EXACTLY 1.0 draws no roll; tier-2/3 enemies still get their
 * separate resistance roll on top (content/enemies.ts).
 *
 * Cats are gated by `cost` (energy); enemies by `cooldown` (0 = every turn).
 * Consumable battle payloads live on their `ConsumableDef.battleSkill`
 * (content/consumables.ts), per ARCHITECTURE.md §1's file responsibilities.
 */
import type { Skill, SkillId } from "../core/types.js";

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
    desc:
      "«THE DUMPSTER KING» hits first, hurls second. The landing is your " +
      "teammates’ problem.",
    cost: 4,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 120,
    kind: "damage",
    moveTarget: 2,
    offBalanceChance: 0.7,
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
    name: "DUMPSTER DUNK",
    desc:
      "«THE DUMPSTER KING» rises, picks them up, and slam-dunks them into " +
      "the bins at the back. Two points.",
    cost: 6,
    usableFrom: [1],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 150,
    kind: "damage",
    moveTarget: 3,
    offBalanceChance: 1.0,
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
    offBalanceChance: 0.8,
  },
  boxAmbush: {
    id: "boxAmbush",
    name: "BOX AMBUSH",
    desc:
      "Her Stand «BOX AMBUSH» swallows her whole. The box reappears " +
      "ANYWHERE.",
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
    desc:
      "«STRING THEORY» loops a thread of fate around the ankle. Front and " +
      "center, please.",
    cost: 3,
    usableFrom: [3, 4],
    target: { side: "enemy", ranks: [2, 3, 4], pattern: "single" },
    power: 60,
    kind: "damage",
    moveTarget: -2,
    offBalanceChance: 0.6,
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
    name: "PHANTOM CUCUMBER",
    desc: "«STRING THEORY» conjures the IDEA of a cucumber directly behind them.",
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
    desc:
      "«PURR ENGINE» directs a rumble at healing frequency. Also dislodges " +
      "cursed hairballs.",
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
    name: "PURRQUAKE",
    desc:
      "«PURR ENGINE» redlines. The floor hums, everyone’s fur settles, and " +
      "everything is briefly okay.",
    cost: 6,
    usableFrom: [3, 4],
    target: { side: "ally", ranks: [1, 2, 3, 4], pattern: "row" },
    power: 60,
    kind: "heal",
    applies: [{ status: "mending", chance: 1.0, value: 3 }],
  },

  /* ---------------------------------------------------------------------- */
  /* Milestone unlocks — L2 / L6 / L8 (docs/design/progression.md §2)        */
  /*                                                                         */
  /* Twelve skills, three per class, authored to CHANGE the loadout question */
  /* rather than out-stat the L1 kit: each one gives its cat a tool its      */
  /* starting three do not have (Bruno pulls and shields, Pixel marks and    */
  /* sweeps, Mora mass-pulls and mass-frazzles, Baguette cleanses, pre-buffs */
  /* and revives twice). Only existing EffectSpec fields are used.           */
  /* ---------------------------------------------------------------------- */

  /* ---- Bruiser — Bruno, «THE DUMPSTER KING» ----------------------------- */
  // L2: the King reaches OVER the front line. Bruno's only pull — it drags a
  // back-line caster into his own threat ranks instead of shoving it away.
  scruffToss: {
    id: "scruffToss",
    name: "Scruff Toss",
    desc:
      "«THE DUMPSTER KING» reaches over the front row, takes something by " +
      "the scruff, and files it at the front. Complaints go to the front.",
    cost: 3,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [2, 3, 4], pattern: "single" },
    power: 80,
    kind: "damage",
    moveTarget: -2,
    offBalanceChance: 0.6,
  },
  // L6: party protection. Hiss taunts; this one actually armours the front.
  binLidBulwark: {
    id: "binLidBulwark",
    name: "BIN LID BULWARK",
    desc:
      "«THE DUMPSTER KING» plants three lids in a row. The front of the " +
      "party is now, technically, a building.",
    cost: 5,
    usableFrom: [1, 2],
    target: { side: "ally", ranks: [1, 2], pattern: "row" },
    power: 0,
    kind: "utility",
    applies: [{ status: "guarded", chance: 1.0 }],
  },
  // L8: the mass-displacement finisher — the whole enemy front row goes back.
  trashCompactor: {
    id: "trashCompactor",
    name: "TRASH COMPACTOR",
    desc:
      "«THE DUMPSTER KING» closes. Everything at the front is now everything " +
      "at the back, and flatter.",
    cost: 7,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "row" },
    power: 110,
    kind: "damage",
    moveTarget: 2,
    offBalanceChance: 1.0,
  },

  /* ---- Trickster — Pixel, «BOX AMBUSH» ---------------------------------- */
  // L2: cheap poke that leaves her somewhere else. Pounce dives in; this
  // one hops out — the hit-and-run half of the kit.
  bottleCapFlick: {
    id: "bottleCapFlick",
    name: "Bottle Cap Flick",
    desc:
      "A bottle cap leaves a box that was not there. Pixel is already in a " +
      "different box, looking innocent.",
    cost: 2,
    usableFrom: [1, 2, 3],
    target: { side: "enemy", ranks: [1, 2, 3], pattern: "single" },
    power: 70,
    kind: "damage",
    moveSelf: 1,
  },
  // L6: Off-Balance WITHOUT displacement — the mark stays where the party
  // can still reach it, and Opportunist reads it. Cat Pile enabler.
  whiskerFeint: {
    id: "whiskerFeint",
    name: "Whisker Feint",
    desc:
      "«BOX AMBUSH» opens a lid that is not there. They flinch at nothing " +
      "and never quite get their paws back under them.",
    cost: 4,
    usableFrom: [2, 3, 4],
    target: { side: "enemy", ranks: [1, 2, 3], pattern: "single" },
    power: 90,
    kind: "damage",
    applies: [{ status: "offBalance", chance: 1.0 }],
  },
  // L8: every box in the room at once — her one true AoE, and the reason a
  // crit-stacked Pixel is terrifying against a full pack.
  everyBoxAtOnce: {
    id: "everyBoxAtOnce",
    name: "EVERY BOX AT ONCE",
    desc:
      "«BOX AMBUSH» opens every box in the room simultaneously, including " +
      "the ones nobody packed. There is no unambushed rank.",
    cost: 8,
    usableFrom: [1, 2, 3, 4],
    target: { side: "enemy", ranks: [1, 2, 3, 4, 5], pattern: "row" },
    power: 80,
    kind: "damage",
  },

  /* ---- Hexer — Mora, «STRING THEORY» ------------------------------------ */
  // L2: Yank of Yarn is a single pull; this is the ROW pull — the whole back
  // line comes forward one rank and eats Off-Paw together.
  snarlOfThreads: {
    id: "snarlOfThreads",
    name: "Snarl of Threads",
    desc:
      "«STRING THEORY» knots the back of the room together and takes up the " +
      "slack. Everyone shuffles forward. Nobody agreed to this.",
    cost: 4,
    usableFrom: [2, 3, 4],
    target: { side: "enemy", ranks: [3, 4, 5], pattern: "row" },
    power: 40,
    kind: "damage",
    moveTarget: -1,
    offBalanceChance: 0.8,
  },
  // L6: the guaranteed bleed (chance 1.0 draws no roll) — almost no up-front
  // damage, enormous over three rounds. The patience skill.
  ninthKnotCurse: {
    id: "ninthKnotCurse",
    name: "NINTH KNOT CURSE",
    desc:
      "«STRING THEORY» ties the ninth knot. It cannot be untied, only " +
      "outlived, and it is fraying you either way.",
    cost: 5,
    usableFrom: [1, 2, 3, 4],
    target: { side: "enemy", ranks: [1, 2, 3, 4, 5], pattern: "single" },
    power: 20,
    kind: "damage",
    applies: [{ status: "scratched", chance: 1.0, value: 6 }],
  },
  // L8: mass Frazzle + mass pull — the boss-windup answer scaled to a whole
  // row (Phantom Cucumber, but for the room).
  fullUnravel: {
    id: "fullUnravel",
    name: "FULL UNRAVEL",
    desc:
      "«STRING THEORY» pulls the one thread everything else was tied to. " +
      "The room comes apart in the order it was knitted.",
    cost: 8,
    usableFrom: [2, 3, 4],
    target: { side: "enemy", ranks: [1, 2, 3], pattern: "row" },
    power: 70,
    kind: "damage",
    moveTarget: -1,
    offBalanceChance: 1.0,
    applies: [{ status: "frazzled", chance: 0.6 }],
  },

  /* ---- Medic — Baguette, «PURR ENGINE» ---------------------------------- */
  // L2: the cheap cleanse. Soothing Purr heals big and clears Scratched;
  // this clears the tempo statuses instead, for a quarter of the energy.
  kneadTheKnots: {
    id: "kneadTheKnots",
    name: "Knead the Knots",
    desc:
      "«PURR ENGINE» idles low and kneads until the panic goes out of " +
      "someone's shoulders. Also fixes posture.",
    cost: 2,
    usableFrom: [2, 3, 4],
    target: { side: "ally", ranks: [1, 2, 3, 4], pattern: "single" },
    power: 40,
    kind: "heal",
    cleanses: ["offBalance", "frazzled"],
  },
  // L6: prophylactic support — Mending + Guarded BEFORE the hit lands.
  // Baguette's first "spend a turn now, save a cat later" button.
  warmLoafPress: {
    id: "warmLoafPress",
    name: "Warm Loaf Press",
    desc:
      "She sits on you. «PURR ENGINE» runs at proofing temperature and the " +
      "next few minutes are survivable.",
    cost: 4,
    usableFrom: [2, 3, 4],
    target: { side: "ally", ranks: [1, 2, 3, 4], pattern: "single" },
    power: 0,
    kind: "utility",
    applies: [
      { status: "mending", chance: 1.0, value: 5 },
      { status: "guarded", chance: 1.0 },
    ],
  },
  // L8: the second revive — a battle can now survive two KOs, at a price.
  ovenSpring: {
    id: "ovenSpring",
    name: "OVEN SPRING",
    desc:
      "«PURR ENGINE» redlines over a fallen friend. Nothing that has been " +
      "properly proofed stays down.",
    cost: 7,
    usableFrom: [2, 3, 4],
    target: { side: "ally", ranks: [1, 2, 3, 4], pattern: "single" },
    power: 0,
    kind: "utility",
    revivePct: 0.6,
    oncePerBattle: true,
  },

  /* ---------------------------------------------------------------------- */
  /* Enemy skills — tier 1 (dungeon.md §7.1 roster)                          */
  /* ---------------------------------------------------------------------- */
  // ratThug — "Shiv, usableFrom [1,2]". Worked example (combat.md §13):
  // base 7 with ATK 7 → power 100.
  shiv: {
    id: "shiv",
    name: "Shiv",
    desc:
      "Its Stand «BOTTLE CAP REQUIEM» presents a sharpened bottle cap, held " +
      "with bad intent.",
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
    desc:
      "«ECHO CHAMBER» screams the coordinates; a leathery dive-bomb out of " +
      "the dark.",
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
    desc: "Its Stand «SOFT OBLIVION» is mostly lint. Some teeth.",
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
    desc: "A spiteful jab of the beak, conducted by «MURDER BALLAD».",
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
    desc:
      "«MURDER BALLAD» croaks a curse that reaches any rank and leaves it " +
      "bleeding.",
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
    desc:
      "«CLEAN SWEEP» declares your rank part of the route. Full speed " +
      "ahead; obstacle rescheduled.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
    moveTarget: 1,
    offBalanceChance: 0.7,
  },
  // sprinklerImp — "row-hitting spray, cooldown 2".
  spray: {
    id: "spray",
    name: "Spray",
    desc: "«WET BLANKET» fans an arc of cold water. Cats HATE this.",
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
    desc: "One pressurized spit while «WET BLANKET» refills the tank.",
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
    desc: "«CABLE KNIT» winds up a fist of yarn, dense as regret.",
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
    desc: "«BONE CHINA» closes porcelain teeth and shoves. Both hurt.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 110,
    kind: "damage",
    moveTarget: 1,
    offBalanceChance: 0.7,
  },
  // laserGhost — back-line glass cannon: reaches every cat rank.
  laserZap: {
    id: "laserZap",
    name: "Laser Zap",
    desc: "«RED SHIFT» — the red dot, weaponized. It can find you anywhere.",
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
    desc: "«MIDNIGHT BUFFET» swings a trash-can lid like a door slamming shut.",
    cost: 0,
    cooldown: 1,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 110,
    kind: "damage",
    moveTarget: 1,
    offBalanceChance: 0.7,
    aiWeight: 12,
  },
  // …and a plain rummage-and-throw filler.
  trashToss: {
    id: "trashToss",
    name: "Trash Toss",
    desc:
      "Whatever «MIDNIGHT BUFFET» found in the can. It is heavier than it " +
      "looks.",
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
    desc: "«THE MISSING PAIR», cold and wet, across the face. Deeply insulting.",
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
    desc:
      "«GRANDFATHER CLAWS» delivers an open-pawed lesson it has taught many " +
      "times before.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 110,
    kind: "damage",
    moveTarget: 1,
    offBalanceChance: 0.7,
  },

  /* ---------------------------------------------------------------------- */
  /* Boss skills — Vacuum King (floor 3; GDD §6)                             */
  /* ---------------------------------------------------------------------- */
  hoseWhack: {
    id: "hoseWhack",
    name: "Hose Whack",
    desc: "«ABSOLUTE VOID» brings the nozzle down like a riding crop.",
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
    desc:
      "«ABSOLUTE VOID» reverses thrust. A bag's worth of grit, everywhere " +
      "at once.",
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
    desc:
      "«ABSOLUTE VOID» opens every hatch, every motor screaming. The room " +
      "leans toward it.",
    cost: 0,
    cooldown: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [2, 3, 4], pattern: "row" },
    power: 40,
    kind: "damage",
    moveTarget: -1,
    offBalanceChance: 0.75,
    aiWeight: 20,
  },

  /* ---------------------------------------------------------------------- */
  /* Boss skills — The Dogfather (floor 6; GDD §6)                           */
  /* ---------------------------------------------------------------------- */
  maul: {
    id: "maul",
    name: "Maul",
    desc: "«BAD TO THE BONE» collects. Nothing personal. Strictly business.",
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
    desc:
      "«BAD TO THE BONE» picks you up by the scruff and files you at the " +
      "back with the other problems.",
    cost: 0,
    cooldown: 2,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 90,
    kind: "damage",
    moveTarget: 2,
    offBalanceChance: 1.0,
    aiWeight: 15,
  },
  // Telegraphed 2-slot windup nuke (combat.md §11.4): row, power 200,
  // cooldown 3; the charge turn is boss.ts's job, this is the release.
  theBigBark: {
    id: "theBigBark",
    name: "THE BIG BARK",
    desc:
      "«BAD TO THE BONE» barks once. The whole front of the room stops " +
      "existing politely.",
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
    desc:
      "«PURPLE REIGN» grants royal assent, administered directly to the " +
      "skull.",
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
    desc: "«PURPLE REIGN» squeaks a command. The walls answer.",
    cost: 0,
    cooldown: 3,
    usableFrom: [1, 2],
    target: { side: "self", ranks: [1, 2], pattern: "single" },
    power: 0,
    kind: "utility",
    aiWeight: 25,
  },
};
