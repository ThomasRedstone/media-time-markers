// Shared fpcalc + AcoustID lookup logic, used by both submit.js (manual single-marker entry)
// and import-from-navidrome.js (bulk import of plugin-detected markers).
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

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

module.exports = { fingerprintFile, lookupAcoustId };
