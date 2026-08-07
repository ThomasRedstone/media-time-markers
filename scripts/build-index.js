#!/usr/bin/env node
// Regenerate index/markers-index.json: a flat, sorted list of every AcoustID
// UUID that has a marker file. A bulk consumer (e.g. a library scanner) pulls
// this once per scan cycle rather than querying per-track.

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const INDEX_PATH = path.join(REPO_ROOT, "index", "markers-index.json");

function listAcoustIds() {
  const ids = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        ids.push(entry.name.replace(/\.json$/, ""));
      }
    }
  }
  walk(DATA_DIR);
  ids.sort();
  return ids;
}

function main() {
  const ids = listAcoustIds();
  const index = {
    schema_version: 1,
    generated_at: process.env.BUILD_INDEX_TIMESTAMP || null, // set by CI; avoids nondeterministic local diffs
    count: ids.length,
    acoustids: ids,
  };
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
  console.log(`Wrote ${INDEX_PATH} with ${ids.length} entries.`);
}

main();
