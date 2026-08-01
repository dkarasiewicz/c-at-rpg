# Enemy Intel — intents, inspection, and the Bestiary

> **STATUS: shipped.** Everything below is implemented. The sections are kept
> in their original proposal voice ("`EnemyDef` gains…") because the reasoning
> is what makes them worth reading; [What shipped](#what-shipped) at the
> bottom maps every section to the code and records the two places reality
> diverged from the plan. Its balance cost is measured in
> `balance-and-meta.md` §3.3 — intents alone moved clear rate by up to 13pp
> and forced a retune of `ENEMY_CURVE`.

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

---

## What shipped

| § | Where | Notes |
|---|---|---|
| 1 — data model | `core/types.ts#EnemyDef`, `content/enemies.ts` | `level`, `description`, `tell`, `weaknesses`, `resistances` all present. `level` is **derived**, as specified: `baseLevel(tier, isBoss)` + `curveLevelSteps` off the same `ENEMY_CURVE` row that scales the stat block, so the printed number and the damage formula cannot drift (`balance-and-meta.md` §3.2) |
| 1 — "fold the tier resistance in" | `EnemyDef.resistances` | done. `'offBalance'` in `resistances` **is** the tier Off-Paw resistance; `offBalanceResistOf` reads it there, so there is one source of truth rather than a per-tier implication |
| 1 — weaknesses are mechanical | `IntelTag` + `combat/resolve.ts` | a shove-weak enemy takes ×1.25 from any force-move hit; a status it is weak to always lands, one it resists never does — and **neither rolls**, because neither outcome was ever in doubt |
| 2 — intents | `core/combat/intent.ts` | `declareIntents` runs at `startRound`, in queue order, one `chooseEnemyAction` per living enemy, off the same seeded stream. The resolver is bound to the declaration |
| 2 — truthfulness | `intent.ts` | bends in exactly two documented ways, both the player's own doing, both announced with `intentBroken`: the declared target died or left the skill's ranks (same skill retargets, no roll), or the skill went offline (AI re-picks at that slot — exactly where the pre-intent engine picked) |
| 2 — authored uncertainty | `intent.ts` | a double-turn boss declares only its FIRST slot; the second is `'unknown'` and chosen live. Its state cannot be known at round start and inventing a number for it would be a lie |
| 3 — inspect panel | `ui/scenes/battleWidgets.ts#makeInspectPanel`, `ui/draw/intel.ts` | portrait, name, Stand, level, tier, HP, statuses, description, `tell`, and what you know. Unknown facts render `???`. Opens on `I`, on hover, or on a ~400 ms hold on touch — `mobile.md`'s **tap acts, long press reads** |
| 4 — Bestiary | `core/meta/bestiary.ts` | `KILLS_TO_COMPLETE = 5`. Reveals are driven by `intel` events the engine emits when a modifier actually fires, so nothing re-derives rules or peeks at unseen content. Persisted in the meta profile |
| 4 — Cat Town hosts it | `ui/scenes/catTown.ts` | the Bestiary is a place on the street; unmet species render `???` for name, level and every stat, so the grid reads as a checklist |
| 5 — damage preview | `combat/state.ts#previewDamage` | used by both the intent plate and target selection |
| 5 — turn order bar | `battleWidgets.ts#makeRibbon` | current unit emphasised, round boundary explicit, `portrait:*` faces |
| 5 — status chips | `ui/widgets.ts#makeStatusChip` | duration, stack count, and `explain: true` so a chip states what it does — never a bare icon to be memorised |
| 5 — threat highlight | `battle.ts#makeThreatLayer` | each declaration is drawn to the cat it named, and that cat carries the **total** incoming |

### Where reality diverged from the plan

- **§2 "intent is shown for enemies you have met before."** Shipped, but the
  *engine* never withholds anything: `intent.ts` always computes the truth and
  `bestiary.ts` decides what the UI may show. An unmet enemy renders `???`
  without the engine ever lying to itself — which matters because the AI's
  own decisions read the same state.
- **§4 "the GM writes the descriptions."** Half shipped. The DM can publish
  enemy flavour — `agent/tools/contribute_content.ts` with `kind: "flavour"`
  writes to the `enemies` pool — but **nothing reads it back.** `agent/lib/pool.ts`
  is server-side only by design (`src/` never imports it), so shipped
  descriptions still come from `content/enemies.ts`. The write side exists;
  the read side is an unbuilt seam, the same one `run-map-and-dm.md` §4b
  describes for every other pool namespace.
