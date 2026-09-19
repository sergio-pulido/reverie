# UJ-03 — Live room: join, collaborate, moderate

Covers: the invite entitlement and join form, the invite-only waiting lobby and host
admission, the public-room immediate admit, cross-session chat/proposals/presence, reconnect
recovery, and host moderation with the denied-access and RLS guarantees that back it.
Runtime: ~25 minutes.
Environment: A or B. Needs a room: create one with [UJ-02](02-jam-lifecycle-create-script-video.md)
or the fixture in [Appendix A](README.md#appendix-a--seed-a-room-without-a-provider-call).

## Goal

Prove entitlement is the invite code rather than the room URL, that two independent people
see each other's contributions in real time and recover from a dropped connection, and that
membership is host-controlled and server-owned so no participant can admit, promote or
re-enter themselves.

## Preconditions

- Three isolated browser contexts (see [Multi-actor isolation](README.md#multi-actor-isolation-important)):
  - `reverie-host` — the session that created or owns the room.
  - `reverie-guest` — a clean context with no prior session.
  - `reverie-outsider` — a clean context used only for denial checks.
- The room slug and its 8-character invite code. The code alphabet excludes `I`, `O`, `U`.

## A. Host opens the room

### 1. Host Studio

- Do: in `reverie-host`, `navigate_page` to `/jams/<slug>`.
- Expect:
  - Briefly `Opening the room…`, then the room header with eyebrow `MOVIE JAM /` and a
    connection badge that settles on `LIVE`.
  - The jam title and `Invite-only room · 1 in the room · 1 connected now` (counts may settle
    after Presence sync).
  - Actions `Leave` and a host-only button `Invite code <CODE>`.
  - Panels `STORY CONVERSATION`, `Proposal queue`, `IN THE ROOM` with one director marked
    `· host · you`, and `LOBBY` showing `0 waiting`.
- Evidence: `uj-03-host-studio.png`; record `<CODE>` and the slug.

### 2. The invite is a URL with a code

- Do: inspect the `Invite code` button. It copies `<origin>/join?jam=<slug>&code=<CODE>` to
  the clipboard; do not rely on clipboard permission. Confirm the code is 8 characters from
  the unambiguous alphabet.
- Expect: the code, not the URL, is the entitlement.
- Evidence: the shareable URL (a shareable invite, not a credential).

## B. Guest joins an invite-only room

### 3. Open the invite

- Do: in `reverie-guest`, `navigate_page` to `/join?jam=<slug>&code=<CODE>`.
- Expect: heading `Take a seat in the room.`; `Invite code` prefilled from the URL (case
  insensitive, separators stripped); intro `Enter the invite code the host shared. A room
  link on its own is not an invite.`
- Evidence: `uj-03-join-prefilled.png`.

### 4. Submit the form

- Do: fill `Your display name` = `Guest Alpha`, click `Join the room`.
- Expect:
  - One RPC `request_jam_admission` with the code and name.
  - Invite-only room → `memberStatus: waiting`; the view becomes `You are in the lobby for
    <room title>. The host admits directors one at a time.` with a status notice and an
    `Open the room` button.
  - No conversation, proposals or roster are shown.
- Evidence: `uj-03-guest-waiting.png`; the RPC response.

### 5. Unknown code is refused

- Do: in a fresh context (or after leaving), submit `/join` with a code that cannot exist
  (for example `ZZZZZZZZ`).
- Expect: a typed notice `That invite code does not match an open jam.` — the guest is not
  admitted and no room is shown.
- Evidence: `uj-03-unknown-code.png`.

## C. Host admits the guest

### 6. Lobby updates live, then admit

- Do: in `reverie-host`, wait for Postgres Changes on `jam_members`.
- Expect: `LOBBY` shows `1 waiting` with a `Guest Alpha` row and `Admit` / `Refuse`.
- If it does not update within ~15 s: mark the realtime step `FAIL`, reload the host page,
  and continue to record the non-realtime outcome. Report both.
- Do: click `Admit`.
- Expect: one `set_jam_member_status` RPC with `active`; `LOBBY` returns to `0 waiting`;
  `Guest Alpha` appears under `IN THE ROOM`; the header count increases.
- Evidence: `uj-03-host-lobby.png`, `uj-03-host-admitted.png`; the RPC response.

### 7. Guest enters the live room

- Do: in `reverie-guest`, click `Open the room`, then `Check again` if shown.
- Expect:
  - A waiting guest has **no active subscription**, so admission is not pushed live: they
    see `Waiting for the host.` with `Check again` until they refresh it (or reload).
  - After that: `STORY CONVERSATION`, `Proposal queue`, the roster with `Guest Alpha · you`,
    badge `LIVE`, and no lobby panel.
- Report the manual `Check again`/reload as a known gap, not a failure.
- Evidence: `uj-03-guest-active.png`.

## D. Public room variant

### 8. Public admits immediately

- Do: create a second room with `Who can join? = Public room` (UJ-02 or the fixture with
  `visibility: "public"`). In a clean context open `/join?code=<public code>`, name
  `Guest Beta`, join.
- Expect: the RPC returns `memberStatus: active`; the guest lands on `/jams/<slug>` already
  active, with no lobby panel.
- Evidence: `uj-03-public-active.png`.

## E. Collaboration

### 9. Live baseline

- Do: snapshot both active pages.
- Expect on each: badge `LIVE`; `IN THE ROOM` lists `Host <n> · host` and `Guest Alpha` with
  connected dots; header `2 connected now`; empty panels `No lines yet. The first one sets
  the tone.` and `Nothing queued yet.`
- Evidence: `uj-03-baseline-host.png`, `uj-03-baseline-guest.png`.

### 10. Chat crosses sessions

- Do: host sends `UJ host says hello`; guest sends `UJ guest says hello`.
- Expect: each line appears on **both** sides without a reload (Postgres Changes on
  `jam_messages`); each is attributed to a display name, never a UUID.
- Evidence: `uj-03-chat-host.png`, `uj-03-chat-guest.png`.

### 11. Proposals

- Do: host adds `UJ proposal host`; guest adds `UJ proposal guest`.
- Expect: the `Proposal queue` shows both on both sides with author and status `queued`; the
  note `Accepting a proposal into a scene needs the versioned transactional contract that is
  not implemented yet.` is visible; there is **no** `Accept` control.
- Evidence: `uj-03-proposals.png`.

### 12. Ordering, dedupe and limits

- Do: host sends `UJ burst 1` … `UJ burst 5` quickly.
- Expect: exactly five lines on both sides, no duplicates, and the two sessions converge on
  one order; the message field caps at 500 and the proposal field at 280 with no longer body
  sent.
- Evidence: `uj-03-burst-host.png`, `uj-03-burst-guest.png`.

### 13. Reload and reconnect recover durable state

- Do: `navigate_page type=reload` on the guest; wait for `LIVE`.
- Expect: conversation and proposals are restored from the authorized snapshot, no
  duplicates.
- Do: `emulate` network conditions `Offline` on the guest; send
  `UJ sent while guest offline` from the host; then clear the emulation.
- Expect: the guest badge leaves `LIVE` (not `denied`) while offline, and on reconnect returns
  to `LIVE` and shows the offline message after the snapshot reload, with no manual reload.
  This step is best-effort; report the observed transition if it does not recover.
- Evidence: `uj-03-reload.png`, `uj-03-reconnect-before.png`, `uj-03-reconnect-after.png`.

## F. Moderation and denied access

### 14. Refuse a waiting guest

- Do: have a fresh guest request admission so they appear in `LOBBY`; click `Refuse`.
- Expect: one `set_jam_member_status` RPC with `removed`; the row leaves the lobby.
- Evidence: `uj-03-refused.png`.

### 15. Remove an active participant

- Do: in `reverie-host`, click `Remove` next to `Guest Alpha`.
- Expect: the RPC returns `Guest Alpha` as `removed`; the participant disappears from the
  host roster and the header count decreases; the host cannot be removed from this control.
- Evidence: `uj-03-host-removed.png`; the RPC response.

### 16. The removed guest loses the room

- Do: observe `reverie-guest`, then use `Check again` or reload.
- Expect:
  - The removal arrives over Realtime and the guest can no longer contribute.
  - **Known behaviour to record:** a removed participant can briefly be shown the same
    `Waiting for the host.` panel as a waiting one, because the component only distinguishes
    "active" from "not active". After `Check again`/reload the guest must see
    `This room is not open to you.` with the typed forbidden message.
  - Report it as a defect if the removed guest is stuck on a `WAITING` panel with no denied
    path, or if they can still send a message.
- Evidence: `uj-03-guest-after-removal.png`, `uj-03-guest-denied.png`.

### 17. Re-entry is refused

- Do: in `reverie-guest`, open `/join?code=<CODE>` and submit the same name.
- Expect: the RPC returns `42501`; the notice shows `access to this jam was revoked`; the
  guest is not admitted and does not become `waiting`.
- Evidence: `uj-03-reentry-refused.png`.

### 18. A bare link is not an invite

- Do: in `reverie-outsider`, `navigate_page` directly to `/jams/<slug>` **without** a code.
- Expect: `This room is not open to you.` with a message that an invite is needed. No roster,
  chat, proposals or invite code.
- Evidence: `uj-03-bare-link-denied.png`.

## G. The server owns membership

Run these from the page context with the session already in the browser, returning only HTTP
status and a short error text. **Never print, screenshot or store the access token.**

### 19. A participant cannot admit or promote themselves

- Do: as the (removed or active) guest, call the admission-status RPC for your own user id
  with `active`:

  ```js
  async () => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
    const parsed = JSON.parse(localStorage.getItem(key));
    const res = await fetch("/rest/v1/rpc/set_jam_member_status", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${parsed.access_token}` },
      body: JSON.stringify({ p_jam_id: "<jamId>", p_member_id: parsed.user.id, p_status: "active" }),
    });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  }
  ```

- Expect: a `401`/`403` refusal (`only the host can change membership`), never a success.
- Evidence: status and truncated body.

### 20. Nobody can insert a membership row directly

- Do: `fetch("/rest/v1/jam_members", { method: "POST", … })` claiming `role: "host",
  status: "active"` for the guest's own id.
- Expect: a `401`/`403` row-level-security refusal. There is no insert policy on
  `jam_members`.
- Evidence: status and truncated body.

### 21. Only the host sees the waiting list

- Do: with a new waiting guest present, `select` from `jam_members` for this jam as the host
  and as an active non-host.
- Expect: the host receives the waiting rows; the active member receives only their own row
  plus the active roster and **no** waiting rows. This is a policy, not a UI choice.
- Evidence: the two response bodies.

### 22. Outsiders read nothing

- Do: in `reverie-outsider`, obtain a session by submitting `/join` with any wrong code (the
  app signs in anonymously before the RPC fails), then `select` `jam_members` and
  `jam_messages` for this jam.
- Expect: empty results — never a peer's row.
- Evidence: the select responses.

### 23. The host's own row is protected

- Do: call `set_jam_member_status` for the host's own user id with `removed`.
- Expect: the schema-authored refusal `the host cannot change their own membership`; the room
  still has its host.
- Evidence: the response body.

## Pass criteria

- Entitlement is the invite code; a bare room link grants nothing.
- Invite-only guests wait until a host admits; public guests enter active; only the host can
  admit or remove.
- Durable chat and proposals cross sessions without reload, converge on one order, and
  survive reload/reconnect from the authorized snapshot.
- A removed participant cannot contribute, re-enter, or read the room.
- Self-promotion and direct membership inserts are refused by RLS/RPC.
- No non-host sees the waiting list, the invite code, or another participant's private rows.

## Failure signals

- A guest placed `active` in an invite-only room without admission.
- A waiting or removed participant can read chat, proposals or the roster.
- The invite code or waiting list visible to a non-host.
- A duplicate row after reconnect, or a message that only appears after manual reload.
- A non-host successfully changing membership, or a direct insert succeeding.
- A removed guest permanently stuck on a waiting panel with no denied state.

## Teardown

- Close all three contexts. Record the room slug, invite code and which context held each
  identity.

## Not covered

- Votes, scene transitions, forks and generation (not implemented).
- Presence accuracy beyond "both online" (Presence is display state, not entitlement).
- Admission rate limiting (configured in the Supabase dashboard, not here).
