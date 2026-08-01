/**
 * dream-content — ask the deployed DM to author genuinely NEW content and
 * contribute it to the shared pool.
 *
 * Why this exists: the pool was seeded with generation zero, which mirrors ids
 * that already ship in `src/content`. Shipped content always wins an id, so a
 * "dreamed" row that reuses one is a shipped item wearing a chip — the pool was
 * wired but not yet true, and no row had `dm:` provenance, so the "dreamed by
 * another stray" credit had never rendered for a player.
 *
 * Each session asks for ONE piece, names the ids already taken so the model
 * cannot collide with shipped content, and lets the agent's own
 * `contribute_content` tool do the validating and the writing — so everything
 * that lands has passed the same lints a player's run would apply.
 *
 * Usage: node scripts/dream-content.mjs [count-per-kind]
 */
import { readFileSync, readdirSync } from "node:fs";

const BASE = process.env.DM_URL ?? "https://c-at-rpg-dm.vercel.app";
const PER_KIND = Number(process.argv[2] ?? 3);
const ROOT = new URL("..", import.meta.url).pathname;

/** Ids that already ship — the model must not reuse them. */
function shippedIds(file, re) {
  try {
    const src = readFileSync(`${ROOT}src/content/${file}`, "utf8");
    return [...src.matchAll(re)].map((m) => m[1]);
  } catch {
    return [];
  }
}
const taken = {
  item: [
    ...shippedIds("equipment.ts", /^ {2}([a-zA-Z][a-zA-Z0-9]*): \{/gm),
    ...shippedIds("consumables.ts", /^ {2}([a-zA-Z][a-zA-Z0-9]*): \{/gm),
  ],
  event: shippedIds("events.ts", /^ {2}([a-zA-Z][a-zA-Z0-9]*): \{/gm),
  enemy: shippedIds("enemies.ts", /^ {2}([a-zA-Z][a-zA-Z0-9]*): \{/gm),
};

const BRIEFS = [
  {
    kind: "item",
    floors: [1, 2, 3, 4, 5, 6],
    ask: (floor) =>
      `Author ONE brand-new piece of equipment for floor ${floor} of the dungeon and contribute it to the pool with your \`contribute_content\` tool (kind: "item").

It must be genuinely new — do NOT reuse any of these existing ids: ${taken.item.join(", ")}.

Give it a cat-scale, scavenged, faintly absurd identity in this world's voice (a bottle cap, a hair tie, a doll's crown, a laundromat token). Balance it for floor ${floor} against the shipped equipment budget. Include an iconPrompt describing ONLY the object — its shape, materials and wear — never style, camera or background.

Contribute it, then reply with one short line.`,
  },
  {
    kind: "event",
    floors: [1, 2, 3, 4, 5, 6],
    ask: (floor) =>
      `Author ONE brand-new narrative event for floor ${floor} and contribute it with \`contribute_content\` (kind: "event").

Genuinely new — do NOT reuse these ids: ${taken.event.join(", ")}.

Follow the shipped GameEvent shape: a title, 2-3 sentences of prompt, and 2-4 options with outcomes drawn from the bounded effect menu. At least one option should be a real gamble and one should be walking away. Keep the stakes small, domestic and strange — a dripping pipe, a locked cat flap, something under the floorboards that is politely waiting.

Contribute it, then reply with one short line.`,
  },
  {
    kind: "enemy",
    floors: [2, 3, 4, 5, 6],
    ask: (floor) =>
      `Author ONE brand-new enemy for floor ${floor} and contribute it with \`contribute_content\` (kind: "enemy").

Genuinely new — do NOT reuse these ids: ${taken.enemy.join(", ")}.

It lives under a city: vermin, appliance, bird, or something the building grew on its own. Give it a name, a one-line description with real menace, a "tell" describing how it telegraphs its next move, and a Stand if it deserves one. Balance it for floor ${floor}.

Contribute it, then reply with one short line.`,
  },
  {
    kind: "stand",
    floors: [1, 3, 5],
    ask: () =>
      `Author ONE brand-new Stand — a spectral patron for a stray cat — and contribute it with \`contribute_content\` (kind: "stand").

Give it a name in corner brackets, its nature in 1-2 sentences, and what it does for the cat bound to it, in this world's bounded vocabulary. Make it strange and specific: Stands here are born of obsession, not power fantasy.

Contribute it, then reply with one short line.`,
  },
];

async function dream(brief, floor, n) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: brief.ask(floor) }),
    });
    if (!r.ok) return { ok: false, why: `post ${r.status}` };
    const s = await r.json();
    const st = await fetch(`${BASE}/eve/v1/session/${s.sessionId}/stream?startIndex=0`);
    const rd = st.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let contributed = false;
    let failed = null;
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      let stop = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const d = ev.data ?? {};
        if (Array.isArray(d.actions)) {
          for (const a of d.actions) if (a?.toolName === "contribute_content") contributed = true;
        }
        if (ev.type === "turn.failed") { failed = d.code ?? "?"; stop = true; break; }
        if (ev.type === "turn.completed") { stop = true; break; }
      }
      if (stop) break;
    }
    const ms = Date.now() - t0;
    return { ok: contributed, why: failed ?? (contributed ? "contributed" : "no tool call"), ms };
  } catch (e) {
    return { ok: false, why: String(e).slice(0, 60) };
  }
}

const jobs = [];
for (const brief of BRIEFS) {
  for (const floor of brief.floors) {
    for (let n = 0; n < PER_KIND; n++) jobs.push({ brief, floor, n });
  }
}
console.log(`dreaming ${jobs.length} pieces against ${BASE}\n`);

let ok = 0;
const LANES = 4; // the agent is one deployment; do not stampede it
let cursor = 0;
async function lane(id) {
  for (;;) {
    const i = cursor++;
    if (i >= jobs.length) return;
    const { brief, floor } = jobs[i];
    const res = await dream(brief, floor, i);
    if (res.ok) ok++;
    console.log(
      `  [${String(i + 1).padStart(3)}/${jobs.length}] ${brief.kind.padEnd(6)} fl${floor}  ${res.ok ? "OK " : "-- "} ${res.why}${res.ms ? ` ${(res.ms / 1000).toFixed(1)}s` : ""}`,
    );
  }
}
await Promise.all(Array.from({ length: LANES }, (_, i) => lane(i)));
console.log(`\ncontributed ${ok}/${jobs.length}`);
