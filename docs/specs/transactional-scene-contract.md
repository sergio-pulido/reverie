# Versioned transactional scene contract

**Status: intended, not implemented.** This records the command contract that turns a queued
proposal into an accepted scene turn. No `vote.cast`, no `scene.accept`, no story version and no
idempotency register exists in the code today. `docs/PROJECT_STATE.md` names this as the
milestone that must land *before* any story-level generation; this document is that milestone's
target shape, not a report of behaviour.

## Problem

`jam_proposals` and `jam_messages` are append-only logs
(`supabase/migrations/20260919190000_jam_collaboration.sql`). The proposals table already carries
a `status` column with the vocabulary `queued | accepted | rejected | superseded`, but **no
update policy exists on it**, so no client can move a proposal out of `queued`. That was a
deliberate refusal, recorded in `docs/specs/jam-realtime-collaboration.md`: changing a proposal's
status is a scene transition, and a scene transition needs a versioned, serialized, idempotent
command — not a row update from a browser.

The result is a room that can talk and propose but cannot decide. The `collecting → voting →
accepted → generating → ready` lifecycle in `docs/STATE_MACHINE.md` has no implementation at any
step, and the Studio says so on screen (`src/screens/Studio.tsx`).

## Vocabulary

- **Proposal** — one participant's queued creative suggestion. Already durable.
- **Scene turn** — the unit a room accepts: exactly one proposal, committed as the next beat of
  the story.
- **Story version** — a monotonically increasing integer per jam, incremented by exactly one on
  each accepted turn. It names *which* creative history the room is on.
- **`stateVersion`** — the compare-and-swap guard carried by every command and every event. It
  is the room's whole mutable state, not just the story; a vote changes it too.

Story version and `stateVersion` are distinct on purpose: two votes then an acceptance move
`stateVersion` three times and story version once.

## The command envelope

Every state-changing command carries `schemaVersion`, `requestId`, `expectedStateVersion`,
`type` and a typed payload, per `docs/API_CONTRACTS.md`. Three rules make that envelope worth
having:

1. **Compare-and-swap.** A command whose `expectedStateVersion` is not the room's current one is
   refused with a conflict error *and the current snapshot*. It is never merged, never retried
   server-side, and never partially applied.
2. **Idempotency.** `requestId` is recorded with its outcome. A replay — a retried fetch, a
   double-tapped button, a reconnect — returns the **original** outcome rather than performing
   the command again. The register is per jam and bounded; an expired `requestId` is treated as
   new, so the window must outlive any client retry policy.
3. **Serialization.** Accepted scene transitions for one jam commit one at a time. Two
   simultaneous acceptances do not interleave; the second sees the first's `stateVersion` and
   loses the compare-and-swap.

## Where it runs

Acceptance is a **`security definer` RPC**, not a browser table write and not a Broadcast
message. This follows the pattern already proven for admission and invites
(`request_jam_admission`, `set_jam_member_status`): the browser holds no insert, update or
delete policy on the rows that matter, and the constrained function is the only mutation path.

Broadcast carries no authority. It cannot accept a scene, cast a vote or move a version — the
same rule `docs/specs/jam-realtime-collaboration.md` already states for membership.

## Voting

`vote.cast` records one active member's vote on one queued proposal.

- One effective vote per member per proposal. Re-casting replaces; it does not accumulate.
- A vote is a row under RLS with `voter_id` defaulted to `auth.uid()` and pinned by policy, so a
  voter cannot be forged by editing a payload — the identity rule already used for `author_id`.
- Only an **active** member may vote. Waiting, left and removed participants are refused by the
  same membership predicate the existing policies use.
- Votes are visible to active members as they land, through Postgres Changes.
- **The tally rule is server-owned.** Whether acceptance needs a plurality, a threshold, a
  quorum, or only the host's word is configuration the server reads; the browser renders the
  outcome and never computes entitlement.

## Acceptance — one commit

`scene.accept` is authorized for the host, or for any active member when the configured vote
rule is already satisfied. It commits **atomically**:

- the named proposal becomes `accepted`;
- every other proposal still `queued` in that turn becomes `superseded` — not `rejected`, which
  is reserved for an explicit refusal;
- the story version increments by one;
- `stateVersion` increments;
- the scene enters `generating`.

Either all of that lands or none of it does. A partially accepted turn — a proposal marked
accepted while the story version stands still — is the failure this contract exists to prevent.

## Interaction with the portion lock window

Portion playback is already implemented and already owns a lock boundary
(`docs/API_CONTRACTS.md`, "Portion playback, locking, and video generation"): portions at or
below `currentPortionIndex + 1` are immutable, and any edit touching them is refused with
`portion_locked`.

An accepted scene turn is an edit like any other, and **the lock boundary wins**:

- An acceptance whose committed change would touch a played or locked portion is refused with
  `portion_locked`, carrying the locked index and the playback `stateVersion`. It is not
  silently dropped and not partially applied.
- The playback guard must be read **inside the same per-jam critical section** as the acceptance
  commit, exactly as the portion-edit router already does, so the boundary cannot move between
  check and write.
- Structural edits remain forbidden in v1. An accepted turn rewrites the content fields of
  freely-editable portions; it does not insert, delete or reorder them, because flat portion
  indices are the address used by generation job keys.

This is the constraint most likely to be missed: the scene contract is a *story* contract, but
it commits into a script whose tail is already being bought as video.

## Generation, and what a failure means

Generation runs **after** the commit, never as part of it. A failed provider call therefore
leaves the accepted creative direction intact: the room keeps the turn it decided on, media is
marked delayed or failed, and an explicit retry is offered. The server never fabricates a
generated scene, never silently falls back to a mock, and discards late provider output after a
room close or a superseding story version.

## Events

`vote.updated`, `scene.processing`, `story.updated` and `artifact.updated` already appear in the
event vocabulary in `docs/API_CONTRACTS.md`. Each carries `eventId`, `roomId`, `stateVersion`,
`occurredAt`, `type` and payload. A subscriber that missed events recovers by reloading the
authorized snapshot, not by replay — there is no persisted event log, and this contract does not
add one.

## Errors

Typed, per the existing rule: `code`, `safeMessage`, `retryable`, `requestId`; never a
credential, a raw provider body or an internal prompt. This contract needs at least:

| Code | Meaning | Retryable |
| --- | --- | --- |
| `stale_state_version` | `expectedStateVersion` is behind; the current snapshot is attached | yes, after reconciling |
| `portion_locked` | the commit would change a played or locked portion | no |
| `vote_rule_unmet` | a non-host acceptance where the configured rule is not satisfied | no |
| `proposal_not_queued` | the named proposal is already accepted, rejected or superseded | no |
| `not_active_member` | the caller is waiting, left or removed | no |

## Open questions (unspecified)

- The vote rule itself — plurality, threshold, quorum, host veto — and whether it is per jam,
  per host or global. This spec fixes *where* the rule lives, not what it is.
- Whether a turn has an explicit boundary (a "call the vote" step) or whether acceptance simply
  supersedes whatever is queued at that instant.
- The lifetime of the `requestId` register, and what a replay outside the window should return.
- Whether `rejected` is reachable at all in v1, or whether refusal is only ever `superseded`.
- How a story version relates to a fork point — see
  `docs/specs/script-forking-and-chat-editing.md`, which needs a declared past version to fork
  from and would be the first consumer of story versioning.
- Whether the durable playback cursor (currently in-memory only) must land first, since a
  restart today returns a jam to `idle` while its clips remain.

## Implementation status

**Nothing in this spec is implemented.** There is no votes table, no `vote.cast` or
`scene.accept` RPC, no story version column, no `requestId` register, and no serialization
around a scene commit. What exists is the refusal: `jam_proposals.status` has the right
vocabulary and **no update policy**, so the illegal path is closed even though the legal one is
not open. See the register in `docs/specs/intended-vs-implemented.md`.

The compare-and-swap *mechanism* does exist elsewhere and should be reused rather than
reinvented: `JamStore.updatePlayback` guards on `stateVersion` and fails with
`stale_state_version` (`apps/server/jams.ts`), and the per-jam critical section that serializes
portion mutations is in the same module.
