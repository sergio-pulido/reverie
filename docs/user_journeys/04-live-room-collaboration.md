# UJ-04 — Live room: join, collaborate, moderate

Covers: the invite lifecycle and join form, the invite-only waiting lobby and host admission,
the public-room immediate admit, cross-session chat/proposals, reconnect recovery, host
moderation, and the denied-access and RLS guarantees that back it.
Runtime: ~25 minutes.
Environment: A or B. Needs a room: create one with [UJ-02](02-reproduce-the-video.md)
or the fixture in [Appendix A](README.md#appendix-a--seed-a-room-without-a-provider-call).

## Goal

Prove entitlement is the invite code rather than the room URL, that two independent people
see each other's contributions in real time and recover from a dropped connection, and that
membership and the invite are host-controlled and server-owned so no participant can admit,
promote or re-enter themselves.

## Preconditions

- Three isolated browser contexts (see [Multi-actor isolation](README.md#multi-actor-isolation-important)):
  - `reverie-host` — the session that registered or owns the room.
  - `reverie-guest` — a clean context with no prior session.
  - `reverie-outsider` — a clean context used only for denial checks.
- The room slug and its 8-character invite code. The code alphabet excludes `I`, `O`, `U`.
- **No Presence in this build.** The roster marks members as active, not online/away, and the
  header shows `N in the room`, not `N connected now`. Do not assert a connected-now count.

## A. Host opens the room and the invite

### 1. Host Studio

- Do: in `reverie-host`, `navigate_page` to `/jams/<slug>`.
- Expect:
  - Briefly `Opening the room…`, then the room header with eyebrow `MOVIE JAM /` and a
    connection badge that settles on `LIVE`.
  - The jam title and `Invite-only room · 1 in the room`.
  - Actions `Leave` and a host-only `Invite people` button.
  - Panels `STORY CONVERSATION`, `Proposal queue`, `LIVE STAGE`, `IN THE ROOM` with one
    director marked `· host · you`, and `LOBBY` showing `0 waiting`.
  - The `LIVE STAGE` panel reads that live media is not enabled for this deployment when
    Vonage is unconfigured. That is expected; live media is a separate slice.
- Evidence: `uj-03-host-studio.png`; record the slug.

### 2. The invite panel

- Do: click `Invite people`.
- Expect a dialog named `Invite people to this jam`:
  - Heading `Share the room.`
  - A QR code for the same URL as the link.
  - The invite code as plain text, plus the description of its lifetime (for example
    `This invite does not expire. Revoke it when the room is full.`).
  - `The code is the entitlement. A room link without it grants nothing.`
  - Buttons `Copy invite link`, `Revoke`, and rotate choices `New code · 30 minutes`,
    `New code · 2 hours`, `New code · No expiry`.
- Expect the underlying read to be the host-only `get_jam_invite` RPC. Record `<CODE>`.
- Evidence: `uj-03-invite-panel.png`; the invite payload (a shareable invite, not a credential).

## B. Guest joins an invite-only room

### 3. Open the invite

- Do: in `reverie-guest`, `navigate_page` to `/join?jam=<slug>&code=<CODE>`.
- Expect: heading `Take a seat in the room.`; `Invite code` prefilled from the URL (case
  insensitive, separators stripped); intro `Enter the invite code the host shared. A room link
  on its own is not an invite.`
- Evidence: `uj-03-join-prefilled.png`.

### 4. Submit the form

- Do: fill `Your display name` = `Guest Alpha`, click `Join the room`.
- Expect:
  - One RPC `request_jam_admission` with the code and name.
  - Invite-only room → `memberStatus: waiting`; the view becomes `You are in the lobby for
    <room title>. The host admits directors one at a time.` with a status notice and an
    `Open the lobby` button.
  - The page states it checks every few seconds.
  - No conversation, proposals or roster are shown.
- Evidence: `uj-03-guest-waiting.png`; the RPC response.

### 5. Unknown, expired and revoked invites are one answer

- Do: in a fresh context, submit `/join` with a code that cannot exist (for example
  `ZZZZZZZZ`).
- Expect: a typed notice `That invite is not available.` The guest is not admitted and no room
  is shown. The database returns this for unknown, expired and revoked codes alike, so a probe
  cannot tell a private room exists at a code.
- Do: after the host revokes or rotates the invite (section G), try the old link in a fresh
  context.
- Expect: the same `That invite is not available.`
- Evidence: `uj-03-unknown-code.png`, `uj-03-stale-code.png`.

## C. Host admits the guest

### 6. Lobby updates live, then admit

- Do: in `reverie-host`, wait for Postgres Changes on `jam_members`.
- Expect: `LOBBY` shows `1 waiting` with a `Guest Alpha` row and `Admit` / `Refuse`.
- If it does not update within ~15 s: mark the realtime step `FAIL`, reload the host page, and
  continue to record the non-realtime outcome. Report both.
- Do: click `Admit`.
- Expect: one `set_jam_member_status` RPC with `active`; `LOBBY` returns to `0 waiting`;
  `Guest Alpha` appears under `IN THE ROOM`; the header count increases.
- Evidence: `uj-03-host-lobby.png`, `uj-03-host-admitted.png`; the RPC response.

### 7. Guest enters the live room automatically

- Do: watch `reverie-guest` **without clicking anything**.
- Expect:
  - The lobby polls its own membership row every ~5 s and, when it turns `active`, the client
    subscribes and loads the room automatically. No manual refresh should be needed.
  - The view becomes `STORY CONVERSATION`, `Proposal queue`, `LIVE STAGE`, the roster with
    `Guest Alpha · you`, badge `LIVE`, and no lobby panel.
- If admission is not detected within ~15 s: report it as a defect with the network trace.
- Evidence: `uj-03-guest-active.png`.

## D. Public room variant

### 8. Public admits immediately

- Do: register a second room with `Who can join? = Public room` (UJ-02 or the fixture with
  `visibility: "public"`). In a clean context open `/join?code=<public code>`, name
  `Guest Beta`, join.
- Expect: the RPC returns `memberStatus: active`; the guest lands on `/jams/<slug>` already
  active, with no lobby panel.
- Evidence: `uj-03-public-active.png`.

## E. Collaboration

### 9. Live baseline

- Do: snapshot both active pages.
- Expect on each: badge `LIVE`; `IN THE ROOM` lists `Host <n> · host` and `Guest Alpha`; empty
  panels `No lines yet. The first one sets the tone.` and `Nothing queued yet.`; a `LIVE STAGE`
  panel whose availability text matches the deployment.
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
- Expect: exactly five lines on both sides, no duplicates, and the two sessions converge on one
  order; the message field caps at 500 and the proposal field at 280 with no longer body sent.
- Evidence: `uj-03-burst-host.png`, `uj-03-burst-guest.png`.

### 13. Reload and reconnect recover durable state

- Do: `navigate_page type=reload` on the guest; wait for `LIVE`.
- Expect: conversation and proposals are restored from the authorized snapshot, no duplicates.
- Do: `emulate` network conditions `Offline` on the guest; send
  `UJ sent while guest offline` from the host; then clear the emulation.
- Expect: the guest badge leaves `LIVE` (not `denied`) while offline, and on reconnect returns
  to `LIVE` and shows the offline message after the snapshot reload, with no manual reload.
  This step is best-effort; report the observed transition if it does not recover.
- Evidence: `uj-03-reload.png`, `uj-03-reconnect-before.png`, `uj-03-reconnect-after.png`.

## F. Moderation and denied access

### 14. Refuse a waiting guest

- Do: have a fresh guest request admission so they appear in `LOBBY`; click `Refuse`.
- Expect: one `set_jam_member_status` RPC with `removed`; the row leaves the lobby; the guest's
  lobby becomes `The host did not admit you.` with `NOT ADMITTED`, no back button (the top bar
  and the remote's Back leave), and no room access.
- Evidence: `uj-03-refused.png`, `uj-03-refused-guest.png`.

### 15. Remove an active participant

- Do: in `reverie-host`, click `Remove` next to `Guest Alpha`.
- Expect: the RPC returns `Guest Alpha` as `removed`; the participant disappears from the host
  roster and the header count decreases; the host cannot be removed from this control.
- Evidence: `uj-03-host-removed.png`; the RPC response.

### 16. The removed guest loses the room

- Do: observe `reverie-guest`, then reload.
- Expect:
  - The removal arrives over Realtime and the guest can no longer contribute.
  - The guest sees `The host did not admit you.` / `NOT ADMITTED` (or, after a reload, an
    access screen), never the conversation or composer.
  - Report it as a defect if the removed guest can still send a message or read the
    conversation.
- Evidence: `uj-03-guest-after-removal.png`.

### 17. Re-entry is refused

- Do: in `reverie-guest`, open `/join?code=<CODE>` and submit the same name.
- Expect: the RPC returns `42501`; the notice shows `access to this jam was revoked`; the guest
  is not admitted and does not become `waiting`.
- Evidence: `uj-03-reentry-refused.png`.

### 18. A bare link is not an invite

- Do: in `reverie-outsider`, `navigate_page` directly to `/jams/<slug>` **without** a code.
- Expect: `This room is not open to you.` with a message that an invite is needed. No roster,
  chat, proposals or invite code.
- Evidence: `uj-03-bare-link-denied.png`.

## G. Invite lifecycle is host-only and server-owned

### 19. Rotate invalidates old links, revoke closes the door

- Do: as the host, open the invite panel and click `New code · 30 minutes`.
- Expect: a new 8-character code; the description says it works for about 30 minutes.
- Do: a fresh context tries the previous code.
- Expect: `That invite is not available.` Nobody already in the room is removed.
- Do: as the host, click `Revoke`.
- Expect: the description reads `This invite was revoked. Rotate it to let anyone else in.`
  and a fresh context cannot join with the current code.
- Evidence: `uj-03-rotated.png`, `uj-03-revoked.png`.

### 20. The invite is unreadable to a non-host

- Do: as an active non-host, `select` `invite_code` from `jams` for this room (via
  `evaluate_script` with the session already in the browser; never print the token).
- Expect: the column is not readable — a `403`/`42501` column-privilege error. A member cannot
  re-share the entitlement.
- Do: as the same non-host, call `get_jam_invite`, `rotate_jam_invite` and `revoke_jam_invite`.
- Expect: each is refused with `only the host can see the invite` / `only the host can change
  the invite` (`42501`).
- Evidence: the status and truncated bodies.

## H. The server owns membership

Run these from the page context with the session already in the browser, returning only HTTP
status and a short error text. **Never print, screenshot or store the access token.**

### 21. A participant cannot admit or promote themselves

- Do: as the (removed or active) guest, call `set_jam_member_status` for your own user id with
  `active`:

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

### 22. Nobody can insert a membership row directly

- Do: `fetch("/rest/v1/jam_members", { method: "POST", … })` claiming `role: "host",
  status: "active"` for the guest's own id.
- Expect: a `401`/`403` row-level-security refusal. There is no insert policy on
  `jam_members`.
- Evidence: status and truncated body.

### 23. Only the host sees the waiting list

- Do: with a new waiting guest present, `select` from `jam_members` for this jam as the host
  and as an active non-host.
- Expect: the host receives the waiting rows; the active member receives only their own row
  plus the active roster and **no** waiting rows. This is a policy, not a UI choice.
- Evidence: the two response bodies.

### 24. Outsiders read nothing

- Do: in `reverie-outsider`, obtain a session by submitting `/join` with any wrong code (the
  app signs in anonymously before the RPC returns the denial), then `select` `jam_members`
  and `jam_messages` for this jam.
- Expect: empty results — never a peer's row.
- Evidence: the select responses.

### 25. The host's own row is protected

- Do: call `set_jam_member_status` for the host's own user id with `removed`.
- Expect: the schema-authored refusal `the host cannot change their own membership`; the room
  still has its host.
- Evidence: the response body.

### 26. Failed invite lookups are throttled

- Do: only if you can afford to burn the window, submit more than 10 wrong invite codes from
  one identity within 10 minutes.
- Expect: after 10 failures the RPC answers `Too many invite attempts. Try again shortly.`
  (`rate_limited`). Note honestly that identity is anonymous, so this bounds probing from one
  session rather than making enumeration impossible.
- Evidence: the notice and the RPC result.
- Do not run this before the other invite steps; it locks the identity out for the window.

## Pass criteria

- Entitlement is the invite code; a bare room link grants nothing; unknown, expired and revoked
  codes are indistinguishable.
- Rotation invalidates old links and revocation blocks new arrivals without removing members.
- Invite-only guests wait and then enter automatically once admitted; public guests enter
  active; only the host can admit or remove.
- Durable chat and proposals cross sessions without reload, converge on one order, and survive
  reload/reconnect from the authorized snapshot.
- A removed participant cannot contribute, re-enter, or read the room.
- The invite is unreadable to non-hosts; rotation, revocation and self-promotion are refused.
- No non-host sees the waiting list, the invite, or another participant's private rows.

## Failure signals

- A guest placed `active` in an invite-only room without admission, or not entered after being
  admitted (a polling defect).
- A waiting or removed participant can read chat, proposals or the roster.
- The invite or waiting list visible to a non-host.
- A stale (rotated/revoked) code still admitting someone.
- A duplicate row after reconnect, or a message that only appears after manual reload.
- A non-host successfully changing membership, or a direct insert succeeding.

## Teardown

- Close all three contexts. Record the room slug, invite code and which context held each
  identity. If you rotated the invite, record the current code.

## Not covered

- Votes, scene transitions, forks and generation (not implemented).
- Live media / Vonage (separate slice; the `LIVE STAGE` panel is only checked for its
  availability text).
- Presence: this build has none, so no connected-now assertion is possible.
