# UJ-01 — Discover and navigation

Covers: the home screen and its entry points, the TV-first `/discover` experience (all four
states, search, pagination, keyboard traversal, the detail dialog, the same-origin API
guard), and what the app does when no catalogue or no Supabase is configured.
Runtime: ~15 minutes.
Environment: A, B or C. The "ready grid" section additionally needs a configured
`TITAN_CATALOGUE_URL` + `TITAN_API_KEY`; without them that section is `BLOCKED` and the
unconfigured state is the real assertion.

## Goal

Prove a first-time visitor can reach every entry point, that Discover shows only authorized
catalogue titles and never invents them, that it is usable with a remote/keyboard, and that
missing configuration becomes an explicit state instead of a half-rendered grid or a fake
room.

## Preconditions

- The app is reachable at the recorded origin and `GET /api/health` returns `200`.
- Record whether `TITAN_CATALOGUE_URL`/`TITAN_API_KEY` and Supabase are configured (say only
  `set`/`missing`).

## A. Home and navigation

### 1. Load the home screen

- Do: `navigate_page` to `/`. Take a snapshot.
- Expect:
  - The brand reads `REVERIE`.
  - Primary navigation has a `Discover` link and a `Movie Jam` control.
  - Heading `Make the next scene together.`
  - Controls `Start a Movie Jam`, `Join with an invite`, and a link `Discover real films`.
  - A section `How Movie Jam works` with `Invite the room`, `Direct the turn`,
    `See it evolve`.
  - Footer text containing `REVERIE / MOVIE JAM` and `Made for HackBarna 2026`.
- Evidence: `uj-01-home.png`.

### 2. Start a Movie Jam

- Do: click `Start a Movie Jam`.
- Expect: URL `/jams/new`; heading `Set the first scene.`; a `Jam title` field and a
  `Write the script` button. The screen must **not** present a room or a script.
- Evidence: `uj-01-create.png`.

### 3. Return home, then open join

- Do: click `← Back to Reverie` (or the `REVERIE` brand); then click `Join with an invite`.
- Expect: first `/` with the hero; then `/join` with heading `Take a seat in the room.`,
  fields `Invite code` and `Your display name`, and a `Join the room` button (disabled when
  the build has no Supabase).
- Evidence: `uj-01-join.png`.

### 4. Browser back/forward

- Do: from `/`, click `Start a Movie Jam`; then `navigate_page type=back`; then
  `type=forward`.
- Expect: back returns to `/`; forward returns to `/jams/new`. No blank screen or error.
- Evidence: one screenshot after each navigation.

### 5. Open Discover and return

- Do: from `/` click `Discover real films`.
- Expect: URL `/discover`; heading `Find something real to watch.`; a search field.
- Do: click the `Movie Jam` control in the Discover header.
- Expect: URL `/` and the hero visible again.
- Evidence: `uj-01-discover.png`, `uj-01-discover-exit.png`.

## B. Discover states

### 6. Loading state

- Do: `navigate_page` to `/discover`; take a snapshot immediately.
- Expect: a busy region reading `Loading catalogue titles…` while pending. Missing it because
  the response is instant is acceptable; note it.
- Evidence: `list_network_requests` filtered to `/api/catalogue`; record status and that the
  request used `query`, `page=1`, `pageSize=24`.

### 7. Assert the state the environment actually supports

Read the `/api/catalogue` response and branch:

- `200 { "status": "catalogue_not_configured" }`:
  - Expect `Catalogue not configured`, the server's safe message, and `Waiting on:` listing
    the missing variable names.
  - Expect **no** title cards, no invented film names, no poster images.
  - Evidence: `uj-01-not-configured.png`.
- `200 { "status": "ok", "items": [...] }`: continue to section C.
- `4xx/5xx { "status": "error" }`:
  - Expect `Discover could not load the catalogue`, the safe message and a `Reference:` code.
  - Expect `Try again` only when `retryable` is `true`.
  - Expect the safe message to contain none of: the credential, the upstream URL, or an
    upstream body.
  - Evidence: `uj-01-error.png`.

## C. Discover ready grid (only with a configured catalogue)

### 8. Grid renders only real records

- Do: `resize_page` to a TV-like size (for example `1920x1080`); snapshot.
- Expect:
  - A list `Catalogue titles`; each card shows a title and `year · rating · genre`, or
    `Catalogue title` when metadata is absent.
  - A missing poster renders `No artwork supplied`, not a broken image.
  - An attribution line appears when the API returns one.
  - No generated Jam scene or `cat:`-less invented title appears.
- Evidence: `uj-01-grid.png`.

### 9. Search and empty state

- Do: focus `Search the catalogue` and type a distinctive term from a visible title.
- Expect: after roughly 320 ms the grid updates; every card matches the term (or the empty
  state appears). Network shows at most one request per paused input, not one per keystroke.
- Do: press `Escape` in the field.
- Expect: the field clears and the grid returns to the unfiltered set.
- Do: search a term that cannot match (for example `zzzzzzzznoresult`).
- Expect: `No catalogue titles match` and `Nothing in the catalogue matches “…”`.
- Evidence: `uj-01-search.png`, `uj-01-empty.png`.

### 10. Keyboard traversal

- Do: focus the search field, press `ArrowDown`, then `ArrowRight`, `ArrowLeft`,
  `ArrowDown`, `ArrowUp`.
- Expect: focus moves to the first card, then between cards by the live column count, and
  never leaves the grid. `ArrowUp` from the first row returns focus to the search field.
- Do: press `Home` then `End`.
- Expect: focus moves to the row's first then last card.
- Evidence: `uj-01-keyboard.png` after each move (focus ring visible).

### 11. Title detail dialog

- Do: with a card focused, press `Enter` (repeat with `Space`).
- Expect: a dialog opens named after the title, showing title, metadata, synopsis when
  present, `Where to watch` when availability exists, and an attribution line. Focus moves
  into the dialog.
- Do: press `Tab` to the last focusable element, then `Tab` again.
- Expect: focus wraps inside the dialog and never reaches the page behind it.
- Do: press `Escape`.
- Expect: the dialog closes and focus returns to the card that opened it.
- Evidence: `uj-01-detail.png`, `uj-01-detail-focus-trap.png`.

### 12. Availability links are safe

- Only if availability entries are shown.
- Do: inspect each `Where to watch` link.
- Expect: every link is `https:` with `rel="noreferrer noopener"`; no `javascript:` or `http:`
  link is rendered. Rejected URLs are absent rather than broken.
- Evidence: the dialog snapshot; do not follow the link.

### 13. Pagination

- Only when the response reports more than one page.
- Do: click `Next →`.
- Expect: the request uses `page=2`; `Next →` is disabled on the last page; `← Previous` is
  disabled on page 1.
- Evidence: `uj-01-page-2.png`.

### 14. The API refuses what it should

- Do: `evaluate_script` a `fetch("/api/catalogue", { method: "POST" })` from the app origin.
- Expect: `405 { "status": "error", "code": "METHOD_NOT_ALLOWED" }`.
- Do: fetch `/api/catalogue?pageSize=9999` and `?page=0`.
- Expect: a typed `4xx` with `code: "INVALID_QUERY"`, not a stack trace or SPA HTML.
- Evidence: the JSON bodies (they contain no secrets).

## D. Unconfigured build states

### 15. Join is unavailable, not simulated

- Do: only in environment C, open `/join` and try to submit.
- Expect: `Join the room` is disabled; a notice says Supabase is not configured in this
  build, so no jam can be joined from here; no RPC is sent and no fake lobby appears.
- Evidence: `uj-01-join-disabled.png`.

### 16. Health is process health only

- Do: `navigate_page` to `/api/health`.
- Expect: `{ "status": "ok", "service": "reverie-movie-jam" }`. This says nothing about
  database or provider readiness; the report must not claim otherwise.
- Evidence: the JSON body.

## Pass criteria

- All entry points work and no route is blank or 404.
- The Discover state the environment supports is exactly one of the four, with expected copy.
- No invented title, no generated Jam artifact, and no leaked credential or upstream URL.
- Keyboard focus follows the grid and is trapped in the dialog; `Escape` restores focus.
- The API guard rejects methods and out-of-range queries with typed JSON.
- Missing Supabase is stated, never simulated.

## Failure signals

- A poster or title that did not come from the response.
- An error page that includes `TITAN_API_KEY`, the upstream URL, or upstream JSON.
- `Escape`/`Tab` escaping the dialog, or focus lost to the page body.
- A 500 or an HTML body where typed JSON is expected.
- Join appearing to succeed without Supabase, or `/jams/new` opening a studio for a room
  called "new".

## Teardown

- Close the page(s). Do not hammer the catalogue endpoint; the adapter rate-limits per
  instance and a self-inflicted `RATE_LIMITED` is not a product failure.

## Not covered

- Real catalogue correctness beyond what the authorized endpoint returns.
- Natural-language discovery turns (`POST /api/discover/turns` is not implemented).
