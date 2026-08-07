#!/usr/bin/env node
// Validate every file under data/ against schema/marker.schema.json plus the
// cross-field and path-convention checks JSON Schema alone can't express.
//
// Usage: node scripts/validate.js [file ...]
//   No args: validate everything under data/.
//   Args: validate just those files (used by CI on a PR diff, but the plain
//   version here always does a full sweep unless given explicit paths).

const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const { shardPath } = require("./lib/shard");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "schema", "marker.schema.json");
const DATA_DIR = path.join(REPO_ROOT, "data");

function listDataFiles() {
  const out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
    }
  }
  walk(DATA_DIR);
  return out;
}

function checkOne(ajvValidate, absPath) {
  const errors = [];
  const relPath = path.relative(REPO_ROOT, absPath).replace(/\\/g, "/");

  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (e) {
    return [`${relPath}: cannot read file: ${e.message}`];
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return [`${relPath}: invalid JSON: ${e.message}`];
  }

  if (!ajvValidate(doc)) {
    for (const err of ajvValidate.errors) {
      errors.push(`${relPath}: schema: ${err.instancePath || "/"} ${err.message}`);
    }
    // Cross-field checks assume schema-valid shape, so bail early if it's not.
    return errors;
  }

  // Path must match the sharding convention derived from the file's own acoustid.
  let expectedRel;
  try {
    expectedRel = shardPath(doc.acoustid);
  } catch (e) {
    errors.push(`${relPath}: ${e.message}`);
    expectedRel = null;
  }
  if (expectedRel && expectedRel !== relPath) {
    errors.push(`${relPath}: expected at ${expectedRel} per sharding convention, found here instead`);
  }

  // Cross-field sanity per marker.
  doc.markers.forEach((m, i) => {
    const where = `${relPath}: markers[${i}] (${m.kind})`;
    if (m.start_ms > doc.duration_ms) {
      errors.push(`${where}: start_ms (${m.start_ms}) exceeds duration_ms (${doc.duration_ms})`);
    }
    if (m.end_ms !== undefined) {
      if (m.end_ms <= m.start_ms) {
        errors.push(`${where}: end_ms (${m.end_ms}) must be greater than start_ms (${m.start_ms})`);
      }
      if (m.end_ms > doc.duration_ms) {
        errors.push(`${where}: end_ms (${m.end_ms}) exceeds duration_ms (${doc.duration_ms})`);
      }
    }
  });

  return errors;
}

function main() {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv({ allErrors: true });
  const validateFn = ajv.compile(schema);

  const argFiles = process.argv.slice(2);
  const files = argFiles.length > 0 ? argFiles.map((f) => path.resolve(f)) : listDataFiles();

  let allErrors = [];
  for (const f of files) {
    allErrors = allErrors.concat(checkOne(validateFn, f));
  }

  if (allErrors.length > 0) {
    console.error(`${allErrors.length} problem(s) found:\n`);
    for (const e of allErrors) console.error(`  ${e}`);
    process.exit(1);
  }

  console.log(`OK: ${files.length} marker file(s) validated.`);
}

main();
