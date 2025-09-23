// Robust transform: accepts many raw shapes & fields, outputs clean Point features.
// Fails loudly if zero features would be written.
import fs from "node:fs/promises";

const SRC = "data/raw_deflock.geojson";
const DST = "data/cameras.geojson";

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const propsOf = o => (o && typeof o === "object" ? (o.properties ?? o) : {});
const dirFromNorth = (p={}) => {
  for (const k of ["dir","direction","bearing","heading","azimuth","angle","yaw"]) {
    const v = num(p[k]); if (v !== null) return ((v % 360) + 360) % 360;
  }
  return 0;
};

function readCoords(obj){
  const g = obj?.geometry;
  if (g?.type==="Point" && Array.isArray(g.coordinates) && g.coordinates.length>=2) return g.coordinates.slice(0,2);
  const p = propsOf(obj);
  let lng = num(p.lng ?? p.lon ?? p.long ?? p.longitude ?? p.x);
  let lat = num(p.lat ?? p.latitude ?? p.y);
  if (lng!==null && lat!==null) return [lng,lat];
  const c = p.coordinates ?? p.coord ?? p.location ?? p.loc ?? p.pos;
  if (Array.isArray(c) && c.length>=2){
    const a=num(c[0]), b=num(c[1]); if (a!==null && b!==null) return [a,b];
  }
  if (typeof c==="object" && c){
    lng = num(c.lng ?? c.lon ?? c.long ?? c.longitude ?? c.x);
    lat = num(c.lat ?? c.latitude ?? c.y);
    if (lng!==null && lat!==null) return [lng,lat];
  }
  if (typeof c==="string"){
    const m=c.match(/-?\d+(\.\d+)?/g);
    if (m && m.length>=2){
      const a=num(m[0]), b=num(m[1]); if (a!==null && b!==null) return [a,b];
    }
  }
  return null;
}

const txt = await fs.readFile(SRC,"utf-8");
let raw;
try { raw = JSON.parse(txt); }
catch { raw = txt.split(/\r?\n/).map(s=>{try{return JSON.parse(s)}catch{return null}}).filter(Boolean); }

let items = Array.isArray(raw) ? raw : (raw?.features ?? raw?.records ?? raw?.data ?? raw?.items ?? []);
if (!Array.isArray(items)) items = [];

const features = [];
for (let i=0;i<items.length;i++){
  const it = items[i];
  const p = propsOf(it);
  let coords = readCoords(it);
  if (!coords) continue;
  let [x,y] = coords;
  // fix lat/lng swapped
  if (Math.abs(x) <= 90 && Math.abs(y) > 90) [x,y] = [y,x];
  if (!(Math.abs(x) <= 180 && Math.abs(y) <= 90)) continue;

  features.push({
    type:"Feature",
    geometry:{ type:"Point", coordinates:[x,y] },
    properties:{
      id: p.id ?? p.camera_id ?? p.cam_id ?? `cam_${String(i).padStart(6,"0")}`,
      type: p.type ?? "flock",
      dir: dirFromNorth(p),
      last_seen: p.last_seen ?? p.updated_at ?? p.timestamp ?? p.seen_at ?? ""
    }
  });
}

if (!features.length) {
  console.error("Transform produced 0 features. Check the RAW file format/fields.");
  process.exit(1);
}

await fs.mkdir("data",{recursive:true});
await fs.writeFile(DST, JSON.stringify({type:"FeatureCollection",features}));
console.log(`Wrote ${DST} with ${features.length} points from ${items.length} raw records`);
