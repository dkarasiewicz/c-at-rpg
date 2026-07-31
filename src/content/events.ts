/**
 * c(at)rpg content — the 10 shipped narrative events, verbatim from
 * events.md §4 with the canonical id fixes (GDD §§6, 8):
 *  - the Perfect Box ambush encounter uses `ratThug` (events.md's `rat` id
 *    does not exist in the roster);
 *  - `roombaScout` / `elderStray` stat blocks live in content/enemies.ts.
 *
 * Selection/resolution semantics live in core/events (events.md §2); the
 * authoring invariants (events.md §1) are enforced by core/events/validate.ts.
 *
 * Data only: imports core/types.ts and nothing else.
 */
import type { GameEvent } from "../core/types.js";

export const EVENTS: GameEvent[] = [
  // ── 1 ─────────────────────────────────────────────────────────────────────
  {
    id: "yarnBall",
    title: "The Mysterious Yarn Ball",
    weight: 10,
    floors: [1, 6],
    prompt:
      "In the middle of the corridor sits a ball of yarn, wound too perfectly, " +
      "lit by no torch you can find. It smells faintly of Stand energy and wet " +
      "wool. It rolls half a paw-width toward you. On its own. Menacingly.",
    options: [
      {
        label: "Bat it around. It exists to be batted.",
        outcomes: [
          {
            weight: 6,
            text: "It unspools into glorious chaos. The party spends five minutes as one joyous, tangled organism, and emerges limber.",
            effects: [
              {
                kind: "buff",
                target: "party",
                stat: "spd",
                amount: 1,
                duration: "floor",
              },
            ],
          },
          {
            weight: 4,
            text: "The yarn bats back. By the time the knots surrender, one of you has been thoroughly mummified.",
            effects: [
              {
                kind: "damage",
                target: "random",
                amount: { base: 4, perFloor: 1 },
              },
              {
                kind: "buff",
                target: "random",
                stat: "spd",
                amount: -1,
                duration: "floor",
              },
            ],
          },
        ],
      },
      {
        label: "Unravel it with surgical precision.",
        requires: { kind: "class", class: "trickster" },
        outcomes: [
          {
            weight: 1,
            text: "The Trickster teases out the one true thread. The ball sighs, unwinds, and surrenders the shinies someone had wound it around.",
            effects: [{ kind: "shinies", amount: { base: 20, perFloor: 5 } }],
          },
        ],
      },
      {
        label: "A cat of your discipline walks on.",
        outcomes: [
          {
            weight: 1,
            text: "You walk on. The yarn ball rolls sadly back into the dark. Nobody speaks of it.",
            effects: [{ kind: "nothing" }],
          },
        ],
      },
    ],
  },

  // ── 2 ─────────────────────────────────────────────────────────────────────
  {
    id: "suspiciousHuman",
    title: "A Suspicious Human",
    weight: 8,
    floors: [1, 4],
    prompt:
      "A human in a trench coat crouches in the gloom, holding out a crinkly bag. " +
      '"Heeere kitty kitty," it says, smiling slightly too wide. ' +
      "The treats smell real. The human does not.",
    options: [
      {
        label: "Accept the treats. Treats are treats.",
        outcomes: [
          {
            weight: 55,
            text: "They ARE real. Salmon flavor. The human nods slowly, satisfied, and backs away into the darkness without breaking eye contact.",
            effects: [
              {
                kind: "heal",
                target: "party",
                amount: { base: 8, perFloor: 1 },
              },
            ],
          },
          {
            weight: 35,
            text: "The treats expired during a previous civilization. Everyone eats them anyway. Everyone regrets it.",
            effects: [
              {
                kind: "damage",
                target: "party",
                amount: { base: 3, perFloor: 1 },
              },
            ],
          },
          {
            weight: 10,
            text: "The human panics, drops the entire bag, and flees up a staircase that was not there before.",
            effects: [{ kind: "giveItem", item: "tunaSnack", count: 2 }],
          },
        ],
      },
      {
        label: "Hiss. Swipe. Take the whole bag.",
        requires: { kind: "class", class: "bruiser" },
        outcomes: [
          {
            weight: 1,
            text: "The Bruiser rises to full height. The human reconsiders every decision that led to this basement, drops the bag AND its lunch money, and leaves.",
            effects: [
              { kind: "giveItem", item: "tunaSnack", count: 2 },
              { kind: "shinies", amount: 10 },
            ],
          },
        ],
      },
      {
        label: "Decline. You saw the van outside.",
        outcomes: [
          {
            weight: 1,
            text: 'You keep walking. Behind you, the human whispers "...worth a try" and folds back into the shadows.',
            effects: [{ kind: "nothing" }],
          },
        ],
      },
    ],
  },

  // ── 3 ─────────────────────────────────────────────────────────────────────
  {
    id: "cursedPost",
    title: "The Cursed Scratching Post",
    weight: 8,
    floors: [2, 6],
    prompt:
      "A scratching post of black sisal stands in a circle of scorched tiles. " +
      "Runes spiral up its length, and the shredded offerings of a hundred " +
      "previous cats litter its base. It is, admittedly, EXACTLY the right height.",
    options: [
      {
        label: "Scratch it. Obviously.",
        outcomes: [
          {
            weight: 45,
            text: "The post PURRS. Warm strength floods up through claw and paw. The runes glow approvingly.",
            effects: [
              {
                kind: "buff",
                target: "random",
                stat: "atk",
                amount: 2,
                duration: "floor",
              },
            ],
          },
          {
            weight: 25,
            text: "The post accepts the offering utterly. The scratcher's claws come away edged with something old and sharp. This feels permanent.",
            effects: [
              {
                kind: "buff",
                target: "random",
                stat: "atk",
                amount: 1,
                duration: "run",
              },
            ],
          },
          {
            weight: 30,
            text: "The post scratches BACK. The runes flash, the tiles hiss, and the offender is flung across the room minus some dignity and fur.",
            effects: [
              {
                kind: "damage",
                target: "random",
                amount: { base: 6, perFloor: 1 },
              },
              {
                kind: "buff",
                target: "random",
                stat: "def",
                amount: -1,
                duration: "floor",
              },
            ],
          },
        ],
      },
      {
        label: "Read the runes first.",
        requires: { kind: "class", class: "hexer" },
        outcomes: [
          {
            weight: 1,
            text: "The Hexer traces the spiral and finds the one safe groove — the maker's signature — and sharpens her claws in it at leisure.",
            effects: [
              {
                kind: "buff",
                target: "gateCat",
                stat: "atk",
                amount: 1,
                duration: "run",
              },
            ],
          },
        ],
      },
      {
        label: "Some posts are not for scratching.",
        outcomes: [
          {
            weight: 1,
            text: 'You file it under "no". The post creaks, disappointed, as you pass.',
            effects: [{ kind: "nothing" }],
          },
        ],
      },
    ],
  },

  // ── 4 ─────────────────────────────────────────────────────────────────────
  {
    id: "shrineOfNine",
    title: "Shrine of the Nine",
    weight: 6,
    floors: [3, 6],
    once: true,
    prompt:
      "A moonlit alcove that should not have moonlight. Nine candles burn around " +
      "a worn stone statue of the First Cat, depicted — as in all the old " +
      "carvings — mid-yawn. The air tastes like the moment before a purr.",
    options: [
      {
        label: "Make an offering of shinies.",
        requires: { kind: "shinies", cost: { base: 60, perFloor: 10 } },
        outcomes: [
          {
            weight: 1,
            text: "The shinies sink into the stone. One candle flares white, and somewhere inside your friend, a spent life quietly rekindles.",
            effects: [
              { kind: "restoreLife", target: "lowestLives", amount: 1 },
            ],
          },
        ],
      },
      {
        label: "Curl up and pray.",
        outcomes: [
          {
            weight: 1,
            text: "You knead the cold stone and think warm thoughts. The First Cat's yawn seems, briefly, like a smile. Aches fade.",
            effects: [{ kind: "heal", target: "party", amount: 6 }],
          },
        ],
      },
      {
        label: "Knock a candle off the shrine.",
        outcomes: [
          {
            weight: 5,
            text: "It clatters magnificently. The First Cat — patron saint of knocking-things-off-surfaces — approves, and shinies rain briefly from nowhere.",
            effects: [{ kind: "shinies", amount: 25 }],
          },
          {
            weight: 5,
            text: "The flame goes out. All the other flames turn to look at you. The lesson is brief, hot, and extremely fair.",
            effects: [{ kind: "damage", target: "party", amount: 5 }],
          },
        ],
      },
    ],
  },

  // ── 5 ─────────────────────────────────────────────────────────────────────
  {
    id: "perfectBox",
    title: "A Perfect Box",
    weight: 10,
    floors: [1, 6],
    prompt:
      "A cardboard box sits in the torchlight. It is clean. It is dry. It is " +
      "precisely the size of four cats. Ancient law is unambiguous on this " +
      "point: if it fits, you sits.",
    options: [
      {
        label: "Get in the box. All of you. Immediately.",
        outcomes: [
          {
            weight: 7,
            text: "You fit. You sits. Twenty perfect minutes of communal loafing later, the dungeon feels beatable again.",
            effects: [
              {
                kind: "heal",
                target: "party",
                amount: { base: 10, perFloor: 1 },
              },
            ],
          },
          {
            weight: 3,
            text: "You fit, you sits, you nap — and wake to rats prying at the flaps, furious that you found their clubhouse.",
            effects: [
              {
                kind: "heal",
                target: "party",
                amount: { base: 10, perFloor: 1 },
              },
              {
                kind: "fight",
                encounter: ["ratThug", "ratThug", "ratThug"],
                loot: "normal",
              },
            ],
          },
        ],
      },
      {
        label: "Circle it warily before committing.",
        requires: { kind: "stat", stat: "spd", min: 8 },
        outcomes: [
          {
            weight: 1,
            text: "Your fastest scout laps the box, spots three rat tails under a flap, and delivers one thunderous pre-emptive pounce. The rats resign. The box — and their stash — are yours.",
            effects: [
              { kind: "shinies", amount: { base: 10, perFloor: 3 } },
              {
                kind: "heal",
                target: "party",
                amount: { base: 10, perFloor: 1 },
              },
            ],
          },
        ],
      },
      {
        label: "It is a trap. It is always a trap.",
        outcomes: [
          {
            weight: 1,
            text: "You walk past the box. The box says nothing, which is somehow worse.",
            effects: [{ kind: "nothing" }],
          },
        ],
      },
    ],
  },

  // ── 6 ─────────────────────────────────────────────────────────────────────
  {
    id: "milkBowl",
    title: "The Bowl of Milk",
    weight: 8,
    floors: [1, 5],
    prompt:
      "A saucer of milk, fresh and impossibly cold, sits on a stone pedestal. " +
      "Every instinct says drink. One very small, frequently ignored instinct " +
      "notes that adult cats are, in fact, lactose intolerant.",
    options: [
      {
        label: "Lap it up. Instinct outranks biology.",
        outcomes: [
          {
            weight: 4,
            text: "Worth it. WORTH IT. Whiskers dripping, hearts full, and — for once — no consequences arrive.",
            effects: [
              {
                kind: "heal",
                target: "party",
                amount: { base: 6, perFloor: 1 },
              },
              { kind: "energyNextBattle", target: "party", amount: 1 },
            ],
          },
          {
            weight: 6,
            text: '"Worth it," you all insist, ten minutes later, lying on your sides in a chorus of tiny gurgles. Biology outranks instinct.',
            effects: [
              {
                kind: "damage",
                target: "party",
                amount: { base: 4, perFloor: 1 },
              },
            ],
          },
        ],
      },
      {
        label: "Have the Medic run a sniff test.",
        requires: { kind: "class", class: "medic" },
        outcomes: [
          {
            weight: 1,
            text: 'One professional sniff: "Oat milk. Barista blend. Safe." The party drinks like royalty.',
            effects: [
              {
                kind: "heal",
                target: "party",
                amount: { base: 6, perFloor: 1 },
              },
              { kind: "energyNextBattle", target: "party", amount: 1 },
            ],
          },
        ],
      },
      {
        label: "Tip the bowl over and leave.",
        outcomes: [
          {
            weight: 1,
            text: "CLATTER. Deeply satisfying. Petty, but satisfying. Under the saucer: a few shinies some earlier, equally petty cat left behind.",
            effects: [{ kind: "shinies", amount: 5 }],
          },
        ],
      },
    ],
  },

  // ── 7 ─────────────────────────────────────────────────────────────────────
  {
    id: "redDot",
    title: "The Red Dot",
    weight: 7,
    floors: [2, 6],
    prompt:
      "It appears on the far wall. It dances. It has no source, no mass, no " +
      "user, no mercy — an enemy Stand, the elders insist, whose wielder has " +
      "never been found. Generations of cats have chased it; none have caught " +
      "it. It slides three inches to the left, daring you.",
    options: [
      {
        label: "CHASE.",
        outcomes: [
          {
            weight: 50,
            text: "The chase is everything. Walls are run upon. Physics files a complaint. You do not catch it — but stars, are you FAST now.",
            effects: [
              {
                kind: "damage",
                target: "party",
                amount: { base: 4, perFloor: 1 },
              },
              {
                kind: "buff",
                target: "party",
                stat: "spd",
                amount: 1,
                duration: "floor",
              },
            ],
          },
          {
            weight: 35,
            text: "You corner it — impossible — and it winks out, revealing the wall-crack it was luring you toward. Inside: a previous chaser's hoard.",
            effects: [{ kind: "shinies", amount: { base: 15, perFloor: 5 } }],
          },
          {
            weight: 15,
            text: "One of you CATCHES IT. Holds it, wriggling, under a paw. The universe holds its breath. Before escaping, the dot yields its secret: how to be exactly where the prey will be.",
            effects: [
              {
                kind: "buff",
                target: "random",
                stat: "crt",
                amount: 5,
                duration: "run",
              },
            ],
          },
        ],
      },
      {
        label: "Predict its path instead of chasing it.",
        requires: { kind: "stat", stat: "crt", min: 12 },
        outcomes: [
          {
            weight: 1,
            text: "The sharpest eyes in the party go still, track the pattern, and slam a paw down on the dot's NEXT position. It never even flickered away. Legendary.",
            effects: [
              {
                kind: "buff",
                target: "gateCat",
                stat: "crt",
                amount: 5,
                duration: "run",
              },
              { kind: "shinies", amount: 10 },
            ],
          },
        ],
      },
      {
        label: "You are above this.",
        outcomes: [
          {
            weight: 1,
            text: "You are not above this. No cat is above this. But you pretend, magnificently, and the dot dims with something like disappointment.",
            effects: [{ kind: "nothing" }],
          },
        ],
      },
    ],
  },

  // ── 8 ─────────────────────────────────────────────────────────────────────
  {
    id: "dormantRoomba",
    title: "The Dormant Roomba",
    weight: 7,
    floors: [3, 6],
    prompt:
      "The Ancient Enemy sleeps in its charging dock, one light blinking slow " +
      "and red, its Stand «CLEAN SWEEP» idling in standby above it. Its dust " +
      "bin rattles when the draft moves it — rattles like a great many " +
      "shinies. Every tail in the party is already puffed.",
    options: [
      {
        label: "Pounce it. End the bloodline.",
        outcomes: [
          {
            weight: 1,
            text: "It wakes mid-pounce, shrieks a boot chime of pure malice, and comes about to face you. The floor is ITS territory. Correct this.",
            effects: [
              {
                kind: "fight",
                encounter: ["roombaScout"],
                loot: "bonus",
                onWinEffects: [
                  { kind: "shinies", amount: { base: 25, perFloor: 5 } },
                ],
              },
            ],
          },
        ],
      },
      {
        label: "Extract its battery without waking it.",
        requires: { kind: "class", class: "trickster" },
        outcomes: [
          {
            weight: 1,
            text: "Sixty silent seconds of surgical paw-work. The light blinks once more and dies forever. The Trickster empties the dust bin into the party purse and bows.",
            effects: [
              { kind: "shinies", amount: { base: 25, perFloor: 5 } },
              { kind: "giveItem", item: "catnip", count: 1 },
            ],
          },
        ],
      },
      {
        label: "Do not wake the Ancient Enemy.",
        outcomes: [
          {
            weight: 1,
            text: "You give it the widest berth the corridor allows, walking sideways, fur up, eyes locked on it the entire time. It blinks once. You survive.",
            effects: [{ kind: "nothing" }],
          },
        ],
      },
    ],
  },

  // ── 9 ─────────────────────────────────────────────────────────────────────
  {
    id: "catnipPatch",
    title: "The Wild Catnip Patch",
    weight: 9,
    floors: [1, 6],
    prompt:
      "Impossibly, a patch of catnip grows from a crack in the dungeon floor, " +
      "silver-green and swaying in a breeze that is not there. The smell arrives " +
      "a full second before your dignity leaves.",
    options: [
      {
        label: "Roll in it. Immediately. All of you.",
        outcomes: [
          {
            weight: 7,
            text: "Bliss. Cosmic, wriggling, upside-down bliss. The party emerges vibrating gently with power and covered in leaves.",
            effects: [
              { kind: "heal", target: "party", amount: 4 },
              { kind: "energyNextBattle", target: "party", amount: 2 },
            ],
          },
          {
            weight: 3,
            text: "TOO much bliss. The party emerges vibrating, yes — but also giggling at load-bearing walls and walking diagonally.",
            effects: [
              { kind: "energyNextBattle", target: "party", amount: 2 },
              {
                kind: "buff",
                target: "party",
                stat: "spd",
                amount: -1,
                duration: "floor",
              },
            ],
          },
        ],
      },
      {
        label: "Harvest it properly for later.",
        requires: { kind: "class", class: "hexer" },
        outcomes: [
          {
            weight: 1,
            text: "The Hexer, breathing through her mouth with heroic restraint, cuts and wraps the potent tops the way the old rites demand.",
            effects: [{ kind: "giveItem", item: "catnip", count: 2 }],
          },
        ],
      },
      {
        label: "March past. You are professionals.",
        outcomes: [
          {
            weight: 1,
            text: "You march past in single file, pupils enormous, tails perfectly straight. Nobody rolls. Everybody wants to. It is the hardest battle of the run.",
            effects: [{ kind: "nothing" }],
          },
        ],
      },
    ],
  },

  // ── 10 ────────────────────────────────────────────────────────────────────
  {
    id: "elderStray",
    title: "The Elder Stray",
    weight: 7,
    floors: [2, 6],
    once: true,
    prompt:
      "On a warm grate sits the oldest cat you have ever seen — one-eared, " +
      "scar-striped, sphinx-still. He was fighting this dungeon before your " +
      "grandmothers were kittens. He does not get up. He does not need to.",
    options: [
      {
        label: "Share your food with him.",
        requires: { kind: "item", item: "tunaSnack" },
        outcomes: [
          {
            weight: 1,
            text: 'He eats slowly, with ceremony, then touches his scarred forehead to each of yours. "Walk soft. Land softer." The blessing settles over you like a warm towel.',
            effects: [
              {
                kind: "buff",
                target: "party",
                stat: "def",
                amount: 1,
                duration: "floor",
              },
            ],
          },
        ],
      },
      {
        label: "Ask him for a lesson.",
        requires: { kind: "stat", stat: "atk", min: 12 },
        outcomes: [
          {
            weight: 1,
            text: "He looks your strongest fighter up and down, sighs, and moves like weather. Three seconds and one humiliating tumble later, the lesson is IN the muscle now. So are some bruises.",
            effects: [
              { kind: "damage", target: "gateCat", amount: 5 },
              {
                kind: "buff",
                target: "gateCat",
                stat: "atk",
                amount: 1,
                duration: "run",
              },
            ],
          },
        ],
      },
      {
        label: "Settle in and listen to his stories.",
        outcomes: [
          {
            weight: 1,
            text: "His purr is a war drum heard from a safe distance. He speaks of the Rat King's grandsire, of the Great De-Clawing, of Stands lost in the wash, of a red dot he almost caught in '09. Your wounds knit as you listen.",
            effects: [{ kind: "heal", target: "party", amount: 4 }],
          },
        ],
      },
      {
        label: "Take his spot. It looks warm.",
        outcomes: [
          {
            weight: 1,
            text: "The grate is warm. The mistake is instant. The Elder rises like smoke with a grudge — and «GRANDFATHER CLAWS» rises behind him, vast and patient — and you learn firsthand why the dungeon never managed to kill him.",
            effects: [
              {
                kind: "fight",
                encounter: ["elderStray"],
                loot: "bonus",
                onWinEffects: [
                  { kind: "shinies", amount: { base: 30, perFloor: 5 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];
