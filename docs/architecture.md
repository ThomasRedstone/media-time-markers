# Spec: native Navidrome support for track skip-markers (intro speech + lead/trail silence)

Status: pre-implementation, personal-fork-first. No upstream discussion opened yet — see "Sequencing" below.

## Problem

Two related annoyances, one mechanism:
- Spoken introductions on tracks (podcasts, some live albums, DJ mixes).
- Leading/trailing silence, notably around hidden tracks (navidrome/navidrome#2082).

Both are "skip this span of a track" facts. Design one schema and one API for both rather than
two bespoke features.

## Plugin route — revisited

Originally ruled out: Navidrome's WASM plugins (metadata agents, scrobblers, websocket
integrations) can't add API endpoints, can't modify Subsonic responses, and can't store
arbitrary data queryable by another client's `getSong` call. True, and still true — a plugin
alone doesn't reach the goal.

But the fix isn't "abandon plugins," it's "give plugins one small, generic, reusable hook into
core." That's a much better shape than a single bespoke feature:

- **Core** gets a small, generic addition: a new plugin capability interface
  (`MediaMarkerProvider`, sibling to the existing metadata-agent interface) plus storage and
  response surfacing.
- **Plugin(s)** carry all the actual feature logic: fingerprinting, crowdsourced lookup, local
  silence detection. None of that needs to live in core, and none of it needs a core PR to
  iterate on.

This also produces a better pitch to maintainers later: not "add my one feature" but "add one
generic extension point," the same leverage `playbackReport` (PR #5442) had.

## Data model — corrected: global, not per-user

Earlier draft rode this on Navidrome's per-user annotation table (same place `userRating` lives).
That's wrong. A skip marker isn't an opinion like a star rating — it's the same span for every
listener on the server (even if that span is occasionally contested — see "confidence" below).
It belongs in its own table, keyed at the track level, not `(user_id, item_id)`.

```
media_marker
  id
  item_id
  item_type        -- 'media_file' (room to extend later)
  kind              -- 'intro_speech' | 'lead_silence' | 'trail_silence' | 'outro_speech'
  start_ms
  end_ms
  source            -- 'manual' | 'plugin:<name>' | 'crowdsourced:<repo>'
  confidence         -- nullable; provenance for anything auto-detected or community-sourced
  created_at / updated_at
```

One row per marker, multiple markers per track allowed (a track can have both lead silence and
a spoken intro, as distinct spans).

## Core surface (small, on purpose)

1. `media_marker` table (above).
2. `MediaMarkerProvider` plugin interface — pull model, invoked by core the same way metadata
   agents already are (on scan, given track + tags + AcoustID fingerprint if computed) — not a
   repurposing of the metadata-agent interface, a new sibling to it.
3. Markers surfaced additively on `getSong`/`getAlbum`/etc., advertised via
   `getOpenSubsonicExtensions` — same additive pattern `userRating` already uses, same template
   `playbackReport` set.
4. One plain CRUD endpoint for manual create/correct/delete against `media_marker` — needed
   regardless of whether any provider plugin is installed, and doesn't fit the plugin config UX
   (a user isn't going to "configure a plugin" to type in an offset). No per-user complexity now
   that the table isn't per-user.

Everything else — detection, lookup, opinions about where an intro *really* ends — stays out of
core.

## Plugin(s) — where the actual logic lives

- **Local silence detection**: ffmpeg `silencedetect`, no network, no fingerprinting. Directly
  addresses #2082 with no dependency on anything crowdsourced.
- **Crowdsourced lookup** (see below): `fpcalc` → AcoustID lookup API → resolve to AcoustID UUID
  → query the marker repo → return matches to core via `MediaMarkerProvider`.
- Both are ordinary `MediaMarkerProvider` implementations; a user can run either, both, or
  neither. Manual correction (core CRUD endpoint) always works regardless.

## Crowdsourced marker repo — separate project, not Navidrome-core, not v1-blocking

No existing open database fits: AcoustID/AcousticBrainz do identity and acoustic descriptors,
not time-coded segments; MusicBrainz has no in-track span concept; SponsorBlock is the right
shape but keyed by YouTube video ID, useless for local/ripped files. Nothing to plug into —
this would be a new, small, deliberately low-tech project:

- **Key**: AcoustID UUID (resolved server-side via `fpcalc` + AcoustID lookup), not the raw
  Chromaprint fingerprint (not stable across encodes) and not ISRC/MBID alone (tag-dependent,
  often missing/wrong, and doesn't distinguish masters/pressings that can have genuinely
  different lead-in silence).
- **Hosting**: a GitHub repo, sharded JSON per AcoustID UUID (`data/ab/cd/<uuid>.json`), served
  through jsDelivr's GitHub CDN mirror (free, cached, CORS-enabled, tag-pinnable) rather than
  raw GitHub Pages. CORS is moot for Navidrome's own scan-time fetch anyway (server-side Go, not
  browser JS) — only matters if a browser client ever queries it directly.
- **Writes**: PRs against the repo, not a write API. A GitHub Action validates schema + sanity
  (offsets within track duration, no overlaps) and can auto-merge on pass. This is the whole
  moderation layer — GitHub's own account/abuse heuristics apply for free, versus SponsorBlock's
  much heavier from-scratch reputation system for its open write API.
- **Read path**: bulk sync, not per-track queries. A library scan touches thousands of tracks;
  publish a lightweight index (sorted list or bloom filter of covered UUIDs, regenerated per
  merge) for clients to pull once per scan cycle, then fetch full per-UUID JSON only for local
  matches. Mirrors why SponsorBlock itself publishes a full DB dump for bulk consumers alongside
  its live single-lookup API.
- Each marker record carries `votes`/provenance, because "where the intro really ends" is
  sometimes genuinely contested (fade-in vs. true silence, cold open vs. spoken intro) — the
  server-side value is a current best answer, not a claim of objective truth.

Explicitly **not v1**. Ship local detection + manual entry first; only build this once the
schema's proven against real files.

## Client-side migration plan (this app)

Unchanged in spirit from the original draft — the engine-level seam is why this swap is
contained rather than sprinkled through QML call sites:

1. On login/ping, check `getOpenSubsonicExtensions` for the marker capability.
2. If present: read/write through the native endpoint. On first sight of it, migrate any
   existing `sonic-player:intro-skip-tagged` bookmarks through the new endpoint, then
   `deleteBookmark` each one — don't leave stale entries behind.
3. If absent: keep today's bookmark-overload path exactly as-is
   (`sync::set_intro_skip_mark` / `sync::fetch_intro_skip_marks`) — this is why those methods
   exist as a seam rather than being inlined into call sites.

## Sequencing — build first, discuss later

Originally planned to open a maintainer discussion before writing Go. Reversed: no interest in
sitting on an issue thread for weeks before starting. New order:

1. Build against a **personal fork** now: `media_marker` table, `MediaMarkerProvider`
   interface, CRUD endpoint, OpenSubsonic extension, client-side migration — prove the schema
   and API shape against real files and real listening (including where "intro speech" actually
   ends, which won't be obvious until it's built).
2. Build the local-silence-detection plugin first (no external dependency, directly answers
   #2082). Crowdsourced-repo plugin is optional/later, and can stay purely local (no PRs opened
   anywhere) for as long as useful.
3. Once the shape has been lived with for a while, open the upstream discussion — with a working
   reference implementation attached rather than a proposal in the abstract. Stronger pitch than
   the original plan, and doesn't block starting.
4. If upstream doesn't want it, the personal fork carrying schema + interface + endpoint diff is
   still small and stays viable indefinitely.

## Phase 3a build notes (2026-08-08) — WASM plugins can't shell out to ffmpeg

The build brief's Phase 3a plan ("wraps `ffmpeg -af silencedetect`, zero dependencies") was
**wrong as written**: Navidrome's WASM plugins run in a pure sandbox (Extism/Wazero) with no
subprocess/exec capability at all — confirmed by reading `plugins/README.md`'s security section
and grepping the whole `plugins/host/` tree for anything exec-shaped. A plugin cannot spawn
`ffmpeg`, or any other binary, under any permission.

Resolved (user's explicit direction, see the three options weighed: new host function vs.
pure-WASM audio decode vs. defer) by adding a new **`SilenceDetect` host function** —
`plugins/host/silencedetect.go` in navidrome/navidrome — that runs ffmpeg server-side on the
plugin's behalf, mirroring how `Artwork`/`Library` host functions already do server-side work
plugins can't do themselves. The plugin supplies a library ID + library-relative path (never a
host filesystem path); the host resolves and jails it the same way the WASM filesystem mount
does (`filepath.IsLocal` escape check). Gated by a new `silencedetect` manifest permission that
requires `library` with `filesystem: true` declared alongside it.

This is worth remembering as a standing constraint for any future plugin idea in this project:
**if a plugin needs to do real audio/media processing (decode, transcode, fingerprint, analyze),
it needs a purpose-built host function — it cannot shell out, and pure-WASM decoding is a much
bigger lift than it sounds** (TinyGo's stdlib/cgo limits rule out most existing decoders). The
crowdsourced-lookup plugin (Phase 3b) is unaffected — it only needs outbound HTTP (already
covered by the existing `http` host service) plus, eventually, audio fingerprinting, which will
hit this same constraint and need its own host function or a bundled fingerprinting library that
actually compiles under TinyGo/wasip1.

## Phase 3b build notes (2026-08-08) — crowdsourced-lookup plugin built and live-verified

`plugins/examples/media-time-markers-lookup` in navidrome/navidrome implements the read side of
this design: fingerprint (new `Fingerprint` host function, same server-side-ffmpeg-style shape
as `SilenceDetect`) → AcoustID lookup → fetch `data/<uuid[0:2]>/<uuid[2:4]>/<uuid>.json` via
jsDelivr → map to markers. Matches this doc's schema and read-path shape exactly (per-UUID file
layout, jsDelivr as the CDN, `source: crowdsourced:<repo>` provenance convention).

Initially only mock-verified — no AcoustID API key was available in-session, and this repo was
still private (jsDelivr only mirrors public repos). Both were resolved same-day: repo made
public (user approved), user supplied a real AcoustID key. Ran the full chain for real: real
`fpcalc` fingerprint of the actual Chevelle track → real AcoustID API call (returned
`5a6b2f12-2f76-4184-a089-68b53a30e6ee` at 0.98 confidence — the exact UUID already on file) →
real jsDelivr fetch → the exact `skip/lead_silence` marker came back. Verified via direct
protocol calls (curl, matching exactly what the plugin's Go code constructs) rather than running
the compiled plugin with the live key, to keep the key off disk/build artifacts entirely.

**Deferred by design, not by omission**: the bulk-index-sync read path this doc describes above
("Read path: bulk sync, not per-track queries") isn't built yet — v1 does a fingerprint+lookup+
fetch per track, every time. Worth revisiting once real scan-time usage shows whether the extra
per-track round-trips actually matter at library scale; the host `Cache` service is the natural
place to hold a fetched index between calls if/when it does.

## Phase 2 build notes (2026-08-08) — resolved while implementing against navidrome/navidrome

Core (migration → model → persistence → plugin capability → scan invocation → CRUD endpoint →
extension → additive response fields) is built and tested on branch `feat/media-markers`. A few
things this spec left open got resolved during the build; recording them here rather than
letting them live only in commit messages:

- **No AcoustID/Chromaprint fingerprinting exists anywhere in core's scan pipeline.** Confirmed
  by searching the scanner package before wiring up invocation. Fingerprinting (for the
  crowdsourced-lookup plugin, Phase 3b) is entirely a plugin-side concern — core has nothing to
  supply and doesn't need to change to support it.
- **Every installed `MediaMarkerProvider` plugin runs and contributes its markers** — this is
  NOT a first-match-wins priority list like metadata agent lookup. A local silence-detector and
  a crowdsourced-lookup plugin can find genuinely complementary markers on the same track (one's
  silence spans, the other's spoken-intro spans), so both should be allowed to contribute. There
  is no enable/priority config yet (unlike `conf.Server.Agents`/`LyricsPriority`) — installing a
  plugin with this capability is what opts a server in, matching how WebSocket/Scheduler
  callback plugins run automatically for every installed plugin with that capability. Worth
  revisiting if a real conflict between two providers' markers ever actually happens.
- **Scan-time invocation happens after `persistChanges`' write transaction commits**, not inside
  it — a track's DB-assigned ID isn't set until `mediaFileRepository.Put` runs inside that
  transaction, and plugin calls (potentially slow WASM invocations) shouldn't run inside a held
  -open write transaction anyway. A track's previous plugin-sourced markers are cleared before
  writing fresh ones on each scan that touches it, so re-scanning a re-tagged file doesn't
  accumulate duplicate rows; manually-entered markers (`source: manual`) are never touched by
  this.
- **The manual CRUD endpoint** is `getMediaMarkers` (any authenticated user) plus
  `create`/`update`/`deleteMediaMarker` (admin only — the table is global, not per-user).
  `updateMediaMarker` always stamps `source: manual` on save: once a human corrects a marker,
  it's a manual entry regardless of where it originally came from.
- **Additive response fields landed on `getSong` and `getAlbum`/`getMusicDirectory`** (the two
  the brief named explicitly), via a `MediaMarkers` field on `OpenSubsonicChild` populated by one
  batched query per response (not per-song) to avoid an N+1 on album song lists. Extending the
  same helper to search/playlists/bookmarks/nowPlaying song lists is straightforward and
  deliberately deferred rather than done as a first pass everywhere.

Nothing here argues the core data model (`media_marker` table shape, global-not-per-user,
`kind` as an open namespaced string) was wrong — it held up. What was underspecified was mostly
the *invocation* side (when/how often plugins run, how multiple providers combine), now resolved
above.

## Production bug found + fixed (2026-08-08) — plugins never actually ran during real scans

Discovered while trying to capture real marker data on the workstation against pulled podcast
audio: after a full local end-to-end setup (plugin enabled, scan triggered), `media_marker`
stayed empty. Root cause took a debug-print trace through `core/mediamarkers.GetMarkers` down to
`scanner.CallScan` to find:

- `conf.Server.DevExternalScanner` **defaults to `true`**, meaning `scanner/external.go`'s
  `scannerExternal.scan()` re-execs the binary as `<exe> scan --nobanner --subprocess ...` for
  **every** real scan trigger — startup, the filesystem watcher, HTTP-triggered (`startScan`),
  scheduled. This is not a CLI-only code path; it's the universal production scan path.
- That subprocess is handled by `cmd/scan.go`'s `runScanner()`, which was hardcoding
  `scanner.CallScan(..., mediamarkers.New(nil), ...)` — a literal nil plugin loader. So
  `MediaMarkerProvider` plugins ran only when a test called `scanner.New(...)` directly, which
  nothing in production does.

Fixed by threading a real `mediamarkers.MediaMarkers` through `CallScan` and having
`runScanner()` build one from a real, started `plugins.Manager` when `conf.Server.Plugins.Enabled`
is true. That hit a second, subtler issue on the way: `plugins.Manager.Start()` **hard-requires**
a `SubsonicRouter` to have been set via `SetSubsonicRouter()` first (SubsonicAPI host functions
call back into it) — the log message when it's missing misleadingly says `"Plugin manager
requires DataStore to be configured"`, which cost real debugging time chasing the wrong field.
The only place that wires a router is the wire-generated `GetPluginManager(ctx)` helper
(`cmd/wire_injectors.go`), which also calls `CreateSubsonicAPIRouter(ctx)` — so despite the
original design intent of keeping the scan subprocess a *lightweight* process (per
`scanner/external.go`'s own doc comment), there's no way to get a plugin-manager that can
actually `Start()` without also pulling in the Subsonic router construction. That's an accepted
cost, not a bug to re-litigate: building the router doesn't bind a network port, it just adds to
the subprocess's in-memory dependency graph.

**Standing lesson for this project**: a plugin capability being correctly wired in
`cmd/wire_injectors.go`/`allProviders` is necessary but not sufficient — always verify a new
scan-time hook actually fires against a *real* triggered scan (HTTP `startScan` or the watcher),
not just a direct `scanner.New(...)` call in a test or a manual CLI `navidrome scan` invocation.
Verified the fix by rebuilding, wiping the local scratch DB, enabling `silence-marker`, and
confirming real `media_marker` rows appeared after an HTTP-triggered full scan over ~166 real
podcast tracks (157/166 got at least one marker via genuine `ffmpeg silencedetect` output).

## Phase 4 build notes (2026-08-09) — speech/music discrimination (`SpeechMusicDetect`)

Added a fourth host function, `SpeechMusicDetect`, following the same shape as `SilenceDetect`/
`Fingerprint` — but a different kind of external dependency. ffmpeg and `fpcalc` are each a
single binary; [inaSpeechSegmenter](https://github.com/ina-foss/inaSpeechSegmenter) is a
Python/TensorFlow package, so the host wraps a **configured Python interpreter**
(`InaSpeechPythonPath` / `ND_INASPEECHPYTHONPATH`) rather than a PATH-discovered binary — there's
deliberately no fallback default, since a bare `python3` almost never has it installed and
running against the wrong interpreter would fail deep inside a Python traceback instead of a
clear "not configured" error.

Two build gotchas worth remembering for any future subprocess-wrapped Python tool in this
project:
- **Keras writes its own progress lines directly to file descriptor 1** during
  `model.predict()`, regardless of `verbose` settings on some versions — redirecting
  `sys.stdout` in Python doesn't catch this, since it's a raw fd write. The embedded
  `segment.py` helper redirects fd 1 itself (`os.dup2` to `os.devnull`) around the
  classification call and restores it before printing the JSON result, so the Go side's
  `cmd.Output()` (which only captures stdout) sees pure JSON.
- **Model downloads happen transparently on first use per venv** (inaSpeechSegmenter fetches its
  CNN weights from GitHub releases the first time `Segmenter()` runs), not at `pip install` time
  — first real classification call after a fresh venv install is slower and needs outbound
  network access once.

The `speech-music-marker` example plugin turns the leading/trailing run of speech segments
around a track's music into `skip/intro_speech` / `skip/outro_speech` — both kinds were already
reserved in `KINDS.md` before this plugin existed, so no schema doc change was needed. It only
emits a marker when the track has a `music` segment at all (a talk-only episode has nothing to
skip into/out of) and only when the leading/trailing run actually contains a speech segment (a
leading `noise`/`noEnergy` run with no speech is `silence-marker`'s job, not double-marked here).

Verified end-to-end in the same local scratch setup as the production-bug fix above, against two
real podcast tracks: a mostly-spoken episode correctly got `skip/outro_speech` for its trailing
speech run after a brief music burst (and correctly got *no* intro marker — its leading segment
was classified `noise`, not speech); a pure-music track got neither marker, as expected.

## Phase 4 addendum (2026-08-12) — talk-over-a-beat was invisible; Demucs vocal separation fixes it

Running `speech-music-marker` at real production scale (249 real podcast tracks, not 2 sample
tracks) surfaced two real problems in sequence, both now fixed:

**1. 100% timeout failure rate at scale.** `SpeechMusicDetect` calls the classifier over a
track's *entire* duration; the host function's 30s call timeout was never going to survive a
20-70 minute episode, and every single one of 242 real invocations failed with "context deadline
exceeded". Fixed by bounding classification to just the leading/trailing `WINDOW_SEC` (150s) of
each track via `ffmpeg`-extracted clips — this plugin only ever cares about the edges anyway.
Re-verified clean: 0/249 timeouts on a full rescan.

**2. Talk-over-a-beat is invisible to both the classifier and a dedicated VAD model.** Once the
timeout was fixed, coverage was still suspiciously low — the user's own listening confirmed most
"silent" workout-mix episodes actually do have a spoken intro, just delivered *over* a continuous
beat from second one, not in a clean silence→speech→music sequence. Verified directly: on a real
track with known spoken content, inaSpeechSegmenter's frame-level output in that region was
statistically indistinguishable from pure music (same mean/p90/p99 as a control region with no
speech at all). Swapping in [Silero VAD][silero] (ONNX, no Python subprocess — a much faster,
architecturally cleaner alternative that was explored specifically to sidestep this) didn't help
either: same result, near-zero voice probability throughout the same known-speech region, even
though the underlying audio unambiguously had substantial energy there (confirmed via raw RMS).
Classical harmonic-percussive source separation (`librosa.effects.hpss`) didn't help either — a
beat's bass/synth content is plenty harmonic, so HPSS doesn't cleanly separate "voice" from "beat"
the way genre-specific source separation does.

**The fix**: running the track through [Demucs][demucs] (`--two-stems=vocals`) *before*
classification. Verified directly: the isolated vocal stem's RMS energy jumps from ~0.0005
(nearly silent) to ~0.15-0.30 exactly where a human listener confirms the talking starts — a
clean, unambiguous signal once the beat is removed. Demucs runs at roughly 5-6x realtime on CPU,
which dominates the per-call cost (a 150s window takes ~30s for Demucs alone, versus
inaSpeechSegmenter's own ~15-20s) — so the plugin's manifest now declares `timeoutSeconds: 150`
(a new, generally-available manifest field — see `plugins/README.md`) rather than trying to claw
back time elsewhere.

**A second, more subtle bug fell out of combining these two fixes**: `speech-music-marker`'s
original marker logic found the "intro"/"outro" boundary by searching the *combined* lead+trail
segment list for a `music`-labeled segment. That assumption silently broke once both fixes
landed together — windowing means the combined list has two disjoint time ranges, not one
continuous timeline, and vocal-isolated audio essentially never produces a `music` label at all
(there's no music left in an isolated vocal stem to classify). Caught before it shipped broken:
manually traced through a real track's output and found the bug would have produced a
`skip/intro_speech` marker spanning from 0ms to 3,793,689ms — nearly the entire 63-minute track.
Fixed by tagging each segment with which window it came from (`lead`/`trail`, a new field on the
host response) and having the plugin process each window's segments independently, never
crossing between them. Re-verified against the same track: the marker now correctly reads
0-119,060ms, bounded by the window, not the bug's near-full-track span.

**Standing lesson for this project**: verify at real production scale before trusting a "looks
right" 2-track smoke test — both the timeout failure and the talk-over-a-beat blindness were
completely invisible in this session's earlier 2-track verification, and only showed up against
the real 249-track library. A synthetic or hand-picked test set can hide exactly the failure
modes that matter.

[silero]: https://github.com/snakers4/silero-vad
[demucs]: https://github.com/facebookresearch/demucs

## Sources

Navidrome plugin docs · Plugin capabilities · getBookmarks entry-shape bug #1099 ·
playbackReport extension PR #5442 · silence-skip feature request #2082 · Jellyfin intro-skipper
· AcoustID / AcousticBrainz · MusicBrainz · SponsorBlock (incl. SponsorBlock for Spotify) ·
custom tags docs (ruled out — scanner-imported file metadata, not client-authored runtime state)
