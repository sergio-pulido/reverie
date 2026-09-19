# UJ-02 — TV-first Discover

Covers: `/discover`, its four states (loading, not configured, error, ready/empty), search,
pagination, keyboard traversal, the title detail dialog, and the same-origin API guard.
Runtime: ~8 minutes.
Environment: A, B or C. The "ready" section additionally needs a configured
`TITAN_CATALOGUE_URL` + `TITAN_API_KEY`; without them it is `BLOCKED` and the unconfigured
state is the real assertion.

## Goal

Prove Discover shows only authorized catalogue titles, never invents or leaks them, is
usable with a remote/keyboard, and degrades into explicit states instead of a half-rendered
grid.

## Preconditions

- The app is reachable.

## Steps

### 1. Load Discover and the loading state

- Do: `navigate_page` to `/discover`. Immediately take a snapshot before the request settles.
- Expect: a busy region with text `Loading catalogue titles…` while pending. It is acceptable
  to miss this if the response is instant; note it.
- Evidence: `list_network_requests` filtered to `/api/catalogue`; record status and whether
  the request included `query`, `page=1`, `pageSize=24`.

### 2. Assert the state the environment actually supports

Read the `/api/catalogue` response:

- If it is `200 { "status": "catalogue_not_configured" }`:
  - Expect visible text `Catalogue not configured`, the server's safe message, and
    `Waiting on:` listing the missing variable names (`TITAN_CATALOGUE_URL` and/or
    `TITAN_API_KEY`).
  - Expect **no** title cards, no invented film names, and no poster images.
  - Evidence: `uj-02-not-configured.png`.
- If it is `200 { "status": "ok", "items": [...] }`: continue to step 3.
- If it is `4xx/5xx { "status": "error" }`:
  - Expect `Discover could not load the catalogue`, the safe message and a `Reference:` code.
  - Expect a `Try again` button only when `retryable` is `true`.
  - Expect the safe message to contain none of: the credential, the upstream URL, or an
    upstream body.
  - Evidence: `uj-02-error.png`.

### 3. Ready grid (only with a configured catalogue)

- Do: `resize_page` to a TV-like size (for example `1920x1080`), take a snapshot.
- Expect:
  - Heading `Find something real to watch.` remains.
  - A list `Catalogue titles`; each card shows a title and metadata
    (`year · rating · genre`), or `Catalogue title` when metadata is absent.
  - A missing poster renders `No artwork supplied` instead of a broken image.
  - An attribution line appears when the API returns one.
- Evidence: `uj-02-grid.png`.

### 4. Search

- Do: focus the `Search the catalogue` field and type a distinctive term from one visible
  title.
- Expect: after roughly 320 ms the grid updates to matching titles; every card title matches
  the term or is absent (empty state). No request fires per keystroke beyond the debounce.
- Do: press `Escape` in the search field.
- Expect: the field clears and the grid returns to the unfiltered set.
- Evidence: `uj-02-search.png`; network list showing at most one request per paused input.

### 5. Empty state

- Do: search a term that cannot match (for example `zzzzzzzznoresult`).
- Expect: `No catalogue titles match` and `Nothing in the catalogue matches “…”`. No cards.
- Evidence: `uj-02-empty.png`.

### 6. Keyboard traversal

- Do: focus the search field, press `ArrowDown`.
- Expect: focus moves to the first title card (the card receives visible focus).
- Do: press `ArrowRight`, `ArrowLeft`, `ArrowDown`, `ArrowUp`.
- Expect: focus moves between cards by the live column count and does not leave the grid.
  Pressing `ArrowUp` from the first row returns focus to the search field.
- Do: press `Home` then `End`.
- Expect: focus moves to the row's first then last card.
- Evidence: `uj-02-keyboard.png` after each move shows the focus ring.

### 7. Title detail dialog

- Do: with a card focused, press `Enter` (repeat with `Space`).
- Expect: a dialog opens whose accessible name is the title, showing title, metadata,
  synopsis when present, `Where to watch` when availability exists, and an attribution line.
  Focus moves into the dialog (the close control).
- Do: press `Tab` repeatedly to the last focusable element, then `Tab` again.
- Expect: focus wraps inside the dialog and never reaches the page behind it.
- Do: press `Escape`.
- Expect: the dialog closes and focus returns to the card that opened it.
- Evidence: `uj-02-detail.png`, `uj-02-detail-focus-trap.png`.

### 8. Availability links are safe

- Only if availability entries are shown.
- Do: inspect each `Where to watch` link.
- Expect: every link is `https:` and opens with `rel="noreferrer noopener"`; no `javascript:`
  or `http:` link is rendered. URLs the validator rejected are absent rather than broken.
- Evidence: snapshot of the dialog; do not follow the link.

### 9. Pagination

- Only when the response reports more than one page.
- Do: click `Next →`.
- Expect: the request uses `page=2`; the button is disabled on the last page; `← Previous`
  is disabled on page 1.
- Evidence: `uj-02-page-2.png`.

### 10. The API refuses what it should

- Do: `evaluate_script` a `fetch("/api/catalogue", { method: "POST" })` from the app origin.
- Expect: `405 { "status": "error", "code": "METHOD_NOT_ALLOWED" }`.
- Do: fetch `/api/catalogue?pageSize=9999` and `?page=0`.
- Expect: a typed `4xx` with `code: "INVALID_QUERY"`, not a stack trace or SPA HTML.
- Evidence: the JSON bodies (they contain no secrets).

## Pass criteria

- The state the environment supports is exactly one of the four, with the expected copy.
- No invented title, no generated Jam artifact, and no leaked credential or upstream URL.
- Keyboard focus follows the grid and is trapped in the dialog; `Escape` restores focus.
- The API guard rejects methods and out-of-range queries with typed JSON.

## Failure signals

- A poster or title that did not come from the response.
- An error page that includes `TITAN_API_KEY`, the upstream URL, or upstream JSON.
- `Escape` or `Tab` escaping the dialog, or focus lost to the page body.
- A 500 or an HTML body where a typed JSON error is expected.

## Teardown

- Close the page. Do not hammer the endpoint; the adapter rate-limits per instance and a
  self-inflicted `RATE_LIMITED` is not a product failure.

## Not covered

- Real catalogue correctness beyond what the authorized endpoint returns.
- Natural-language discovery turns (`POST /api/discover/turns` is not implemented).
