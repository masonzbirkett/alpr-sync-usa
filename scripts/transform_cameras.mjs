// Robust transform: accepts many raw shapes & fields, outputs clean Point features
import fs from "node:fs/promises";
import path from "node:path";

const CANDIDATES = [
  "data/raw_deflock.geojson",
  "data/raw_deflock.json",
  "data/deflock.raw.json",
  "data/flock_raw.json"
];

// pick the first raw file that exists
let SRC = null;
for (const p of CANDIDATES) {
  try { await fs.access(p); SRC = p; break; } catch {}
}
if (!SRC) {
  throw new Error(`No raw input found. Expected one of:\n${CANDIDATES.map(p=>" - "+p).join("\n")}`);
}
const DST = "data/cameras.geojson";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const fromNorth0 = (p = {}) => {
  for (const k of ["dir","direction","bearing","heading","azimuth","angle","yaw"]) {
    const v = num(p[k]);
    if (v !== null) return ((v % 360) + 360) % 360;
  }
  return 0;
};
const propsOf = (o) => (o && typeof o === "object" ? (o.properties ?? o) : {});

// parse JSON or NDJSON
async function loadRaw(file) {
  const text = await fs.readFile(file, "utf-8");
  try {
    return JSON.parse(text);
  } catch {
    // NDJSON fallback
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const arr = [];
    for (const ln of lines) {
      try { arr.push(JSON.parse(ln)); } catch {}
    }
    return arr;
  }
}

// extract [lng,lat] from many layouts
function readCoords(obj) {
  const g = obj?.geometry;
  if (g?.type === "Point" && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
    return g.coordinates.slice(0, 2);
  }
  const p = propsOf(obj);

  // common fields
  let lng = num(p.lng ?? p.lon ?? p.long ?? p.longitude ?? p.x);
  let lat = num(p.lat ?? p.latitude ?? p.y);
  if (lng !== null && lat !== null) return [lng, lat];

  // nested containers
  const c = p.coordinates ?? p.coord ?? p.location ?? p.loc ?? p.pos;
  if (Array.isArray(c) && c.length >= 2) {
    const a = num(c[0]), b = num(c[1]);
    if (a !== null && b !== null) return [a, b];
  }
  if (typeof c === "object" && c) {
    lng = num(c.lng ?? c.lon ?? c.long ?? c.longitude ?? c.x);
    lat = num(c.lat ?? c.latitude ?? c.y);
    if (lng !== null && lat !== null) return [lng, lat];
  }
  if (typeof c === "string") {
    const m = c.match(/-?\d+(\.\d+)?/g);
    if (m && m.length >= 2) {
      const a = num(m[0]), b = num(m[1]);
      if (a !== null && b !== null) return [a, b];
    }
  }
  return null;
}

const raw = await loadRaw(SRC);

// normalize top-level shapes
let items = Array.isArray(raw)
  ? raw
  : raw?.features ?? raw?.records ?? raw?.data ?? raw?.items ?? raw?.results ?? [];

if (!Array.isArray(items)) items = [];

const features = [];
for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const p = propsOf(it);

  let coords = readCoords(it);
  if (!coords) continue;

  // fix [lat,lng] accidentally swapped
  let [x, y] = coords;
  if (Math.abs(x) <= 90 && Math.abs(y) > 90) [x, y] = [y, x];
  if (!(Math.abs(x) <= 180 && Math.abs(y) <= 90)) continue;

  features.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: [x, y] },
    properties: {
      id: p.id ?? p.camera_id ?? p.cam_id ?? `cam_${String(i).padStart(6,"0")}`,
      type: p.type ?? "flock",
      dir: fromNorth0(p),
      last_seen: p.last_seen ?? p.updated_at ?? p.timestamp ?? p.seen_at ?? ""
    }
  });
}

await fs.mkdir(path.dirname(DST), { recursive: true });
await fs.writeFile(DST, JSON.stringify({ type: "FeatureCollection", features }));
console.log(`SRC: ${SRC}`);
console.log(`Wrote ${DST} with ${features.length} points from ${items.length} raw records`);
