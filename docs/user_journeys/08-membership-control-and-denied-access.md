# UJ-08 — Membership control, removal, and denied access

Covers: host removal and refusal, what a removed participant can still see, re-entry
refusal, self-promotion and direct membership writes being impossible, and the host's own
row being protected.
Runtime: ~12 minutes.
Environment: A or B, reusing the host and guest contexts from
[UJ-06](06-join-lobby-and-admission.md) and the room from
[UJ-07](07-studio-realtime-collaboration.md).

## Goal

Prove membership is host-controlled and server-owned: a participant cannot admit or remove
anyone, cannot promote themselves, cannot write a membership row, and cannot return after
removal. Denial is shown as access ending, not as a network blip.

## Preconditions

- `reverie-host`: host, active, `LIVE`.
- `reverie-guest`: `Guest Alpha`, active, `LIVE`.
- Optionally a third clean context `reverie-outsider` with no membership.

## Steps

### 1. Refusing a waiting guest

- Do: if a fresh guest is available, have them request admission to the invite-only room so
  they appear in `LOBBY`. In `reverie-host`, click `Refuse`.
- Expect: one `set_jam_member_status` RPC with status `removed`; the row leaves the lobby.
- Do: that refused guest tries `/join?code=<CODE>` again.
- Expect: a typed error notice (see step 4) and no admission.
- Evidence: `uj-08-refused.png`.

### 2. Host removes an active participant

- Do: in `reverie-host`, in `IN THE ROOM`, click `Remove` next to `Guest Alpha`.
- Expect:
  - One `set_jam_member_status` RPC with status `removed`, returning `Guest Alpha` as
    `removed`.
  - `Guest Alpha` disappears from the host roster; the header count decreases.
  - The host remains host and cannot be removed from this control.
- Evidence: `uj-08-host-removed.png`; the RPC response.

### 3. The removed guest loses the room

- Do: observe `reverie-guest` immediately, then use its `Check again` button or reload.
- Expect:
  - The removal arrives over Realtime; the guest's subscription is torn down and the guest
    can no longer contribute.
  - **Known behaviour to record:** a removed participant can briefly be shown the same
    `Waiting for the host.` panel as a waiting one, because the component only distinguishes
    "active" from "not active". After `Check again` or a reload the guest must see
    `This room is not open to you.` and the typed forbidden message.
  - Report if the removed guest is left in a waiting panel with no path to the denied screen
    (a real defect), or if they can still send a message (a security defect).
- Evidence: `uj-08-guest-after-removal.png`, and the denied screen after `Check again`.

### 4. Re-entry with the same code is refused

- Do: in `reverie-guest`, `navigate_page` to `/join?code=<CODE>` and submit the same name.
- Expect: the RPC returns `42501`; the UI shows the schema-authored message
  `access to this jam was revoked`. The guest is not admitted and does not become `waiting`.
- Evidence: `uj-08-reentry-refused.png`.

### 5. A participant cannot admit or promote themselves

- Do: in `reverie-guest`, call the RPC directly from the page context, using the session
  already in the browser, and return only the HTTP status and error text. Do **not** print,
  screenshot or store the access token.

  ```js
  async () => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
    const session = JSON.parse(localStorage.getItem(key)).user; // user id only is needed
    const token = JSON.parse(localStorage.getItem(key)).access_token;
    const res = await fetch("/rest/v1/rpc/set_jam_member_status", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ p_jam_id: "<jamId>", p_member_id: session.id, p_status: "active" }),
    });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  }
  ```

- Expect: a refusal (`401`/`403`) whose body is a fixed RLS/permission error, never a success.
  The guest cannot make itself active, host, or rejoin.
- Evidence: the status and truncated body (no token).

### 6. Nobody can insert a membership row directly

- Do: in `reverie-guest`, `fetch("/rest/v1/jam_members", { method: "POST", ... })` with a body
  claiming `role: "host", status: "active"` for the guest's own id.
- Expect: a `401`/`403` row-level-security refusal. The browser has no insert policy on
  `jam_members`.
- Evidence: the status and truncated body.

### 7. Outsider is denied the room and its roster

- Do: in `reverie-outsider` (never admitted), `navigate_page` to `/jams/<slug>`.
- Expect: `This room is not open to you.` with the invite message, and no roster, chat,
  proposals or invite code.
- Do: with the outsider's token, `select` from `jam_members` and `jam_messages` for this jam.
  To obtain a session, first submit `/join` with any wrong code: the app signs the visitor in
  anonymously before the RPC fails, so a token exists without granting membership.
- Expect: an empty result (RLS filters every row) — never a peer's row.
- Evidence: `uj-08-outsider-denied.png`, the select response.

### 8. Only the host sees the waiting list

- Do: if a new waiting guest exists, query `jam_members` for this jam from the host and from
  an active non-host.
- Expect: the host receives the waiting rows; the active member receives only their own row
  plus the active roster, and **no** waiting rows. This is a database policy, not a UI choice.
- Evidence: the two response bodies.

### 9. The host cannot change their own membership

- Do: in `reverie-host`, call `set_jam_member_status` for the host's own user id with status
  `removed`.
- Expect: the schema-authored refusal `the host cannot change their own membership`; the room
  still has its host.
- Evidence: the response body.

## Pass criteria

- All membership changes go through the host RPCs and are reflected on both sides.
- A removed participant cannot contribute, re-enter, or read the room.
- Self-promotion and direct membership inserts are refused by RLS/RPC, not hidden by the UI.
- The host's own row is protected.

## Failure signals

- A non-host successfully changes a membership status.
- A direct `jam_members` insert succeeds.
- A removed participant can still send a message or read the roster.
- An outsider can read any member or message row.
- A removed guest is permanently stuck on a `WAITING` panel with no denied state.

## Teardown

- Close the outsider page. Note the room slug for cleanup. Do not leave removed test
  identities expecting access.

## Not covered

- League/rate limiting of admission attempts (dashboard configuration).
- Two hosts or host transfer (not supported).
