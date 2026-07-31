/**
 * Service worker (docs/design/mobile.md §5 "PWA").
 *
 * The game is offline-first BY DESIGN already — every rule, every table and
 * every sprite ships with the bundle, and the only network call in the whole
 * app is the optional DM (which fails soft into a DM-less game). So this file
 * is packaging, not architecture: it makes the thing installable and makes the
 * second launch instant.
 *
 * Three strategies, chosen per request kind:
 *
 *  • navigation  → network-first, falling back to the cached shell. A new
 *    deploy is picked up on the first online launch; a plane is still playable.
 *  • asset manifests (`/assets/gen/**\/manifest.json`) → stale-while-revalidate.
 *    They are the index the sprite loader reads at boot (src/ui/sprites.ts), so
 *    they must be present offline and fresh online.
 *  • everything else same-origin → cache-first. Vite fingerprints its JS/CSS,
 *    and the generated art is immutable, so a cached hit is always correct.
 *
 * Cross-origin requests (the deployed DM) are never touched: an intercepted
 * auth'd POST that fell back to a stale cache would be a correctness bug.
 *
 * ── Why every match passes `ignoreVary` ──────────────────────────────────
 * Static hosts (including `vite preview`) commonly answer assets with
 * `Vary: Origin`. A response stored under a plain `cache.add(url)` was
 * fetched WITHOUT an Origin header, while the page's own module script —
 * `<script type="module" crossorigin>` — sends one. Honouring Vary makes
 * those two requests different keys, the cache misses, and the app is
 * mysteriously not offline-capable at all. The URLs here are fingerprinted
 * and immutable, so Origin cannot change what the bytes are.
 */

const VERSION = "catrpg-v1";
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

/**
 * The precache. Deliberately small: the shell plus the two asset manifests
 * the sprite loader cannot boot without. The 30-odd MB of generated art is
 * left to the runtime cache, so installing the app does not cost a download
 * of every backdrop in the game before the first frame.
 */
const PRECACHE = [
  "/",
  "/index.html",
  "/style.css",
  "/favicon.png",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/assets/gen/manifest.json",
  "/assets/gen/scenes/manifest.json",
];

const isManifest = (url) => url.pathname.endsWith("/manifest.json");

/**
 * The bundle's OWN entry points, read out of index.html at install time.
 *
 * Vite fingerprints its JS and CSS (`/assets/index-C0b60etH.js`), so this
 * file cannot name them — and the very first visit fetches them BEFORE the
 * worker activates, which means they land in no cache at all and the first
 * offline reload gets a blank page. Parsing the shell we just cached fixes
 * that without a build step or a generated asset list.
 */
async function entryPoints(cache) {
  try {
    const res = await cache.match("/index.html");
    if (!res) return [];
    const html = await res.text();
    const urls = new Set();
    for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      urls.add(m[1]);
    }
    return [...urls];
  } catch {
    return [];
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // One-by-one: a single 404 (a manifest an art pass has not produced
      // yet) must not fail the whole install and leave the app uncached.
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {}),
        ),
      );
      await Promise.all(
        (await entryPoints(cache)).map((url) => cache.add(url).catch(() => {})),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL && k !== RUNTIME)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") {
    void self.skipWaiting();
    return;
  }
  /*
   * "warm": the page telling us what it ACTUALLY needed to boot.
   *
   * index.html only names the entry chunk; the renderer, the font and the
   * first screen's art arrive through dynamic `import()` and `Assets.load`,
   * which no static list can predict. So after the first successful boot the
   * page hands us `performance.getEntriesByType('resource')` and we cache
   * exactly that — the real dependency set, no build step, no guessing.
   */
  if (event.data && event.data.type === "warm") {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(RUNTIME);
        await Promise.all(
          (event.data.urls ?? []).map(async (url) => {
            if (await cache.match(url, { ignoreVary: true })) return;
            await cache.add(url).catch(() => {});
          }),
        );
      })(),
    );
  }
});

/** Cache a response only when it is one worth replaying. */
const cacheable = (res) =>
  res && res.status === 200 && res.type !== "opaqueredirect";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never intercept the DM (or anything else off-origin): a stale or offline
  // answer to an authenticated call is worse than an honest failure.
  if (url.origin !== self.location.origin) return;
  // The dev server's own plumbing must reach Vite untouched.
  if (url.pathname.startsWith("/@") || url.pathname.startsWith("/node_modules"))
    return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (cacheable(fresh)) {
            const cache = await caches.open(SHELL);
            void cache.put("/index.html", fresh.clone());
          }
          return fresh;
        } catch {
          const cached =
            (await caches.match("/index.html", { ignoreVary: true })) ||
            (await caches.match("/", { ignoreVary: true }));
          if (cached) return cached;
          throw new Error("offline and no cached shell");
        }
      })(),
    );
    return;
  }

  if (isManifest(url)) {
    // stale-while-revalidate: boot from the cached index instantly, then
    // quietly pick up a manifest an art pass added.
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        const cached = await cache.match(req, { ignoreVary: true });
        const network = fetch(req)
          .then((res) => {
            if (cacheable(res)) void cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        const fresh = cached ? null : await network;
        if (cached) void network;
        const out = cached ?? fresh;
        if (out) return out;
        throw new Error("manifest unavailable");
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req, { ignoreVary: true });
      if (cached) return cached;
      const res = await fetch(req);
      if (cacheable(res)) {
        const cache = await caches.open(RUNTIME);
        void cache.put(req, res.clone());
      }
      return res;
    })(),
  );
});
