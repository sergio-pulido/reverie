# Spec — opt-in live media with the Vonage Video API

Status: implemented for camera, microphone and screen share. Recording, export and
creative transformation are deliberately out of scope and are not implemented.

## Goal

A jam participant can deliberately join the room's live stage with camera, microphone or
screen, and can stop at any moment. Everything about that contribution — who owns it, what
it is for, whether consent stands, when it expires, and the reference other parts of the
product may cite — is a row the room can read, not client state.

## Boundaries

- The browser never sees `VONAGE_API_SECRET`. It receives only the public project key, a
  session id and a short-lived token minted for it.
- The browser never chooses its role. The server maps membership to a Vonage role.
- No raw media is recorded or retained. Sessions are created with `archiveMode=manual`
  and no archive, broadcast, render or transformation call exists in this slice.
- Live media is opt-in per participant and per track. Joining the stage publishes nothing
  until the participant enables a track.

## Authorization — `POST /api/live/token`

Request: `{ "jamId": "<uuid>" }` plus `Authorization: Bearer <Supabase access token>`.

The function, in order:

1. Refuses a method other than `POST`, and refuses a cross-origin browser call.
2. Applies a per-instance rate limit (10 requests per minute per client).
3. Refuses unless `REVERIE_LIVE_ENABLED=true` and both Vonage credentials are present
   (`live_not_configured`), so live media cannot half-exist.
4. Resolves the caller's identity from Supabase Auth using the presented access token. An
   absent, malformed or rejected token is `LIVE_UNAUTHENTICATED`. The browser never sends a
   user id.
5. Reads the caller's own `jam_members` row under RLS with that same token. Anything other
   than `status = 'active'` is `LIVE_FORBIDDEN`; a `completed` or `closed` jam is refused.
6. Derives the role from the membership row: `host → moderator`, active member →
   `publisher`. A `role` field in the request body is ignored.
7. Reads the jam's stored Vonage session id, creating a session and recording it through
   `ensure_jam_live_session` when the jam has none.
8. Mints a connection token valid for 10 minutes (hard maximum 15) and returns
   `{ apiKey, sessionId, token, role, expiresAt }`.

Every failure is `{ status: "error", code, safeMessage, retryable }`. No code carries the
credential, the upstream URL or the upstream body.

## Consent record

`jam_live_consents` is the register. One row per participant per track kind:

| Column | Meaning |
| --- | --- |
| `owner_id` | `auth.uid()`, defaulted and pinned by policy |
| `kind` | `camera`, `microphone` or `screen` |
| `purpose` | the declared creative purpose, 3–200 characters |
| `asset_ref` | server-issued `live:<uuid>`; a trigger overwrites whatever the client sent |
| `granted_at` / `expires_at` | lifetime; the trigger clamps expiry into `(now, now + 2h]` |
| `withdrawn_at` | set only by `withdraw_live_consent` |

A consent is effective only while `withdrawn_at is null and expires_at > now()`. Active
members read the register, so the room can always see who is live and what for. There is no
client update or delete policy: withdrawal is a constrained `security definer` function that
can only stamp the caller's own row.

Withdrawing stops the use, not just the record: the owner's client unpublishes and stops the
underlying track immediately, and every other client sees the row change through Postgres
Changes and drops the reference. An expired consent behaves the same way without any call.

## Client behaviour

- Joining requires a declared purpose per track. There is no implicit publish.
- A denied browser permission is a distinct, stated state; it is never retried silently and
  never reported as a network fault.
- Vonage session reconnection is surfaced (`connecting · live · reconnecting · offline`).
  A token expires in 10 minutes, so a rejoin mints a new one.
- Leaving, losing consent, unmounting the studio or closing the tab destroys the publisher
  and calls `stop()` on every track it owns.

## Not in this slice

Archiving, broadcast, RTMP output, captions, fal.ai transformation of a live feed, and any
export. Each needs its own permission, its own consent field and its own budget, and none is
enabled as a side effect of joining a stage.
