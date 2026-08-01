/**
 * THE CAMP, in words (docs/design/roster-and-persistence.md §4).
 *
 * "Camp is where the party becomes characters instead of stat blocks, so the
 * writing matters more than the numbers here."
 *
 * When a DM is reachable the exchange between two named cats is asked for
 * live, and it is the best material the DM has — it can call back to what
 * happened two floors ago. When there is no DM (the hard offline-first rule),
 * THIS FILE is the camp. So it is written to be enough on its own: every
 * situation the camp can be in has its own lines, nothing here is a stub, and
 * a run that never touches the network still hears its cats talk to each
 * other differently on floor 5 than it did on floor 1.
 *
 * SHAPE. An exchange is 2-4 lines between two cats, `a` and `b`, chosen by the
 * camp for this fire. `{a}` and `{b}` interpolate their names. Tags say what
 * situation a line belongs to; an exchange with NO tags fits any fire, which
 * is what guarantees there is always something to say.
 *
 * Data only — `core/run/camp.ts` picks, `ui/scenes/camp.ts` renders.
 */

/**
 * What is true at this fire. The camp collects these from the run and the
 * exchange pool is filtered to lines that fit at least one of them (or fit
 * anything).
 */
export type CampTag =
  /** somebody at the fire is hungry (§3 hunger ≥ 2) */
  | "hungry"
  /** somebody is carrying a scar */
  | "scarred"
  /** somebody is under half HP */
  | "hurt"
  /** somebody is down to their last Life */
  | "lastLife"
  /** a cat on this descent is out of Lives */
  | "fallen"
  /** the floor's terminal node is a boss */
  | "boss"
  /** floor 4 or deeper */
  | "deep"
  /** floor 1-2 */
  | "early"
  /** the backpack is heavy */
  | "flush"
  /** not one shiny between them */
  | "broke"
  /** these two already sat up together once */
  | "bonded";

export interface CampLine {
  who: "a" | "b";
  /** `{a}` / `{b}` interpolate the two cats' names. */
  text: string;
}

export interface CampExchange {
  id: string;
  /** Situations this fits. EMPTY = fits any fire (the always-there pool). */
  tags: readonly CampTag[];
  lines: readonly CampLine[];
}

/** The line over the fire when the party first sits down. */
export const CAMP_OPENERS: readonly string[] = [
  "A dry corner, a dented tin, and something in it that burns.",
  "The pipes tick overhead. Nothing down here is hunting for a while.",
  "Somebody has scraped a circle clear of grit. It will do.",
  "The fire is mostly an idea, but it is a warm one.",
  "Four walls, three of them standing. Good enough to sit against.",
  "Heat off a fuse box, and the smell of old rain.",
];

/**
 * THE ALWAYS-THERE POOL and every situational one, in one table.
 *
 * Written so that no two consecutive fires on a run are likely to repeat: the
 * generic pool alone is deep, and the situational tags layer on top of it.
 */
export const CAMP_EXCHANGES: readonly CampExchange[] = [
  /* ---- generic: fits any fire -------------------------------------- */
  {
    id: "wall",
    tags: [],
    lines: [
      { who: "a", text: "{a} sits with their back to the wall. Again." },
      { who: "b", text: '"The wall has never once bitten me," {a} says.' },
      {
        who: "b",
        text: "{b} moves their tail off the cold floor and says nothing, which is agreement.",
      },
    ],
  },
  {
    id: "names",
    tags: [],
    lines: [
      {
        who: "b",
        text: '"What did they call you," {b} asks, "before all this?"',
      },
      { who: "a", text: '"They didn\'t," says {a}. "That was the problem."' },
    ],
  },
  {
    id: "counting",
    tags: [],
    lines: [
      {
        who: "a",
        text: "{a} counts something on their toes, twice, and gets a different answer.",
      },
      {
        who: "b",
        text: '"Stop counting," says {b}. "We\'re all still here. That\'s the number."',
      },
    ],
  },
  {
    id: "grooming",
    tags: [],
    lines: [
      { who: "b", text: "{b} starts grooming {a}'s ears without being asked." },
      { who: "a", text: "{a} pretends to hate it for eleven whole seconds." },
    ],
  },
  {
    id: "listening",
    tags: [],
    lines: [
      { who: "a", text: '"Hear that?" says {a}.' },
      { who: "b", text: '{b} listens. "That\'s the building settling."' },
      { who: "a", text: '"That\'s what it wants us to think."' },
    ],
  },
  {
    id: "plan",
    tags: [],
    lines: [
      {
        who: "b",
        text: "{b} draws the way ahead in the dust: three lines and a scribble.",
      },
      { who: "a", text: '"What\'s the scribble?"' },
      { who: "b", text: '"The part we improvise."' },
    ],
  },
  {
    id: "sleepTalk",
    tags: [],
    lines: [
      {
        who: "a",
        text: "{a} is asleep in nine seconds flat, upright, eyes half open.",
      },
      {
        who: "b",
        text: "{b} watches for a while, then stops pretending they aren't relieved.",
      },
    ],
  },
  {
    id: "boxTheory",
    tags: [],
    lines: [
      {
        who: "b",
        text: '"If we find a box down here," says {b}, "I\'m getting in it."',
      },
      {
        who: "a",
        text: '"You\'ll get in it and we will never see you again."',
      },
      { who: "b", text: '"Correct."' },
    ],
  },
  {
    id: "stands",
    tags: [],
    lines: [
      {
        who: "a",
        text: "{a} tries to explain their Stand out loud and gives up halfway.",
      },
      {
        who: "b",
        text: '"You don\'t have to explain it," says {b}. "I\'ve seen it work."',
      },
    ],
  },
  {
    id: "quietOne",
    tags: [],
    lines: [
      { who: "b", text: "Neither of them says anything for a long time." },
      {
        who: "a",
        text: "It is the good kind of nothing. {a} leans a shoulder in and leaves it there.",
      },
    ],
  },
  {
    id: "argument",
    tags: [],
    lines: [
      {
        who: "a",
        text: '"You went LEFT," says {a}. "Left was the one with the teeth."',
      },
      {
        who: "b",
        text: "\"And we're sitting down having a nice chat about it, aren't we.\"",
      },
    ],
  },
  {
    id: "supper",
    tags: [],
    lines: [
      {
        who: "b",
        text: "{b} splits something small in half and pushes the bigger piece over.",
      },
      {
        who: "a",
        text: "{a} pushes it back. They do this twice more before it gets eaten.",
      },
    ],
  },

  /* ---- hungry ------------------------------------------------------- */
  {
    id: "hungryRation",
    tags: ["hungry"],
    lines: [
      {
        who: "a",
        text: "{a}'s stomach makes a noise like a drain unblocking.",
      },
      {
        who: "b",
        text: '"That\'s the fourth one," says {b}. "I\'m keeping count now."',
      },
      { who: "a", text: '"Keep count quieter."' },
    ],
  },
  {
    id: "hungryDream",
    tags: ["hungry"],
    lines: [
      {
        who: "b",
        text: '"When we get up top," says {b}, "I\'m eating an entire fish. Bones in."',
      },
      {
        who: "a",
        text: "{a} does not answer. {a} is already there, in their head, with the fish.",
      },
    ],
  },
  {
    id: "hungryShare",
    tags: ["hungry"],
    lines: [
      {
        who: "a",
        text: "{a} has been not-eating so quietly that {b} nearly missed it.",
      },
      { who: "b", text: '"Take it. You\'re no use to me hollow."' },
    ],
  },
  {
    id: "hungryGrit",
    tags: ["hungry"],
    lines: [
      { who: "b", text: '"You\'re shaking."' },
      { who: "a", text: '"I\'m cold."' },
      { who: "b", text: '"You\'re hungry. Say the true one next time."' },
    ],
  },

  /* ---- scarred ------------------------------------------------------ */
  {
    id: "scarStory",
    tags: ["scarred"],
    lines: [
      {
        who: "b",
        text: "{b} looks at the mark for a while, then away, then back.",
      },
      { who: "a", text: '"Ask," says {a}.' },
      {
        who: "b",
        text: '"Did it hurt?" "Still does. That\'s how I know which way not to go."',
      },
    ],
  },
  {
    id: "scarTrade",
    tags: ["scarred"],
    lines: [
      {
        who: "a",
        text: '"Yours is worse than mine," says {a}, almost proud of them.',
      },
      { who: "b", text: '"It\'s not a competition." A pause. "But yes."' },
    ],
  },
  {
    id: "scarTend",
    tags: ["scarred"],
    lines: [
      {
        who: "b",
        text: "{b} works at the old mark with a wet paw, gently, the way nobody ever did for them.",
      },
      { who: "a", text: "{a} holds very still and looks at the ceiling." },
    ],
  },

  /* ---- hurt --------------------------------------------------------- */
  {
    id: "hurtCheck",
    tags: ["hurt"],
    lines: [
      { who: "b", text: '"Let me see it." "It\'s fine." "Let me SEE it."' },
      {
        who: "a",
        text: "It is not fine. {b} does not say so out loud, which is its own kind of kindness.",
      },
    ],
  },
  {
    id: "hurtHonest",
    tags: ["hurt"],
    lines: [
      {
        who: "a",
        text: '"I can keep going," says {a}, in the voice of someone who cannot.',
      },
      { who: "b", text: '"I know. Sit down anyway."' },
    ],
  },
  {
    id: "hurtBlame",
    tags: ["hurt"],
    lines: [
      {
        who: "b",
        text: '"That one was mine. I should have been a rank forward."',
      },
      {
        who: "a",
        text: '"You were where I put you," says {a}. "Eat something."',
      },
    ],
  },

  /* ---- last life ---------------------------------------------------- */
  {
    id: "lastLifeCount",
    tags: ["lastLife"],
    lines: [
      { who: "b", text: '"How many have you got left?"' },
      { who: "a", text: "{a} holds up one paw and does not elaborate." },
      { who: "b", text: '"Then you walk behind me from here."' },
    ],
  },
  {
    id: "lastLifePromise",
    tags: ["lastLife"],
    lines: [
      { who: "a", text: '"If it goes wrong," {a} starts.' },
      {
        who: "b",
        text: '"It won\'t." "If it DOES —" "Then I\'ll carry you up myself. Sleep."',
      },
    ],
  },
  {
    id: "lastLifeName",
    tags: ["lastLife"],
    lines: [
      {
        who: "b",
        text: "{b} says {a}'s name once, for no reason, just to have said it.",
      },
      { who: "a", text: '"I\'m right here." "I know. Go to sleep."' },
    ],
  },

  /* ---- somebody fell ------------------------------------------------ */
  {
    id: "fallenSpace",
    tags: ["fallen"],
    lines: [
      {
        who: "a",
        text: "There is a gap at the fire where somebody should be sitting.",
      },
      { who: "b", text: "Neither of them moves into it." },
    ],
  },
  {
    id: "fallenName",
    tags: ["fallen"],
    lines: [
      {
        who: "b",
        text: '"Say their name," says {b}. "Out loud, once. Then we go on."',
      },
      { who: "a", text: "{a} says it. The pipes tick. That's all there is." },
    ],
  },

  /* ---- boss ahead --------------------------------------------------- */
  {
    id: "bossListen",
    tags: ["boss"],
    lines: [
      {
        who: "a",
        text: "Something enormous is breathing on the other side of the wall.",
      },
      { who: "b", text: '"That\'s not the building settling," {b} admits.' },
      { who: "a", text: '"No. That one\'s awake."' },
    ],
  },
  {
    id: "bossPlan",
    tags: ["boss"],
    lines: [
      {
        who: "b",
        text: '"Front rank, and don\'t let it turn," says {b}. "I\'ll go under it."',
      },
      {
        who: "a",
        text: '"That\'s not a plan, that\'s a dare." "It\'s worked before."',
      },
    ],
  },
  {
    id: "bossAfraid",
    tags: ["boss"],
    lines: [
      { who: "a", text: '"Are you scared?"' },
      {
        who: "b",
        text: '"Yes." Beat. "Are you?" "Very." "Good. Scared cats live."',
      },
    ],
  },

  /* ---- deep --------------------------------------------------------- */
  {
    id: "deepAir",
    tags: ["deep"],
    lines: [
      {
        who: "a",
        text: '"The air\'s different this far down. Tastes like coins."',
      },
      {
        who: "b",
        text: '"Everything tastes like coins to you. That\'s the problem."',
      },
    ],
  },
  {
    id: "deepUp",
    tags: ["deep"],
    lines: [
      { who: "b", text: "{b} looks up the way they came for a long moment." },
      { who: "a", text: '"Still there," says {a}. "Up is still there."' },
    ],
  },
  {
    id: "deepStories",
    tags: ["deep"],
    lines: [
      { who: "a", text: '"Nobody in town tells stories about this floor."' },
      {
        who: "b",
        text: '"Nobody in town has been on this floor." "That\'s the thing I meant."',
      },
    ],
  },

  /* ---- early -------------------------------------------------------- */
  {
    id: "earlyBravado",
    tags: ["early"],
    lines: [
      { who: "b", text: '"Easy so far," says {b}, out loud, like an idiot.' },
      { who: "a", text: "{a} closes their eyes very slowly." },
    ],
  },
  {
    id: "earlyFirst",
    tags: ["early"],
    lines: [
      { who: "a", text: '"First fire\'s always the best one."' },
      { who: "b", text: '"Why?" "Everyone\'s still here."' },
    ],
  },

  /* ---- flush / broke ------------------------------------------------ */
  {
    id: "flushPlans",
    tags: ["flush"],
    lines: [
      {
        who: "b",
        text: "{b} pours the shinies out and sorts them by size, which helps nobody.",
      },
      {
        who: "a",
        text: '"That\'s a collar\'s worth." "That\'s a collar AND a tin."',
      },
    ],
  },
  {
    id: "brokePockets",
    tags: ["broke"],
    lines: [
      {
        who: "a",
        text: "{a} turns the bag upside down. Grit comes out. That's it.",
      },
      {
        who: "b",
        text: '"So we\'re doing this the interesting way," says {b}.',
      },
    ],
  },

  /* ---- already bonded ----------------------------------------------- */
  {
    id: "bondedShorthand",
    tags: ["bonded"],
    lines: [
      {
        who: "b",
        text: "{b} starts a sentence. {a} finishes it. Neither notices.",
      },
      { who: "a", text: "They have done this fire before, and it shows." },
    ],
  },
  {
    id: "bondedWatch",
    tags: ["bonded"],
    lines: [
      { who: "a", text: '"Same as last time?" "Same as last time."' },
      {
        who: "b",
        text: "{b} takes first watch without either of them deciding it.",
      },
    ],
  },
];

/**
 * Flavour for each camp action, offline. `{a}` is the cat acted on, `{b}` the
 * other one at the fire when there is one.
 */
export const CAMP_ACTION_LINES: Record<string, readonly string[]> = {
  eat: [
    "{a} eats like it is a job to be finished.",
    "{a} takes it slowly, which fools nobody.",
    "It is not much. {a} makes it be enough.",
  ],
  bandage: [
    "{b} winds the strip too tight and {a} says so, twice.",
    "{a} is patched with something that used to be a sock.",
    "The bleeding stops. That is the whole of the good news, and it is plenty.",
  ],
  tend: [
    "{a}'s old mark gets an hour of somebody's full attention.",
    "Warmth, pressure, patience. The scar stays. The pull lets go for a while.",
    "{a} stops holding that shoulder like it belongs to someone else.",
  ],
  talk: [
    "They talk until the fire is embers and neither of them wins.",
    "Whatever that was, they are both a little steadier for it.",
    "Something gets said out loud that had been waiting a few floors.",
  ],
  watch: [
    "{a} takes the last watch and lets the others go under properly.",
    "Nothing comes. {a} was ready for it anyway.",
    "{a} sits facing the dark so nobody else has to.",
  ],
};
