// Shared per-track marker document read/merge logic (data/<shard>/<uuid>.json), used by both
// submit.js (manual single-marker entry) and import-from-navidrome.js (bulk plugin import).
const fs = require("fs");

function loadOrInitDoc(absPath, acoustid, durationMs) {
  if (fs.existsSync(absPath)) {
    const doc = JSON.parse(fs.readFileSync(absPath, "utf8"));
    if (doc.acoustid !== acoustid) {
      throw new Error(`existing file at ${absPath} has acoustid ${doc.acoustid}, expected ${acoustid}`);
    }
    return doc;
  }
  return { acoustid, duration_ms: durationMs, schema_version: 1, markers: [] };
}

// Upserts by (kind, start_ms) — a re-run (re-fingerprinting the same track, or re-importing
// after a fresh workstation scan) overwrites its own previous entry rather than duplicating it.
function upsertMarker(doc, marker) {
  const idx = doc.markers.findIndex((m) => m.kind === marker.kind && m.start_ms === marker.start_ms);
  if (idx >= 0) {
    doc.markers[idx] = marker;
  } else {
    doc.markers.push(marker);
  }
  doc.markers.sort((a, b) => a.kind.localeCompare(b.kind) || a.start_ms - b.start_ms);
}

module.exports = { loadOrInitDoc, upsertMarker };
