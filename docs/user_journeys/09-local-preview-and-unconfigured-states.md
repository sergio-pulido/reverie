# UJ-09 — Local preview and unconfigured states

Covers: how the app behaves without Supabase or without a catalogue, and the rule that a
missing configuration becomes an explicit state rather than a fake success or silent local
room.
Runtime: ~6 minutes.
Environment: C (`pnpm dev` with no Supabase values). If run in A or B, use it to confirm the
configured path instead and mark the preview steps `BLOCKED`.

## Goal

Prove the product never pretends a room, a script, or a catalogue exists when the
configuration needed for it is absent.

## Preconditions

- No `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in the build, so `hasSupabaseConfiguration()`
  is false.
- Note whether live providers are configured, because it decides the create outcome.

## Steps

### 1. The home and create screens state the limitation

- Do: open `/`, then `/jams/new`.
- Expect:
  - The home screen loads normally.
  - On the create form the note reads that Supabase is not configured and this creates a
    clearly labelled local preview (not a persistent URL claim).
  - The format controls are still usable.
- Evidence: `uj-09-create-note.png`.

### 2. Join is unavailable, not simulated

- Do: open `/join`.
- Expect:
  - Fields are present but `Join the room` is disabled.
  - A notice reads that Supabase is not configured in this build, so no jam can be joined
    from here.
  - Submitting anyway sends no RPC and shows no fake lobby.
- Evidence: `uj-09-join-disabled.png`.

### 3. Create outcome depends on providers

- If live providers are configured:
  - Do: create a jam with the smallest format as in [UJ-03](03-create-jam-from-scratch.md).
  - Expect: the script screen appears, then a notice that the room is a local preview only.
    The URL may show a slug, but the room is not shareable.
- If providers are not configured:
  - Do: submit the form.
  - Expect: `Script generation is disabled: live providers are not configured on this
    server.` and no script screen.
- Evidence: `uj-09-create-outcome.png`.

### 4. The preview studio is labelled and not a room

- Do: only if a script was produced, click `Open the studio`.
- Expect:
  - Eyebrow `MOVIE JAM / LOCAL PREVIEW`.
  - Text `This preview is not a room. Nothing here is shared, stored, or visible to anyone
    else.`
  - A notice telling the operator to configure `VITE_SUPABASE_URL` and
    `VITE_SUPABASE_ANON_KEY` and apply the migrations.
  - No invite code, no lobby, no roster, no chat composer.
- Evidence: `uj-09-preview-studio.png`.

### 5. A configured-but-failing project never degrades to preview

- Do: if you can, run with `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` set to a project that
  is unreachable or unmigrated, and open a room.
- Expect: Studio shows an error state (`This room is not open to you.` or a typed failure) —
  it must **not** show the local-preview screen, and must not silently use local state.
- Evidence: the error screen and the failing network response.
- If you cannot change the build, mark this step `BLOCKED` and say so.

### 6. Catalogue unconfigured state

- Do: open `/discover`.
- Expect: `Catalogue not configured`, the safe message, and the missing variable names; no
  invented titles. (Full detail in [UJ-02](02-discover-catalogue.md).)
- Evidence: `uj-09-discover-unconfigured.png`.

### 7. Health is process health only

- Do: `navigate_page` to `/api/health`.
- Expect: `{ "status": "ok", "service": "reverie-movie-jam" }`. Note that this says nothing
  about database or provider readiness, and the report should not claim otherwise.
- Evidence: the JSON body.

## Pass criteria

- Every missing dependency becomes an explicit, honest state.
- No preview is described as a shared room; no unconfigured catalogue shows titles.
- No request to Supabase is attempted when it is unconfigured.

## Failure signals

- A "room" URL presented as shareable without Supabase.
- Join appearing to succeed locally.
- A configured project failure falling back to preview state.
- Health `ok` used to imply database or provider readiness.

## Teardown

- Close the page(s).

## Not covered

- Hosted Vercel behaviour (not verifiable from this repository).
