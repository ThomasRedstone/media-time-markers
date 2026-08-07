#!/usr/bin/env node
// Fingerprint a local audio file, resolve it to an AcoustID UUID, and
// write/update its marker file under data/. Doesn't touch git — review and
// commit the result yourself.
//
// Usage:
//   ACOUSTID_API_KEY=xxx node scripts/submit.js \
//     --file ~/Music/track.flac \
//     --kind skip/lead_silence --start 0 --end 1800 \
//     [--label "fades in over the first bar"] [--source manual]
//
// Requires `fpcalc` (from the chromaprint-tools / libchromaprint package) on
// PATH, and a free API key from https://acoustid.org/api-key.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { shardPath } = require("./lib/shard");

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {};
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

async function fingerprintFile(filePath) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("fpcalc", ["-json", filePath]));
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(
        "fpcalc not found on PATH. Install chromaprint tools (e.g. `apt install libchromaprint-tools`) first."
      );
    }
    throw new Error(`fpcalc failed: ${e.message}`);
  }
  const parsed = JSON.parse(stdout);
  return { fingerprint: parsed.fingerprint, durationSec: parsed.duration };
}

async function lookupAcoustId(apiKey, fingerprint, durationSec) {
  const url = new URL("https://api.acoustid.org/v2/lookup");
  url.searchParams.set("client", apiKey);
  url.searchParams.set("meta", "recordingids");
  url.searchParams.set("duration", String(Math.round(durationSec)));
  url.searchParams.set("fingerprint", fingerprint);

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`AcoustID lookup HTTP ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (body.status !== "ok") {
    throw new Error(`AcoustID lookup error: ${JSON.stringify(body)}`);
  }
  if (!body.results || body.results.length === 0) {
    throw new Error(
      "No AcoustID match for this file. It may not be in AcoustID's database yet " +
        "(submit it at https://acoustid.org/submit first), or the fingerprint is too short/noisy to match."
    );
  }
  // Highest-scoring result wins.
  const best = body.results.reduce((a, b) => (b.score > (a?.score ?? -1) ? b : a), null);
  return best.id;
}

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

function upsertMarker(doc, marker) {
  const idx = doc.markers.findIndex((m) => m.kind === marker.kind && m.start_ms === marker.start_ms);
  if (idx >= 0) {
    doc.markers[idx] = marker;
  } else {
    doc.markers.push(marker);
  }
  doc.markers.sort((a, b) => a.kind.localeCompare(b.kind) || a.start_ms - b.start_ms);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ["file", "kind", "start"];
  const missing = required.filter((k) => !(k in args));
  if (missing.length > 0) {
    console.error(`Missing required args: ${missing.map((m) => `--${m}`).join(", ")}`);
    console.error(
      "Usage: node scripts/submit.js --file <path> --kind <ns/name> --start <ms> [--end <ms>] [--label <text>] [--source <text>]"
    );
    process.exit(1);
  }

  const apiKey = process.env.ACOUSTID_API_KEY;
  if (!apiKey) {
    console.error("Set ACOUSTID_API_KEY (get a free key at https://acoustid.org/api-key).");
    process.exit(1);
  }

  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`No such file: ${filePath}`);
    process.exit(1);
  }

  console.log(`Fingerprinting ${filePath} ...`);
  const { fingerprint, durationSec } = await fingerprintFile(filePath);

  console.log("Looking up AcoustID ...");
  const acoustid = await lookupAcoustId(apiKey, fingerprint, durationSec);
  console.log(`AcoustID: ${acoustid}`);

  const relPath = shardPath(acoustid);
  const absPath = path.join(REPO_ROOT, relPath);
  const durationMs = Math.round(durationSec * 1000);

  const doc = loadOrInitDoc(absPath, acoustid, durationMs);

  const marker = { kind: args.kind, start_ms: parseInt(args.start, 10) };
  if (args.end !== undefined) marker.end_ms = parseInt(args.end, 10);
  if (args.label) marker.label = String(args.label);
  marker.source = args.source ? String(args.source) : "manual";

  upsertMarker(doc, marker);

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(doc, null, 2) + "\n");
  console.log(`Wrote ${relPath}`);
  console.log("Run scripts/validate.js and scripts/build-index.js, then git add/commit.");
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
