# RV-08 — Jam registry and script import

## Problem

A Jam room was only reachable from the create screen or a known URL. There was no way to
see the jams an identity already hosts or joined, and "from an existing movie" could riff on
a film but could not work on a script the room already has.

## Scope

- `/jams` lists the jams this identity can read (host or member), newest first, and offers
  "start a new jam". A jam is registered when the room is created, before its script exists.
- The registered room id is the script's `jamId`, so every jam owns exactly one script and
  its revision history instead of the server minting a second, unrelated id.
- Two creation sources: **from scratch** (a prompt generates the script) or **import a
  script** (the pasted markdown becomes revision 1 verbatim, with no provider call).
- Without Supabase configuration the registry is browser-local and labelled as a
  non-shareable preview.

## Non-goals

Per-user sessions, voting, scene acceptance, video generation, and parsing an imported
screenplay back into structured scene/portion text remain follow-ups. The imported script is
wrapped for timed playback, not interpreted.

## Contracts

### `POST /api/jams`

A discriminated union on `mode`:

- `generate` — the default when `mode` is omitted, so existing callers keep working. Calls
  Nebius behind the server allowlist and the generation concurrency gate. `source` is
  `from-scratch` or `from-movie`.
- `import` — `source` is `{ kind: "imported-script", scriptTitle }` plus `scriptMarkdown`
  (40–9000 characters). No provider call and no concurrency slot. A script that cannot be
  projected into the format returns `invalid_script_import` (`400`).

Both accept the optional `format` and `jamId` (the pre-registered room id). Reusing an id
that already has a script returns `jam_exists` (`409`). The response is
`201 { jam, scriptMarkdown }`.

### Browser registry

`listJams()` selects `jams` under RLS (`host_id = auth.uid() or is_jam_member(id)`), ordered
by `updated_at` descending, and the registry hides `completed`/`closed` rooms. Preview mode
reads and writes `localStorage["reverie.preview-jams.v1"]`, capped at 50 entries.

### Import projection

`projectImportedScript(title, markdown, format)` derives the timed portions that playback
needs while revision 1 keeps the exact imported markdown:

- The portion count aims for ~200 characters per portion, clamped between the format's hard
  minimum and maximum portion counts.
- Text below 40 characters per required portion is rejected as too short; text above 600
  characters per portion is rejected as too long. A summary/one-line premise is not a script.
- Cuts snap to word boundaries so no word is split across portions.

## Client

- `src/screens/JamRegistry.tsx` renders the list, loading/empty/error states, and the
  preview-vs-remote distinction.
- `src/lib/jams.ts` owns `createJam` (now with an optional pre-minted id), `listJams`, and
  the preview registry.
- `src/core/scriptImport.ts` is provider-free and browser-free; it is unit tested.

## Acceptance

`pnpm typecheck`, `pnpm build` and `pnpm test` pass. Tests cover the projection (bounded
portions, word boundaries, too short, too long) and the import route (no provider call,
markdown preserved as revision 1).

## Known gaps

No Supabase project has been migrated or probed, so the RLS-scoped registry is specified and
unit-tested but not verified live. Opening a registered jam lands in its room, not its script
view. The projection is a timing wrapper, not a screenplay parser.
