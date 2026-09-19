# UJ-02 — Jam lifecycle: create, script, video

Covers: registering a jam, generating its script, reviewing the script and a per-user
playback session, and generating + streaming the portion video through the playback API. Also
covers the "Import a script" variant (no provider call) and the honest failure paths.
Runtime: ~20–40 minutes for the generated path (video generation dominates); ~10 minutes for
the import path.
Environment: A or B. Generate needs `REVERIE_LIVE_ENABLED=true` with `NEBIUS_API_KEY`
(script) and `FAL_KEY` (video); import needs neither. Supabase is needed for the room URL;
without it run section G.

## Goal

Prove one jam can be created end to end: the room is registered first, Reverie writes or
imports a script in the requested format, the script is labelled honestly, a session records
per-user playback settings without changing the shared script, and the server generates and
streams portion clips under the locking rules.

## Preconditions

- Supabase configured; live providers configured for the generated path.
- Use the smallest format (`0.2` min total, `4`–`4` s portions). This bounds the script call
  and the number of paid clips.
- **No playback UI exists.** Sections C–D drive the documented playback API with
  `evaluate_script` from the app origin. Do not expect buttons in the Studio.

## A. Register a jam and generate its script

### 1. Create-screen defaults and validation

- Do: `navigate_page` to `/jams/new`.
- Expect: heading `Set the first scene.`; back link `← Back to your jams`; `Jam title`
  prefilled `Untitled Movie Jam`; `Story source` = `From scratch`; `Opening premise`
  prefilled; `Total length (min)` `4`, `Shortest portion (s)` `10`, `Longest portion (s)`
  `20`; `Who can join?` `Invite only`; a note that the room will receive its own persistent
  URL and the script is generated.
- Do: clear `Jam title`, click `Write the script`.
- Expect: the browser blocks submission (required); no `POST /api/jams`; focus on the invalid
  field. Repeat by clearing the premise (minLength 8).
- Evidence: `uj-02-create-defaults.png`; network list filtered to `/api/jams` shows nothing.

### 2. Fill the test values and submit

- Do: set title `UJ Run <date> 1`, premise
  `A lighthouse keeper receives a letter from the future.`, total `0.2`, portions `4`–`4`,
  `Invite only`; click `Write the script`.
- Expect:
  - The button reads `Writing your 0.2-minute script…` and disables.
  - A room row is registered **first** (a `POST`/`insert` to Supabase `jams`), then exactly
    one `POST /api/jams` with `mode: "generate"`, `source.kind: "from-scratch"`, the room's
    `jamId`, and `format { totalSeconds: 12, portionMinSeconds: 4, portionMaxSeconds: 4 }`.
  - The two ids match: the server script artifact is attached to the registered room.
- Evidence: `uj-02-submitting.png`; both request bodies.

### 3. Script success

- Do: `wait_for` text `Open the studio` (allow up to 60 s); snapshot; read the URL.
- Expect:
  - Eyebrow `UJ Run <date> 1 · SCRIPT · 0:12 · N SCENES · M PORTIONS`, portions summing to
    12 s with 4 s each.
  - The script title, logline, and the note `An original generated Movie Jam script — not an
    existing film or catalogue title.`
  - Scene headings and `PORTION x.y · start–end · Ns` labels with action, optional dialogue
    and visuals; times are contiguous from `0:00`.
  - URL `/jams/<slug>` — the room row persisted.
- Evidence: `uj-02-script.png`, `uj-02-script-portions.png`, `uj-02-url.txt`.

### 4. Script markdown and playback session

- Do: open `Open as markdown`; read the new page; close it.
- Expect: markdown with `# <title>`, the logline, `- Source: from scratch, prompted by “…”`,
  `- Runtime: 0:12 (12s) across …`, the generated-work line, and
  `### Portion a.b · start–end (Ns)` sections.
- Do: in `YOUR SESSION`, name `Host <n>`, language `Español`, ambientation
  `neon-noir rainy metropolis`, click `Start my session`.
- Expect: `POST /api/jams/<jamId>/sessions` returns `201` with a session and a one-time
  `ownerToken` (**treat the token as a secret; never screenshot or report it**); the panel
  becomes `YOUR SESSION · Host <n>` with `Save my playback` and a `My script view` link.
- Do: open `My script view`.
- Expect: the same script plus `- Playback for Host <n>: language es, ambientation
  “neon-noir rainy metropolis”`.
- Do: `evaluate_script` a `PATCH /api/sessions/<id>` with a wrong/absent bearer.
- Expect: `403 { "error": { "code": "not_owner" } }`.
- Evidence: `uj-02-markdown.png`, `uj-02-session.png`, `uj-02-session-view.png`.

## B. Locate the server jam id

- Do: read the `Open as markdown` link's `href` (it is `/api/jams/<jamId>/script.md`) and
  extract `<jamId>`.
- Expect: a UUID. Because the room is registered first, this id is also the Supabase room id.
  All playback routes below use it.
- Evidence: the id string.

## C. Start playback and prove the lock window

### 5. Idle snapshot

- Do: `evaluate_script` `GET /api/jams/<jamId>/playback`.
- Expect: `{ playback: { status: "idle", currentPortionIndex: null, stateVersion: 1 },
  lockedPortionIndex: null, minEditablePortionIndex: 0, portions: [ … media: "none" ] }` with
  three portions.
- Evidence: the snapshot.

### 6. Start playback

- Do: `evaluate_script` `POST /api/jams/<jamId>/playback/start` (no body).
- Expect `202`:
  - `playback.status` `priming`, `currentPortionIndex` null, `stateVersion` `2`.
  - `lockedPortionIndex` `0`, `minEditablePortionIndex` `1`.
  - `portions[0].media` moves from `none` to `queued`/`submitted`/`generating`.
- Do: start again.
- Expect: `409 { "error": { "code": "invalid_transition" } }` — playback already started.
- Evidence: the start snapshot and the duplicate-start error.

### 7. Advance is refused until the clip is ready

- Do: immediately `POST /api/jams/<jamId>/playback/advance` with
  `{ "expectedStateVersion": 2 }`.
- Expect, while the clip is still generating:
  `409 { "error": { "code": "media_not_ready", "retryable": true } }`. The room holds on the
  current portion; nothing advances.
- Evidence: the error body.

## D. Generate and stream the video

### 8. Wait for portion 0

- Do: repeat a bounded `evaluate_script` that waits ~5 s and returns
  `GET /api/jams/<jamId>/playback`, until `portions[0].media === "ready"`.
- Expect: `ready` within the provider's time budget (the server polls the provider up to
  ~10 min per job). Record elapsed time and bytes generated.
- If it never becomes `ready`: mark this section `BLOCKED` (not `FAIL`) with the last
  observed status, and report the provider response class without leaking URLs or keys.
- Evidence: the final snapshot; `uj-02-media-ready.png`.

### 9. Stream the clip

- Do: `evaluate_script` a `fetch` of `/api/jams/<jamId>/portions/0/video` and return only
  status and headers. Then request `Range: bytes=0-99`.
- Expect:
  - Full request: `200`, `content-type: video/mp4`, `accept-ranges: bytes`.
  - Range request: `206`, `content-range: bytes 0-…/<total>`.
  - A `Range: bytes=<total>-<total+50>` request: `416` with `content-range: bytes */<total>`.
  - `GET /api/jams/<jamId>/portions/2/video` before portion 2 exists: `404`.
  - The response is the server-hosted clip; **no provider URL or fal hostname appears**.
- Evidence: the status/headers (never the fal URL).

### 10. Play the clip in the browser

- Do: `new_page` to `<origin>/api/jams/<jamId>/portions/0/video`.
- Expect: Chrome renders a media player and the clip is playable; screenshot it. If the
  browser downloads instead, use `evaluate_script` to create a `<video>` element with that
  `src` and report `duration` and `videoWidth` once `loadedmetadata` fires.
- Evidence: `uj-02-video-play.png`.

### 11. Advance into playing

- Do: `POST /api/jams/<jamId>/playback/advance` first with a wrong
  `expectedStateVersion` (for example `99`).
- Expect: `409 { "error": { "code": "stale_state_version" } }`.
- Do: advance with the current `expectedStateVersion` (`2` after start).
- Expect `200`:
  - `playback.status` `playing`, `currentPortionIndex` `0`, `stateVersion` `3`.
  - `lockedPortionIndex` `1` — the next portion is now the generation buffer.
  - `portions[0].media` `ready`; `portions[1].media` no longer `none`.
- Evidence: the advanced snapshot; `uj-02-advancing.png`.

### 12. (Optional, bounds cost) Finish the sequence

- Do: repeat "wait for the locked portion" + "advance" for portion 1 and portion 2.
- Expect: after the final advance, `playback.status` `finished`, `currentPortionIndex` null,
  `stateVersion` `6`, `lockedPortionIndex` null, `minEditablePortionIndex` `3`, and
  `portions[0..2].media` all `ready`.
- Skip this if the run must stay cheap; record that only the first clip was generated.

## E. Variant — Import a script (no provider call)

### 13. Import an existing script

- Do: on `/jams/new`, choose `Import a script`.
- Expect: the `Opening premise` field disappears and an `Existing script` textarea appears
  (minLength 40, maxLength 9000). `Movie title` and a movie memory no longer exist in this
  build.
- Do: set title `UJ Imported <date>`, paste a ~600-character original synopsis paragraph,
  total `0.2`, portions `4`–`4`; submit.
- Expect:
  - One `POST /api/jams` with `mode: "import"`, `source.kind: "imported-script"`,
    `source.scriptTitle` = the jam title, `scriptMarkdown` = the pasted text, and the room's
    `jamId`. **No Nebius call is made.**
  - The script screen shows one `Scene 1 — Imported script` split into portions whose actions
    are chunks of the pasted text, with contiguous times.
  - The note reads `Imported into this Movie Jam as its own editable script.`
  - `Open as markdown` returns the pasted text verbatim as revision 1.
- Evidence: `uj-02-import.png`, `uj-02-import-script.png`.

### 14. Import fit rules are honest

- Do: import a script far too short for the chosen runtime (for example 20 characters with
  `0.2` min), then one far too long.
- Expect: `400 { "error": { "code": "invalid_script_import" } }` with
  `This script is too short for the selected runtime. …` or
  `This script is too long for the selected runtime. …`. The room stays registered; the
  create screen shows the message and no script screen appears.
- Evidence: both error bodies.

## F. Generate-the-video failure path

### 15. Disabled providers are honest

- Do: only if `FAL_KEY`/`REVERIE_LIVE_ENABLED` are unset, `POST .../playback/start`.
- Expect: `503 { "error": { "code": "generation_disabled", "safeMessage": "Video generation
  is disabled: live providers are not configured on this server." } }`. No clip is claimed,
  no fake media appears.
- Evidence: the error body.
- If providers are configured, mark this step `BLOCKED` and say so.

## G. Honest create failures

- Do: with providers disabled, submit a `From scratch` jam.
- Expect: the room is registered first, then the notice reads
  `Jam registered, but its script is not ready: Script generation is disabled: live providers
  are not configured on this server.` The tester stays on the create form; `/jams` lists the
  new room without a script. This is the intended "registered but no script" state, not a
  pass-through to the script screen.
- Do: on a build **without** Supabase (environment C), create a jam with the smallest format,
  then click `Open the studio`.
- Expect: a notice that the jam is registered in the browser as a local preview only, and a
  `MOVIE JAM / LOCAL PREVIEW` screen saying it is not a room and nothing is shared or stored.
  No invite panel, lobby, roster or composer.
- Do: exceed 5 creations in a minute if you must, and expect `429 rate_limited`
  (`Too many jams created; wait a minute.`) — expected, not a defect.
- Evidence: `uj-02-registered-no-script.png`, `uj-02-preview-studio.png`.

## Pass criteria

- The room is registered before the script; the script artifact carries the same id.
- One submission creates one script; the URL changes to `/jams/<slug>` on success.
- Portions sum to the requested format and timings are contiguous, generated or imported.
- A session records language/ambientation, is annotated in its own script view, and only the
  owner token can update it.
- The playback lock window follows the contract: start → priming/locked 0; advance refused
  with `media_not_ready`; after advance → playing 0/locked 1.
- A generated clip streams as `video/mp4` with Range support and no provider URL.
- The import variant performs no provider call and rejects scripts that do not fit the runtime.
- Every failure path returns a typed error; nothing is faked.

## Failure signals

- A script artifact whose id differs from the registered room id.
- A script whose total or portion lengths contradict the requested format.
- A provider URL, key, prompt or raw body leaking into any response or the UI.
- Advance succeeding before the clip is ready, or a clip streaming before it is ready.
- The import path calling a model, or silently padding/slicing a script that does not fit.
- A preview described as a shared room.

## Teardown

- Record the room slug, invite code, server jam id, and how many clips were generated.
- Close the video page and the markdown page.

## Not covered

- The `portion_locked` script-edit rejection from `docs/API_CONTRACTS.md` is specified but not
  wired into the script edit route in this build; do **not** assert it.
- Per-session translated/re-ambiented media (not implemented; sessions only record settings).
- Live media / Vonage (separate slice).
