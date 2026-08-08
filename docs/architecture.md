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

## Sources

Navidrome plugin docs · Plugin capabilities · getBookmarks entry-shape bug #1099 ·
playbackReport extension PR #5442 · silence-skip feature request #2082 · Jellyfin intro-skipper
· AcoustID / AcousticBrainz · MusicBrainz · SponsorBlock (incl. SponsorBlock for Spotify) ·
custom tags docs (ruled out — scanner-imported file metadata, not client-authored runtime state)
