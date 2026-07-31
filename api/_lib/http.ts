/**
 * Small web-standard Request/Response helpers shared by the /api/gm/*
 * functions.
 *
 * The handlers themselves are written against the web standard (Request in,
 * Response out) — that is what the unit tests drive them with. Vercel's Node
 * runtime, however, invokes the default export with Node's
 * (IncomingMessage, ServerResponse) pair, so every route's default export is
 * wrapped in `vercelHandler` below, which accepts EITHER calling convention.
 */

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorJson(message: string, status: number): Response {
  return json({ error: message }, status);
}

/** Parsed JSON body or null (never throws). */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return (await req.json()) as unknown;
  } catch {
    return null;
  }
}

/** 405 for anything but POST, else null. */
export function requirePost(req: Request): Response | null {
  if (req.method !== "POST") return errorJson("POST only", 405);
  return null;
}

/* ------------------------------------------------------------------------ */
/* Per-IP rate limiting (best-effort, per warm lambda instance)              */
/* ------------------------------------------------------------------------ */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, number[]>();

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/* ------------------------------------------------------------------------ */
/* Node <-> web handler adapter (Vercel Node runtime)                        */
/* ------------------------------------------------------------------------ */

/** The web-standard handler shape every /api/gm/* route implements. */
export type WebHandler = (req: Request) => Promise<Response>;

/** The slice of Node's IncomingMessage the adapter needs. */
interface NodeRequestLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
}

/** The slice of Node's ServerResponse the adapter needs. */
interface NodeResponseLike {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (chunk?: string) => void;
}

/** Duck-type: a web Request exposes Headers (with .get), Node's does not. */
function isWebRequest(req: unknown): req is Request {
  const h = (req as { headers?: { get?: unknown } } | null)?.headers;
  return typeof h?.get === "function";
}

function nodeHeaders(req: NodeRequestLike): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function nodeBody(req: NodeRequestLike): Promise<string> {
  if (typeof req[Symbol.asyncIterator] !== "function") return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of req as AsyncIterable<Uint8Array>)
    chunks.push(chunk);
  if (chunks.length === 0) return "";
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Build a web Request from Node's request object. */
async function toWebRequest(req: NodeRequestLike): Promise<Request> {
  const headers = nodeHeaders(req);
  const host = headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto") ?? "https";
  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`${proto}://${host}${req.url ?? "/"}`, {
    method,
    headers,
    body: hasBody ? await nodeBody(req) : undefined,
  });
}

/** Write a web Response back onto Node's response object. */
async function writeWebResponse(
  res: NodeResponseLike,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  res.end(await response.text());
}

/**
 * Wrap a web-standard handler so it survives BOTH calling conventions:
 * Vercel's Node runtime `(IncomingMessage, ServerResponse)` and a direct
 * `(Request) => Response` call (unit tests, edge runtimes).
 *
 * Also the last line of defence for the client's offline-first contract: a
 * throw anywhere below (most commonly missing gateway credentials, which make
 * the Anthropic constructor throw) becomes a clean JSON error response instead
 * of a FUNCTION_INVOCATION_FAILED crash, so the game falls back to static
 * content immediately rather than waiting out a timeout.
 */
export function vercelHandler(
  web: WebHandler,
): (req: unknown, res?: unknown) => Promise<Response | void> {
  return async (req: unknown, res?: unknown) => {
    if (isWebRequest(req) && res === undefined) {
      try {
        return await web(req);
      } catch {
        return errorJson("gm unavailable", 503);
      }
    }
    const nodeRes = res as NodeResponseLike;
    try {
      const request = await toWebRequest(req as NodeRequestLike);
      await writeWebResponse(nodeRes, await web(request));
    } catch {
      await writeWebResponse(nodeRes, errorJson("gm unavailable", 503));
    }
  };
}

/** Returns a 429 Response when over budget, else null. */
export function rateLimit(req: Request): Response | null {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return errorJson("rate limited", 429);
  }
  recent.push(now);
  hits.set(ip, recent);
  return null;
}
