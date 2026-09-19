# UJ-02 — Reproduce the video

Covers: registering a jam, obtaining a script (generated or imported), generating the portion
clip, playing it back in the browser, and reading the room's shared playback position. This is
the basic jam→script→video journey; the configuration cap is [UJ-03](03-session-configuration-cap.md).
Runtime: ~20–40 minutes for the generated script (video generation dominates); ~10 minutes for
the imported-script path.
Environment: A or B. The **generated** path needs `REVERIE_LIVE_ENABLED=true` with
`NEBIUS_API_KEY` (script) and `FAL_KEY` (clip); the **imported** path needs `FAL_KEY` only.
Shared conventions, test data and the report template are in the [runbook index](README.md).

## Goal

Prove one jam can reach a playable video: the room is registered first, Reverie writes or
imports a script in the requested format, the server generates a portion clip under the locking
rules, the clip streams as video, and the room shows one shared playback position.

## Preconditions

- Supabase configured; `FAL_KEY` set; `NEBIUS_API_KEY` set for the generated path.
- Use the smallest format (`0.2` min total, `4`–`4` s portions) to bound cost.
- **No playback UI exists for the clip.** The per-portion generation and streaming routes are a
  server API (`docs/API_CONTRACTS.md`); drive them with `evaluate_script` from the app origin.
  The room's shared **position** does have a UI (`SHARED PLAYBACK` in the Studio), covered in
  section C. Report the missing clip UI as a known gap, not a failure.

## A. Get a script

### 1. Create-screen defaults and validation

- Do: `navigate_page` to `/jams/new`.
- Expect: heading `Set the first scene.`; back link `← Back to your jams`; `Jam title`
  prefilled; `Story source` = `From scratch`; `Opening premise`, the `Script length` group,
  and `Who can join?` all present.
- Do: clear `Jam title`, click `Write the script`.
- Expect: the browser blocks submission (required); no `POST /api/jams`; focus on the invalid
  field.
- Evidence: `uj-02-create-defaults.png`; network list filtered to `/api/jams` shows nothing.

### 2. Register the room and generate the script

- Do: set title `UJ Run <date> 1`, premise
  `A lighthouse keeper receives a letter from the future.`, total `0.2`, portions `4`–`4`,
  `Invite only`; click `Write the script`.
- Expect:
  - The room row is registered **first** (Supabase `jams` insert), then one `POST /api/jams`
    with `mode: "generate"`, `source.kind: "from-scratch"`, the room's `jamId`, and
    `format { totalSeconds: 12, portionMinSeconds: 4, portionMaxSeconds: 4 }`.
  - `wait_for` `Open the studio` (allow up to 60 s): the script screen shows the title,
    logline, the note `An original generated Movie Jam script — not an existing film or
    catalogue title.`, and portions summing to 12 s.
  - URL is `/jams/<slug>` — the room persisted, and the script artifact carries the room id.
- Evidence: `uj-02-script.png`, `uj-02-url.txt`; both request bodies.

### 3. Cheap path — import a script (no Nebius call)

- Do: on `/jams/new`, choose `Import a script`, set title `UJ Imported <date>`, paste a
  ~600-character original synopsis, total `0.2`, portions `4`–`4`; submit.
- Expect: one `POST /api/jams` with `mode: "import"`, `source.kind: "imported-script"`,
  `scriptMarkdown` = the pasted text, and the room's `jamId`. **No Nebius call is made.** The
  script screen shows one `Scene 1 — Imported script` and the note
  `Imported into this Movie Jam as its own editable script.`
- Do: import a script far too short, then one far too long for the runtime.
- Expect: `400 { "error": { "code": "invalid_script_import" } }` with the matching
  `too short` / `too long for the selected runtime` message; no script screen.
- Evidence: `uj-02-import.png`, both error bodies.

### 4. Locate the jam id

- Do: read the `Open as markdown` link's `href` (`/api/jams/<jamId>/script.md`) and extract
  `<jamId>`.
- Expect: a UUID equal to the Supabase room id. All playback routes below use it.
- Evidence: the id string.

## B. Generate and reproduce the clip

### 5. Idle snapshot

- Do: `evaluate_script` `GET /api/jams/<jamId>/playback`.
- Expect: `{ playback: { status: "idle", currentPortionIndex: null, stateVersion: 1 },
  lockedPortionIndex: null, portions: [ … media: "none" ] }`.
- Evidence: the snapshot.

### 6. Start playback

- Do: `POST /api/jams/<jamId>/playback/start` (no body).
- Expect `202`: `priming`, `stateVersion` `2`, `lockedPortionIndex` `0`,
  `minEditablePortionIndex` `1`, `portions[0].media` moving off `none`.
- Do: start again.
- Expect: `409 { "error": { "code": "invalid_transition" } }`.
- Evidence: the start snapshot and the duplicate-start error.

### 7. Advance is refused until the clip is ready

- Do: immediately `POST /api/jams/<jamId>/playback/advance` with `{ "expectedStateVersion": 2 }`.
- Expect: `409 { "error": { "code": "media_not_ready", "retryable": true } }` while generating.
- Evidence: the error body.

### 8. Wait for portion 0, then stream it

- Do: repeat a bounded `evaluate_script` that waits ~5 s and returns
  `GET /api/jams/<jamId>/playback`, until `portions[0].media === "ready"`. If it never becomes
  ready, mark section B `BLOCKED` with the last status and move on.
- Do: `fetch` `/api/jams/<jamId>/portions/0/video` and return status/headers, then with
  `Range: bytes=0-99`, then with an out-of-range range.
- Expect: `200` `video/mp4` with `accept-ranges: bytes`; `206` with
  `content-range: bytes 0-…/<total>`; `416` for the bad range; `404` for a not-yet-generated
  index. **No provider URL or fal hostname appears.**
- Evidence: the statuses/headers and elapsed time.

### 9. Reproduce the clip in the browser

- Do: `new_page` to `<origin>/api/jams/<jamId>/portions/0/video`.
- Expect: Chrome renders a media player and the clip plays. If it downloads instead, use
  `evaluate_script` to build a `<video>` with that `src` and report `duration`/`videoWidth`
  once `loadedmetadata` fires.
- Evidence: `uj-02-video-play.png`.

### 10. Advance into playing

- Do: advance with a wrong `expectedStateVersion` (for example `99`).
- Expect: `409 { "error": { "code": "stale_state_version" } }`.
- Do: advance with the current version (`2`).
- Expect `200`: `playing`, `currentPortionIndex` `0`, `stateVersion` `3`,
  `lockedPortionIndex` `1`, `portions[0].media` `ready`.
- Evidence: the advanced snapshot.
- Optional (bounds cost): repeat wait+advance for portions 1 and 2 until `finished`.

### 11. Disabled providers are honest

- Do: only if `FAL_KEY`/`REVERIE_LIVE_ENABLED` are unset, `POST .../playback/start`.
- Expect: `503 { "error": { "code": "generation_disabled" } }`; no clip is claimed.
- Evidence: the error body. Otherwise mark this step `BLOCKED`.

## C. The room's shared playback position (current UI)

### 12. Host drives the clock

- Do: from the script screen click `Open the studio` (the host is active).
- Expect: a `SHARED PLAYBACK` panel titled `The room's position`, status `READY`, the counter
  `0:00`, and host controls `Play for everyone`, `Pause` (disabled) and `Reset` (disabled).
- Do: click `Play for everyone`.
- Expect: status becomes `PLAYING`; the counter advances (about one second per second); the
  button shows `Playing…` and `Pause` becomes enabled. This is the room's shared position, read
  through `get_jam_playback` and polled about every 2.5 s.
- Do: click `Pause`.
- Expect: status `PAUSED` and the counter freezes.
- Do: click `Reset`.
- Expect: status `READY` and the counter returns to `0:00`.
- Evidence: `uj-02-playback-ready.png`, `uj-02-playback-playing.png`,
  `uj-02-playback-paused.png`.

### 13. A member follows, and cannot drive

- Optional; needs a second active member (see [UJ-04](04-live-room-collaboration.md) for join and
  admission).
- Do: with the host playing, open the same room as the admitted guest.
- Expect: the guest sees the same `SHARED PLAYBACK` position (allowing a moment to converge) and
  **no** `Play`/`Pause`/`Reset` controls — only the note that the host drives the clock.
- Evidence: `uj-02-playback-member.png`.

## Pass criteria

- The room is registered before the script; the script artifact carries the same id.
- Portions sum to the requested format; generated or imported, the script screen is honest.
- The lock window follows the contract: start → priming/locked 0; advance refused with
  `media_not_ready`; after advance → playing 0/locked 1.
- A generated clip streams as `video/mp4` with Range support and plays in the browser.
- The shared position has one host-controlled anchor that starts, pauses and resets, with no
  provider URL or key in any response.

## Failure signals

- A script artifact whose id differs from the registered room id.
- Provider URL, key, prompt or raw body leaking into any response or the UI.
- Advance succeeding before the clip is ready, or a clip streaming before it is ready.
- The shared clock advancing on a paused room, or a non-host seeing host controls.
- A missing clip treated as success.

## Teardown

- Record the room slug, jam id, and how many clips were generated.
- Close the video page and the studio page.

## Not covered

- The `portion_locked` script-edit guard: specified in `docs/API_CONTRACTS.md` but not wired
  into the script edit route in this build; do **not** assert it.
- The configuration cap and per-configuration streams — [UJ-03](03-session-configuration-cap.md).
- Per-session translated/re-ambiented media (sessions only record settings).
- Live media / Vonage (separate slice).
