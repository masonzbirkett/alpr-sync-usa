// fetch-alprs.js  — nightly USA ALPR fetch (robust v2)
//
// Why this version exists:
//   The previous version hit Overpass with 50 heavy state queries spaced
//   only 800ms apart, then used 1.5s linear backoff on 429s. Overpass
//   responded by 429-rate-limiting all but the first 6-8 states. New
//   strategy:
//     1) Wait 8 seconds between successful states (Overpass docs recommend
//        ~one heavy query per slot per ~5s; 8s gives margin).
//     2) On 429, parse the Retry-After header and honor it. Don't retry
//        sooner than the server explicitly says we can.
//     3) Exponential backoff for non-429 failures.
//     4) Don't switch mirrors on 429 — both will rate-limit the same IP.
//        Just wait it out on the same mirror.
//     5) Fetch in shuffled order so a partial failure on retry day doesn't
//        always lose the same alphabetically-late states.
//
// Node 20+ (uses native fetch and AbortSignal.timeout)

import fs from "node:fs/promises";

// Single primary mirror. Overpass-api.de has the best uptime and rate
// limits. Kumi is a fallback for hard failures (5xx, network errors), NOT
// for 429 retries — switching mirrors on a 429 just spreads the rate-limit
// flag to both.
const PRIMARY_MIRROR = "https://overpass-api.de/api/interpreter";
const FALLBACK_MIRROR = "https://overpass.kumi.systems/api/interpreter";

// Tunables
const SLEEP_BETWEEN_STATES_MS = 8000;   // 8s between successful state fetches
const MAX_429_RETRIES = 5;              // give up after 5 rate-limit retries
const MAX_NON_429_RETRIES = 3;          // network/5xx retries
const HARD_BACKOFF_CAP_MS = 180_000;    // never wait more than 3 min for a single 429
const REQUEST_TIMEOUT_MS = 150_000;     // 2.5min — Overpass timeout in query is 120s

const STATES = JSON.parse(await fs.readFile("./states.json", "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build an Overpass query limited to a US state by name */
function overpassQueryForState(stateName) {
  return `
[out:json][timeout:120];
area
  ["name"="${stateName}"]
  ["boundary"="administrative"]
  ["admin_level"~"4|5"];
(
  node(area)["man_made"="surveillance"]["surveillance:type"="ALPR"];
  node(area)["man_made"="surveillance"]["camera:type"="ALPR"];
  node(area)["man_made"="surveillance"]["brand"="Flock Safety"];
);
out body; >; out skel qt;`;
}

/**
 * Fetch one state from Overpass, with proper rate-limit handling.
 * - On 429: read Retry-After header, sleep that long, try again on the
 *   SAME mirror (switching just spreads the block).
 * - On 5xx / network: brief retry on same mirror, then fall back to
 *   secondary mirror.
 * - On 4xx other than 429: throw immediately (likely query bug, not
 *   transient).
 */
async function fetchState(stateName) {
  const query = overpassQueryForState(stateName);
  const body = new URLSearchParams({ data: query }).toString();

  // First, try primary mirror with 429-aware retry loop
  let result = await tryMirror(PRIMARY_MIRROR, body, stateName);
  if (result.ok) return result.data;

  // Primary fully gave up — try the fallback ONCE for non-429 errors only.
  // We don't try fallback for 429 since rate limits track by IP across mirrors.
  if (!result.was429) {
    console.log(`  ↳ Primary failed (${result.error}); trying fallback mirror…`);
    result = await tryMirror(FALLBACK_MIRROR, body, stateName);
    if (result.ok) return result.data;
  }
  throw new Error(result.error);
}

async function tryMirror(url, body, stateName) {
  let was429 = false;
  let lastError = "unknown";

  for (let attempt = 1; attempt <= MAX_429_RETRIES + MAX_NON_429_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // Identify ourselves so admins can contact us if we're a problem
          "User-Agent": "alpr-sync-usa/1.0 (https://github.com/masonzbirkett/alpr-sync-usa)",
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        const data = await res.json();
        return { ok: true, data };
      }

      // Rate-limited: parse Retry-After (seconds OR HTTP-date)
      if (res.status === 429) {
        was429 = true;
        const ra = res.headers.get("retry-after");
        let waitMs;
        if (ra) {
          const asInt = parseInt(ra, 10);
          waitMs = isFinite(asInt)
            ? asInt * 1000
            : Math.max(0, new Date(ra).getTime() - Date.now());
        } else {
          // No Retry-After header. Use exponential backoff: 30s, 60s, 120s...
          waitMs = Math.min(30_000 * 2 ** (attempt - 1), HARD_BACKOFF_CAP_MS);
        }
        waitMs = Math.min(Math.max(waitMs, 5_000), HARD_BACKOFF_CAP_MS);
        console.log(`  ⏸  ${stateName}: 429 from ${hostOf(url)}, waiting ${Math.round(waitMs/1000)}s (attempt ${attempt})`);
        await sleep(waitMs);
        continue;
      }

      // Other non-OK: 4xx is likely a query problem, don't retry. 5xx is transient.
      lastError = `HTTP ${res.status} @ ${url}`;
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, error: lastError, was429 };
      }
      // 5xx — short backoff and try again on this mirror
      const backoff = Math.min(2000 * 2 ** (attempt - 1), 30_000);
      console.log(`  ⚠  ${stateName}: ${lastError}, retry in ${backoff/1000}s`);
      await sleep(backoff);
    } catch (e) {
      lastError = e.message || "network error";
      const backoff = Math.min(2000 * 2 ** (attempt - 1), 30_000);
      console.log(`  ⚠  ${stateName}: ${lastError}, retry in ${backoff/1000}s`);
      await sleep(backoff);
    }
  }

  return { ok: false, error: lastError, was429 };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

/** Convert Overpass JSON to GeoJSON Feature[] */
function toFeatures(osm, stateName) {
  const feats = [];
  for (const el of osm.elements || []) {
    if (el.type !== "node") continue;
    const t = el.tags || {};
    const direction =
      t.direction ?? t["camera:direction"] ?? t["surveillance:direction"] ?? null;

    feats.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [el.lon, el.lat] },
      properties: {
        id: el.id,
        state: stateName,
        brand: t.brand || null,
        operator: t.operator || null,
        direction,
        tags: t,
      },
    });
  }
  return feats;
}

async function writeGeoJSON(path, features) {
  const fc = {
    type: "FeatureCollection",
    features,
    meta: {
      generated_at: new Date().toISOString(),
      source: "OpenStreetMap (via Overpass)",
      license: "ODbL 1.0",
      attribution: "© OpenStreetMap contributors",
    },
  };
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(fc));
}

/**
 * Shuffle array — Fisher-Yates. We do this so that if the run dies
 * mid-list (CI timeout, etc), we don't always lose the same trailing
 * states. Over many nightly runs each state gets equal chance.
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  await fs.mkdir("./public/usa", { recursive: true });

  // Load any existing index so we know what we had before this run.
  // Used at the end to preserve files for states we couldn't refetch today.
  let priorIndex = { states: [] };
  try {
    priorIndex = JSON.parse(await fs.readFile("./public/index.json", "utf8"));
  } catch {/* first run, no prior */}
  const priorByState = Object.fromEntries(priorIndex.states?.map(s => [s.state, s]) || []);

  const index = [];
  // Fetch in shuffled order so failures don't always concentrate on the
  // alphabetically-late states
  const order = shuffle(STATES);

  for (let i = 0; i < order.length; i++) {
    const state = order[i];
    console.log(`[${i + 1}/${order.length}] ${state}`);
    try {
      const osm = await fetchState(state);
      const feats = toFeatures(osm, state);

      // de-dup by OSM node id
      const seen = new Set();
      const dedup = [];
      for (const f of feats) {
        if (seen.has(f.properties.id)) continue;
        seen.add(f.properties.id);
        dedup.push(f);
      }

      const fileName = `usa/${state.replaceAll(" ", "_")}.json`;
      await writeGeoJSON(`./public/${fileName}`, dedup);
      console.log(`  ✓ ${dedup.length} features → public/${fileName}`);

      index.push({ state, file: fileName, count: dedup.length, ok: true });
    } catch (e) {
      // Today's fetch failed — but if we had data from a prior run, KEEP IT.
      // Stale data is much better than no data, especially for the user's
      // home state. Mark it as stale in the index so the client can show
      // a warning if it wants to.
      const prior = priorByState[state];
      if (prior?.ok && prior.file) {
        console.warn(`  ✗ ${state} failed (${e.message}); keeping prior data`);
        index.push({
          state,
          file: prior.file,
          count: prior.count,
          ok: true,
          stale: true,
          last_success: prior.last_success || priorIndex.generated_at,
          last_error: e.message,
        });
      } else {
        console.warn(`  ✗ ${state} failed (${e.message}); no prior data`);
        index.push({ state, file: null, count: null, ok: false, error: e.message });
      }
    }

    // Pace ourselves between states. Skip the wait after the last one.
    if (i < order.length - 1) {
      await sleep(SLEEP_BETWEEN_STATES_MS);
    }
  }

  // Sort the index alphabetically before writing so the published file
  // is stable / diffable in git
  index.sort((a, b) => a.state.localeCompare(b.state));

  await fs.writeFile(
    "./public/index.json",
    JSON.stringify({
      generated_at: new Date().toISOString(),
      states: index,
    }, null, 2)  // pretty-print so PR diffs are readable
  );

  const okCount = index.filter(s => s.ok).length;
  const freshCount = index.filter(s => s.ok && !s.stale).length;
  console.log(`\nDone. ${okCount}/${index.length} states have data (${freshCount} fresh, ${okCount - freshCount} stale).`);
}

// Don't exit(1) on top-level errors — we still want partial data published
main().catch((err) => {
  console.error("Unexpected error:", err);
});

