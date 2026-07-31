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
 */
import { Container, Graphics, Text } from "pixi.js";
import type { CatClass, ClassId, Skill, TraitId } from "../../core/types";
import {
  newRun,
  PARTY_ORDER,
  type CustomCatKit,
} from "../../core/run/runState";
import { CLASSES } from "../../content/classes";
import { SKILLS } from "../../content/skills";
import { CAT_POWERS } from "../../content/powers";
import { requestGmParty } from "../../services/gm";
import type { GeneratedCatKit, GmRole } from "../../services/gmTypes";
import { PAL } from "../palette";
import { DESIGN_H, DESIGN_W, RADIUS } from "../layout";
import { display, mono, ui } from "../textStyles";
import { layer, type GameCtx, type Scene } from "../sceneManager";

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
          ? "[Enter] Take them in · [Esc] Rewrite"
          : mode === "loading"
            ? "[Esc] Never mind — back to the title"
            : "[Enter] Summon the GM · [Esc] Back to title";
    }
  };

  function buildInputStage(): void {
    if (!stage) return;
    const sub = new Text({
      text:
        "Describe one to four cats. The GM invents the rest —\n" +
        "Stands, skills, stats, the works.",
      style: ui(16, { fill: PAL.textDim, align: "center" }),
    });
    sub.anchor.set(0.5, 0);
    sub.position.set(DESIGN_W / 2, 116);
    stage.addChild(sub);

    statusText = new Text({
      text: "",
      style: ui(14, { fill: PAL.offBal }),
    });
    statusText.anchor.set(0.5, 0);
    statusText.position.set(DESIGN_W / 2, 636);
    stage.addChild(statusText);
  }

  function buildLoadingStage(): void {
    if (!stage) return;
    statusText = new Text({
      text: "The GM shuffles the deck",
      style: display(24, { fill: PAL.gold }),
    });
    statusText.anchor.set(0.5);
    statusText.position.set(DESIGN_W / 2, DESIGN_H / 2 - 10);
    stage.addChild(statusText);
    const sub = new Text({
      text: "conjuring four Stands from your words…",
      style: ui(15, { fill: PAL.textDim }),
    });
    sub.anchor.set(0.5);
    sub.position.set(DESIGN_W / 2, DESIGN_H / 2 + 26);
    stage.addChild(sub);
  }

  function buildPreviewStage(): void {
    if (!stage || !kits) return;
    const party = mapKitsToCustomParty(kits);
    const colW = 296;
    const gap = 16;
    const x0 = (DESIGN_W - 4 * colW - 3 * gap) / 2;
    const s = stage;
    party.forEach((kit, i) => {
      const p = buildKitPanel(kit, colW);
      p.position.set(x0 + i * (colW + gap), 112);
      s.addChild(p);
    });
  }

  function buildKitPanel(kit: CustomCatKit, w: number): Container {
    const c = new Container();
    const h = 528;
    c.addChild(
      new Graphics()
        .roundRect(0, 0, w, h, RADIUS.panel)
        .fill(PAL.panel)
        .stroke({ width: 2, color: PAL.border }),
    );
    let y = 14;
    const add = (t: Text, x = 14): void => {
      t.position.set(x, y);
      c.addChild(t);
      y += t.height + 4;
    };
    const wrap = { wordWrap: true, wordWrapWidth: w - 28 } as const;
    add(
      new Text({ text: kit.catName, style: display(22, { fill: PAL.gold }) }),
    );
    add(
      new Text({
        text: kit.epithet,
        style: ui(12, { fill: PAL.textDim, ...wrap }),
      }),
    );
    add(
      new Text({
        text: `${kit.className} · ${kit.role}`,
        style: ui(14, { fill: PAL.text }),
      }),
    );
    y += 4;
    add(
      new Text({
        text: `«${kit.standName}»`,
        style: mono(14, { fill: PAL.energy, ...wrap }),
      }),
    );
    y += 4;
    const b = kit.base;
    add(
      new Text({
        text:
          `HP ${b.hp}  ATK ${b.atk}  DEF ${b.def}\n` +
          `SPD ${b.spd}  CRT ${b.crt}  EN ${b.enMax}`,
        style: mono(13, { fill: PAL.text }),
      }),
    );
    y += 6;
    for (const s of kit.skills) {
      add(
        new Text({
          text: `· ${s.name} (${s.cost}⚡)`,
          style: ui(13, { fill: PAL.text, ...wrap }),
        }),
      );
    }
    y += 6;
    add(
      new Text({
        text: `${kit.trait.name} — ${kit.trait.desc}`,
        style: ui(11, { fill: PAL.textDim, ...wrap }),
      }),
    );
    y += 4;
    add(
      new Text({
        text: kit.power.flavor,
        style: ui(11, { fill: PAL.hexer.body, ...wrap }),
      }),
    );
    return c;
  }

  function showToast(msg: string): void {
    toastC?.destroy({ children: true });
    toastC = new Container();
    const tw = 600;
    toastC.addChild(
      new Graphics()
        .roundRect(0, 0, tw, 48, RADIUS.panel)
        .fill(PAL.panelLite)
        .stroke({ width: 2, color: PAL.gold }),
    );
    const t = new Text({ text: msg, style: ui(16, { fill: PAL.text }) });
    t.anchor.set(0.5);
    t.position.set(tw / 2, 24);
    toastC.addChild(t);
    toastC.position.set((DESIGN_W - tw) / 2, 560);
    view.addChild(toastC);
  }

  /* ---- DOM overlay ------------------------------------------------- */

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

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      pointerEvents: "auto",
      width: "min(560px, 82vw)",
      background: "rgba(26, 22, 38, 0.96)",
      border: "2px solid #4a3f66",
      borderRadius: "8px",
      padding: "18px 20px",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      fontFamily: "monospace",
    } satisfies Partial<CSSStyleDeclaration>);
    dom.appendChild(panel);

    inputs = PLACEHOLDERS.map((ph, i) => {
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 500;
      input.placeholder = ph;
      input.setAttribute("data-cat-input", String(i + 1));
      Object.assign(input.style, {
        background: "#241f33",
        border: "1px solid #4a3f66",
        borderRadius: "6px",
        color: "#f2ede4",
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
      panel.appendChild(input);
      return input;
    });

    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      gap: "10px",
      justifyContent: "flex-end",
    } satisfies Partial<CSSStyleDeclaration>);
    const mkBtn = (
      label: string,
      primary: boolean,
      onClick: () => void,
    ): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      Object.assign(btn.style, {
        background: primary ? "#f5c84c" : "#262038",
        color: primary ? "#1a1626" : "#f2ede4",
        border: `1px solid ${primary ? "#b98a1f" : "#4a3f66"}`,
        borderRadius: "6px",
        padding: "8px 16px",
        fontFamily: "inherit",
        fontSize: "14px",
        cursor: "pointer",
      } satisfies Partial<CSSStyleDeclaration>);
      btn.addEventListener("click", onClick);
      row.appendChild(btn);
      return btn;
    };
    mkBtn("Back", false, backToTitle);
    mkBtn("Summon the GM", true, submit);
    panel.appendChild(row);

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
        new Graphics().rect(0, 0, DESIGN_W, DESIGN_H).fill(PAL.bgDeep),
      );
      const header = new Text({
        text: "Assemble your own alley",
        style: display(34, { fill: PAL.text }),
      });
      header.anchor.set(0.5, 0);
      header.position.set(DESIGN_W / 2, 52);
      view.addChild(header);

      stage = new Container();
      view.addChild(stage);

      hint = new Text({ text: "", style: ui(14, { fill: PAL.textDim }) });
      hint.anchor.set(0.5, 1);
      hint.position.set(DESIGN_W / 2, DESIGN_H - 16);
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
