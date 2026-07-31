/**
 * Party creator scene (GM-DEPLOY.md "UI wiring plan" §1, gm-system.md):
 * title → [C] → describe 1–4 cats in free text (DOM overlay inputs) →
 * `requestGmParty` → preview the four generated kits (name, Stand, role,
 * stats, skills, power flavor) → [Enter] starts the run with those kits.
 *
 * THE GM IS OPTIONAL. Every failure (offline / timeout / invalid body)
 * degrades to the exact static behavior: a "GM offline — using the Strays"
 * toast, then a normal default-party run. A run start is never blocked.
 *
 * Custom kits keep the four fixed ClassId slots (role-mapped) so every
 * classId-keyed system — save files, marching order, weapons, sprites —
 * keeps working. `applyPartyContent` overlays the kits onto the CLASSES /
 * CAT_POWERS / SKILLS content tables for the duration of the run (floorgen
 * re-syncs from `run.customParty` at every run start, restoring the stock
 * Strays when no custom party is present). Custom cats have no generated
 * art: `catTexture()` misses on their names, so the procedural renderers
 * take over automatically; `stand.visualPrompt` is stored on the run for
 * future sprite generation.
 *
 * All chrome is the shared kit (widgets.ts): `sceneBackdrop`/`vignette`,
 * `panel` cards, `avatar()` slot portraits (painted-first — never a flat
 * vector face), `heading`/`label` type and `button` hotkey chips. The DOM
 * entry overlay mirrors the same palette tokens.
 */
import { Container, Text } from "pixi.js";
import type { CatClass, ClassId, Skill, TraitId } from "../../core/types.js";
import {
  newRun,
  PARTY_ORDER,
  type CustomCatKit,
} from "../../core/run/runState.js";
import { CLASSES } from "../../content/classes.js";
import { SKILLS } from "../../content/skills.js";
import { CAT_POWERS } from "../../content/powers.js";
import { requestGmParty } from "../../services/gm.js";
import type { GeneratedCatKit, GmRole } from "../../services/gmTypes.js";
import { PAL } from "../palette.js";
import { DESIGN_H, DESIGN_W, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import {
  avatar,
  button,
  heading,
  label,
  panel,
  sceneBackdrop,
  vignette,
} from "../widgets.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";

/* ---------------------------------------------------------------------- */
/* Kit mapping (GeneratedCatKit → CustomCatKit, pure)                      */
/* ---------------------------------------------------------------------- */

/** Role → fixed party slot (gm-system.md "tank/striker/control/support"). */
const ROLE_SLOT: Record<GmRole, ClassId> = {
  tank: "bruiser",
  striker: "trickster",
  control: "hexer",
  support: "medic",
};

/**
 * Map the 4 wire kits onto the core CustomCatKit shape: each kit takes its
 * role's ClassId slot (duplicated roles — a guard should prevent them, but
 * defensively — spill into the first free slot in party order), and skill
 * ids are rewritten into a collision-proof `custom:<classId>:<n>` namespace
 * before they are registered next to the stock content skills.
 */
export function mapKitsToCustomParty(kits: GeneratedCatKit[]): CustomCatKit[] {
  const taken = new Set<ClassId>();
  return kits.slice(0, PARTY_ORDER.length).map((kit) => {
    let slot: ClassId | undefined = ROLE_SLOT[kit.role];
    if (taken.has(slot)) {
      slot = PARTY_ORDER.find((id) => !taken.has(id));
    }
    const classId = slot ?? "bruiser";
    taken.add(classId);
    const skills: Skill[] = kit.skills.map((s, i) => ({
      ...s,
      id: `custom:${classId}:${i + 1}`,
    }));
    return {
      classId,
      role: kit.role,
      catName: kit.catName,
      className: kit.className,
      epithet: kit.epithet,
      base: { ...kit.base },
      growth: kit.growth.map((g) => ({ ...g })),
      skills,
      trait: { name: kit.trait.name, desc: kit.trait.desc },
      standName: kit.stand.name,
      visualPrompt: kit.stand.visualPrompt,
      power: kit.power,
      flavor: kit.flavor,
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Content overlay (CLASSES / CAT_POWERS / SKILLS for the current run)     */
/* ---------------------------------------------------------------------- */

// Stock entries captured once at module load — before any overlay can run —
// so restoration is always exact.
const STOCK_CLASSES: Record<ClassId, CatClass> = { ...CLASSES };
const STOCK_POWERS = { ...CAT_POWERS };
let customSkillIds: string[] = [];

/** Build a CatClass-shaped record from a kit (stock palette: the kit has no
 *  palette hints, so procedural fallback art keeps the slot's colors). The
 *  custom trait is prose-only — its id is outside every executable TraitId,
 *  so combat trait hooks never match it (gm-system.md v1 ruling). */
function catClassFromKit(kit: CustomCatKit): CatClass {
  return {
    id: kit.classId,
    className: kit.className,
    catName: kit.catName,
    epithet: kit.epithet,
    base: { ...kit.base },
    growth: kit.growth.map((g) => ({ ...g })),
    // mirror the stock unlock pattern: three L1 skills + an L4 capstone
    skills: kit.skills.map((s, i) => ({
      skillId: s.id,
      unlockLevel: i === 3 ? 4 : 1,
    })),
    trait: {
      id: `custom:${kit.classId}` as TraitId, // inert: no hook matches it
      name: kit.trait.name,
      desc: kit.trait.desc,
      tier2Level: 7,
      tier2Desc: kit.trait.desc,
    },
    flavor: {
      bio: kit.flavor.bio,
      barks: { ...kit.flavor.barks },
    },
    palette: STOCK_CLASSES[kit.classId].palette,
  };
}

/**
 * Overlay a custom party onto the content tables (or restore the stock
 * Strays when `party` is null/absent). Idempotent — always restores first,
 * then applies. Called from floorgen at every run start (the choke point
 * every new/again run passes through), from title's Continue (a saved
 * custom run re-applies after reload), and from this scene right before
 * `newRun` so starting HP derives from the custom base stats.
 */
export function applyPartyContent(
  party: CustomCatKit[] | null | undefined,
): void {
  for (const id of PARTY_ORDER) {
    CLASSES[id] = STOCK_CLASSES[id];
    const stock = STOCK_POWERS[id];
    if (stock) CAT_POWERS[id] = stock;
    else delete CAT_POWERS[id];
  }
  for (const sid of customSkillIds) delete SKILLS[sid];
  customSkillIds = [];
  if (!party || party.length === 0) return;
  for (const kit of party) {
    CLASSES[kit.classId] = catClassFromKit(kit);
    CAT_POWERS[kit.classId] = kit.power;
    for (const s of kit.skills) {
      SKILLS[s.id] = s;
      customSkillIds.push(s.id);
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Scene                                                                   */
/* ---------------------------------------------------------------------- */

/** Random 8-hex run seed (visual RNG picking a gameplay seed — the
 *  ARCHITECTURE.md §4 exception, same as title.ts's randomSeed). */
function randomSeed8(): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s.toUpperCase();
}

type CreatorMode = "input" | "loading" | "preview" | "offline";

const OFFLINE_TOAST = "GM offline — using the Strays";
/** Toast hold before the fallback run starts. */
const OFFLINE_HOLD_MS = 1400;

const PLACEHOLDERS = [
  "A one-eyed dumpster brawler with a heart of gold…",
  "A tiny void who hoards bottle caps…",
  "(optional) third cat…",
  "(optional) fourth cat…",
];

/* ---- screen geometry (design px) ------------------------------------- */
const EYEBROW_Y = 46;
const BANNER_Y = 78;
const SUB_Y = 124;
const CARD_TOP = 170;
const CARD_W = 296;
const CARD_H = 400;
const CARD_GAP = SPACE.lg;
const BAR_Y = 632;
const BTN_H = 52;

export function createPartyCreatorScene(): Scene {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let alive = false;
  let mode: CreatorMode = "input";

  // DOM overlay (free-text entry needs real inputs: spaces, IME, paste)
  let dom: HTMLDivElement | null = null;
  let inputs: HTMLInputElement[] = [];

  // pixi bits swapped per mode
  let stage: Container | null = null; // mode-owned content
  let hint: Text | null = null;
  let statusText: Text | null = null;
  let toastC: Container | null = null;
  let offlineTimer = 0;
  let dotT = 0;
  let requestToken = 0;
  let kits: GeneratedCatKit[] | null = null;

  const setMode = (m: CreatorMode): void => {
    mode = m;
    if (dom) dom.style.display = m === "input" ? "flex" : "none";
    rebuildStage();
  };

  /* ---- run starts -------------------------------------------------- */

  const startCustomRun = (): void => {
    if (!ctx || !kits) return;
    const party = mapKitsToCustomParty(kits);
    applyPartyContent(party); // BEFORE newRun: starting HP = custom bases
    ctx.run = newRun(randomSeed8(), party);
    ctx.scenes.goto("floorgen");
  };

  const startFallbackRun = (): void => {
    if (!ctx) return;
    applyPartyContent(null);
    ctx.run = newRun(randomSeed8());
    ctx.scenes.goto("floorgen");
  };

  const backToTitle = (): void => {
    requestToken++; // orphan any in-flight GM response
    ctx?.scenes.goto("title");
  };

  /* ---- GM submit --------------------------------------------------- */

  const submit = (): void => {
    if (mode !== "input") return;
    const descriptions = inputs
      .map((el) => el.value.trim())
      .filter((d) => d !== "")
      .slice(0, 4);
    if (descriptions.length === 0) {
      if (statusText) statusText.text = "Describe at least one cat first.";
      return;
    }
    const token = ++requestToken;
    setMode("loading");
    void requestGmParty(descriptions).then((result) => {
      if (!alive || token !== requestToken || mode !== "loading") return;
      if (result === null) {
        // offline / timeout / invalid — toast, then the Strays. Never block.
        setMode("offline");
        showToast(OFFLINE_TOAST);
        offlineTimer = OFFLINE_HOLD_MS;
      } else {
        kits = result;
        setMode("preview");
      }
    });
  };

  /* ---- pixi builders ----------------------------------------------- */

  const rebuildStage = (): void => {
    if (!stage) return;
    stage.removeChildren().forEach((c) => c.destroy({ children: true }));
    statusText = null;
    if (mode === "input") buildInputStage();
    else if (mode === "loading") buildLoadingStage();
    else if (mode === "preview") buildPreviewStage();
    if (hint) {
      hint.text =
        mode === "preview"
          ? "The GM's word is final — but you can always rewrite it."
          : mode === "loading"
            ? "The GM is thinking. This takes a few seconds."
            : "Describe one to four cats, then summon the GM.";
    }
  };

  /** The persistent action bar: same slot, same language, every mode. */
  function actionBar(
    defs: {
      label: string;
      hotkey: string;
      onTap: () => void;
      primary?: boolean;
      w?: number;
    }[],
  ): void {
    if (!stage) return;
    const gap = SPACE.lg;
    const total =
      defs.reduce((s, d) => s + (d.w ?? 220), 0) + gap * (defs.length - 1);
    let x = (DESIGN_W - total) / 2;
    for (const d of defs) {
      const w = d.w ?? 220;
      const b = button(d.label, w, BTN_H, d.onTap, {
        primary: d.primary,
        hotkey: d.hotkey,
      });
      b.view.position.set(x, BAR_Y);
      stage.addChild(b.view);
      x += w + gap;
    }
  }

  function buildInputStage(): void {
    if (!stage) return;
    const sub = label(
      "Describe one to four cats. The GM invents the rest —\n" +
        "Stands, skills, stats, the works.",
      { dim: true, center: true, align: "center", size: TYPE.body },
    );
    sub.position.set(DESIGN_W / 2, SUB_Y);
    stage.addChild(sub);

    // the DOM entry panel owns the middle of the screen in this mode; the
    // status line sits just under it, above the action bar
    statusText = label("", { fill: PAL.offBal, center: true });
    statusText.position.set(DESIGN_W / 2, BAR_Y - SPACE.xl);
    stage.addChild(statusText);

    actionBar([
      { label: "Summon the GM", hotkey: "Enter", onTap: submit, primary: true },
      { label: "Back", hotkey: "Esc", onTap: backToTitle, w: 160 },
    ]);
  }

  function buildLoadingStage(): void {
    if (!stage) return;
    statusText = heading("The GM shuffles the deck", 2, {
      center: true,
      fill: PAL.gold,
    });
    statusText.position.set(DESIGN_W / 2, DESIGN_H / 2 - 16);
    stage.addChild(statusText);
    const sub = label("conjuring four Stands from your words…", {
      dim: true,
      center: true,
      size: TYPE.body,
    });
    sub.position.set(DESIGN_W / 2, DESIGN_H / 2 + 24);
    stage.addChild(sub);

    actionBar([
      { label: "Never mind", hotkey: "Esc", onTap: backToTitle, w: 200 },
    ]);
  }

  function buildPreviewStage(): void {
    if (!stage || !kits) return;
    const party = mapKitsToCustomParty(kits);
    const x0 = (DESIGN_W - 4 * CARD_W - 3 * CARD_GAP) / 2;
    const s = stage;
    party.forEach((kit, i) => {
      const p = buildKitPanel(kit, CARD_W, CARD_H);
      p.position.set(x0 + i * (CARD_W + CARD_GAP), CARD_TOP);
      s.addChild(p);
    });

    actionBar([
      {
        label: "Take them in",
        hotkey: "Enter",
        onTap: startCustomRun,
        primary: true,
        w: 240,
      },
      {
        label: "Rewrite",
        hotkey: "Esc",
        onTap: () => setMode("input"),
        w: 200,
      },
    ]);
  }

  /** One kit preview card: kit chrome only, class-colored accent edge. */
  function buildKitPanel(kit: CustomCatKit, w: number, h: number): Container {
    const c = new Container();
    c.addChild(
      panel(w, h, { variant: "glass", accent: PAL[kit.classId].body }),
    );

    // header: the party-slot portrait (painted-first) + name + role
    const face = avatar(kit.classId, 60, { shape: "rounded" });
    face.position.set(SPACE.lg + 30, SPACE.lg + 26);
    c.addChild(face);

    const name = heading(kit.catName, 2, { fill: PAL.gold });
    name.position.set(SPACE.lg + 70, SPACE.md);
    const role = label(`${kit.className} · ${kit.role}`, {
      size: TYPE.tiny,
      wrap: w - SPACE.lg - 78,
    });
    role.position.set(SPACE.lg + 70, SPACE.md + 30);
    const slot = label(`${kit.classId} slot`, {
      mono: true,
      dim: true,
      size: TYPE.tiny,
    });
    slot.position.set(SPACE.lg + 70, SPACE.md + 48);
    c.addChild(name, role, slot);

    let y = SPACE.lg + 62;
    const add = (t: Text, gap: number = SPACE.xs): void => {
      t.position.set(SPACE.lg, y);
      c.addChild(t);
      y += t.height + gap;
    };
    const wrapW = w - SPACE.lg * 2;

    add(label(kit.epithet, { dim: true, size: TYPE.tiny, wrap: wrapW }));
    y += SPACE.xs;
    add(
      label(`«${kit.standName}»`, {
        mono: true,
        fill: PAL.energy,
        wrap: wrapW,
      }),
      SPACE.sm,
    );

    const b = kit.base;
    add(
      label(
        `HP ${b.hp}  ATK ${b.atk}  DEF ${b.def}\n` +
          `SPD ${b.spd}  CRT ${b.crt}  EN ${b.enMax}`,
        { mono: true, size: TYPE.small },
      ),
      SPACE.sm,
    );

    const skillsTitle = heading("SKILLS", 3);
    add(skillsTitle, SPACE.xs);
    for (const s of kit.skills) {
      add(
        label(`· ${s.name} (${s.cost}⚡)`, {
          size: TYPE.small,
          wrap: wrapW,
        }),
        2,
      );
    }
    y += SPACE.sm;
    add(
      label(`${kit.trait.name} — ${kit.trait.desc}`, {
        dim: true,
        size: TYPE.tiny,
        wrap: wrapW,
      }),
      SPACE.xs,
    );
    add(
      label(kit.power.flavor, {
        fill: PAL.hexer.body,
        size: TYPE.tiny,
        wrap: wrapW,
      }),
    );
    return c;
  }

  function showToast(msg: string): void {
    toastC?.destroy({ children: true });
    const tw = 600;
    const th = 56;
    const box = new Container();
    box.addChild(panel(tw, th, { variant: "raised", accent: PAL.gold }));
    const t = label(msg, { center: true, size: TYPE.body });
    t.position.set(tw / 2, th / 2);
    box.addChild(t);
    box.position.set((DESIGN_W - tw) / 2, DESIGN_H / 2 + 80);
    toastC = box;
    view.addChild(box);
  }

  /* ---- DOM overlay ------------------------------------------------- */

  /** PAL token → CSS hex, so the DOM entry panel matches the pixi chrome. */
  const css = (color: number): string =>
    `#${color.toString(16).padStart(6, "0")}`;

  function buildDom(): void {
    dom = document.createElement("div");
    dom.id = "party-creator-overlay";
    Object.assign(dom.style, {
      position: "fixed",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      pointerEvents: "none",
      zIndex: "10",
    } satisfies Partial<CSSStyleDeclaration>);

    const domPanel = document.createElement("div");
    Object.assign(domPanel.style, {
      pointerEvents: "auto",
      width: "min(560px, 82vw)",
      background: "rgba(29, 24, 48, 0.94)", // PAL.glass
      border: `1px solid ${css(PAL.border)}`,
      borderRadius: "8px",
      padding: "18px 20px",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      boxShadow: "0 10px 32px rgba(7, 6, 13, 0.55)",
      fontFamily: "monospace",
    } satisfies Partial<CSSStyleDeclaration>);
    dom.appendChild(domPanel);

    inputs = PLACEHOLDERS.map((ph, i) => {
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 500;
      input.placeholder = ph;
      input.setAttribute("data-cat-input", String(i + 1));
      Object.assign(input.style, {
        background: css(PAL.hpBack),
        border: `1px solid ${css(PAL.border)}`,
        borderRadius: "6px",
        color: css(PAL.text),
        padding: "10px 12px",
        fontSize: "14px",
        fontFamily: "inherit",
        outline: "none",
      } satisfies Partial<CSSStyleDeclaration>);
      // Free typing must never reach the global game key listener (which
      // preventDefaults space/arrows) — stop propagation at the input and
      // handle Enter/Esc locally instead.
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") submit();
        else if (e.key === "Escape") backToTitle();
      });
      input.addEventListener("keyup", (e) => e.stopPropagation());
      domPanel.appendChild(input);
      return input;
    });

    // No DOM buttons: the pixi action bar below owns Summon/Back, so the
    // screen shows exactly one button language (kit `button` + hotkey chip).
    document.body.appendChild(dom);
    setTimeout(() => inputs[0]?.focus(), 0);
  }

  /* ---- Scene contract ---------------------------------------------- */

  return {
    mount(root, gameCtx) {
      ctx = gameCtx;
      alive = true;
      mode = "input";
      kits = null;

      view.addChild(
        sceneBackdrop("scene:partyCreator", DESIGN_W, DESIGN_H, { dim: 0.5 }),
        vignette(DESIGN_W, DESIGN_H, 0.8),
      );

      const eyebrow = heading("THE GM IS LISTENING", 3, { center: true });
      eyebrow.position.set(DESIGN_W / 2, EYEBROW_Y);
      const header = heading("Assemble your own alley", 1, {
        center: true,
        fill: PAL.gold,
      });
      header.position.set(DESIGN_W / 2, BANNER_Y);
      view.addChild(eyebrow, header);

      stage = new Container();
      view.addChild(stage);

      hint = label("", { dim: true, center: true, size: TYPE.tiny });
      hint.position.set(DESIGN_W / 2, DESIGN_H - SPACE.lg);
      view.addChild(hint);

      buildDom();
      rebuildStage();
      layer(root, "bg").addChild(view);

      // dev/CI observability, mirroring main.ts's __scene/__overlay hooks
      (window as unknown as { __partyCreator?: () => string }).__partyCreator =
        () => mode;
    },

    unmount() {
      alive = false;
      requestToken++;
      delete (window as unknown as { __partyCreator?: () => string })
        .__partyCreator;
      dom?.remove();
      dom = null;
      inputs = [];
      stage = null;
      hint = null;
      statusText = null;
      toastC = null;
      view.destroy({ children: true });
    },

    update(dtMs) {
      if (mode === "loading" && statusText) {
        dotT += dtMs;
        const dots = ".".repeat(1 + (Math.floor(dotT / 350) % 3));
        statusText.text = `The GM shuffles the deck${dots}`;
      }
      if (mode === "offline" && offlineTimer > 0) {
        offlineTimer -= dtMs;
        if (offlineTimer <= 0) startFallbackRun();
      }
    },

    onKey(key) {
      if (mode === "input") {
        if (key === "enter") {
          submit();
          return true;
        }
        if (key === "esc") {
          backToTitle();
          return true;
        }
      } else if (mode === "loading") {
        if (key === "esc") {
          backToTitle();
          return true;
        }
      } else if (mode === "preview") {
        if (key === "enter") {
          startCustomRun();
          return true;
        }
        if (key === "esc") {
          setMode("input");
          return true;
        }
      }
      // No run exists here — swallow everything else (Esc-pause must not
      // open over the creator; partyCreator is also in PAUSE_BLOCKED).
      return true;
    },
  };
}
