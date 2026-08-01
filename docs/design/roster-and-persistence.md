# The Roster, the Camp, and the Dreaming World

Player feedback after a full local playthrough, and the design that answers it:

> "when I have unblocked the characters I couldn't add them to party. also we
> shouldn't have all 4 available immediately (I lvl all of them up, manage gear
> etc which feels wrong). I would rather have darkest dungeon mechanic where
> characters can die, and maybe can have some status transient the runs (like
> being hungry or smth). in darkest dungeon we have a camp from time to time in
> a run, where our characters interact with each other. town needs a little
> visual cleanup, and a way to manage our gear/characters between the runs.
> characters and their powers, and a gear can be dreamed, same as new lvls,
> backgrounds, and enemies, and encounters. we should store all of them so as
> much u play as much content we have."

## 0. The bug underneath the feedback

`recruitCat()` has **zero call sites in the UI**. The only recruit in the game
is automatic, on arriving at floor 3. So a `class:*` unlock bought in Cat Town
adds a cat to the run's eligible pool and then nothing — there is no screen
anywhere that lets a player field them. Fix this first; everything below
assumes the player controls their own roster.

## 1. The roster is a stable, not a fixed four

Today every run carries all four `ClassId` slots and benches what is not
fielded, so the player levels and gears cats who are not really theirs yet. The
feedback is exactly right: that is bookkeeping, not a choice.

- **Cat Town houses a roster of individual cats**, not four class slots. A cat
  is an instance — a name, a class, a Stand, a level, gear, scars, quirks —
  persisted in the meta profile, not rebuilt per run.
- **You start with one or two.** More arrive by unlocking, by recruit
  encounters, and by being *dreamed* (§5). The clowder growing IS the meta
  progression.
- **You choose who descends**, up to party capacity, from the town roster. That
  screen is the missing `recruitCat` UI.
- Levelling and gear belong to the cat, in town, between runs — so time spent
  managing is time spent on cats you actually field.

`RunState.cats` stops being a fixed four-slot record. This is the biggest
engine change here: every classId-keyed system (`marchingOrder`, powers,
portraits, Cat Pile, the §13 fixture) must move to cat *instance* ids with
class as an attribute. Do it as a contract change with tests, not a patch.

## 2. Death is permanent

Darkest Dungeon's real stakes. Nine Lives becomes the *run*-scale buffer, and
running out is the end of that cat, permanently, from the town roster.

- A cat who dies is gone from the profile. Their gear returns to town (or is
  lost with them — decide and be consistent; losing it is more DD, returning it
  is kinder to a small roster).
- Because a death is permanent, the town needs a memorial: names, how far they
  got, what killed them. Loss the player can look at is loss that means
  something.
- **Guard rails**: never allow a wipe that leaves an empty roster with no way
  to recruit. There must always be a path back — a free stray at the gate, or a
  recruit that costs only time.

## 3. Transient state that survives the run

Cats carry conditions between runs, so a roster has texture and a "rest a cat"
decision exists.

- **Hunger** — rises per run; a hungry cat is weaker until fed in town. Feeding
  costs shinies, so hunger competes with unlocks for the same currency.
- **Scars** — a permanent mark from a near-death: a small stat cost with a
  story attached, and a name the DM can call back to.
- **Quirks** — earned traits, good and bad, from what actually happened
  (survived a boss, fled twice, ate something suspicious).

All of it is bounded by the existing stat/effect vocabulary; none of it is a new
mechanic. And all of it is *visible in town*, because state you cannot see is
state you cannot plan around.

## 4. The Camp — a beat between fights

A run-map node type (or a beat after a hard fight) where the party stops.

- **Cats interact with each other**, not with the dungeon: a bond, a grudge, a
  memory, a warning. This is the DM's best material, and it uses the durable
  session's memory — it can call back to floor 2.
- **Camp actions** cost a shared resource: eat (hunger), bandage (HP), tend a
  scar, talk (a quirk or a bond), or keep watch (a bonus next fight).
- Camp is where the party becomes characters instead of stat blocks, so the
  writing matters more than the numbers here.

## 5. The Dreaming — content that accumulates

The player's phrasing is the right frame: content is **dreamed**, then kept.

Anything the DM can author within existing bounds becomes durable content:
cats and their Stands, gear, encounters, events, enemies, floor backgrounds,
and later levels. Every dreamed thing is validated, budget-linted, stamped with
its `styleVersion`, and written to the shared pool with its art. Future runs —
and other players — draw from that pool first.

This is what makes "the more you play, the more there is" literally true, and
it is why the storage question below is not optional.

## 6. Storage: yes, Supabase

**The current state is worse than it looks.** The pool is `agent/lib/pool.ts`
over Upstash Redis, and `UPSTASH_REDIS_REST_URL` has never been set in
production — so it silently falls back to a per-instance in-memory store.
Nothing has ever persisted, for anyone. The growing-world promise is currently
not delivered at all.

**Supabase (Postgres) is the right fit**, and better here than Upstash:

- The pool wants **queries**, not key lookups: "tier-2 enemies at styleVersion 3
  with rating > 0", "a Stand nobody in this run has met", "the 20 newest events
  for floor 5". That is SQL. Doing it in Redis means hand-maintaining index sets
  and getting them wrong.
- It wants **relations**: a cat has a Stand, a Stand has interactions, a run has
  a roster, a death has a cause. Foreign keys and joins, not JSON blobs.
- **Storage in the same product** for generated art. Right now art URLs point at
  the generator, which is not a durable host — dreamed content whose picture
  404s in a month is not persisted, it is remembered wrong.
- Row Level Security and (optional, later) auth if profiles ever leave the
  device.
- Free tier, first-class from Vercel functions, and an official MCP.

Keep Upstash only if a hot cache is ever needed in front of Postgres. It is not
needed now.

**Non-negotiable, unchanged:** the game stays offline-first. No database, no
DM, no network ⇒ the game plays completely on authored content and the local
profile. The pool is an enrichment layer, never a dependency, and the local
`MetaFile` remains the source of truth for *your* town so a player is never
blocked by someone else's outage.

## 7. Build order

1. **The roster UI + `recruitCat` wiring** — the reported bug. Player picks who
   descends; unlocks become meaningful.
2. **Cat instances** replacing fixed class slots (engine contract change).
3. **Perma-death + memorial + the no-dead-end guard.**
4. **Town rebuild**: visual cleanup, plus manage cats and gear between runs.
5. **Camp node** with inter-cat interaction written by the DM.
6. **Hunger / scars / quirks** carried between runs.
7. **Supabase pool**: schema, art storage, pool-first reads, seed generation
   zero, and the Dreaming writing everything back.
