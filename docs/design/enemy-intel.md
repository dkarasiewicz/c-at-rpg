# Enemy Intel — intents, inspection, and the Bestiary

Two complaints, one system: combat does not tell you what is about to happen,
and enemies are anonymous stat-blocks with no level, description or weakness.

Reference points (researched, not invented):

- **Slay the Spire — intents.** Enemies telegraph next turn's action as a symbol
  above their head. The stated payoff is that players "never feel cheated when
  they die": telegraphing turns defence from a guess into a decision.
- **Darkest Dungeon — partial information.** Hovering shows some stats and skill
  *names*, not full detail, and turn order is deliberately incomplete.
  Uncertainty is authored, not accidental.

We take intents from the first and earned-knowledge from the second.

## 1. Enemy data model

`EnemyDef` gains:

| field | meaning |
|---|---|
| `level` | shown in the UI; derived from tier + floor curve, not hand-typed |
| `description` | 1-2 lines of JoJo-flavoured menace; the Stand's nature hinted |
| `weaknesses` | statuses/effects it takes **extra** from |
| `resistances` | statuses/effects it shrugs off (already partly exists as tier Off-Paw resistance — fold that in rather than duplicating it) |
| `tell` | one line describing how it telegraphs — flavour for the intent icon |

**Weaknesses must be mechanical, not decorative.** A weakness is a real
modifier the engine applies (e.g. +25% damage from shove-type hits, or Off-Paw
lands at 100% regardless of tier resistance). If inspecting an enemy does not
change how you play, the panel is decoration and should not exist.

Keep the numbers in the existing bounded vocabulary — no new mechanics, only
modifiers on what `resolveAction` already does.

## 2. Intents (the big win)

Above each living enemy, an icon + value showing what it intends **next**:

- **Strike** — with the expected damage number against its current target.
- **Status** — which status it will try to apply.
- **Shove** — it intends to force-move (our signature mechanic; must be legible).
- **Guard / buff / heal ally**.
- **Unknown** — for enemies you have not learned yet, and deliberately for some
  boss phases. Uncertainty is allowed to be authored.

Rules:

- The intent must be **truthful** — it is the action the AI has actually
  selected. If the engine cannot commit to next action at render time, then
  intent is computed at round start and the AI is bound to it.
- Intent is shown for enemies you have **met before** (see Bestiary); a
  first-time enemy shows `?` until it acts once. Learning is the reward.
- This changes AI scheduling, so it is an ENGINE change, not a UI veneer:
  `startRound` publishes a per-enemy declared intent that `resolveAction`
  honours. Determinism unaffected — the choice is made from the same seeded
  stream, only earlier.

## 3. Inspect panel

Tap (or hover) an enemy → a panel with portrait, name, `«STAND»`, level, tier,
HP, current statuses, description, and **what you know**: weaknesses and
resistances discovered so far, skills you have seen it use.

Unknown facts render as `???` rather than being hidden, so the panel doubles as
a checklist of what is left to learn. Touch-first, and the rule is the same one
the whole game uses: **a tap acts, a long press reads**. On a phone the panel
opens on a ~400 ms hold; a tap on an enemy you are aiming at attacks it
(`docs/design/mobile.md` §2).

## 4. The Bestiary — knowledge as meta progression

Knowledge is **earned and persistent**, and it is the natural bridge to
Cat Town (`balance-and-meta.md` §4).

- Fighting an enemy records it. Facts unlock progressively: meeting it reveals
  name/level/description; being hit by a skill reveals that skill; landing a
  status reveals a resistance or weakness; killing N of them completes the entry
  and reveals everything, including its intent telegraphs from then on.
- Entries persist in the meta profile, so a later run starts already knowing
  the early floors' roster — a real, non-numeric power increase that makes the
  world feel learned rather than grinded.
- Cat Town hosts the Bestiary as a location; completed entries are a
  collection worth finishing.
- **The GM writes the descriptions.** Enemy flavour and `tell` lines are exactly
  the kind of long-tail variety that `run-map-and-dm.md` says should come from
  the LLM and the shared pool, not from big static tables. Ship enough for a
  good offline fallback; let the pool grow the rest.

## 5. Other UI improvements from the references

- **Damage preview on target selection** — show the expected range before
  committing, so a shove combo can be planned rather than discovered.
- **Turn order bar**: current unit emphasised, round boundary marked, and each
  entry showing its intent icon so the whole round reads at a glance.
- **Status chips** with duration and stack count, consistently styled and
  explained on tap — never a bare icon whose meaning must be memorised.
- **Threat highlight**: when an enemy intends to strike a specific cat,
  visually connect them, so the consequence of not defending is obvious.
