# UJ-03 — Create a Jam from scratch

Covers: the create form defaults and validation, the paid `POST /api/jams` call, the
generated script, persistence of the room, and the honest failure states when generation is
disabled or the provider fails.
Runtime: ~6 minutes (generation is the long part).
Environment: A or B. Needs `REVERIE_LIVE_ENABLED=true` + `NEBIUS_API_KEY` for the success
path; without them run the failure path in step 6 and mark the rest `BLOCKED`.

## Goal

Prove the host can set the first scene, that Reverie writes a real script in scene portions
of the requested format, that the room gets a persistent URL, and that the app never implies
a script or room exists when the server said no.

## Preconditions

- Supabase is configured (environment A or B). Without it the room cannot persist and the
  run becomes the local-preview path in [UJ-09](09-local-preview-and-unconfigured-states.md).
- Live providers are configured for the success path.
- Use the smallest format (`0.2` min, portions `4`–`4` s) to bound cost and latency.

## Steps

### 1. Open the create screen

- Do: `navigate_page` to `/jams/new`.
- Expect:
  - Heading `Set the first scene.`
  - `Jam title` prefilled `Untitled Movie Jam`.
  - `Story source` radiogroup with `From scratch` selected (`aria-checked=true`) and
    `From an existing movie` not selected.
  - `Opening premise` prefilled `A signal changes what the room thinks is possible.`
  - `Script length` group with `Total length (min)` = `4`, `Shortest portion (s)` = `10`,
    `Longest portion (s)` = `20`.
  - `Who can join?` = `Invite only`.
  - A note that the room will receive its own persistent URL, and that the script is an
    original generated work.
- Evidence: `uj-03-create-defaults.png`.

### 2. Client-side validation does not call the server

- Do: clear `Jam title`, fill the premise, click `Write the script`.
- Expect: the browser blocks submission (required field); no `POST /api/jams` in the network
  list; focus returns to the invalid field.
- Do: set the title, clear the premise, click `Write the script`.
- Expect: blocked again (`minLength` 8); no request.
- Evidence: network list filtered to `/api/jams` shows nothing.

### 3. Set the test values

- Do:
  - `Jam title` = `UJ Run <date> 1`.
  - `Opening premise` = `A lighthouse keeper receives a letter from the future.`
  - `Total length (min)` = `0.2`.
  - `Shortest portion (s)` = `4`.
  - `Longest portion (s)` = `4`.
  - `Who can join?` = `Invite only`.
- Expect: values are accepted; no validation message.
- Evidence: `uj-03-values.png`.

### 4. Submit and watch the pending state

- Do: click `Write the script`.
- Expect:
  - The button becomes disabled and its label changes to `Writing your 0.2-minute script…`.
  - Exactly one `POST /api/jams` request is issued with a JSON body containing `source.kind`
    `from-scratch`, the premise, and `format` `{ totalSeconds: 12, portionMinSeconds: 4,
    portionMaxSeconds: 4 }`.
  - No duplicate submissions while pending.
- Evidence: `uj-03-submitting.png`; the request body (contains no secret).

### 5. Script success

- Do: `wait_for` text `Open the studio` (allow up to 60 s), then snapshot.
- Expect on the script screen:
  - An eyebrow of the form `UJ Run <date> 1 · SCRIPT · 0:12 · N SCENES · M PORTIONS` where
    the portions total 12 seconds and each portion is 4 seconds.
  - The generated script's own title and logline.
  - The note `An original generated Movie Jam script — not an existing film or catalogue
    title.`
  - Buttons `Open the studio` and link `Open as markdown`.
  - At least one `Scene 1 — …` heading and `PORTION 1.1 · 0:00–0:04 · 4s` label; every
    portion shows an action, optional dialogue and optional visual direction.
  - The `YOUR SESSION` panel is present (tested in UJ-05).
- Do: read the URL.
- Expect: `/jams/<slug>` with a lowercase slug, and the create-screen route is gone from the
  address bar. This proves the Supabase room row persisted.
- Evidence: `uj-03-script.png`, `uj-03-url.txt` (the URL), a screenshot of the first scene.

### 6. Generation failure is honest (run when providers are off, or as a second run)

- Do: repeat steps 1–4 in a new run (or with the provider deliberately unset).
- Expect exactly one of these, shown in a `role="alert"` notice under the form, with the
  user still on `/jams/new` and **no** script screen:
  - Providers disabled: `Script generation is disabled: live providers are not configured on
    this server.` (`503 generation_disabled`).
  - Misconfigured model: the server's allowlist message (`503 provider_misconfigured`).
  - Provider failure: a safe retryable message such as `The creative provider did not
    respond.` (`502 generation_failed`, `retryable: true`).
  - Busy: `The studio is busy; try again shortly.` (`503 busy`).
  - Invalid format combination: `The jam request is not valid.` (`400 invalid_command`).
- Expect: no room URL was created, no script markdown is reachable, and no notice claims the
  jam succeeded.
- Evidence: `uj-03-failure.png`; the response JSON.

### 7. Markdown view

- Do: only on the success path, open `Open as markdown` (a new page).
- Expect: a `text/markdown` document that states it is an original generated work, names the
  source, and renders timed scene portions. It must not contain catalogue identifiers or
  claim to be an existing film.
- Do: close that page.
- Evidence: `uj-03-markdown.png`.

### 8. Rate limiting is bounded

- Do: do not exceed 5 creations per minute per client. If you intentionally cross it, expect
  `429 rate_limited` with `Too many jams created; wait a minute.` — report it as expected,
  not a defect.

## Pass criteria

- The success path produces a script whose portions sum to the requested format.
- The room URL changes to `/jams/<slug>` only after the room persisted.
- Every failure path keeps the user on the form with a typed safe message and no fake script
  or room.
- `POST /api/jams` is called once per submission.

## Failure signals

- A pending label that never resolves, or a success screen with no server jam id.
- A script whose total duration or portion lengths contradict the requested format.
- A leaked internal message from the provider (stack, prompt, raw body) in the notice.
- A second room created when the first submission is retried.

## Teardown

- Record the slug and invite code for later journeys.
- Do not delete the jam unless you must; UJ-05/06 reuse it.

## Not covered

- The "from an existing movie" source (UJ-04).
- Playback session settings (UJ-05) and the live room (UJ-06/07/08).
