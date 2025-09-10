// fetch-alprs.js  — nightly USA ALPR fetch (robust)
// Node 18+ (uses native fetch). Recommended Node 20.
import fs from "node:fs/promises";

// Reliable Overpass mirrors (removed the flaky private.coffee host)
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Read state list (lower 48 + AK, HI + DC)
const STATES = JSON.parse(await fs.readFile("./states.json", "utf8"));

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

/** POST to Overpass with retries across mirrors (does NOT throw the whole run) */
async function postOverpassWithRetry(query, attemptsPerMirror = 2) {
  let lastErr;
  for (const url of OVERPASS_URLS) {
    for (let attempt = 1; attempt <= attemptsPerMirror; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: query }).toString(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
        // Linear backoff before next try/mirror
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw lastErr;
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

/** Write a FeatureCollection to disk at path */
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

async function main() {
  await fs.mkdir("./public/usa", { recursive: true });

  const index = [];

  for (const state of STATES) {
    try {
      console.log(`Fetching ${state}…`);
      const osm = await postOverpassWithRetry(overpassQueryForState(state));
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
      console.log(`  → ${dedup.length} features → public/${fileName}`);

      index.push({ state, file: fileName, count: dedup.length, ok: true });
    } catch (e) {
      // Don’t kill the whole run; record and continue
      console.warn(`Skipping ${state} — ${e.message}`);
      index.push({ state, file: null, count: null, ok: false, error: e.message });
    }

    // Be kind to Overpass
    await new Promise((r) => setTimeout(r, 800));
  }

  await fs.writeFile(
    "./public/index.json",
    JSON.stringify({
      generated_at: new Date().toISOString(),
      states: index,
    })
  );
  console.log("Wrote index → public/index.json");
}

// IMPORTANT: do not exit(1) on error — still publish what we got
main().catch((err) => {
  console.error("Unexpected error:", err);
});


