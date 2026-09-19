# UJ-07 — Studio chat, proposals, and presence

Covers: append-only chat and proposals crossing two independent sessions over Supabase
Realtime, presence, reconnect snapshot recovery, and the honest absence of scene acceptance.
Runtime: ~12 minutes.
Environment: A or B, with the host and an admitted guest from
[UJ-06](06-join-lobby-and-admission.md).

## Goal

Prove two people in the same room see each other's contributions without reloading, converge
on one order, survive a dropped connection without losing durable state, and cannot fake
scene acceptance.

## Preconditions

- `reverie-host` shows the active room; `reverie-guest` shows the active room
  (`Guest Alpha · you`).
- Both badges read `LIVE`. If a badge shows `NOT CONNECTED` or `OFFLINE`, note it and retry.

## Steps

### 1. Confirm the live baseline

- Do: snapshot both pages.
- Expect on each:
  - Connection badge `LIVE`.
  - `IN THE ROOM` lists `Host <n> · host` and `Guest Alpha`, with connected dots for both.
  - Header `… in the room · 2 connected now` (allow a moment for Presence to sync).
  - Empty panels show `No lines yet. The first one sets the tone.` and
    `Nothing queued yet.`
- Evidence: `uj-07-baseline-host.png`, `uj-07-baseline-guest.png`.

### 2. Host message reaches the guest

- Do: in `reverie-host`, type `UJ host says hello` in `Say something to the room…` and click
  `Send`.
- Expect:
  - Host: the line appears immediately (optimistic/insert echo), authored `Host <n>`.
  - Guest: the same line appears **without a reload** as a Postgres Change on `jam_messages`.
  - The guest's line is attributed `Host <n>`, never a UUID.
- Evidence: `uj-07-host-message.png`, `uj-07-guest-receives.png`.

### 3. Guest message reaches the host

- Do: in `reverie-guest`, send `UJ guest says hello`.
- Expect: the line appears on both sides, authored `Guest Alpha`.
- Evidence: `uj-07-guest-message.png`, `uj-07-host-receives.png`.

### 4. Proposals

- Do: in each session, add a proposal (`Add a character, twist, shot, or feeling…`):
  host adds `UJ proposal host`, guest adds `UJ proposal guest`.
- Expect:
  - The `Proposal queue` shows both on both sides, each with author and status `queued`.
  - The queue keeps creation order; a redelivered event does not duplicate a row.
  - The note `Accepting a proposal into a scene needs the versioned transactional contract
    that is not implemented yet.` is visible.
  - There is **no** `Accept` control anywhere in the queue.
- Evidence: `uj-07-proposals-host.png`, `uj-07-proposals-guest.png`.

### 5. Ordering and deduplication under a burst

- Do: from the host, send five distinct lines quickly (`UJ burst 1` … `UJ burst 5`).
- Expect on both sides: exactly five lines, no duplicates, no reordering between the two
  sessions after they settle. Compare the two lists in the report.
- Evidence: `uj-07-burst-host.png`, `uj-07-burst-guest.png`.

### 6. Limits are enforced

- Do: attempt to send a message longer than 500 characters (the field caps at 500) and a
  proposal longer than 280 (caps at 280).
- Expect: the fields stop at their limits; no request is sent with a longer body. A
  server-side rejection, if forced, is a typed error shown in a notice, not a crash.
- Evidence: field values.

### 7. Reload restores durable state

- Do: `navigate_page type=reload` on `reverie-guest`.
- Expect: after reconnecting (`LIVE`), the conversation and proposal queue are restored from
  the authorized snapshot, including the burst lines. No duplicates appear.
- Evidence: `uj-07-reload-guest.png`.

### 8. Reconnect closes the gap (best effort)

- Do: in `reverie-guest`, `emulate` network conditions `Offline`.
- Expect: the badge leaves `LIVE` (it may show `OFFLINE` or `RECONNECTING`). This is not a
  `denied` state.
- Do: while offline, send `UJ sent while guest offline` from the host (it only needs the
  host's connection).
- Do: clear the emulation (omit `networkConditions`) on the guest.
- Expect: the guest reconnects to `LIVE` and the offline message appears after the snapshot
  reload, without a manual page reload.
- Evidence: `uj-07-reconnect-before.png`, `uj-07-reconnect-after.png`, and the console/network
  if the state does not recover.

### 9. A closed/removed session is not a blip

- Skip here; covered by [UJ-08](08-membership-control-and-denied-access.md). Do not confuse
  `denied` with the transient states in step 8.

## Pass criteria

- Every durable row added by one active member arrives at the other without a reload.
- Both sessions converge on the same order with no duplicates.
- A reload and a reconnect both recover the missing rows from the authorized snapshot.
- No author is ever shown as a raw user id.
- Proposals stay `queued`; there is no fake scene acceptance.

## Failure signals

- A message appears only after a manual reload.
- A row is duplicated after a reconnect.
- The guest can read or write after being removed (UJ-08).
- An `Accept` control, or a proposal that changes status without the unimplemented contract.

## Teardown

- Keep both contexts for UJ-08. Do not close the guest context before removal is tested.

## Not covered

- Presence accuracy beyond "both online" (Presence is display state, not entitlement).
- Voting, scene transitions or generation (not implemented).
