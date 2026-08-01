/**
 * THE CAMP — the beat between fights (roster-and-persistence.md §4).
 *
 * "Cats interact with EACH OTHER, not with the dungeon… Camp is where the
 * party becomes characters instead of stat blocks, so the writing matters more
 * than the numbers here."
 *
 * So this screen is built the other way round from every other one in the
 * game: the FIRE is the big panel and the mechanics are a row of buttons under
 * it. What the cats say to each other is the content; eat / bandage / tend /
 * talk / keep watch are how you spend the three embers the fire is worth.
 *
 * ── WHAT SPEAKS ─────────────────────────────────────────────────────────
 * Two seated cats, chosen deterministically from the node's payload seed, and
 * one exchange between THEM by name. There are two sources and they layer,
 * they do not compete:
 *
 *   ALWAYS   an authored exchange from `content/camp.ts`, on screen the
 *            instant the scene mounts, filtered by what is true at this fire
 *            (somebody hungry, somebody scarred, a boss through the wall).
 *            This is the offline-first guarantee in its strongest form —
 *            camp is never silent, never a spinner, never a blank panel.
 *   IF UP    the DM, asked in the background through the run's DURABLE
 *            session, which is why this is the best material it has: it can
 *            call back to what this party did on floor 2. When it lands it is
 *            APPENDED under the authored beat rather than replacing it, so
 *            nothing the player was reading is yanked away mid-sentence.
 *
 * Every mechanical outcome comes from `core/run/camp.ts`. This file renders
 * and collects taps; it computes nothing.
 */
import { Container, Graphics, Text } from "pixi.js";
import type {
  CatId,
  CatRunState,
  ResultLine,
  RunState,
} from "../../core/types.js";
import { floorConfig } from "../../core/run/runState.js";
import { maxHp } from "../../core/run/party.js";
import { fieldedCats } from "../../core/run/runState.js";
import {
  CAMP_ACTIONS,
  campExchange,
  campOpener,
  campPair,
  canTakeCamp,
  newCampSession,
  takeCampAction,
  untendedScar,
  type CampActionId,
  type CampSession,
} from "../../core/run/camp.js";
import { conditionLine, hungerOf } from "../../core/run/conditions.js";
import {
  ensureDmSession,
  markDmUnreachable,
  probeDm,
  sendDmTurn,
} from "../../services/dm.js";
import { withDmSession, type TabletopRun } from "../../services/tabletop.js";
import { PAL, mix } from "../palette.js";
import {
  DESIGN_H,
  DESIGN_W,
  SPACE,
  rh,
  rw,
  rx,
  ry,
  type Rect,
} from "../layout.js";
import { TYPE } from "../textStyles.js";
import {
  avatar,
  bar,
  button,
  heading,
  label,
  panel,
  scrim,
  sceneBackdrop,
  vignette,
  type ValueBar,
} from "../widgets.js";
import { hasSprite } from "../sprites.js";
import { catNameColor } from "../overlays/inventoryPanel.js";
import { padHit } from "../touch.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";

/** What the run map hands over when the party walks onto a camp node. */
export interface CampSceneParams {
  /** The node this fire IS — its payload seed is what seats the cats. */
  nodeId: number;
  /** `hash(runSeed, floor, 'node', id)` — derived, never drawn. */
  seed: number;
}

/* ---------------------------------------------------------------------- */
/* geometry (1280×720 design px)                                           */
/* ---------------------------------------------------------------------- */

const CP = {
  header: [16, 12, 1248, 34] as Rect,
  /** The fire: what the cats say. The biggest thing on the screen. */
  fire: [40, 82, 736, 402] as Rect,
  /** One card per fielded cat, down the right. */
  cats: [800, 82, 440, 402] as Rect,
  /** Delta lines from the last action. */
  results: [40, 494, 736, 56] as Rect,
  /** The five actions plus Break camp. */
  actions: [40, 562, 1200, 52] as Rect,
  /** The one-line instruction under the buttons. */
  hint: [40, 624, 1200, 24] as Rect,
} as const;

const CAT_CARD_H = 92;
const ACT_W = 196;
const ACT_GAP = 10;

/** Ember pip radius. */
const EMBER_R = 7;

/** The fire panel never shrinks below this, however little was said. */
const MIN_FIRE_H = 190;

/* ---------------------------------------------------------------------- */
/* the scene                                                               */
/* ---------------------------------------------------------------------- */

interface CatCardView {
  cat: CatRunState;
  view: Container;
  ring: Graphics;
  hp: ValueBar;
  hpText: Text;
  cond: Text;
}

/** One thing that was said at this fire. */
interface Beat {
  /** Who is talking, for the attribution line. */
  who: string;
  lines: string[];
  /** DM beats read gold; authored ones read as ordinary prose. */
  fromDm: boolean;
}

export class CampScene implements Scene {
  private ctx!: GameCtx;
  private params: CampSceneParams = { nodeId: -1, seed: 0 };
  private mounted = false;

  private bgC = new Container();
  private hudC = new Container();

  private session: CampSession = newCampSession();
  private beats: Beat[] = [];
  private results: ResultLine[] = [];
  private shownExchangeIds: string[] = [];

  /** The action waiting for a target, or null. */
  private pending: CampActionId | null = null;
  /** Cats already picked for the pending action (talk needs two). */
  private picked: CatId[] = [];

  private embersC = new Container();
  private fireC = new Container();
  private resultsC = new Container();
  private actionsC = new Container();
  private hintC = new Container();
  private cards: CatCardView[] = [];

  /** Where the fire panel's bottom edge landed (the results sit under it). */
  private fireBottom = 0;
  /** True while a DM turn is in flight (the fire prints a waiting line). */
  private asking = false;
  private dmUp = false;

  /* ------------------------------ lifecycle ---------------------------- */

  mount(root: Container, ctx: GameCtx, params?: unknown): void {
    this.ctx = ctx;
    if (!ctx.run) throw new Error("camp: mounted without a run");
    this.params = (params as CampSceneParams | undefined) ?? {
      nodeId: ctx.run.currentNodeId ?? -1,
      seed: ctx.run.runSeed.length,
    };
    this.mounted = true;
    this.session = newCampSession();
    this.beats = [];
    this.results = [];
    this.shownExchangeIds = [];
    this.pending = null;
    this.picked = [];

    this.bgC = new Container();
    this.hudC = new Container();
    layer(root, "bg").addChild(this.bgC);
    layer(root, "hud").addChild(this.hudC);

    // A camp has its own warm room when the art pack has one; the rest node's
    // backdrop is the right sibling when it does not, and a plain wash is the
    // floor under both (zero generated assets must still play).
    const art = hasSprite("scene:camp")
      ? "scene:camp"
      : hasSprite("scene:rest")
        ? "scene:rest"
        : "";
    if (art !== "") {
      this.bgC.addChild(
        sceneBackdrop(art, DESIGN_W, DESIGN_H, { dim: 0.3 }),
        vignette(DESIGN_W, DESIGN_H, 0.9),
      );
    } else {
      this.bgC.addChild(
        new Graphics()
          .rect(0, 0, DESIGN_W, DESIGN_H)
          .fill(mix(PAL.bgDeep, PAL.gold, 0.06)),
        scrim(DESIGN_W, DESIGN_H, 0.25),
        vignette(DESIGN_W, DESIGN_H, 0.9),
      );
    }

    this.buildHeader();
    this.buildCats();
    this.fireC = new Container();
    this.resultsC = new Container();
    this.actionsC = new Container();
    this.hintC = new Container();
    this.hudC.addChild(this.fireC, this.resultsC, this.actionsC, this.hintC);

    // THE OFFLINE GUARANTEE: an exchange is on screen before anything else
    // happens, and before any network call has been considered.
    this.pushAuthoredBeat();
    this.refresh();

    // …and the DM is asked in the background, if there is one at all.
    void probeDm().then((ok) => {
      if (!ok || !this.mounted) return;
      this.dmUp = true;
      this.refresh();
      this.askDm(campPair(this.run, this.params.seed), "arrival");
    });
  }

  unmount(): void {
    this.mounted = false;
    this.cards = [];
    for (const c of [this.bgC, this.hudC]) {
      c.parent?.removeChild(c);
      c.destroy({ children: true });
    }
  }

  onKey(key: string): boolean {
    if (!this.mounted) return false;
    if (this.pending) {
      if (key === "esc") {
        this.cancelPending();
        return true;
      }
      const party = fieldedCats(this.run);
      const i = "123456789".indexOf(key);
      if (i >= 0 && i < party.length) {
        this.pickCat(party[i].id);
        return true;
      }
      return true; // targeting swallows everything else
    }
    const i = "12345".indexOf(key);
    if (i >= 0 && i < CAMP_ACTIONS.length) {
      this.startAction(CAMP_ACTIONS[i].id);
      return true;
    }
    if (key === "enter" || key === "space" || key === "b") {
      this.breakCamp();
      return true;
    }
    return false;
  }

  /* -------------------------------- state ------------------------------ */

  private get run(): RunState {
    return this.ctx.run as RunState;
  }

  private get isBossFloor(): boolean {
    return floorConfig(this.run.floorNum).boss !== undefined;
  }

  /* ------------------------------- header ------------------------------ */

  private buildHeader(): void {
    const rail = new Container();
    rail.position.set(rx(CP.header), ry(CP.header));
    const cfg = floorConfig(this.run.floorNum);

    const title = heading("THE CAMP", 3, { fill: PAL.gold });
    title.position.set(0, 8);
    rail.addChild(title);

    const where = label(
      `floor ${this.run.floorNum} · ${cfg.name} · nothing is hunting for a while`,
      { dim: true, size: TYPE.tiny },
    );
    where.position.set(Math.ceil(title.width) + SPACE.lg, 12);
    rail.addChild(where);

    this.embersC = new Container();
    rail.addChild(this.embersC);
    this.hudC.addChild(rail);
  }

  /** The shared resource, as pips. Spent ones go cold, they do not vanish. */
  private paintEmbers(): void {
    this.embersC.removeChildren().forEach((c) => c.destroy({ children: true }));
    const total = newCampSession().embers;
    const g = new Graphics();
    const right = rw(CP.header);
    for (let i = 0; i < total; i++) {
      const lit = i < this.session.embers;
      const x = right - 12 - (total - 1 - i) * (EMBER_R * 2 + 8);
      g.circle(x, 19, EMBER_R).fill({
        color: lit ? PAL.gold : PAL.panel,
        alpha: lit ? 1 : 0.9,
      });
      g.circle(x, 19, EMBER_R).stroke({
        width: 1.5,
        color: lit ? PAL.goldDark : PAL.border,
      });
    }
    const cap = label(
      this.session.embers > 0
        ? `${this.session.embers} embers`
        : "the fire is out",
      { size: TYPE.tiny, dim: true },
    );
    cap.anchor.set(1, 0);
    cap.position.set(right - 12 - total * (EMBER_R * 2 + 8), 12);
    this.embersC.addChild(g, cap);
  }

  /* -------------------------------- cats ------------------------------- */

  private buildCats(): void {
    const wrap = new Container();
    wrap.position.set(rx(CP.cats), ry(CP.cats));
    this.hudC.addChild(wrap);

    const title = label("AT THE FIRE", {
      size: TYPE.tiny,
      bold: true,
      dim: true,
    });
    title.position.set(SPACE.sm, 0);
    wrap.addChild(title);

    this.cards = [];
    const w = rw(CP.cats);
    fieldedCats(this.run).forEach((cat, i) => {
      const view = new Container();
      view.position.set(0, 22 + i * (CAT_CARD_H + SPACE.sm));
      view.addChild(panel(w, CAT_CARD_H, { variant: "glass" }));

      const ring = new Graphics();
      view.addChild(ring);

      const face = avatar(cat.classId, 52, {});
      face.position.set(SPACE.md + 26, CAT_CARD_H / 2);
      view.addChild(face);

      const textX = SPACE.md + 58;
      const name = label(cat.name, {
        bold: true,
        size: TYPE.body,
        fill: catNameColor(cat.classId),
      });
      name.position.set(textX, SPACE.sm);
      view.addChild(name);

      const key = label(`${i + 1}`, { size: TYPE.tiny, mono: true, dim: true });
      key.anchor.set(1, 0);
      key.position.set(w - SPACE.sm, SPACE.sm);
      view.addChild(key);

      const hp = bar(w - textX - SPACE.md, 9, { kind: "hp" });
      hp.view.position.set(textX, 34);
      view.addChild(hp.view);

      const hpText = label("", { mono: true, dim: true, size: TYPE.tiny });
      hpText.position.set(textX, 46);
      view.addChild(hpText);

      const cond = label("", {
        size: TYPE.tiny,
        dim: true,
        wrap: w - textX - SPACE.md,
      });
      cond.position.set(textX, 64);
      view.addChild(cond);

      view.eventMode = "static";
      view.cursor = "pointer";
      padHit(view, w, CAT_CARD_H);
      view.on("pointertap", () => this.pickCat(cat.id));

      wrap.addChild(view);
      this.cards.push({ cat, view, ring, hp, hpText, cond });
    });
  }

  private refreshCats(): void {
    const run = this.run;
    for (const card of this.cards) {
      const cat = run.cats.find((c) => c.id === card.cat.id) ?? card.cat;
      card.cat = cat;
      const max = maxHp(cat, run.level);
      card.hp.set(cat.hp, max);
      card.hpText.text = `${cat.hp}/${max} hp · ${cat.lives} lives`;
      card.cond.text = conditionLine(cat.conditions);
      const hungry = hungerOf(cat.conditions) >= 2;
      card.cond.style.fill = hungry ? PAL.danger : PAL.textDim;

      // the target ring: only lit while an action is looking for somebody
      const legal =
        this.pending !== null &&
        canTakeCamp(run, this.session, this.pending, [
          ...(this.pending === "talk" ? this.picked : []),
          cat.id,
        ]).ok &&
        !this.picked.includes(cat.id);
      card.ring.clear();
      if (this.pending !== null) {
        card.view.alpha = legal || this.picked.includes(cat.id) ? 1 : 0.5;
        if (legal || this.picked.includes(cat.id)) {
          card.ring.roundRect(1, 1, rw(CP.cats) - 2, CAT_CARD_H - 2, 8).stroke({
            width: 2,
            color: this.picked.includes(cat.id) ? PAL.heal : PAL.gold,
          });
        }
      } else {
        card.view.alpha = 1;
      }
    }
  }

  /* -------------------------------- fire ------------------------------- */

  /** Add the authored exchange for this fire (the always-there source). */
  private pushAuthoredBeat(seedSalt = 0): void {
    const ex = campExchange(this.run, this.params.seed + seedSalt, {
      isBossFloor: this.isBossFloor,
      avoid: this.shownExchangeIds,
      ...(this.pending === "talk" && this.picked.length === 2 ? {} : {}),
    });
    if (!ex) return;
    this.shownExchangeIds.push(ex.id);
    this.pushBeat({
      who: ex.cats.map((c) => c.name).join(" & "),
      lines: ex.lines,
      fromDm: false,
    });
  }

  /** Keep the last two beats — a fire is a conversation, not a log. */
  private pushBeat(beat: Beat): void {
    this.beats = [...this.beats, beat].slice(-2);
  }

  /**
   * The fire, sized to what was actually said.
   *
   * The panel used to be a fixed 400px block with two lines of dialogue
   * floating at the top of it, which read as a screen that had failed to
   * load rather than as a quiet moment. So the content is laid out first and
   * the card is drawn around it — it grows when the DM's beat lands under the
   * authored one, and it never reserves space for a beat that is not coming.
   */
  private paintFire(): void {
    this.fireC.removeChildren().forEach((c) => c.destroy({ children: true }));
    const [fx, fy, fw, fh] = CP.fire;
    const inner = new Container();
    const wrap = fw - SPACE.lg * 2;

    const opener = label(campOpener(this.params.seed), {
      size: TYPE.small,
      dim: true,
      wrap,
    });
    opener.position.set(SPACE.lg, SPACE.md);
    inner.addChild(opener);

    let y = SPACE.md + Math.ceil(opener.height) + SPACE.md;
    inner.addChild(
      new Graphics()
        .moveTo(SPACE.lg, y)
        .lineTo(fw - SPACE.lg, y)
        .stroke({ width: 1, color: PAL.border, alpha: 0.8 }),
    );
    y += SPACE.md;

    for (const beat of this.beats) {
      const who = label(beat.fromDm ? `${beat.who} — at the fire` : beat.who, {
        size: TYPE.tiny,
        bold: true,
        fill: beat.fromDm ? PAL.gold : PAL.textDim,
      });
      who.position.set(SPACE.lg, y);
      inner.addChild(who);
      y += 18;
      for (const line of beat.lines) {
        const t = label(line, {
          size: TYPE.small,
          wrap,
          ...(beat.fromDm ? { fill: PAL.text } : {}),
        });
        t.position.set(SPACE.lg, y);
        inner.addChild(t);
        y += Math.ceil(t.height) + 6;
        if (y > fh - 44) break;
      }
      y += SPACE.sm;
      if (y > fh - 44) break;
    }

    if (this.asking) {
      const wait = label("The DM leans in…", { size: TYPE.tiny, dim: true });
      wait.position.set(SPACE.lg, y);
      inner.addChild(wait);
      y += Math.ceil(wait.height) + 4;
    }

    const h = Math.max(MIN_FIRE_H, Math.min(fh, y + SPACE.md));
    const card = panel(fw, h, { variant: "raised", accent: PAL.gold });
    card.position.set(fx, fy);
    inner.position.set(fx, fy);
    this.fireC.addChild(card, inner);
    this.fireBottom = fy + h;
  }

  /* ------------------------------ results ------------------------------ */

  private paintResults(): void {
    this.resultsC
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    if (this.results.length === 0) return;
    const [x, y, w] = CP.results;
    const wrap = new Container();
    // just under the fire, wherever the fire ended up
    // right under the fire, wherever the fire ended up (never past its rect)
    wrap.position.set(x, Math.min(y, this.fireBottom + SPACE.md));
    let ly = 0;
    for (const r of this.results.slice(0, 3)) {
      const t = label(r.text, {
        size: TYPE.small,
        wrap: w,
        fill:
          r.tone === "gain"
            ? PAL.heal
            : r.tone === "loss"
              ? PAL.danger
              : r.tone === "buff"
                ? PAL.energy
                : PAL.textDim,
      });
      t.position.set(0, ly);
      wrap.addChild(t);
      ly += Math.ceil(t.height) + 2;
    }
    this.resultsC.addChild(wrap);
  }

  /* ------------------------------ actions ------------------------------ */

  private paintActions(): void {
    this.actionsC
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    const [ax, ay] = CP.actions;
    const h = rh(CP.actions);

    CAMP_ACTIONS.forEach((def, i) => {
      const usable = this.anyLegalTarget(def.id);
      const b = button(def.name, ACT_W, h, () => this.startAction(def.id), {
        hotkey: def.hotkey,
        disabled: !usable,
        fontSize: TYPE.small,
        ...(this.pending === def.id ? { primary: true } : {}),
      });
      b.view.position.set(ax + i * (ACT_W + ACT_GAP), ay);
      this.actionsC.addChild(b.view);
    });

    const bx = ax + CAMP_ACTIONS.length * (ACT_W + ACT_GAP);
    const leave = button(
      this.session.embers > 0 ? "Break camp" : "Move on",
      DESIGN_W - bx - 40,
      h,
      () => this.breakCamp(),
      {
        primary: this.session.embers === 0,
        hotkey: "Enter",
        fontSize: TYPE.small,
      },
    );
    leave.view.position.set(bx, ay);
    this.actionsC.addChild(leave.view);
  }

  private paintHint(): void {
    this.hintC.removeChildren().forEach((c) => c.destroy({ children: true }));
    const [x, y, w] = CP.hint;
    let text: string;
    if (this.pending === "talk") {
      text =
        this.picked.length === 0
          ? "Who starts? Tap a cat."
          : "…and who do they say it to?";
    } else if (this.pending) {
      text = "Tap the cat it is for. Esc to think again.";
    } else if (this.session.embers === 0) {
      text = "The fire is embers. Whatever was going to be said got said.";
    } else {
      text =
        "Three embers, five things worth doing. " +
        (this.dmUp ? "The DM is listening." : "");
    }
    const t = label(text, {
      size: TYPE.small,
      dim: true,
      wrap: w,
      center: true,
    });
    t.position.set(x + w / 2, y);
    this.hintC.addChild(t);
  }

  private refresh(): void {
    if (!this.mounted) return;
    this.paintEmbers();
    this.paintFire();
    this.refreshCats();
    this.paintResults();
    this.paintActions();
    this.paintHint();
  }

  /* ---------------------------- interaction ---------------------------- */

  /** Is there ANY cat this action could legally be taken on right now? */
  private anyLegalTarget(id: CampActionId): boolean {
    const party = fieldedCats(this.run);
    if (id === "talk") {
      if (party.length < 2) return false;
      return canTakeCamp(this.run, this.session, id, [party[0].id, party[1].id])
        .ok;
    }
    return party.some(
      (c) => canTakeCamp(this.run, this.session, id, [c.id]).ok,
    );
  }

  private startAction(id: CampActionId): void {
    if (!this.mounted) return;
    if (this.pending === id) {
      this.cancelPending();
      return;
    }
    if (!this.anyLegalTarget(id)) {
      this.results = [{ text: reasonFor(this, id), tone: "neutral" }];
      this.refresh();
      return;
    }
    this.pending = id;
    this.picked = [];
    this.results = [];
    this.refresh();
  }

  private cancelPending(): void {
    this.pending = null;
    this.picked = [];
    this.refresh();
  }

  private pickCat(id: CatId): void {
    const action = this.pending;
    if (!action) return;
    const need = action === "talk" ? 2 : 1;
    const who = [...this.picked, id];
    if (who.length < need) {
      // a partial pick is only legal if the pair could still work out
      if (this.picked.includes(id)) return;
      this.picked = who;
      this.refresh();
      return;
    }
    const check = canTakeCamp(this.run, this.session, action, who);
    if (!check.ok) {
      this.results = [{ text: check.why, tone: "neutral" }];
      this.refresh();
      return;
    }
    const out = takeCampAction(this.run, this.session, action, who);
    this.ctx.run = out.run;
    this.session = out.session;
    this.results = out.results;
    this.pending = null;
    this.picked = [];
    if (out.flavour !== "") {
      this.results = [...this.results, { text: out.flavour, tone: "neutral" }];
    }
    this.ctx.save();

    // TALK is the action that is ABOUT the interaction, so it buys another
    // exchange — from the DM when there is one, from the authored pool when
    // there is not. Everything else just happens.
    if (action === "talk") {
      const cats = who
        .map((cid) => out.run.cats.find((c) => c.id === cid))
        .filter((c): c is CatRunState => c !== undefined);
      const ex = campExchange(out.run, this.params.seed + this.beats.length, {
        isBossFloor: this.isBossFloor,
        cats,
        avoid: this.shownExchangeIds,
      });
      if (ex) {
        this.shownExchangeIds.push(ex.id);
        this.pushBeat({
          who: ex.cats.map((c) => c.name).join(" & "),
          lines: ex.lines,
          fromDm: false,
        });
      }
      if (this.dmUp) this.askDm(cats, "talk");
    }
    this.refresh();
  }

  private breakCamp(): void {
    if (!this.mounted) return;
    this.ctx.save();
    this.ctx.scenes.goto("runMap", { from: "camp" });
  }

  /* -------------------------------- the DM ----------------------------- */

  /** The run, seen through the tabletop extension (the durable session). */
  private get talkRun(): TabletopRun {
    return this.ctx.run as TabletopRun;
  }

  /**
   * Ask the DM for the exchange between two NAMED cats.
   *
   * No output schema on purpose. The agent is emphatically tools-first (see
   * `services/dm.ts`, `verdictFromToolCalls`), and a camp beat wants prose,
   * not a structured payload — so this asks for prose and reads the assistant
   * text. Nothing mechanical rides on the answer: the embers, the healing and
   * the conditions are all decided by `core/run/camp.ts` from the player's own
   * choices, so a DM that is slow, absent or rambling costs exactly one extra
   * paragraph of flavour and never a rule.
   */
  private askDm(cats: readonly CatRunState[], why: "arrival" | "talk"): void {
    if (!this.mounted || this.asking || cats.length === 0) return;
    const a = cats[0];
    const b = cats[1] ?? cats[0];
    this.asking = true;
    this.refresh();

    void (async () => {
      const ensured = await ensureDmSession(this.talkRun);
      if (!ensured) {
        this.asking = false;
        this.dmUp = false;
        markDmUnreachable();
        if (this.mounted) this.refresh();
        return;
      }
      if (this.mounted) this.ctx.run = ensured.run;
      const res = await sendDmTurn(ensured.session, {
        message: campPrompt(this.run, a, b, why),
        timeoutMs: DM_CAMP_TIMEOUT_MS,
      });
      this.asking = false;
      if (!this.mounted) return;
      if (!res) {
        this.dmUp = false;
        markDmUnreachable();
        this.refresh();
        return;
      }
      this.ctx.run = withDmSession(this.talkRun, res.session);
      this.ctx.save();
      const lines = campLinesFrom(res.text);
      if (lines.length > 0) {
        this.pushBeat({
          who: a.id === b.id ? a.name : `${a.name} & ${b.name}`,
          lines,
          fromDm: true,
        });
      }
      this.refresh();
    })();
  }
}

/**
 * A camp beat nobody is waiting on. Shorter than a verdict's budget: the
 * authored exchange is already on screen, so a slow DM costs nothing but its
 * own line, and a long wait at a fire reads as the game having hung.
 */
export const DM_CAMP_TIMEOUT_MS = 25_000;

/** Longest DM camp beat the panel will render. */
export const MAX_CAMP_TEXT = 700;

/**
 * THE CAMP PROMPT — what the DM is asked for (roster-and-persistence.md §4:
 * "this is the DM's best material, and it uses the durable session's memory").
 *
 * It names TWO CATS and asks for what passes between them, explicitly invites
 * a callback to an earlier floor, and states the one hard boundary: nothing
 * mechanical. The camp's numbers belong to the engine.
 */
export function campPrompt(
  run: RunState,
  a: CatRunState,
  b: CatRunState,
  why: "arrival" | "talk",
): string {
  const cfg = floorConfig(run.floorNum);
  const who = (c: CatRunState): string => {
    const bits: string[] = [`${c.hp} hp`, `${c.lives} lives`];
    const cond = conditionLine(c.conditions);
    if (cond !== "rested") bits.push(cond);
    return `${c.name}${c.standName ? ` 「${c.standName}」` : ""} (${bits.join(", ")})`;
  };
  return [
    `CAMP — floor ${run.floorNum}, "${cfg.name}". The party has stopped at a`,
    "fire. Nothing is hunting them for a little while.",
    "",
    why === "talk"
      ? `${a.name} and ${b.name} have sat up to talk on purpose.`
      : `${a.name} and ${b.name} end up beside each other at the fire.`,
    `  ${who(a)}`,
    `  ${who(b)}`,
    "",
    "Write what passes between THESE TWO. 2-4 short lines, their words, not",
    "yours — this is the one beat in the game that is about the cats and not",
    "about the dungeon. If you remember something this party did on an earlier",
    "floor, put it in their mouths: that is the whole point of you being here",
    "for the whole run.",
    "",
    "No mechanics, no tools, no offers, no dice — the fire's effects belong to",
    "the game. Just the exchange, as plain text.",
  ].join("\n");
}

/**
 * The DM's prose, split into renderable lines. Defensive: the agent may answer
 * with a paragraph, a dialogue block, or a fenced anything, and none of those
 * may be allowed to blow up a scene the player is standing in.
 */
export function campLinesFrom(text: string): string[] {
  const clean = text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .trim()
    .slice(0, MAX_CAMP_TEXT);
  if (clean === "") return [];
  return clean
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 5);
}

/** Why an action button is dark, in words. */
function reasonFor(scene: CampScene, id: CampActionId): string {
  void scene;
  switch (id) {
    case "eat":
      return "Nothing left worth calling food.";
    case "bandage":
      return "Nobody here has a scratch on them.";
    case "tend":
      return "No old marks to tend. Long may that last.";
    case "talk":
      return "It takes two, and there is only one of them awake.";
    case "watch":
      return "Somebody already has the watch.";
  }
}

/** Everything the camp scene needs to answer "is this cat scarred?". */
export const campUntendedScar = untendedScar;

/** Factory for the scene registry (main.ts wires it by id 'camp'). */
export const createCampScene = (): CampScene => new CampScene();
