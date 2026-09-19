# RV-06 — Realtime participants, chat and proposals

## Problem

The Studio screen held local React state. Nothing a participant wrote reached anyone else,
and the room had no notion of who was connected.

## Authority model

- **Postgres rows under RLS are the durable truth.** `jam_messages` and `jam_proposals` are
  append-only logs written by active members only.
- **Postgres Changes** notify subscribers about those rows. They are delivered per
  subscriber under the same policies, so a waiting, removed or outside session receives
  nothing.
- **Presence** reports who is connected right now. It is display state, never entitlement.
- **Broadcast is not used as authority** and carries no story state in this slice.

## Identity

`author_id` defaults to `auth.uid()` and the insert policy requires `author_id = auth.uid()`.
The browser never sends an author id, so an author cannot be forged by editing a payload.

## Client behaviour

| Requirement | Implementation |
| --- | --- |
| Admission contract checked first | `loadJamSnapshot` reads the membership row before any chat or proposal query; a non-active member gets the lobby view |
| Snapshot on connect and reconnect | every `SUBSCRIBED` transition reloads `loadJamSnapshot`, so a gap is closed by durable state rather than by replaying missed events |
| Deduplication | `mergeRow` is keyed by row id and re-sorted by `(created_at, id)`, so a redelivered change is idempotent and two clients converge on one order |
| Subscription cleanup | `subscribeToJamRoom` returns a disposer that untracks presence, removes the channel and silences every in-flight callback |
| Connection state | `idle · connecting · live · reconnecting · offline · denied` is rendered in the room header; `denied` is never shown as a network blip |
| Visible errors | every failure becomes a typed `JamError` with a safe message shown in the room. Only a message our own schema authored (marked at the raise site) is displayed; a native Postgres message naming a table or constraint is replaced by fixed text |
| No silent local fallback | a configured Supabase project that fails leaves the room in an error state; the local preview exists only when Supabase is unconfigured |

## Schemas

`src/core/jam.ts` holds Zod schemas for every row and RPC payload plus the pure merge
rules. It imports nothing from React, the DOM or a provider SDK. A row that fails
validation is dropped rather than rendered.

## Explicitly not in this slice

Scene acceptance and generation. Changing a proposal status is a scene transition and
needs the versioned, transactional command contract from `docs/API_CONTRACTS.md`
(`expectedStateVersion`, idempotent `requestId`, serialized commit). No update policy on
`jam_proposals` exists, so no client can fake one.

## Verification

`scripts/verify-realtime.mjs` drives three independent anonymous sessions against a real
Supabase project: lobby placement, refusal of self-admission and direct membership
inserts, host admission, cross-session Realtime delivery of a message and a proposal,
snapshot recovery after a dropped subscription, host-only visibility of the waiting lobby,
outsider denial, removal, and refusal to re-enter with the same invite code after removal.

## Known gaps

The script has not been run: this repository has no Supabase project credentials and no
hosted database has been migrated. Presence is not yet reconciled with the roster on a
host device that never subscribes, and there is no rate limit on message or proposal
inserts beyond Supabase's own.
