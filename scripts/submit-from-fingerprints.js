#!/usr/bin/env node
// Companion to import-from-navidrome.js for the case where fpcalc already ran somewhere else
// (e.g. directly on the server, against files this machine doesn't have local copies of) and
// only the fingerprint JSON was copied back. Looks each one up against AcoustID; anything with
// no existing match gets submitted (--submit-missing requires ACOUSTID_USER_API_KEY, same as
// import-from-navidrome.js).
//
// Doesn't touch data/ — this is purely about contributing fingerprints to AcoustID so a later
// run of import-from-navidrome.js (or the crowdsourced-lookup plugin itself) can match them.
//
// Input shape: --paths-file is a plain text file, one file path per line (index N == line N,
// 0-based). --fp-dir contains one <NNNNN>.json per line (fpcalc's own -json output, e.g.
// 00000.json for line 0) — see docs/architecture.md's "Phase 4" workstation-cleanup note for
// why this two-file split exists (fpcalc must run where the audio lives; this script doesn't
// need the audio at all, just fpcalc's output).
//
// Usage:
//   ACOUSTID_API_KEY=xxx ACOUSTID_USER_API_KEY=yyy node scripts/submit-from-fingerprints.js \
//     --paths-file /tmp/podcast-fp/paths.txt --fp-dir /tmp/podcast-fp/fp --submit-missing
//     [--dry-run]

const fs = require("fs");
const path = require("path");
const { lookupAcoustId, submitFingerprint, NoMatchError } = require("./lib/acoustid");

const LOOKUP_DELAY_MS = 400;

function parseArgs(argv) {
  const args = { "dry-run": false, "submit-missing": false };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const missing = ["paths-file", "fp-dir"].filter((k) => !(k in args));
  if (missing.length > 0) {
    console.error(`Missing required args: ${missing.map((m) => `--${m}`).join(", ")}`);
    console.error(
      "Usage: node scripts/submit-from-fingerprints.js --paths-file <path> --fp-dir <path> [--submit-missing] [--dry-run]"
    );
    process.exit(1);
  }

  const apiKey = process.env.ACOUSTID_API_KEY;
  if (!apiKey) {
    console.error("Set ACOUSTID_API_KEY (get a free key at https://acoustid.org/api-key).");
    process.exit(1);
  }

  const submitMissing = args["submit-missing"] === true;
  const userApiKey = process.env.ACOUSTID_USER_API_KEY;
  if (submitMissing && !userApiKey) {
    console.error(
      "--submit-missing requires ACOUSTID_USER_API_KEY (a personal key from your AcoustID account page, distinct from ACOUSTID_API_KEY)."
    );
    process.exit(1);
  }

  const dryRun = args["dry-run"] === true;
  const paths = fs
    .readFileSync(path.resolve(args["paths-file"]), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  console.log(`Loaded ${paths.length} path(s). Looking up against AcoustID ...`);

  let matched = 0;
  let submitted = 0;
  let skipped = 0;

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const fpFile = path.join(path.resolve(args["fp-dir"]), `${String(i).padStart(5, "0")}.json`);
    process.stdout.write(`[${i + 1}/${paths.length}] ${path.basename(p)} ... `);

    if (!fs.existsSync(fpFile)) {
      console.log("SKIP (no fingerprint file — fpcalc likely failed on this track)");
      skipped++;
      continue;
    }

    let fingerprint, durationSec;
    try {
      const parsed = JSON.parse(fs.readFileSync(fpFile, "utf8"));
      fingerprint = parsed.fingerprint;
      durationSec = parsed.duration;
      if (!fingerprint || !durationSec) throw new Error("missing fingerprint/duration in fpcalc output");
    } catch (e) {
      console.log(`SKIP (bad fingerprint file: ${e.message})`);
      skipped++;
      continue;
    }

    try {
      const acoustid = await lookupAcoustId(apiKey, fingerprint, durationSec);
      console.log(`MATCH -> ${acoustid} (already in AcoustID, nothing to submit)`);
      matched++;
    } catch (e) {
      if (e instanceof NoMatchError && submitMissing) {
        if (dryRun) {
          console.log("SUBMIT (dry-run, no match)");
        } else {
          const result = await submitFingerprint(apiKey, userApiKey, fingerprint, durationSec, {
            track: path.basename(p, path.extname(p)),
          });
          console.log(`SUBMITTED (id=${result.id}, status=${result.status})`);
        }
        submitted++;
      } else if (e instanceof NoMatchError) {
        console.log("SKIP (no match, not submitting — pass --submit-missing to contribute it)");
        skipped++;
      } else {
        console.log(`SKIP (${e.message})`);
        skipped++;
      }
    }

    await sleep(LOOKUP_DELAY_MS);
  }

  console.log(`\nDone: ${matched} already matched, ${submitted} submitted, ${skipped} skipped.`);
  if (!dryRun && submitted > 0) {
    console.log(
      "Submitted tracks aren't matchable yet — re-run import-from-navidrome.js in a while to pick them up once AcoustID processes them."
    );
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
