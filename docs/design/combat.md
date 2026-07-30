# c(at)rpg Combat — Final Design: "Claws & Ranks: Nine Lives Edition"

**Status: FINAL — synthesized from three contest entries.** Base system: Design 1
("Claws & Ranks", the contest winner). Grafts: the headless event-driven engine
architecture and the Cat Pile all-out attack from Design 2 ("Claws & Effect");
boss Poise and the Nine Lives death rule from Design 3 ("Nine Lives: Stalk &
Pounce"). Every contradiction between the sources is resolved in §15. The system
below is fully specified: an implementing agent needs zero additional design calls.

Design pillars:

1. **Forced movement is the combo engine** ("Off-Paw"): shoving enemies around
   is both crowd control and a damage amplifier for teammates.
2. **One exploit system, not two.** No elemental affinities — positioning is the
   only amplification game, so every class, enemy, and item hooks into it.
3. **Deterministic and headless.** One seeded RNG stream, rolls in documented
   order, pure `resolveAction(state, action, rng) -> { newState, events[] }`.
   The PixiJS layer only animates the event log.
4. **Light roguelike dread**: HP persists across a floor, KOs burn Lives, but a
   single fight is low-stakes slapstick — cats batting rats around like toys.

---

## 1. Battle Setup & Positioning

Combat is a side-view formation fight on a single axis:

```
  CATS (party)                    ENEMIES
[R4][R3][R2][R1]   <-- gap -->   [R1][R2][R3][R4][R5]
 back      front                  front         back
```

- **Cats** occupy ranks 1–4 (rank 1 = frontmost), exactly one cat per rank.
  Party order at battle start comes from the dungeon-side marching order.
- **Enemies** occupy ranks 1–5, one per rank, 1–5 enemies per encounter.
  Encounter data is a plain front-to-back array, e.g. `['rat','rat','crowShaman']`.
- **No empty gaps, ever**: when a combatant dies or is KO'd it is removed and
  everyone behind slides forward one rank. This is the only free movement, and
  it matters — killing the front rat drags the squishy shaman into claw range.
- Rank 5 exists only on the enemy side (big encounters, boss summons). Almost
  no skill reaches rank 5; creatures there are reinforcements that slide into
  danger as the front dies.
- Every skill declares which ranks it can be **used from** and which ranks it
  can **hit**. Position is both a constraint (can my cat act?) and a weapon
  (can I shove the enemy out of *its* usable ranks?).

### Data model (combatants)

```ts
interface Combatant {
  id: string;
  name: string;
  side: 'cat' | 'enemy';
  rank: number;              // 1-based, current position
  stats: Stats;              // §3
  hp: number;
  energy: number;            // cats only; enemies use cooldowns
  skills: SkillId[];
  cooldowns: Record<SkillId, number>;   // enemies only
  statuses: StatusInstance[];
  traits: Trait[];           // 'heavy' = immune to forced movement (bosses/elites)
  lives?: number;            // cats only, 0..9 — see §12
  poise?: number;            // bosses only — see §11
}
```

Units render as procedural PixiJS blobs (rounded-rect body, triangle ears, dot
eyes, line whiskers), HP/energy bars underneath, status icons above.

---

## 2. Turn Order (exact algorithm)

Round-based initiative with a small seeded roll — predictable enough to plan
around, noisy enough to stay lively.

At the start of each round:

1. For every living combatant `c`, compute
   `initiative = c.stats.spd + rngInt(0, 2)` (inclusive). One draw per
   combatant, in a fixed order — cats rank 1→4, then enemies rank 1→5 — so the
   result is deterministic.
2. Sort descending by initiative. **Tie-breaks, in order:** cats before
   enemies → lower current rank first → lower entity id.
3. The queue is **frozen for the round**. Forced movement does not re-sort it.
   Combatants that die or are KO'd before their slot are skipped. Combatants
   summoned mid-round act starting next round.
4. When the queue is exhausted, run the **round-end phase** (§7), then start
   the next round.

Bosses with the `doubleTurn` flag get **two independent entries** in the queue
(two separate initiative rolls pointing at the same combatant).

The full initiative queue is **shown to the player** as a timeline bar at the
top of the screen (Persona/Grandia style). Visible turn order is what makes the
Off-Paw combo system (§8) a planning game instead of a guessing game.

---

## 3. Core Stats (6) and the Damage Formula

| Stat | Meaning | Typical cat range | Typical enemy range |
|------|---------|------------------|---------------------|
| `hp`  | Max hit points | 24–40 | 10–60 (boss 120+) |
| `atk` | Power for ALL skills — claws, hexes, and heals alike (one offensive stat keeps the list tiny) | 9–14 | 5–12 |
| `def` | Flat damage reduction | 0–4 | 0–5 |
| `spd` | Initiative (§2) and flee chance | 3–9 | 3–8 |
| `crt` | Crit chance, percent | 5–15 | 0–10 |
| `enMax` | Energy cap (cats only; fixed 10 in v1 — listed as a stat so items can raise it) | 10 | — |

### Damage formula (exact, applied in this order)

```
1. base     = skill.power / 100 * user.atk
2. variance = 0.9 + 0.1 * rngInt(0, 2)           // exactly 0.9, 1.0, or 1.1
3. crit     = (rngFloat() < user.crt / 100) ? 1.5 : 1.0
4. offBal   = target has Off-Balance ? 1.5 : 1.0
5. guard    = target has Guarded     ? 0.5 : 1.0
6. dmg      = round(base * variance * crit * offBal * guard)   // round half up
7. final    = max(1, dmg - target.def)
```

There is **no accuracy roll** — attacks always land (misses feel bad in a
4-actor party; defense is expressed through `def`, Guarded, and positioning).
Maximum stacked multiplier is 1.1 × 1.5 × 1.5 = 2.475, a bounded burst ceiling.

**Healing:** `heal = round(skill.power / 100 * user.atk)` — no variance, no
crit, capped at max HP.

**Cat Pile** (§8) uses its own flat formula and skips this pipeline entirely.

All RNG comes from **one seeded stream per battle**, derived as
`mulberry32(hash(runSeed, floor, encounterIndex))`. Rolls are always drawn in
a documented order (initiative draws at round start; per damaging action per
target in rank order: variance, then crit, then per-effect status chances;
then AI tie-breaks; flee), so replays with the same seed are identical.

---

## 4. Skill Model (data-driven)

A skill is a plain data object. Cats are gated by **energy** (no cooldowns);
enemies are gated by **cooldowns** (no energy). One resource system per side
keeps both the UI and the AI simple.

```ts
interface Skill {
  id: string;
  name: string;
  desc: string;               // one-liner for tooltip
  cost: number;               // energy (cats). Ignored for enemies.
  cooldown?: number;          // rounds (enemies). Ignored for cats.
  usableFrom: number[];       // user's ranks this can be used from, e.g. [1,2]
  target: {
    side: 'enemy' | 'ally' | 'self';
    ranks: number[];          // valid target ranks, e.g. [1,2]
    pattern: 'single' | 'row';// 'row' hits every valid occupant of `ranks`
  };
  power: number;              // 0 = no damage/heal component
  kind: 'damage' | 'heal' | 'utility';
  moveTarget?: number;        // + pushes back N, - pulls forward N (forced)
  moveSelf?: number;          // + retreats N, - advances N (voluntary)
  applies?: { status: StatusId; chance: number; value?: number }[]; // chance 0..1
  energyGain?: number;        // bonus energy to user on use (basic attacks)
  aiWeight?: number;          // base score for enemy AI (§10)
}
```

**Resolution order inside one skill use (global rule, no per-skill exceptions):**

1. Damage/heal to all targets →
2. forced movement (`moveTarget`; applies Off-Balance, §8; decrements boss
   Poise instead if the target is `heavy`, §11) →
3. `applies` statuses (roll chance per target) →
4. self movement (`moveSelf`, never causes Off-Balance) →
5. Cat Pile trigger check (§8) →
6. death/victory check.

Damage-before-movement means a push/pull skill **never buffs its own damage** —
Off-Balance windows are gifts to your *teammates*, which is the heart of the
combo game.

### Reference skill set (four cat classes)

Classes: **Bruiser** (front-line tomcat), **Trickster** (leaping rogue),
**Hexer** (back-line witch-cat), **Medic** (support purrer). Each cat knows
Claw Swipe + 3 class skills (12 class skills in content; 8 specified here as
the reference set).

| Skill | Class | Cost | From | Targets | Power | Effects |
|---|---|---|---|---|---|---|
| **Claw Swipe** | all | 0 | [1,2] | enemy [1,2], single | 100 | `energyGain: 1`. Bread-and-butter that banks energy. |
| **Body Slam** | Bruiser | 4 | [1,2] | enemy [1,2], single | 120 | `moveTarget: +2` — damage, then hurl them backward (Off-Balance for allies to exploit). |
| **Hiss** | Bruiser | 2 | [1,2] | self | 0 | Applies **Guarded** to self and **Provoked** (chance 1.0) to all enemies until round end. |
| **Pounce** | Trickster | 3 | [3,4] | enemy [1,2], single | 150 | `moveSelf: -2` (leap to the front line). High burst, scrambles your own formation. |
| **Trip Wire** | Trickster | 4 | [2,3] | enemy [1,2], **row** | 60 | `moveTarget: +1` on each — the row-shove that sets up Cat Pile (§8). |
| **Yank of Yarn** | Hexer | 3 | [3,4] | enemy [2,3,4], single | 60 | `moveTarget: -2` — drag a back-liner up front, out of its usable ranks, Off-Balanced. |
| **Hairball Hex** | Hexer | 3 | [2,3,4] | enemy [1,2,3], single | 40 | Applies **Scratched** (value 3, chance 0.9). |
| **Soothing Purr** | Medic | 4 | [3,4] | ally any rank, single | 120 (heal) | Also removes one Scratched application. |
| **Nine Lives Nudge** | Medic | 6 | [3,4] | KO'd ally, single | 0 | Revive at 30% max HP, placed in rank 4 (others shift forward). Once per battle. Does **not** cost the target a Life (§12). |

This is how the system drives content: every skill needs `usableFrom` + target
ranks + an optional move (which instantly places it in the positioning game);
every enemy needs a formation slot, `usableFrom` constraints, and a shove or a
reason to fear shoves; items map to the same hooks (Catnip = energy, Feather
Wand = revive, Cucumber = guaranteed Frazzle, once per battle).

---

## 5. Resource System: Energy (cats)

- Every cat has **Energy 0–10**. Battle starts at **4**. Energy does not
  persist between battles (resets to 4); **HP does persist** — HP is the
  attrition currency of a floor, energy is the pacing currency of a fight.
- **Regen:** +2 at the start of that cat's own turn, before acting (cap 10).
- **Spend:** the skill's `cost`, paid on use. `energyGain` (Claw Swipe's +1)
  is added after.
- **Guard action** (§9) grants +2 bonus energy.
- Net effect: Claw every turn ≈ +3/turn income; a 6-cost nuke needs ~2 turns of
  setup. The player constantly chooses between cashing out now and banking for
  a big combo round.

Enemies skip energy entirely: each enemy skill has a `cooldown` (0 = usable
every turn), tracked per skill, decremented at that enemy's turn start.

---

## 6. Status Effects (6)

| Status | Effect | Tick timing | Duration | Stacking |
|---|---|---|---|---|
| **Scratched** (bleed) | Take `value` damage (ignores DEF and Guarded, min 1) | Start of victim's turn, before energy regen | 3 rounds | Values **add** (cap 3 applications, so cap value 9); reapplying resets duration to 3 |
| **Frazzled** (stun) | Skip your next turn entirely (no regen, no action), then removed | On the victim's turn slot | 1 turn | Cannot be applied while already present (no stunlock). On a double-turn boss, consumes only **one** queue slot. |
| **Off-Balance** | Take +50% damage (multiplier in §3) | passive | Until **round-end phase** of the current round, or consumed by Cat Pile | No stacking; reapplying does nothing |
| **Guarded** | Take −50% damage | passive | Until the start of the owner's next turn | No stacking |
| **Provoked** | Single-target damage skills must target the provoker, if the provoker is in a valid rank; otherwise unrestricted | passive (checked by AI/targeting) | Until round-end phase | Newest provoker wins |
| **Mending** (regen) | Heal `value` HP | Start of owner's turn | 2 rounds | Duration refreshes, value replaced by the higher |

KO clears all statuses on the KO'd combatant.

---

## 7. Round-End Phase (exact order)

1. Decrement all durations measured in rounds, removing expired statuses.
2. Remove all Off-Balance and Provoked from all combatants.
3. Reset the once-per-round Cat Pile latch (§8).
4. Check victory / defeat (§12).

(Enemy skill cooldowns do **not** tick here — they tick at each enemy's own
turn start, §5. Listed to make the omission explicit.)

---

## 8. The Signature Twist: "Off-Paw" — forced movement IS the combo system

> **Rule 1 — Off-Paw:** any combatant moved 1+ ranks against its will becomes
> **Off-Balance** (takes +50% damage) until the end of the round.

- **Shove-then-shred:** a fast cat pushes/pulls an enemy, and every teammate
  acting later this round hits it for +50%. The visible initiative timeline
  makes this plannable: "Pixel yanks at initiative 9, Bruno slams at 6."
- **Rank denial as a bonus:** the same push that Off-Balances the shaman also
  shoves it out of its `usableFrom` ranks — next turn it must waste an action
  Advancing (§10).
- **It cuts both ways:** enemy brutes shove *your* cats. A Medic knocked to
  rank 2 is Off-Balance, out of position for Soothing Purr, and the enemies
  smell blood. Party order is a defensive decision.
- **Counterplay knobs:** the `heavy` trait (bosses, elites) means the body
  never moves — but see Poise (§11): staggering blows still pay off against
  bosses. Voluntary movement (Pounce, Swap, `moveSelf`) never self-inflicts
  Off-Balance.
- **Clamping:** push/pull moves the target N ranks (others shift to fill);
  movement clamps at rank 1 and at the last occupied rank. **If the clamped
  distance is 0, no Off-Balance** — a front-rank enemy can't be "pulled" for a
  free debuff.

> **Rule 2 — Cat Pile (all-out attack):** after any cat's action fully
> resolves, if **every living enemy is Off-Balance** and **at least 2 cats are
> alive**, a prompt appears (once per round). On accept, all living cats
> dogpile: each living enemy takes `floor(0.30 * sum(living cats' atk))` —
> typeless, ignores DEF, Guarded, and the Off-Balance multiplier, cannot miss
> or crit. Then **Off-Balance is removed from all surviving enemies** (they
> scramble back to their feet). A procedural dust-cloud with paws sticking out
> plays. Declining keeps all Off-Balance marks in place.

Cat Pile is the payoff spike for coordinated shoving: Trip Wire's row-push or
two sequenced single shoves can floor a whole encounter. The real decision is
Design 2's "pile or pick": pile now for flat damage, or keep the enemies
Off-Balance and let the remaining cats hit them at +50% the normal way.
Against a lone boss, the "every living enemy" condition is satisfied exactly
during a Poise break (§11), making Cat Pile the boss-fight burst window.

It's Darkest Dungeon's positioning tension, flipped from dread to slapstick:
cats batting enemies around like toys, then piling on.

---

## 9. Player Choices Per Turn (the decision space)

On a cat's turn, exactly one action:

1. **Skill** — any known skill with `cost <= energy`, `usableFrom` containing
   current rank, and a valid target.
2. **Claw Swipe** — the free fallback that banks +1 energy (only from ranks
   1–2, so back-liners can't turtle-farm energy).
3. **Move** — swap with the adjacent cat ahead or behind (voluntary, no
   Off-Balance). Costs the turn; fixes scrambled formations.
4. **Guard** — gain Guarded + 2 bonus energy. The "bank a turn" button and the
   answer to telegraphed boss nukes.
5. **Item** — use one consumable (Tuna Snack: heal 12; Catnip: +2 energy to an
   ally; Feather Wand: revive a KO'd ally at 25% max HP). Item effects reuse
   the Skill shape with `cost: 0`; item content lives in the dungeon layer.
6. **Scatter!** (flee) — see §12.

Every turn overlaps 2–3 tensions: *spend vs bank* (Claw now or afford Body
Slam next turn?), *combo sequencing* (who shoves, and do enough teammates act
after them this round? is a full Cat Pile setup worth it?), *formation risk*
(Pounce wins faster but leaves the Trickster tanking rank 1), *attrition math*
(HP persists across the floor — is ending the fight a round sooner worth the
chip damage?), and *aggro control* (Hiss eats a round of enemy turns but
stalls your own damage).

---

## 10. Enemy AI (deterministic-ish, <100 lines)

Score-and-pick. All ties resolved by the seeded RNG so fights don't feel
robotic but replay identically.

```ts
function takeEnemyTurn(self: Combatant, state: Battle, rng: Rng): Action {
  const usable = self.skills
    .map(id => SKILLS[id])
    .filter(s => cooldownReady(self, s)
              && s.usableFrom.includes(self.rank)
              && validTargets(self, s, state).length > 0);

  if (usable.length === 0) return { type: 'advance' }; // move forward 1 rank (voluntary)

  const scored: {skill: Skill; target: Combatant; score: number}[] = [];
  for (const s of usable) {
    for (const t of candidateTargets(self, s, state)) {   // honors Provoked
      let score = s.aiWeight ?? 10;
      if (s.kind === 'damage') {
        score += 30 * (1 - t.hp / t.stats.hp);                 // prefer wounded
        if (expectedDamage(self, s, t) >= t.hp) score += 50;   // kill shot
        if (t.statuses.has('offBalance')) score += 15;         // exploits combos too!
      }
      if (s.kind === 'heal') score += t.hp / t.stats.hp < 0.5 ? 40 : -100;
      if (s.applies?.some(a => t.statuses.has(a.status))) score -= 100; // don't reapply
      if (s.moveTarget && !t.traits.includes('heavy')
          && !t.statuses.has('offBalance')) score += 15;       // enemies combo you back
      scored.push({ skill: s, target: t, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(b => b.score === scored[0].score);
  const pick = top[rng.int(0, top.length - 1)];
  return { type: 'skill', skill: pick.skill, target: pick.target };
}
```

Target candidates for single-target damage skills: if any cat has Provoked this
enemy and stands in a valid rank, that cat is the only candidate; otherwise all
valid-rank cats (scoring then favors the most wounded; final ties → lower
rank). `expectedDamage` uses variance 1.0 and no crit. Encounter personality
comes from skill data (`aiWeight`, cooldowns, `usableFrom`), not code. A boss
script hook runs before scoring: if a windup finished or a phase entry queued a
scripted move (§11), it executes unconditionally.

---

## 11. Boss Fights — differentiators

Bosses are data + five flags, not a second engine:

1. **`heavy` + Poise (merged rule).** The boss body never moves, but every
   forced-movement attempt from a skill (a `moveTarget` whose clamped distance
   *would* have been ≥1 on a normal target) is a **staggering blow**: it
   decrements the boss's visible **Poise** counter (typically 3) by 1, at most
   once per skill use. At Poise 0 the boss becomes **Off-Balance until the
   round-end phase**, any charging windup is cancelled, and Poise resets. The
   player's combo engine stays alive against bosses — it just runs on a rhythm
   instead of every turn, and a Poise break on a lone boss opens Cat Pile (§8).
2. **Double turn** — two independent entries in the initiative queue (§2).
   Frazzled consumes only one of the two slots.
3. **Phase switch at 50% HP** — the boss's `skills` array is swapped for a
   phase-2 list the moment HP crosses the threshold; cooldowns clear. Visual:
   recolor + screen shake + log line.
4. **Telegraphed nuke** — a phase-2 skill with `cooldown: 3` that takes two
   turn-slots: on first use the boss gains a "Charging!" marker (a big warning
   glyph over its head plus a log line naming the ranks it will hit), and the
   next boss turn-slot releases a row-hitting 200-power attack. The party gets
   a full window to Guard, Hiss, Swap out of the targeted ranks, Frazzle it, or
   break Poise (both Frazzled and a Poise break cancel the charge).
5. **Summons** — a skill that spawns a minion into the lowest empty enemy rank
   (up to rank 5, cap 2 summons alive). Summons act starting next round. Live
   minions must also be Off-Balance for a Cat Pile, so summons *ration* the
   pile — intended pressure.
6. **No fleeing** in boss battles.

All boss behavior is data:
`{ poise, doubleTurn, phases: [{ hpPct, skills }], windupSkills: [{ skillId, telegraphText }], summonSkillId }`.

Example boss: **The Vacuum King** (floor 3) — heavy, Poise 3, 140 HP, double
turn. Phase 2 "MAX SUCTION" pulls all cats 1 rank forward each turn — forced
movement, so the boss weaponizes the player's own twist against them.

---

## 12. Victory / Defeat / Flee / Cat Death

- **Victory:** all enemies at 0 HP → seeded loot + XP screen (dungeon layer's
  job). No auto-heal: cats carry their wounds to the next room — floor
  attrition, DD-style. Energy resets to 4 next fight; battle statuses clear.
- **Defeat:** all living cats KO'd → the run ends (roguelike restart;
  meta-unlocks out of scope).
- **Flee ("Scatter!"):** an action any cat can take, not allowed vs bosses.
  `chance = clamp(0.4 + 0.05 * (avgCatSpd - avgEnemySpd), 0.25, 0.9)`, one
  `rngFloat()` roll. Success: battle ends immediately, no loot, all statuses
  cleared, party returns to the room entrance (the encounter entity remains).
  Failure: the turn is wasted. No stacking penalty for retries.
- **Cat death — the Nine Lives rule.** At 0 HP a cat is **Knocked Out**:
  removed from formation (others slide forward), statuses cleared, cannot act
  or be targeted except by revival effects (Nine Lives Nudge, Feather Wand).
  After a **won** battle, each still-KO'd cat stands up at 1 HP and **loses 1
  of its 9 Lives** (shown as paw pips on the portrait; in-battle revival
  avoids the Life loss — that's why the Medic matters). A cat at **0 Lives is
  gone for the rest of the run**: its slot disappears (ranks compress to the
  remaining cats) and its skills go with it. If every remaining cat is gone or
  KO'd, the run ends. Lives do not regenerate; a rare shrine event may restore
  one (dungeon layer).
  *Why this hybrid:* single fights stay low-stakes and experimental (light
  tone), while the run accumulates real dread — Darkest Dungeon pressure at
  one integer per cat, without a first KO bricking a class-locked party.

---

## 13. Worked Example — one full round, real numbers

**Party** (front to back):

| Cat | Class | Rank | HP | ATK | DEF | SPD | CRT | EN | Lives |
|---|---|---|---|---|---|---|---|---|---|
| Bruno | Bruiser | 1 | 40/40 | 10 | 3 | 4 | 5 | 4 | 9 |
| Pixel | Trickster | 2 | 28/28 | 12 | 1 | 8 | 15 | 4 | 9 |
| Mora | Hexer | 3 | 24/24 | 11 | 0 | 6 | 5 | 4 | 8 |
| Baguette | Medic | 4 | 26/26 | 9 | 1 | 5 | 5 | 4 | 9 |

**Enemies:** Rat Thug A (R1, HP 18, ATK 7, DEF 1, SPD 5), Rat Thug B (R2,
HP 18, ATK 7, DEF 1, SPD 5), Crow Shaman (R3, HP 14, ATK 8, DEF 0, SPD 7; its
hex is `usableFrom [2,3,4]`, its Peck `usableFrom [1,2]`).

**Initiative rolls** (spd + rngInt(0,2)): Bruno 4+2=6, Pixel 8+1=**9**, Mora
6+2=**8**, Baguette 5+1=6, Rat A 5+2=7, Rat B 5+0=5, Crow 7+1=**8**.
Sorted: Pixel 9 → [tie at 8: cats before enemies] Mora 8 → Crow 8 → Rat A 7 →
[tie at 6, both cats: lower rank first] Bruno 6 → Baguette 6 → Rat B 5.

1. **Pixel** (regen +2 → EN 6). From rank 2 Pounce is illegal (needs rank
   3–4), so **Claw Swipe** on Rat A, power 100: base 12.0 × variance 1.0 ×
   **crit** (roll 0.07 < 0.15) 1.5 = 18 − DEF 1 = **17**. Rat A 18→1.
   EN 6+1 = 7.
2. **Mora** (regen +2 → EN 6). **Yank of Yarn** (cost 3) on the Crow (rank 3,
   valid). Damage first: base 0.6×11 = 6.6 × variance 1.1 = 7.26 → round
   **7** − DEF 0 = 7. Crow 14→7. Then forced pull 2: Crow to enemy rank 1,
   Rat A slides to 2, Rat B to 3. Moved 2 ranks → **Off-Balance**. Cat Pile
   check: Rats A and B are not Off-Balance → no prompt. EN 3.
3. **Crow Shaman** (Off-Balance, now rank 1). Its hex isn't usable from rank
   1; only Peck (targets cat ranks 1–2). Candidates: Bruno (100% HP), Pixel
   (100%) — tie score → lower rank → Bruno. Peck: base 8.0 × variance 0.9 =
   7.2 → 7 − DEF 3 = **4**. Bruno 40→36.
4. **Rat A** (1 HP, rank 2). Shiv (`usableFrom [1,2]`, targets cat ranks 1–2)
   prefers the most wounded → Bruno (36/40). Base 7 × 1.1 = 7.7 → 8 − 3 =
   **5**. Bruno 36→31.
5. **Bruno** (regen +2 → EN 6). **Body Slam** (cost 4) on the Off-Balance Crow
   at enemy rank 1: base 1.2×10 = 12 × variance 1.0 × no crit × **Off-Balance
   1.5** = 18 − 0 = **18**. Crow 7→**dead** (push moot). Rats slide: A→1,
   B→2. EN 2. *(Had the Crow been a `heavy` elite, the Body Slam push would
   instead have chipped 1 Poise.)*
6. **Baguette** (regen +2 → EN 6). Bruno is at 31/40 — Soothing Purr would
   heal round(1.2×9) = 11, but he isn't in danger, so she **Guards**: Guarded
   until her next turn, EN 6+2 = 8, banking toward Nine Lives Nudge money she
   hopefully won't need.
7. **Rat B** (rank 2). Shiv on the most wounded reachable cat → Bruno:
   7 × 0.9 = 6.3 → 6 − 3 = **3**. Bruno 31→28.

**Round-end phase:** no round-duration statuses remain (the Crow took its
Off-Balance to the grave); the Off-Balance/Provoked sweep clears nothing; the
Cat Pile latch resets; nobody is at 0 HP on either side → next round. Two rats
at ranks 1–2, party healthy. Pixel is weighing a swap back to rank 3 to line
up Pounce — or staying at rank 2 for Trip Wire next round to row-shove both
rats Off-Balance and cash a **Cat Pile**
(`floor(0.30 × (10+12+11+9)) = 12` to each rat, killing Rat A outright and
leaving Rat B at 6).

One round showcased: initiative ties, energy regen/banking, crit, variance,
pull-combo (Yank → Body Slam for +50%), rank denial (the Crow's hex went
offline), corpse sliding, AI wounded-targeting, the Guard economy, and the
Cat Pile setup calculus.

---

## 14. Scope & Module Budget (~1500 LoC engine)

The engine is **headless and pure** (grafted from Design 2):
`resolveAction(state, action, rng) -> { newState, events[] }`. The PixiJS
scene consumes the events queue (`Damage`, `Heal`, `Moved`, `OffBalance`,
`PoiseBreak`, `CatPilePrompt`, `CatPile`, `StatusApplied`, `KO`, `Revive`,
`PhaseChange`, `Charging`, `Summon`, `Fled`, `Victory`, `Defeat`, …) and
animates it with tween-only motion (position/scale/alpha shakes, flash tints,
floating `Text` numbers) — zero assets, trivially 60fps, and the whole combat
core is unit-testable; the worked example above doubles as a unit test.

| Module | ~LoC | Contents |
|---|---|---|
| `battle/state.ts` | 150 | Combatant, Battle, rank ops (slide, push/pull clamp, swap), seeded RNG stream |
| `battle/turns.ts` | 160 | Initiative rolls, round loop, round-end phase, win/lose/flee, Lives bookkeeping |
| `battle/resolve.ts` | 280 | Skill pipeline (damage formula, movement, statuses, energy), Cat Pile |
| `battle/status.ts` | 120 | 6 status defs + tick/stack/expiry rules |
| `battle/ai.ts` | 100 | §10 scorer + boss script hook |
| `battle/boss.ts` | 100 | Poise, double-turn, phase swap, charge telegraph, summons |
| `battle/ui.ts` | 550 | PixiJS: rank slots, cat/enemy blobs, initiative timeline, skill bar, Life pips, Poise counter, floating damage Text, dust-cloud Cat Pile, tweened lunges; mouse targeting + 1–5 keys |
| `data/*.ts` | (content, not engine) | 4 classes × 4 skills, ~10 enemies, 3 bosses, items, encounters |

---

## 15. Contradiction Ledger (how the three designs were reconciled)

| Conflict | Resolution |
|---|---|
| Resource: per-cat Energy (D1) vs per-cat MP (D2) vs shared 9-cap Moxie (D3) | **Per-cat Energy.** A shared pool couples all four cats to one number and punishes the last cat in initiative order; per-cat energy keeps every turn's spend/bank tension local and readable. The "party sequencing" pressure Moxie provided is preserved by Cat Pile setup and Off-Paw ordering. |
| Exploit engine: forced-movement Off-Balance (D1) vs elemental affinities + Down/One More (D2) vs both (D3) | **Off-Balance only.** Two parallel exploit systems compete for the same design space, stack multipliers past the budget (weak × off-balance × crit ≈ 3.4×), and blow the LoC/content budget. Affinities and One More are cut; their *payoffs* (all-out attack, boss stagger rhythm) are re-hosted on Off-Balance via Cat Pile and Poise. |
| Extra actions: One More / Pounce Pass (D2) | **Cut.** Extra-action chains need caps, pass UI, and regen exceptions — the hardest ~150 lines and the trickiest edge cases in D2. Cat Pile keeps the "coordinated payoff" fantasy without any extra-turn machinery. |
| All-out attack trigger: all enemies Down (D2) | **Retargeted:** all living enemies Off-Balance, once per round; consumes survivors' Off-Balance, keeping D2's "pile or pick" decision intact. |
| Damage math: flat-DEF subtraction (D1) vs ATK/(ATK+DEF) ratio (D2/D3) | **D1's formula** — the entire stat table, skill powers, and worked example are already balanced around it, and flat DEF makes Guarded/DEF-item math legible. `max(1, …)` handles the negative-base edge. |
| Accuracy rolls + Blind (D2) | **Cut** — no misses. With 4 actors and no extra-turn engine, a whiffed turn is pure feel-bad; Blind existed only to serve accuracy. |
| Bosses vs the combo engine: `heavy` shuts it off (D1) vs Poise (D2/D3) | **Merged:** heavy bosses never move, but forced-move attempts decrement Poise; a Poise break = Off-Balance window + windup cancel + Cat Pile access. Fixes D1's dead-system boss problem with D3's rhythm. |
| Death: Bruised −25% maxHP (D1) vs Bruised −20% (D2) vs Nine Lives pips (D3) | **Nine Lives pips (per cat), Bruised cut** — one attrition marker, not two; on-theme; one integer per cat. In-battle revival avoids the Life loss, giving the Medic a real job. Per-cat pips (not a shared pool) so reckless play with one cat doesn't tax the others invisibly. |
| Stun naming/behavior: Frazzled (D1) vs Shock (D2) vs Startled (D3) | **Frazzled**, D1 rules (no reapply while present). Clarified here: on a double-turn boss it consumes only one queue slot. |
| Status tick timing: start of victim's turn (D1) vs end of turn (D2/D3) | **D1:** DoTs tick at the start of the victim's turn (before regen); round-counted durations decrement in the round-end phase. One clock, no per-turn duration bookkeeping. |
| Enemy throttle: cooldowns (D1/D3) vs MP (D2) | **Cooldowns** for enemies, energy for cats — one resource system per side. |
| AI unpredictability: RNG tie-breaks (D1/D3) vs 20% second-best pick (D2) | **RNG tie-breaks only.** A deliberate 20% suboptimal pick undermines the "plan around the timeline" promise; `aiWeight` supplies species personality. |
| Stalk action (D3) | **Cut** — overlaps Guard (defensive banking) and Off-Balance (burst windows); a third setup verb dilutes the twist. |
| Positioning: 4v5 single-file ranks (D1/D3) vs none (D2) | **Ranks (D1's exact model).** They are the twist's substrate and the main driver of class/enemy/item identity. D3's size-2 bosses are unnecessary once heavy bosses simply anchor rank 1. |
| Initiative: spd + rngInt(0,2) per round (D1) vs pure spd sort (D2/D3) | **D1's jittered roll.** The ±2 jitter keeps same-speed mirror matches from being fully static while the visible timeline (frozen per round) preserves plannability. |
| Engine architecture | **D2's headless pure-function + event queue**, grafted wholesale (§14). |

---

## Appendix: Judging Notes

Scores are 1–10 per criterion: (a) fun/decision depth per turn,
(b) implementability within ~1500 lines of TS, (c) fit with a 4-cat party and
light roguelike tone, (d) how well it drives class/enemy/item design.

| Design | (a) Fun/depth | (b) Implementability | (c) Fit/tone | (d) Content driver | Total |
|---|---|---|---|---|---|
| **1. Claws & Ranks** | **9** | 8 | **9** | 8 | **34 — winner** |
| 2. Claws & Effect | 8 | **9** | 8 | 8 | 33 |
| 3. Nine Lives: Stalk & Pounce | 8 | 6 | **9** | 8 | 31 |

- **Design 1 (winner).** The richest per-turn decision space: six actions that
  each touch position, economy, and timing, plus the cleanest signature twist —
  damage-before-movement makes shoves inherently cooperative rather than
  selfish. It is also the most precisely specified entry (exact tie-breaks,
  clamping rules, resolution order, RNG draw order), so it costs the fewest
  follow-up design decisions. Weaknesses: the `heavy` trait made the signature
  system go dead in boss fights (fixed by grafting Poise), and it lacked a
  climactic payoff moment (fixed by grafting Cat Pile).
- **Design 2.** The best engineering (headless pure engine, event queue —
  grafted verbatim) and the best payoff moment (Cat Pile). But One More /
  Pounce Pass chains are the hardest 150 lines in any of the three designs
  (caps, regen exceptions, prompt interleaving), no positioning means classes
  differentiate only by element and target count, and hidden-affinity probing
  adds a bookkeeping layer (per-species reveal persistence) for depth that
  fades once a species is known.
- **Design 3.** The strongest theme (Stalk/Pounce/Moxie/Nine Lives all read
  "cat") and the best death rule, but it is three systems welded together —
  ranks AND affinities AND a shared pool AND Stalk — which overshoots the LoC
  budget and overloads a single turn with overlapping currencies. The shared
  9-cap pool also lets one cat starve the next, which plays worse than it
  reads. Its Poise and Nine Lives ideas were the two best individual
  mechanics in the contest, and both survive into the final design.
