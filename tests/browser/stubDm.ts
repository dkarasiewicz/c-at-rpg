/**
 * A local stand-in for the deployed DM, for the FINAL GATE playtest only.
 *
 * WHY THIS EXISTS. The typed-action affordance (`[T]`, the tabletop card) is
 * built ONLY when `probeDm()` resolves true — that is the offline-first rule
 * working as designed. So a playtest that must exercise "typed action" needs
 * a DM that answers. The deployed one cannot be it: its CORS allow-list is
 * the deployed GAME origin, so `/eve/v1/info` from `http://localhost:5199`
 * is unreadable by a browser (see boss-playtest.ts). Pointing at it would
 * test nothing but a CORS failure.
 *
 * So this speaks the four routes of the eve HTTP surface that
 * `src/services/dm.ts` actually calls, with permissive CORS and canned
 * verdicts that are DELIBERATELY INSIDE the caps in `services/tabletop.ts`.
 * It is a transport double, not a model: it proves the client's plumbing,
 * the card, the streaming and the verdict application all work end to end.
 * It cannot and does not prove anything about the real model's judgement.
 *
 * Everything is deterministic, so a run driven through it is reproducible.
 */
import { createServer, type Server } from "node:http";

/** Events one turn streams back, in eve's NDJSON shape. */
function turnEvents(result: unknown, prose: string): string {
  const lines = [
    {
      type: "message.appended",
      data: { messageDelta: prose, messageSoFar: prose },
    },
    { type: "message.completed", data: { message: prose } },
    { type: "result.completed", data: { result } },
    { type: "session.waiting", data: { continuationToken: "stub-cont" } },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/**
 * The canned answer for a turn, chosen off the prompt text.
 *
 * A combat verdict is the interesting one: `allowed`, a narration, and ONE
 * effect that must survive `validateCombatVerdict` — a damage pct under the
 * floor cap and a total inside `improvBudgetCap`. 8% of max HP on the named
 * target is comfortably under every floor's cap, so the same answer is legal
 * on floor 1 and floor 6 and the gate never depends on where it fires.
 */
function answerFor(message: string): { result: unknown; prose: string } {
  const inCombat = message.includes("acting cat");
  if (inCombat) {
    return {
      prose: "The lantern swings. Dust comes down in a sheet.",
      result: {
        allowed: true,
        narration:
          "You kick the hanging lantern into the nearest shape. It reels, " +
          "spitting sparks, and the dark closes back over it.",
        energyCost: 1,
        target: null,
        effects: [{ kind: "damage", pct: 8 }],
      },
    };
  }
  // Out of combat: allowed, narrated, no mechanical consequence at all —
  // the "saying no gently" answer, which is the one the design calls the
  // legitimate default.
  return {
    prose: "You look. There is not much here that wants looking at.",
    result: {
      allowed: true,
      narration:
        "You put your paw to the damp stone and listen. Water, somewhere " +
        "below. Nothing answers.",
      effects: [],
    },
  };
}

export interface StubDm {
  url: string;
  /** Every turn message the client sent, in order. */
  turns: string[];
  close: () => Promise<void>;
}

export async function startStubDm(port = 5601): Promise<StubDm> {
  const turns: string[] = [];
  let n = 0;
  /** sessionId → the events queued by its most recent POST. */
  const pending = new Map<string, string>();

  const server: Server = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    // the probe — JSON, and readable cross-origin
    if (path === "/eve/v1/info") {
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ name: "stub-dm", agents: ["dm"] }));
      return;
    }

    // the durable stream for a session
    const streamed = /^\/eve\/v1\/session\/([^/]+)\/stream$/.exec(path);
    if (streamed && req.method === "GET") {
      const id = decodeURIComponent(streamed[1]);
      res.writeHead(200, { ...cors, "content-type": "application/x-ndjson" });
      res.end(pending.get(id) ?? "");
      pending.delete(id);
      return;
    }

    // start a session, or take a turn on one
    const onSession = /^\/eve\/v1\/session(?:\/([^/]+))?$/.exec(path);
    if (onSession && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += String(c)));
      req.on("end", () => {
        let message = "";
        try {
          const body: unknown = JSON.parse(raw || "{}");
          if (body && typeof body === "object" && "message" in body) {
            message = String((body as { message: unknown }).message);
          }
        } catch {
          /* an unparseable body still gets a session; the client lints */
        }
        turns.push(message);
        const id = onSession[1] ? decodeURIComponent(onSession[1]) : `s${++n}`;
        const { result, prose } = answerFor(message);
        pending.set(id, turnEvents(result, prose));
        res.writeHead(200, { ...cors, "content-type": "application/json" });
        res.end(
          JSON.stringify({ sessionId: id, continuationToken: "stub-cont" }),
        );
      });
      return;
    }

    res.writeHead(404, cors);
    res.end("no");
  });

  // A previous run that was killed rather than closed can still be holding
  // the port; walk up rather than dying on EADDRINUSE.
  const bound = await new Promise<number>((resolve, reject) => {
    let p = port;
    const tryPort = (): void => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && p < port + 20) {
          p += 1;
          tryPort();
        } else reject(e);
      });
      server.listen(p, () => resolve(p));
    };
    tryPort();
  });
  return {
    url: `http://127.0.0.1:${bound}`,
    turns,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
