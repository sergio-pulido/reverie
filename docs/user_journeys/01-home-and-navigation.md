# UJ-01 — Home and navigation

Covers: the landing screen, its entry points, and movement between `/`, `/jams/new`,
`/join` and `/discover`.
Runtime: ~3 minutes.
Environment: A, B or C (no Supabase, no provider required).

## Goal

Confirm that a first-time visitor can reach every entry point from the home screen, that the
copy describes the product honestly, and that navigation does not strand the user.

## Preconditions

- The app is reachable at the recorded origin and `GET /api/health` returns `200`.

## Steps

### 1. Load the home screen

- Do: `navigate_page` to `/`. Take a snapshot.
- Expect:
  - The page title/brand reads `REVERIE`.
  - A primary navigation exists with a `Discover` link and a `Movie Jam` control.
  - Heading `Make the next scene together.`
  - Buttons labelled `Start a Movie Jam`, `Join with an invite` and a link
    `Discover real films`.
  - A section `How Movie Jam works` with three articles titled `Invite the room`,
    `Direct the turn`, `See it evolve`.
  - Footer text containing `REVERIE / MOVIE JAM` and `Made for HackBarna 2026`.
- Evidence: `uj-01-home.png`; `network.list` shows `GET /` `200` and `GET /api/health` if the
  client calls it (it may not).

### 2. Start a Movie Jam

- Do: click the control named `Start a Movie Jam`.
- Expect: URL becomes `/jams/new`; heading `Set the first scene.`; a `Jam title` field and a
  `Write the script` button are present. The screen must **not** present a room or a script.
- Evidence: `uj-01-create.png`.

### 3. Return home from create

- Do: click `← Back to Reverie` (or the `REVERIE` brand).
- Expect: URL is `/`; the hero from step 1 is visible again.
- Evidence: `uj-01-back-home.png`.

### 4. Open the join screen

- Do: click `Join with an invite`.
- Expect: URL becomes `/join`; heading `Take a seat in the room.`; fields `Invite code` and
  `Your display name`; a `Join the room` button disabled when the build has no Supabase.
- Evidence: `uj-01-join.png`.

### 5. Open Discover

- Do: from `/` click `Discover real films`.
- Expect: URL becomes `/discover`; heading `Find something real to watch.`; a search field is
  present. (Discover behaviour is UJ-02.)
- Evidence: `uj-01-discover.png`.

### 6. Return from Discover

- Do: click the `Movie Jam` control in the Discover header.
- Expect: URL is `/` and the hero is visible.
- Evidence: `uj-01-discover-exit.png`.

### 7. Browser back/forward

- Do: from `/`, click `Start a Movie Jam`, then use `navigate_page type=back`, then
  `type=forward`.
- Expect: back returns to `/`; forward returns to `/jams/new`. No blank screen or error.
- Evidence: one screenshot after each navigation.

## Pass criteria

- All seven steps show their expected screen and URL.
- No console error of severity `error` appears during navigation (warnings are reported, not
  failed).
- No notice claims a room, script or catalogue exists when it does not.

## Failure signals

- A dead control, a 404 route, or a blank screen.
- The create/join screens claim a room exists before the user has created one.
- `/jams/new` opening a studio screen for a room named "new".

## Teardown

- Close the page.

## Not covered

- Discover states beyond the landing (UJ-02).
- Any room creation (UJ-03 onward).
