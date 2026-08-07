# Marker kind registry

`kind` is a namespaced string, `<namespace>/<name>`, matching `^[a-z0-9_-]+/[a-z0-9_-]+$`. Adding
a new one doesn't require a schema change — just document it here in the same PR that first uses
it, so the meaning is agreed rather than guessed from context.

A marker is a span (`start_ms`, optional `end_ms`) or a point-in-time (`start_ms` only, `end_ms`
omitted) depending on the kind — see each entry below.

## `skip/*` — spans a client may offer to skip

| kind                 | shape | meaning                                                           |
|----------------------|-------|--------------------------------------------------------------------|
| `skip/lead_silence`  | span  | Silence (or near-silence) at the start of the track, before audible content begins. |
| `skip/trail_silence` | span  | Silence at the end of the track, e.g. padding before a hidden track. |
| `skip/intro_speech`  | span  | Spoken introduction before the musical/main content starts.       |
| `skip/outro_speech`  | span  | Spoken content after the main content ends (not silence — a DJ talking over the fade, an outro announcement). |

## `sample/*` — point or span, provenance/trivia, not skip-worthy

| kind             | shape | meaning                                                              |
|------------------|-------|-----------------------------------------------------------------------|
| `sample/amen-break`   | span | The Amen break (or a recognizable variant) occurs here. |
| `sample/wilhelm-scream` | point | The Wilhelm scream occurs here. |

Add more `sample/*` entries freely — this namespace is for "interesting to know," not "worth
skipping."

## Adding a new kind

1. Pick a namespace: `skip/*` if a client would reasonably offer to jump past it, otherwise a new
   or existing non-skip namespace (`sample/*`, or propose another).
2. Add a row to the relevant table above in the same PR as your first marker file using it.
3. Keep names short, lowercase, `snake_case` or `kebab-case` (schema allows `[a-z0-9_-]+`).
