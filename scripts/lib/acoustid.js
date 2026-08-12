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

// Thrown by lookupAcoustId specifically when AcoustID has no fingerprint on file at all —
// distinct from network/API errors, so callers (e.g. import-from-navidrome.js's --submit-missing
// mode) can react to "not in the database yet" differently from "something went wrong."
class NoMatchError extends Error {}

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
    throw new NoMatchError(
      "No AcoustID match for this file. It may not be in AcoustID's database yet " +
        "(submit it at https://acoustid.org/submit first), or the fingerprint is too short/noisy to match."
    );
  }
  // Highest-scoring result wins.
  const best = body.results.reduce((a, b) => (b.score > (a?.score ?? -1) ? b : a), null);
  return best.id;
}

// Submits a fingerprint to AcoustID's shared database so future lookups (by anyone, not just
// us) can match it — distinct from lookupAcoustId, which only reads. Requires a *personal* user
// API key (from an AcoustID account's own page), not the application key: AcoustID ties
// contributions to an individual account, separate from the per-app key used for lookups.
// Submissions are queued and processed asynchronously on AcoustID's end — a submitted
// fingerprint typically isn't matchable via lookupAcoustId for a while (hours to days), not
// immediately. Metadata (track/artist/album) is optional but improves moderation/match quality.
async function submitFingerprint(appApiKey, userApiKey, fingerprint, durationSec, meta = {}) {
  const body = new URLSearchParams({
    client: appApiKey,
    user: userApiKey,
    duration: String(Math.round(durationSec)),
    fingerprint,
  });
  if (meta.track) body.set("track", meta.track);
  if (meta.artist) body.set("artist", meta.artist);
  if (meta.album) body.set("album", meta.album);

  const res = await fetch("https://api.acoustid.org/v2/submit", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`AcoustID submit HTTP ${res.status}: ${await res.text()}`);
  }
  const parsed = await res.json();
  if (parsed.status !== "ok") {
    throw new Error(`AcoustID submit error: ${JSON.stringify(parsed)}`);
  }
  const submission = parsed.submissions?.[0];
  return { id: submission?.id, status: submission?.status };
}

module.exports = { fingerprintFile, lookupAcoustId, submitFingerprint, NoMatchError };
