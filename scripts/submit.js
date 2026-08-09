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
const { shardPath } = require("./lib/shard");
const { fingerprintFile, lookupAcoustId } = require("./lib/acoustid");
const { loadOrInitDoc, upsertMarker } = require("./lib/markerdoc");

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
