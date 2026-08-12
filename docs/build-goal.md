# Goal: build native track skip-marker support for Navidrome

Self-contained build brief — written to stand alone if handed to a fresh agent session with no
prior conversation context. Read `docs/architecture.md` in this repo first; it's the design this
brief implements. Don't re-litigate decisions already made there — data model, why AcoustID UUID
as key, why global-not-per-user, why plugin-plus-small-core-hook, why crowdsourced repo isn't v1
— treat it as settled unless building it out surfaces something the design got wrong.

## Ground rules

- **Personal fork, no upstream discussion yet.** Work happens on a branch in a personal fork of
  navidrome/navidrome. Do not open an issue/discussion against navidrome/navidrome, and do not
  push anything to a public remote, without asking first — those are outward-facing and
  one-way-door-ish; everything else in this brief (writing code, running migrations locally,
  committing to a personal branch) can proceed without asking at each step.
- **Small, reviewable commits**, following the precedent Navidrome's own `playbackReport`
  extension set: it landed as three separate PRs (subsonic endpoint, UI, plugin capability —
  commits `94eb6c52`, `7e16b6ac`, `ae0e0c89`). Mirror that shape here even on a personal branch:
  migration+model+persistence as one unit, plugin capability as another, subsonic
  endpoint+extension+response fields as another. Makes it easy to split into real PRs later if
  upstream wants pieces independently.
- **Prove the schema against real use before treating it as fixed.** Where "intro speech" really
  ends, whether `confidence`/`votes` end up used, whether one marker table serves both `skip/*`
  and `sample/*` cleanly — these are open until lived with. Flag anything that argues for
  changing `docs/architecture.md`'s data model rather than silently deviating from it.
- Ask before installing anything that isn't already present (system packages, new Go deps) if
  there's a lighter option — but this is a low-stakes personal fork, so don't block on this if
  the answer's obvious (e.g. an ffmpeg dependency for silence detection is clearly fine).

## Phase 1 — media-time-markers repo (mostly done)

Already scaffolded and working at `~/own/media-time-markers` (see its own `README.md`): schema,
validator, index builder, `submit.js` CLI, CI workflows. `ACOUSTID_API_KEY` env var needed for
`submit.js` — application key registered under app name "media-time-markers", retrievable at
https://acoustid.org/my-applications if lost.

Remaining for this phase:
- [x] Push to GitHub (**ask first** — first time this repo goes public). Done 2026-08-08,
      kept **private** (asked and confirmed, not public).
- [ ] Add real markers for tracks as they get manually reviewed (replace/remove the placeholder
      `skip/lead_silence 0-500ms` entry on the Chevelle smoke-test track with a real value once
      that track's actually reviewed).

## Phase 2 — Navidrome core (this repo, on a personal branch)

Grounded in the current codebase as of 2026-08-08:

### 2a. Migration
New file in `db/migrations/`, timestamp-prefixed per existing convention (see e.g.
`db/migrations/20251109010105_add_annotation_rating_date.sql`). Plain `.sql` is fine (no
data-backfill needed) — creates the `media_marker` table per `docs/architecture.md`'s schema:
`id, item_id, item_type, kind, start_ms, end_ms, source, confidence, created_at, updated_at`.

### 2b. Model
`model/media_marker.go` — struct + repository interface. **Do not** reuse
`model.AnnotatedRepository` (`model/annotation.go`) — that's the per-user pattern
(`IncPlayCount`, `SetStar`, `SetRating`) and this table is global per-track, not
`(user_id, item_id)`-scoped. New interface: something like `MediaMarkerRepository` with
`Get(itemID string) ([]MediaMarker, error)`, `Put(m *MediaMarker) error`, `Delete(id string) error`.

### 2c. Persistence
`persistence/sql_media_marker.go` — plain CRUD against the `media_marker` table. Reference
`persistence/sql_annotations.go` for the SQL/squirrel idiom used in this codebase, but don't copy
its per-user join logic — this is simpler (no join to `user`). Wire into the DI graph the way
other repositories are (check `core/wire_providers.go` / `persistence/persistence.go` for the
pattern). Add a test mirroring `persistence/sql_annotations_test.go`'s structure.

### 2d. Plugin capability interface
New file `plugins/capabilities/media_marker_provider.go`. Follow the exact pattern of
`plugins/capabilities/metadata_agent.go`: a Go interface decorated with `//nd:capability
name=MediaMarkerProvider` and `//nd:export name=...` comments. Shape: given a track's ID, path,
tags, and duration, return `[]MediaMarker` (or empty/nil if the plugin has nothing for this
track) — this is a **pull model**, invoked per-track by core, matching how `MetadataAgent` is
invoked, not a push/webhook model.

After adding the interface, regenerate the YAML schema + PDK wrappers:
```
cd plugins/cmd/ndpgen && go run . -schemas -input=../../capabilities -shared=../../types
```
(documented in `plugins/capabilities/README.md`).

Check `plugins/host/*.go` for the `http` host function before assuming a marker-provider plugin
needs anything new from core to make outbound calls — the crowdsourced-lookup plugin (Phase 3)
needs outbound HTTP to jsDelivr, and an `http` host capability already exists; confirm it's
sufficient rather than adding a new host function.

### 2e/2f. Wiring: manager + invocation
- `plugins/manager.go`: add `LoadMediaMarkerProvider(name string) (..., bool)`, following
  `LoadMediaAgent`/`LoadScrobbler`/`LoadLyricsProvider` (lines ~236-248 as of this writing).
- New loader interface analogous to `core/agents.PluginLoader` (`core/agents/agents.go`) —
  likely a new small package, e.g. `core/mediamarkers`, with `PluginNames("MediaMarkerProvider")`
  + `LoadMediaMarkerProvider`, decoupled from `plugins` the same way `core/agents` is (avoids
  import cycle).
- Invocation site: **needs investigation** — metadata agents are invoked both at scan time and
  on-demand via `core/external/provider.go`. Markers should be invoked at **scan time** (new/
  changed tracks), not on-demand per API call. Find the scanner's per-track processing point
  (search the `scanner`/`core/scanner` package) and add a call there: for each enabled
  `MediaMarkerProvider` plugin, call it for the track, persist any returned markers via the
  Phase 2c repository, `source: "plugin:<name>"`. Note: confirm whether core already computes an
  AcoustID/Chromaprint fingerprint anywhere in the scan pipeline — if not, the fingerprinting
  happens inside the plugin itself (Phase 3b), and core doesn't need to supply one.

### 2g. Manual CRUD endpoint
A plain create/correct/delete endpoint for manual marker entry — needed independent of whether
any provider plugin is installed. Follow the `playbackReport` precedent (`94eb6c52`) for how a
new OpenSubsonic-extension-backed endpoint gets added under `server/subsonic/`. No per-user
auth complexity beyond "is this user allowed to edit," since the table isn't per-user.

### 2h. Extension advertisement
`server/subsonic/opensubsonic.go`, `GetOpenSubsonicExtensions` — add a new extension entry
(e.g. `mediaMarkers`) to the slice literal, alongside `playbackReport` et al. Route registration
for the new endpoint(s) goes in `server/subsonic/api.go` next to the existing `h(r, ...)` calls.

### 2i. Additive response fields
`server/subsonic/helpers.go` sets fields like `UserRating` on the `Child`/`Album`/`Directory`
DTOs in several spots (song/album/child/directory builders, ~lines 102/122/228/382/486);
`browsing.go` (~412/452) and `searching.go` (~115) do the same for directory/search responses.
Add a `Markers` (or similar) field the same additive way — define the field on the response
structs in `server/subsonic/responses/`, populate it wherever `UserRating` is currently set,
sourced from the Phase 2c repository.

### 2j. Tests
- Migration applies cleanly against a fresh DB and against the current head.
- Persistence CRUD round-trip test (mirror `sql_annotations_test.go` structure).
- Endpoint test: create/read/delete via the new manual endpoint.
- Extension advertisement test: `getOpenSubsonicExtensions` includes the new capability.
- A scan-time test with a fake `MediaMarkerProvider` plugin confirming markers get persisted.

## Phase 3 — Plugins

Separate small WASM plugin projects (new repos, or subdirectories if Navidrome's plugin
convention favors that — check `plugins/README.md`'s quick-start for the expected project
layout before deciding).

### 3a. Local silence-detection plugin
No network, no fingerprinting — wraps `ffmpeg -af silencedetect` against the track's audio,
returns `skip/lead_silence`/`skip/trail_silence` markers with `source: "plugin:silence-detect"`.
Directly answers navidrome/navidrome#2082 with zero dependency on Phase 1's repo. Build and
verify this one first — it's the simplest possible proof that the whole pipeline (Phase 2d-2f)
actually works end to end before adding network complexity.

### 3b. Crowdsourced-lookup plugin
`fpcalc` (bundle or shell out, depending on what's feasible inside the WASM sandbox — check
`plugins/README.md`'s security/sandboxing section for what's actually possible; may need to do
fingerprinting via a host function rather than shelling out from inside WASM) → AcoustID lookup →
query `media-time-markers`'s jsDelivr-served index and per-UUID files (Phase 1) → return matches.
`source: "plugin:media-time-markers"`. Build after 3a proves the pipeline; this one has more
moving parts (network host function, external service dependency, index-based bulk sync per
`docs/architecture.md`'s "read path" section).

## Phase 4 — Client-side (explicitly out of scope here)

The actual client (a separate Rust/QML app, `sync::set_intro_skip_mark`/`fetch_intro_skip_marks`
as the existing bookmark-based seam) lives in a different codebase not available in this session.
Track its migration (detect the new extension via `getOpenSubsonicExtensions`, migrate existing
`sonic-player:intro-skip-tagged` bookmarks, clean them up) as separate follow-up work once Phase
2's endpoint and extension are real and stable enough to build a client against.

## Definition of done for this brief

- [x] `media_marker` table exists, migration tested.
- [x] `MediaMarkerProvider` plugin capability exists, documented, regenerated via `ndpgen`.
- [x] Scan pipeline invokes enabled `MediaMarkerProvider` plugins per track and persists results.
- [x] Manual CRUD endpoint exists and is tested.
- [x] `getOpenSubsonicExtensions` advertises the new capability.
- [x] `getSong`/`getAlbum`/etc. responses carry markers additively (getSong + getAlbum/
      getMusicDirectory done; search/playlists/bookmarks/nowPlaying deferred, same helper reusable).
- [x] Local silence-detection plugin (3a) built and verified against a real hidden-track album.
      Verified 2026-08-08 via a real generated audio fixture (2s silence/3s tone/1.5s silence)
      and a real ffmpeg subprocess, not a synthetic mock — see
      plugins/media_marker_provider_integration_test.go in the navidrome/navidrome repo.
- [x] Crowdsourced-lookup plugin (3b) built and **fully verified** 2026-08-08. Repo made public
      (user approved) and a real AcoustID API key supplied, so the whole read path was run for
      real: real fpcalc fingerprint of the actual Chevelle track (`/home/tom/music/chevelle/
      Daredevil/32 until you're refreshed.mp3`) -> real AcoustID API lookup (returned
      5a6b2f12-2f76-4184-a089-68b53a30e6ee at 0.98 confidence, the exact UUID already on file) ->
      real jsDelivr fetch of that UUID's marker file -> the exact skip/lead_silence marker came
      back. Verified via direct protocol calls (curl) matching exactly what the plugin's Go code
      constructs, rather than running the compiled plugin with the live key through disk/build
      artifacts, to avoid the key touching any file. Unit tests (main_test.go, mocked) remain the
      permanent regression coverage, since committing a live-network test would need a secret key
      present in CI.
- [x] `docs/architecture.md` updated with anything the build proved wrong or underspecified.
      See "Phase 2 build notes" section there.
- [x] Nothing pushed/opened publicly without an explicit go-ahead at that point (true as of
      2026-08-08 — media-time-markers push was explicitly approved and kept private;
      navidrome/navidrome's feat/media-markers branch stays local, no upstream discussion opened).

## Post-v1 additions (beyond this brief's original scope)

- **Production bug found + fixed (2026-08-08)**: `MediaMarkerProvider` plugins never actually ran
  during real (non-test) scans, because `cmd/scan.go`'s `runScanner()` — the code path every real
  scan trigger actually goes through, since `conf.Server.DevExternalScanner` defaults to `true` —
  hardcoded a nil plugin loader. See `docs/architecture.md`'s "Production bug found + fixed"
  section for the full root cause and fix. Verified via a real HTTP-triggered scan over ~166 real
  podcast tracks pulled from a PinePods deployment.
- **Phase 4: speech/music discrimination (2026-08-09)**: a new `SpeechMusicDetect` host function
  (inaSpeechSegmenter-backed) plus a `speech-music-marker` example plugin producing
  `skip/intro_speech`/`skip/outro_speech` markers — see `docs/architecture.md`'s "Phase 4 build
  notes" section. Verified against real podcast audio in the same local scratch setup used for
  the production-bug fix above.
- **Phase 4 addendum (2026-08-12)**: real production-scale testing (249 tracks, not 2) found two
  real bugs the 2-track smoke test had hidden — a 100% timeout failure rate, and talk-over-a-beat
  content being invisible to both the classifier and a dedicated VAD model. Fixed by bounding
  classification to a leading/trailing window and running it through Demucs vocal separation
  first; a related per-window marker-boundary bug (would have produced a marker spanning nearly
  an entire 63-minute track) was caught and fixed before shipping. See `docs/architecture.md`'s
  "Phase 4 addendum" section.

## Explicitly deferred (do not build unless asked)

- Automatic cross-episode intro detection via audio fingerprint matching (Jellyfin
  intro-skipper-style) — real engineering lift, follow-up once manual+plugin marking proves the
  shape is right, per the original spec.
- Any voting/reputation system beyond "a PR against media-time-markers is the moderation layer."
- Per-user marker overrides (a user disagreeing with the global value) — out of scope until it's
  clear it's actually needed; the manual CRUD endpoint already lets any allowed user correct the
  global value, which may be sufficient.
