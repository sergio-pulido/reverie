# UJ-01 — Discover, jam registry and navigation

Covers: the home screen and its entry points, the `/jams` registry, the TV-first `/discover`
experience (all four states, search, the endless grid, keyboard traversal, film pages at
`/discover/:id`, the same-origin API guard), and what the app does when no catalogue or no Supabase is configured.
Runtime: ~18 minutes.
Environment: A, B or C. The "ready grid" section needs a Supabase project that holds
`public.catalogue_titles` (the curated TMDB snapshot) and the server variables
`SUPABASE_URL` + `SUPABASE_ANON_KEY` (or the `VITE_` pair they fall back to). The hosted
project already holds the snapshot, so environments pointed at it run section C. Only an
environment without Supabase shows the unconfigured state, and there it is the real assertion.

## Goal

Prove a first-time visitor can reach every entry point, that a host can find their jams, that
Discover shows only authorized catalogue titles and never invents them, that it is usable
with a remote/keyboard, and that missing configuration becomes an explicit state instead of a
half-rendered grid or a fake room.

## Preconditions

- The app is reachable at the recorded origin and `GET /api/health` returns `200`.
- Record whether `SUPABASE_URL`/`SUPABASE_ANON_KEY` (or `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`)
  are configured (say only `set`/`missing`).

## A. Home, registry and entry points

### 1. Load the home screen

- Do: `navigate_page` to `/`. Take a snapshot.
- Expect:
  - The brand reads `REVERIE`.
  - Primary navigation has a `Discover` link and a `Movie Jam` control.
  - Heading `Make the next scene together.`
  - Controls `Start a Movie Jam`, `Join with an invite`, and a link `Find something to watch`.
  - A section `How Movie Jam works` with `Invite the room`, `Direct the turn`,
    `See it evolve`.
  - Footer text containing `REVERIE / MOVIE JAM` and `Made for HackBarna 2026`.
- Evidence: `uj-01-home.png`.

### 2. Start a Movie Jam opens the registry

- Do: click `Start a Movie Jam`.
- Expect: URL `/jams`; heading `Your stories, still running.`; a `Start a new jam` button; a
  list region that resolves from `Loading your jams…` to either jam cards or the empty state
  `No running jams yet.`
- Evidence: `uj-01-registry.png`.

### 3. Registry states

- Expect, depending on environment:
  - Environment C: a status notice `Supabase is not configured. These are browser-only
    preview registrations.`
  - With Supabase and at least one jam: each card shows `STATUS · PUBLIC|INVITE ONLY`, the
    title, the premise, and an `Open jam` button. Completed/closed jams are absent.
  - With Supabase and no jams: `No running jams yet.` plus
    `Your next room will appear here as soon as it is registered.`
- Do: if a card exists, click `Open jam`.
- Expect: URL `/jams/<slug>` and the room header appears (full behaviour in UJ-03); return to
  `/jams`.
- Evidence: `uj-01-registry-card.png`.

### 4. Start a new jam

- Do: on `/jams`, click `Start a new jam`.
- Expect: URL `/jams/new`; heading `Set the first scene.`; `Jam title`; a `Story source`
  radiogroup with `From scratch` and `Import a script`; the `Script length` group; a
  `Who can join?` select; a `Write the script` button. No room or script is shown yet.
- Do: click `← Back to your jams`.
- Expect: URL `/jams` again.
- Evidence: `uj-01-create.png`.

### 5. Join screen

- Do: from `/`, click `Join with an invite`.
- Expect: URL `/join`; heading `Take a seat in the room.`; fields `Invite code` and
  `Your display name`; a `Join the room` button (disabled when the build has no Supabase).
- Evidence: `uj-01-join.png`.

### 6. Browser back/forward

- Do: from `/`, click `Start a Movie Jam`; then `navigate_page type=back`; then
  `type=forward`.
- Expect: back returns to `/`; forward returns to `/jams`. No blank screen or error.
- Evidence: one screenshot after each navigation.

### 7. Open Discover and return

- Do: from `/` click `Find something to watch`.
- Expect: URL `/discover`; the header label `DISCOVER`; heading `What are we watching tonight?`;
  one supporting line; a search field. The header mentions neither the data source nor what
  the product does not do.
- Do: click the `Movie Jam` control in the Discover header.
- Expect: URL `/` and the hero visible again.
- Evidence: `uj-01-discover.png`, `uj-01-discover-exit.png`.

## B. Discover states

### 8. Loading state

- Do: `navigate_page` to `/discover`; snapshot immediately.
- Expect: a busy region reading `Loading films…` while pending. Missing it because
  the response is instant is acceptable; note it.
- Evidence: `list_network_requests` filtered to `/api/catalogue`; record status and that the
  request used `query`, `page=1`, `pageSize=24`.

### 9. Assert the state the environment actually supports

Read the `/api/catalogue` response and branch:

- `200 { "status": "catalogue_not_configured" }`:
  - Expect `Catalogue not configured`, the server's safe message, and `Waiting on:` listing
    the missing variable names.
  - Expect **no** title cards, no invented film names, no poster images.
  - Evidence: `uj-01-not-configured.png`.
- `200 { "status": "ok", "items": [...] }`: continue to section C.
- `4xx/5xx { "status": "error" }`:
  - Expect `Films could not be loaded`, the safe message and a `Reference:` code.
  - Expect `Try again` only when `retryable` is `true`.
  - Expect the safe message to contain none of: the credential, the upstream URL, or an
    upstream body.
  - Evidence: `uj-01-error.png`.

## C. Discover ready grid (only with a configured catalogue)

### 10. Grid renders only real records

- Do: `resize_page` to a TV-like size (for example `1920x1080`); snapshot.
- Expect:
  - A list `Films`; each card shows a title and `year · genre`, and nothing in place of
    metadata a record lacks.
  - Every poster box is 2:3 before its image arrives, so nothing moves as images load.
  - A missing poster renders `No artwork supplied`, not a broken image.
  - An attribution line appears when the API returns one.
  - No generated Jam scene or invented title appears.
- Evidence: `uj-01-grid.png`.

### 11. Search and empty state

- Do: focus `Search films` and type a distinctive term from a visible title.
- Expect: after roughly 320 ms the grid updates; every card matches the term (or the empty
  state appears). Network shows at most one request per paused input, not one per keystroke.
- Do: press `Escape` in the field.
- Expect: the field clears and the grid returns to the unfiltered set.
- Do: search a term that cannot match (for example `zzzzzzzznoresult`).
- Expect: `Nothing matches` and `Nothing matches “…”. Try another title, mood or genre.`
- Expect: every change of search or refinement starts again from page 1 at the top.
- Evidence: `uj-01-search.png`, `uj-01-empty.png`.

### 12. Keyboard traversal

- Do: focus the search field, press `ArrowDown`, then `ArrowRight`, `ArrowLeft`,
  `ArrowDown`, `ArrowUp`.
- Expect: focus moves to the first card, then between cards by the live column count, and
  never leaves the grid. `ArrowUp` from the first row returns focus to the search field.
- Do: press `Home` then `End`.
- Expect: focus moves to the row's first then last card.
- Evidence: `uj-01-keyboard.png` after each move (focus ring visible).

### 13. Film page

- Do: with a card focused, press `Enter` (repeat with `Space`).
- Expect: the URL becomes `/discover/<id>` and the film's page covers the screen: backdrop,
  poster, title, and only the fields the record holds (tagline, year, running time, score with
  votes, genres, synopsis, release date, languages, keywords, IMDb). Nothing reads "unknown",
  "0" or "—". A `What to do with this film` group holds `Not this one`. The TMDB attribution bar
  is visible. Focus is on `All films`; arrows walk the page's controls.
- Do: press `Escape`.
- Expect: URL `/discover`, the grid exactly where it was, and focus on the film that was opened.
- Do: `navigate_page type=forward`, then `type=back`.
- Expect: forward reopens the same film page; back returns to the grid with focus on that film.
- Do: open a film, then reload the page.
- Expect: the same film page renders, with one `GET /api/catalogue-title?id=<id>` and no list
  request. `Escape` then shows the grid.
- Do: open `/discover/abc` and `/discover/1`.
- Expect: `This film isn’t here`; `/discover/abc` makes no request.
- Evidence: `uj-01-film.png`, `uj-01-film-reload.png`.

### 14. Nothing implies where to watch

- Expect: neither the grid nor a film page shows a `Where to watch` block or a streaming claim.
  Availability is empty in every response.

### 15. The grid grows as the viewer moves through it

- Only when the response reports `hasMore: true`.
- Do: with the remote keys, move focus into the last row of posters.
- Expect: `Loading more…` at the end of the grid, then one request with `page=2`; the new
  posters are appended below and focus stays on the same poster.
- Do: scroll with the mouse or touch towards the end of the grid.
- Expect: the next page loads the same way. At most one page request is in flight at a time.
- Do: reach the last page (a narrow search).
- Expect: no further requests and nothing written at the end of the grid.
- Do: make a page request fail (block `/api/catalogue` in DevTools), then trigger it.
- Expect: `More films could not be loaded.` with `Try again` at the end of the grid; every
  poster already loaded stays. `ArrowDown` from the last row reaches `Try again`.
- Evidence: `uj-01-grid-page-2.png`, `uj-01-grid-failed.png`.

### 16. The API refuses what it should

- Do: `evaluate_script` a `fetch("/api/catalogue", { method: "POST" })` from the app origin.
- Expect: `405 { "status": "error", "code": "METHOD_NOT_ALLOWED" }`.
- Do: fetch `/api/catalogue?pageSize=9999` and `?page=0`.
- Expect: a typed `4xx` with `code: "INVALID_QUERY"`, not a stack trace or SPA HTML.
- Evidence: the JSON bodies (they contain no secrets).

## D. Unconfigured build states

### 17. Join is unavailable, not simulated

- Do: only in environment C, open `/join` and try to submit.
- Expect: `Join the room` is disabled; a notice says Supabase is not configured in this
  build, so no jam can be joined from here; no RPC is sent and no fake lobby appears.
- Evidence: `uj-01-join-disabled.png`.

### 18. Health is process health only

- Do: `navigate_page` to `/api/health`.
- Expect: `{ "status": "ok", "service": "reverie-movie-jam" }`. This says nothing about
  database or provider readiness; the report must not claim otherwise.
- Evidence: the JSON body.

## Pass criteria

- All entry points work and no route is blank or 404. `Start a Movie Jam` leads to the
  registry, and `Start a new jam` leads to the create form.
- The registry shows only open jams this identity may see, or an explicit empty/preview state.
- The Discover state the environment supports is exactly one of the four, with expected copy.
- No invented title, no generated Jam artifact, and no leaked credential or upstream URL.
- Keyboard focus follows the grid; a film has its own URL that survives a reload, and
  `Escape` or Back returns to the grid with focus on that film.
- The API guard rejects methods and out-of-range queries with typed JSON.

## Failure signals

- A poster or title that did not come from the response.
- An error page that includes a Supabase key or access token, the upstream URL, or upstream JSON.
- Focus lost to the page body after closing a film page, a retry, or new posters arriving.
- A film page showing "unknown", "0" or "—" for a field the record lacks.
- A 500 or an HTML body where typed JSON is expected.
- Join appearing to succeed without Supabase, or `/jams/new` opening a studio for a room
  called "new".

## Teardown

- Close the page(s). Do not hammer the catalogue endpoint; the adapter rate-limits per
  instance and a self-inflicted `RATE_LIMITED` is not a product failure.

## Not covered

- Real catalogue correctness beyond what the authorized endpoint returns.
- Natural-language discovery turns (`POST /api/discover/turns` is not implemented).
- Live media (Vonage), which is a separate slice.
