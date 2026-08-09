#!/usr/bin/env node
// Bulk-import plugin-detected markers from a local Navidrome instance's media_marker table
// into this repo's data/ files — the missing link between the workstation's local-compute
// plugins (silence-marker, speech-music-marker) and the crowdsourced-lookup plugin that reads
// this repo back in production. See docs/architecture.md's "Production bug found + fixed" and
// "Phase 4" sections for the workstation-computes / production-reads-published-data split.
//
// For each track with at least one plugin-sourced marker: fingerprint it (fpcalc), resolve to
// an AcoustID UUID, and upsert its markers into data/<shard>/<uuid>.json — same file shape and
// merge logic as submit.js's manual single-marker path, just driven by a DB query instead of
// CLI args, so a track can pick up multiple markers (e.g. both lead and trail silence) in one
// pass.
//
// Manual markers (source: manual) and already-crowdsourced markers (source: crowdsourced:*)
// are deliberately skipped — the former belongs in submit.js's deliberate-entry flow, the
// latter would just be re-publishing what this repo already told the workstation.
//
// Usage:
//   ACOUSTID_API_KEY=xxx node scripts/import-from-navidrome.js \
//     --db ~/navidrome-scratch/nd-data/navidrome.db \
//     --music-folder ~/navidrome-scratch/podcasts-local \
//     [--dry-run]
//
// Requires `fpcalc` and `sqlite3` on PATH, and a free AcoustID API key.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { shardPath } = require("./lib/shard");
const { fingerprintFile, lookupAcoustId } = require("./lib/acoustid");
const { loadOrInitDoc, upsertMarker } = require("./lib/markerdoc");

const REPO_ROOT = path.resolve(__dirname, "..");

// AcoustID's free tier is rate-limited (roughly 3 req/s) — space lookups out rather than
// hammering it, since this can run against hundreds of tracks in one pass.
const LOOKUP_DELAY_MS = 400;

function parseArgs(argv) {
  const args = { "dry-run": false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function queryMarkers(dbPath) {
  const sql = `
    select mf.path as path, mf.duration as durationSec, mf.title as title,
           mm.kind as kind, mm.start_ms as startMs, mm.end_ms as endMs,
           mm.source as source, mm.confidence as confidence
    from media_marker mm
    join media_file mf on mf.id = mm.item_id
    where mm.item_type = 'media_file' and mm.source like 'plugin:%'
    order by mf.path, mm.kind, mm.start_ms;
  `;
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], { maxBuffer: 64 * 1024 * 1024 });
  const text = out.toString("utf8").trim();
  return text ? JSON.parse(text) : [];
}

function groupByTrack(rows) {
  const byPath = new Map();
  for (const row of rows) {
    if (!byPath.has(row.path)) byPath.set(row.path, { title: row.title, durationSec: row.durationSec, markers: [] });
    byPath.get(row.path).markers.push({
      kind: row.kind,
      start_ms: row.startMs,
      ...(row.endMs !== null && row.endMs !== undefined ? { end_ms: row.endMs } : {}),
      ...(row.confidence !== null && row.confidence !== undefined ? { confidence: row.confidence } : {}),
      source: row.source,
    });
  }
  return byPath;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const missing = ["db", "music-folder"].filter((k) => !(k in args));
  if (missing.length > 0) {
    console.error(`Missing required args: ${missing.map((m) => `--${m}`).join(", ")}`);
    console.error(
      "Usage: node scripts/import-from-navidrome.js --db <path> --music-folder <path> [--dry-run]"
    );
    process.exit(1);
  }

  const apiKey = process.env.ACOUSTID_API_KEY;
  if (!apiKey) {
    console.error("Set ACOUSTID_API_KEY (get a free key at https://acoustid.org/api-key).");
    process.exit(1);
  }

  const dbPath = path.resolve(args.db);
  const musicFolder = path.resolve(args["music-folder"]);
  const dryRun = args["dry-run"] === true;

  console.log(`Querying ${dbPath} for plugin-sourced markers ...`);
  const rows = queryMarkers(dbPath);
  const byTrack = groupByTrack(rows);
  console.log(`Found ${rows.length} marker(s) across ${byTrack.size} track(s).`);

  let written = 0;
  let skipped = 0;
  let i = 0;
  for (const [relPath, track] of byTrack) {
    i++;
    const filePath = path.join(musicFolder, relPath);
    process.stdout.write(`[${i}/${byTrack.size}] ${track.title || relPath} ... `);

    if (!fs.existsSync(filePath)) {
      console.log("SKIP (file not found on disk)");
      skipped++;
      continue;
    }

    try {
      const { fingerprint, durationSec } = await fingerprintFile(filePath);
      const acoustid = await lookupAcoustId(apiKey, fingerprint, durationSec);
      const relDataPath = shardPath(acoustid);
      const absDataPath = path.join(REPO_ROOT, relDataPath);
      const durationMs = Math.round(durationSec * 1000);

      const doc = loadOrInitDoc(absDataPath, acoustid, durationMs);
      for (const marker of track.markers) upsertMarker(doc, marker);

      if (dryRun) {
        console.log(`OK (dry-run) -> ${acoustid}, ${track.markers.length} marker(s)`);
      } else {
        fs.mkdirSync(path.dirname(absDataPath), { recursive: true });
        fs.writeFileSync(absDataPath, JSON.stringify(doc, null, 2) + "\n");
        console.log(`OK -> ${relDataPath} (${track.markers.length} marker(s))`);
      }
      written++;
    } catch (e) {
      console.log(`SKIP (${e.message})`);
      skipped++;
    }

    await sleep(LOOKUP_DELAY_MS);
  }

  console.log(`\nDone: ${written} track(s) written, ${skipped} skipped.`);
  if (!dryRun && written > 0) {
    console.log("Run scripts/validate.js and scripts/build-index.js, then review and git add/commit.");
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
