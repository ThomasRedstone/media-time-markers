# Contributing

This is currently a single-maintainer repo backing a personal Navidrome client's intro/silence
skip support — but it's built PR-first from day one so the process doesn't have to change if
that stops being true.

## Adding or correcting a marker

1. Install [`fpcalc`](https://acoustid.org/chromaprint) (chromaprint tools) and get a free
   [AcoustID API key](https://acoustid.org/api-key).
2. From the repo root:
   ```
   npm install --prefix scripts
   ACOUSTID_API_KEY=xxx node scripts/submit.js \
     --file /path/to/track.flac \
     --kind skip/lead_silence --start 0 --end 1800
   ```
   This fingerprints the file, resolves it to an AcoustID UUID, and writes/updates
   `data/<shard>/<uuid>.json`. Run it again with a different `--kind`/`--start` to add more
   markers to the same track.
3. Validate and rebuild the index locally before committing:
   ```
   node scripts/validate.js
   node scripts/build-index.js
   ```
4. Open a PR. CI runs the same validation; on merge to `main`, the index rebuilds and commits
   automatically.

## Adding a new marker kind

New `kind` values don't need a schema change — just document the new kind in
[KINDS.md](KINDS.md) in the same PR that first uses it. See that file for the namespace
convention.

## Editing a marker file by hand

Submitting via `scripts/submit.js` is the easy path, but the files are plain JSON — hand-editing
is fine too as long as `node scripts/validate.js` passes before you open the PR. Keep the file at
the path its `acoustid` field implies (`scripts/lib/shard.js` has the exact rule); CI checks this.
