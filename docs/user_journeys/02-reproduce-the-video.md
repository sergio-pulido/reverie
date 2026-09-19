# UJ-02 — Reproduce the video

Covers: registering a jam, obtaining a script (generated or imported), generating the portion
clip, streaming it, and reproducing the film in the product's own player. This is
the basic jam→script→video journey; the configuration cap is [UJ-03](03-session-configuration-cap.md).
Runtime: ~20–40 minutes for the generated script (video generation dominates); ~10 minutes for
the imported-script path.
Environment: A or B. The **generated** path needs `REVERIE_LIVE_ENABLED=true` with
`NEBIUS_API_KEY` (script) and `FAL_KEY` (clip); the **imported** path needs `FAL_KEY` only.
Shared conventions, test data and the report template are in the [runbook index](README.md).

## Goal

Prove one jam can reach a playable video: the room is registered first, Reverie writes or
imports a script in the requested format, the server generates a portion clip under the locking
rules, the clip streams as video, and the player reproduces the film portion by portion with
play and stop alone.

## Preconditions

- Supabase configured; `FAL_KEY` set; `NEBIUS_API_KEY` set for the generated path.
- Use the smallest format (`0.2` min total, `4`–`4` s portions) to bound cost.
- The clip has a player now (`THE FILM` on the script screen and in the Studio), covered in
  section C. Section B still drives the routes directly with `evaluate_script`, because it
  checks the contract — status codes, Range, the lock window — which the player does not show.
- The room's shared elapsed-time counter (`SHARED PLAYBACK`) is **gone from the screens**: the
  player took its place in the Studio. `src/screens/PlaybackBar.tsx`, `usePlaybackClock.ts` and
  `src/lib/playback.ts` still exist and the host-only clock RPCs are untouched, but no screen
  mounts them. Do not report the missing counter as a regression, and do not "fix" that UI
  believing it is live; whether it returns or is deleted is an open product decision.

## A. Get a script

### 1. Create-screen defaults and validation

- Do: `navigate_page` to `/jams/new`.
- Expect: heading `Set the first scene.`; the top bar with `Movie Jam` current; `Jam title`
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
  once `loadedmetadata` fires. (Section C plays the same clip through the product's own player.)
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

## C. Reproduce it in the player (current UI)

Play and stop are the only controls in this iteration. There is no seek: the cursor only moves
forward, the next portion is generated while the current one plays, and a clip that does not
exist yet cannot be scrubbed to.

### 12. The player on the script screen

- Do: from the script screen (the one reached in section A), find the `THE FILM` panel under
  `YOUR SESSION`.
- Expect: badge `READY`, the placeholder `Nothing has been generated yet.`, the line
  `Press play: the first of <N> portions is generated, then the next one while it plays.`, one
  pip per portion, and the note naming this viewer's playback — `language en, ambientation as
  written` before a session is created, the session's own settings after.
- Do: click `Play`.
- Expect **with providers configured**: badge `GENERATING`, `Generating portion 1 of <N>. The
  film continues by itself when it is ready.`, and that portion's pip turning amber. No request
  moves the cursor while the clip is unfinished: `POST .../playback/advance` is only sent once
  the video element reports the current clip ended.
- Expect **without `REVERIE_LIVE_ENABLED` + `FAL_KEY`**: badge `UNAVAILABLE` and the notice
  `Video generation is disabled: live providers are not configured on this server.` — no clip
  is claimed and `Play` is disabled afterwards.
- Evidence: `uj-02-player-ready.png`, `uj-02-player-generating.png` (or the disabled notice).

### 13. The film plays through, one portion at a time

- Only runnable with providers configured; mark `BLOCKED` otherwise.
- Do: leave the page alone once portion 0 is ready.
- Expect: the clip plays without a second click; at its end the player advances and the next
  clip continues; the status line counts `Portion <i> of <N>`; played pips dim and the current
  one is outlined; after the last portion the badge reads `FINISHED` and `All <N> portions have
  played.`
- Do: click `Stop` mid-portion.
- Expect: the video stops where it is and the badge leaves `PLAYING`. This is a local stop: the
  room's cursor does not rewind, and `GET .../playback` still reports the same
  `currentPortionIndex`.
- Evidence: `uj-02-player-playing.png`, `uj-02-player-finished.png`.

### 14. In the Studio, and what a member sees

- Do: click `Open the studio` (needs Supabase configured and this viewer active in the room).
- Expect: the same `THE FILM` panel where the `SHARED PLAYBACK` counter used to be. The host has
  `Play`/`Stop`.
- Optional; needs a second admitted member (see [UJ-04](04-live-room-collaboration.md)). Expect
  a member to see the same panel and the same portion state, with `Play` unavailable until the
  host has started the film — per `docs/API_CONTRACTS.md` starting and advancing are host-only.
  **This is a UI boundary, not an enforced one:** the Express routes carry no authorization, so
  a member calling `POST .../playback/start` directly still succeeds. Record that as the known
  gap it is.
- Evidence: `uj-02-player-studio.png`, `uj-02-player-member.png`.

## Pass criteria

- The room is registered before the script; the script artifact carries the same id.
- Portions sum to the requested format; generated or imported, the script screen is honest.
- The lock window follows the contract: start → priming/locked 0; advance refused with
  `media_not_ready`; after advance → playing 0/locked 1.
- A generated clip streams as `video/mp4` with Range support and plays in the browser.
- The player reaches a clip with play alone, continues into the next portion by itself, and
  offers no seek. No provider URL or key appears in any response or on screen.

## Failure signals

- A script artifact whose id differs from the registered room id.
- Provider URL, key, prompt or raw body leaking into any response or the UI.
- Advance succeeding before the clip is ready, or a clip streaming before it is ready.
- The player advancing the room's cursor before the clip in the element has ended, so a portion
  is cut short.
- A disabled provider shown as "generating" instead of unavailable.
- A missing clip treated as success.

## Teardown

- Record the room slug, jam id, and how many clips were generated.
- Close the video page and the studio page.

## Not covered

- The `portion_locked` script-edit guard: specified in `docs/API_CONTRACTS.md` but not wired
  into the script edit route in this build; do **not** assert it.
- Durable playback state: clips persist with Storage configured, but the cursor does not, so a
  restarted server reads `idle` while its clips remain. Do not treat that as a data loss bug.
- The configuration cap and per-configuration streams — [UJ-03](03-session-configuration-cap.md).
- Per-session translated/re-ambiented media (sessions only record settings).
- Live media / Vonage (separate slice).
