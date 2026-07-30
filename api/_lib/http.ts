/**
 * Small web-standard Request/Response helpers shared by the /api/gm/*
 * functions (Vercel Node runtime, web handler signature).
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
