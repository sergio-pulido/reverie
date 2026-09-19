# Spec: invite lifecycle, QR sharing and live access status

Extends `docs/specs/jam-lobby-admission.md`. That slice made the invite code the
entitlement and gave the host a lobby. Four things it left open are closed here.

## Problem

1. **The invite never ends.** A code is valid forever and cannot be withdrawn. A link
   forwarded out of the room is permanent access to the admission queue.
2. **Every member can read the invite.** `jams.invite_code` is selectable by anyone the
   `jams` read policy admits, so an admitted participant can re-share the entitlement.
   The lobby is supposed to expose only the minimum a participant is authorized to see.
3. **A waiting participant is never told they were admitted.** Realtime authorization
   requires *active* membership, so a waiting participant holds no channel. The lobby
   claims "this page updates when you are admitted"; it does not.
4. **`qrcode.react` is installed and unused.** The host has a copy-the-code button and no
   way to put an invite in front of a room of people.

## Decisions

### Invite lifecycle is database state, not client state

`jams` gains `invite_expires_at` and `invite_revoked_at`. `request_jam_admission`
refuses a revoked or expired invite with a marked, non-enumerating message — the same
`jam: invite not found` used for an unknown code, so a probe cannot tell "wrong code"
from "this room exists but the invite lapsed".

Three host-only `security definer` functions own the lifecycle:

| Function | Effect |
| --- | --- |
| `get_jam_invite(jam)` | returns the code, expiry, revocation and derived state |
| `rotate_jam_invite(jam, minutes)` | mints a new code, sets/clears expiry, clears revocation |
| `revoke_jam_invite(jam)` | stamps `invite_revoked_at`; every outstanding link dies |

Rotation is the revocation-with-continuity path: the old code stops working the moment
the new one exists, because the code is a column, not a row.

### The invite is host-only at the column level

RLS is row-level; "a member may read this jam but not its invite code" is a column
privilege. Table-level `select` and `update` on `public.jams` are revoked from
`authenticated` and re-granted per column, excluding the three invite columns. A member
reading the room therefore cannot read the entitlement, and a host cannot hand-write a
predictable code through the normal update policy either — both paths go through the
functions above, which run as owner.

### Failed invite lookups are throttled per user

`public.jam_admission_attempts` counts failed lookups per authenticated user in a rolling
10-minute window and refuses after 10. The table has RLS on and **no policies**, and
neither helper function is granted to `authenticated`, so no caller can query it or inflate
someone else's count into a lockout.

What it is worth, stated honestly: the key is `auth.uid()`, and this product signs people in
anonymously, so an attacker can mint a fresh identity and reset the window. The throttle
raises the cost of scripted probing from a single session; it is not the barrier. The
barrier is the code's ~39 bits of entropy, backed by Supabase Auth's own limits on anonymous
sign-in, which must be configured before a public audience.

### A waiting participant polls their own membership row

A waiting participant has exactly one authorized fact: their own `jam_members` row. The
lobby polls it (5 s) and reacts to what it finds — `active` opens the room, `removed`
says access was refused, `waiting` keeps waiting. No new read surface is opened, and the
lobby copy stops promising an update it could not deliver. Polling stops as soon as the
participant is active, because from that point Postgres Changes carry the transition.

### The host shares a link and a QR of the same URL

`QRCodeSVG` from `qrcode.react` renders the invite URL that `inviteUrl()` already builds
(`/join?jam=<slug>&code=<code>`). The slug in that URL is navigation; the `code` is the
entitlement. The panel shows the state of the invite (active / expires in N / expired /
revoked) so a host never holds up a QR that has stopped working.

## Out of scope

- Per-guest single-use invites. The room-level invite plus host admission is the
  entitlement model this product uses; per-guest tokens would be a second one.
- Changing a proposal status, which still needs the versioned transactional contract.
