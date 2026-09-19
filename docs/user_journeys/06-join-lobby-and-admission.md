# UJ-06 — Join with an invite, waiting lobby, and admission

Covers: the invite code and URL, the join form, the invite-only waiting lobby, host
admission, the public-room immediate admit, and the fact that a room link alone is not an
invite.
Runtime: ~10 minutes.
Environment: A or B, plus a room created by [UJ-03](03-create-jam-from-scratch.md) or the
fixture in [Appendix A](README.md#appendix-a--seed-a-room-without-a-provider-call).

## Goal

Prove that entitlement is the invite code, not the room URL; that an invite-only guest waits
until the host admits them; that a public guest enters immediately; and that membership is
changed only through the host tools.

## Preconditions

- Two isolated browser contexts:
  - `reverie-host` — the browser session that created or owns the room.
  - `reverie-guest` — a clean context with no prior session.
- The room slug and its 8-character invite code (from the host's `Invite code` button or the
  fixture output). The code alphabet excludes `I`, `O` and `U`.

## Steps

### 1. Open the host Studio

- Do: in `reverie-host`, `navigate_page` to `/jams/<slug>`.
- Expect:
  - Briefly `Opening the room…`, then the room header.
  - Eyebrow `MOVIE JAM /` with a connection badge; eventually `LIVE`.
  - The jam title and `Invite-only room · 1 in the room · 1 connected now` (counts may settle
    after Presence sync).
  - Actions `Leave` and a host-only button labelled `Invite code <CODE>`.
  - Panels: `STORY CONVERSATION`, `Proposal queue`, `IN THE ROOM` with one director marked
    `· host · you`, and `LOBBY` showing `0 waiting` / `Nobody is waiting for admission.`
- Evidence: `uj-06-host-studio.png`; record `<CODE>` and the slug.

### 2. The invite URL

- Do: inspect the `Invite code` button (the click copies to the clipboard; do not rely on
  clipboard permission). The shareable URL this control produces is
  `<origin>/join?jam=<slug>&code=<CODE>`.
- Expect: the code is exactly 8 characters from the unambiguous alphabet, and the URL
  carries the code as the entitlement.
- Evidence: the URL string with the code (this is a shareable invite, not a secret in the
  credential sense).

### 3. Guest opens the invite

- Do: in `reverie-guest`, `navigate_page` to `/join?jam=<slug>&code=<CODE>`.
- Expect:
  - Heading `Take a seat in the room.`
  - `Invite code` prefilled with the code from the URL (case-insensitive; separators are
    stripped).
  - Intro text `Enter the invite code the host shared. A room link on its own is not an
    invite.`
- Evidence: `uj-06-join-prefilled.png`.

### 4. Guest joins an invite-only room

- Do: fill `Your display name` = `Guest Alpha`, click `Join the room`.
- Expect:
  - One RPC `request_jam_admission` with the code and name.
  - Because the room is invite-only, the result is `memberStatus: waiting`.
  - The view changes to `You are in the lobby for <room title>. The host admits directors one
    at a time.`, a status notice about waiting, and a button `Open the room`.
  - No conversation, proposals or roster are shown.
- Evidence: `uj-06-guest-waiting.png`; the RPC response (contains no secret).

### 5. Host sees the waiting guest

- Do: in `reverie-host`, wait for the lobby to update (Postgres Changes on `jam_members`).
- Expect: `LOBBY` shows `1 waiting` and a row `Guest Alpha` with `Admit` and `Refuse`.
  Presence/subtitle counts are display-only and may lag.
- If it does not update within ~15 s: mark this step `FAIL` for realtime, then reload the host
  page and continue to record the non-realtime outcome. Report both.
- Evidence: `uj-06-host-lobby.png`.

### 6. Host admits the guest

- Do: click `Admit` for `Guest Alpha`.
- Expect:
  - One RPC `set_jam_member_status` with status `active`, returning the member now `active`.
  - `LOBBY` returns to `0 waiting` / `Nobody is waiting for admission.`
  - `IN THE ROOM` now lists `Guest Alpha` among the active directors; the header count
    increases.
- Evidence: `uj-06-host-admitted.png`; the RPC response.

### 7. Guest enters the live room

- Do: in `reverie-guest`, click `Open the room`.
- Expect:
  - If the guest is still on the waiting page, this opens `/jams/<slug>`. A waiting guest
    sees the `LOBBY` panel with `Waiting for the host.` and a `Check again` button.
  - Because the guest had no active subscription while waiting, they are **not** pushed the
    admission live. Click `Check again` (or reload).
  - After that, the active room appears: `STORY CONVERSATION`, `Proposal queue`, the roster
    with `Guest Alpha · you`, and no lobby panel.
- Evidence: `uj-06-guest-active.png`. Report whether the guest needed `Check again`/reload as
  a known gap, not a failure.

### 8. Public room admits immediately

- Do: this needs a second room created with `Who can join? = Public room` (repeat
  [UJ-03](03-create-jam-from-scratch.md) if providers allow, or seed a public fixture).
- Do: in a clean context, open `/join?code=<public code>`, enter `Guest Beta`, join.
- Expect: the RPC returns `memberStatus: active`, the guest is taken straight to
  `/jams/<slug>` with the active room view, and no lobby panel is shown.
- Evidence: `uj-06-public-active.png`.

### 9. A bare link is not an invite

- Do: in a third clean context (`reverie-outsider`), `navigate_page` directly to
  `/jams/<slug>` **without** a code.
- Expect: `This room is not open to you.` with a message that an invite is needed. No room
  data, roster, chat or invite code is exposed.
- Evidence: `uj-06-bare-link-denied.png`.

## Pass criteria

- The invite code resolves the room; a guest without membership sees no room data.
- Invite-only guests wait until a host action, and only the host can admit.
- Public guests enter active immediately.
- The host lobby shows who is waiting; a non-host never sees the waiting list.

## Failure signals

- A guest is placed `active` in an invite-only room without admission.
- A waiting guest can read chat, proposals, or the roster.
- The invite code is visible to a non-host.
- A direct `/jams/<slug>` visit shows room content.

## Teardown

- Keep the room and the admitted guest for UJ-07.
- Record slugs, codes and which context held each identity.

## Not covered

- Removal and re-entry refusal (UJ-08).
- Cross-session chat delivery (UJ-07).
