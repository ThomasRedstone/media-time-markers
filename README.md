# media-time-markers

An open, crowdsourced database of time-coded markers on audio recordings — skippable silence,
spoken intros, sample flips (the Amen break, the Wilhelm scream), chapter points, whatever turns
out to be useful. Keyed by content, not by file: the same recording matches regardless of which
rip, encode, or tagging job produced the file you actually have.

## Status

Single-maintainer, personal use right now — this repo exists to back
[Navidrome](https://github.com/navidrome/navidrome) intro/silence-skip support in a personal
client. The schema and validation are built to hold up if it ever gets contributors, but nothing
here is stable-API-promised yet. Expect the `kind` registry ([KINDS.md](KINDS.md)) to grow.

## Why keyed by AcoustID

No existing open database fits this shape:

- MusicBrainz / AcoustID / AcousticBrainz do track *identity* and static acoustic descriptors,
  not in-track time spans.
- [SponsorBlock](https://sponsor.ajay.app/) is the right shape (crowdsourced, public, exactly
  this kind of segment data) but keyed by YouTube video ID — no reach into a ripped/local file.

An [AcoustID](https://acoustid.org/) UUID is the right key: it's derived from the audio content
itself via a Chromaprint fingerprint (fuzzy-matched server-side by AcoustID across different
encodes of the same audio), not from tags — so it doesn't depend on the file being correctly
identified first, and it's stable across re-rips and transcodes of the *same master*. A different
master or pressing of the same recording can legitimately have different silence/intro timing,
which is exactly the granularity a marker needs.

## Layout

```
data/<uuid[0:2]>/<uuid[2:4]>/<uuid>.json   -- one file per AcoustID UUID
schema/marker.schema.json                  -- JSON Schema for marker files
index/markers-index.json                   -- generated: flat list of all covered UUIDs
scripts/                                   -- validation, index build, submission CLI
```

Sharding by the first four hex characters of the UUID keeps any single directory small as the
dataset grows.

## Marker file shape

```json
{
  "acoustid": "1a2b3c4d-....",
  "duration_ms": 214000,
  "schema_version": 1,
  "markers": [
    { "kind": "skip/lead_silence", "start_ms": 0, "end_ms": 1800, "source": "manual" },
    { "kind": "skip/intro_speech", "start_ms": 0, "end_ms": 14200, "source": "manual" }
  ]
}
```

See [KINDS.md](KINDS.md) for the marker-kind namespace, and
[schema/marker.schema.json](schema/marker.schema.json) for the full validated shape.

## Reading the data

Served over [jsDelivr's GitHub CDN mirror](https://www.jsdelivr.com/?docs=gh) rather than raw
GitHub Pages — free, CDN-cached, CORS-enabled, and pinnable to a tag:

```
https://cdn.jsdelivr.net/gh/ThomasRedstone/media-time-markers@main/data/1a/2b/1a2b3c4d-....json
https://cdn.jsdelivr.net/gh/ThomasRedstone/media-time-markers@main/index/markers-index.json
```

A bulk consumer (e.g. a library scanner) should fetch `index/markers-index.json` once per scan
cycle and only fetch per-UUID files for local matches — not query per-track, which doesn't scale
to a full library.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `scripts/submit.js` computes the AcoustID for a
local file and writes/updates the sharded JSON for you; open a PR; CI validates it.

## License

Code (`scripts/`, schema, workflows): MIT, see [LICENSE](LICENSE).
Data (`data/`, `index/`): CC0-1.0, see [DATA-LICENSE](DATA-LICENSE) — public domain, no
attribution required, so it's actually reusable by anyone without friction.
