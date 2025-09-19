import fs from "node:fs/promises";

const SRC = "data/raw_deflock.geojson";
const DST = "data/cameras.geojson";

const raw = JSON.parse(await fs.readFile(SRC, "utf-8"));

function normDir(p = {}) {
  for (const k of ["dir","direction","bearing","heading","azimuth","angle"]) {
    if (k in p) {
      const v = Number(p[k]);
      if (!Number.isNaN(v)) return ((v % 360) + 360) % 360;
    }
  }
  return 0; // default north if missing
}

const features = (raw.features || [])
  .filter(f => f?.geometry?.type === "Point")
  .map((f, i) => ({
    type: "Feature",
    geometry: f.geometry, // [lng,lat]
    properties: {
      id: f.properties?.id ?? `cam_${String(i).padStart(6,"0")}`,
      type: f.properties?.type ?? "flock",
      last_seen: f.properties?.last_seen ?? f.properties?.updated_at ?? "",
      dir: normDir(f.properties)
    }
  }));

await fs.mkdir("data", { recursive: true });
await fs.writeFile(DST, JSON.stringify({ type:"FeatureCollection", features }));
console.log(`Wrote ${DST} with ${features.length} points`);
