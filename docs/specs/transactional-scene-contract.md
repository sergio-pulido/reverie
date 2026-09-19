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

A third counter already exists and must not be duplicated blindly:
`scriptRevisionSchema.revision` (`src/core/scriptHistory.ts`) is a monotonic per-jam integer over
an append-only log. It is not the same as a story version — a revert increments the revision and
does not advance the story, and an accepted turn may produce one revision or none — but two
monotonic per-jam counters over the same history is a smell. Either the story version is defined
*in terms of* the revision log, or one of the two should go, and whichever is chosen needs a
sentence of justification at the point of implementation.

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

**A warning from the nearest precedent.** `POST /api/jams/:id/playback/start` and `/advance` are
host-only in `docs/API_CONTRACTS.md` and host-only in the UI, and the Express routes enforce
nothing — any caller can drive playback and trigger paid generation. That gap is tracked as row
12 of `docs/INCONSISTENCIES.md` (PR #8) and is unowned. "Host-only" written in a contract is not
authorization; this spec's host and vote-rule checks must be enforced where the state changes,
or acceptance will inherit exactly the same hole.

## Prerequisite — the commit spans two systems today

**This contract cannot be implemented as written until the proposal and the script live in one
durable store.** The atomic commit below crosses a boundary that currently exists, and saying so
is part of the spec rather than a caveat on it. Verified in the code:

| What the commit touches | Where it lives today |
| --- | --- |
| `jam_proposals` status | Supabase Postgres, under RLS |
| The script and its revisions | The Node process — `InMemoryJamStore` is the only implementation of `JamStore` (`apps/server/jams.ts:138`), and **no server code references `jam_scripts` or `jam_script_revisions` at all**; that migration exists and nothing reads it |
| The playback cursor | The Node process — `PlaybackCoordinator` keeps its own `Map` (`apps/server/playback.ts:76`) |
| The per-jam critical section | `withJamLock` (`apps/server/jams.ts:115`), a Node mutex |

A Postgres `security definer` function cannot read a Node mutex, a `Map` in another process, or
an in-memory script. So "the proposal becomes accepted **and** the story version increments, or
neither does" has no mechanism today, and neither does reading the playback guard inside the
same critical section as the commit.

Three honest exits, none of which this document picks:

1. **Move the script into Postgres first.** The migration is already written and unread, and the
   durable-cursor gap is already on the register. Largest change, and the only one where the
   whole contract holds as stated.
2. **Let the Node server own acceptance,** reducing the RPC to the vote and authorization half.
   Keeps atomicity, moves the authority boundary, and needs its own answer for how a Node process
   authorizes against Supabase identity.
3. **Bound the guarantee explicitly** — atomicity covers the Postgres half until the script is
   durable — and say so wherever the contract is quoted.

Until one is chosen, **do not implement the acceptance path and do not describe it as atomic.**
Whichever is chosen, it is a decision to record in `docs/DECISIONS.md`, not an implementation
detail. (This constraint was found by the RV-17 session while cross-checking this spec against
the code; the anchors above were re-verified here.)

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
  is reserved for an explicit refusal. Under the outline model in
  `docs/specs/story-outline.md` this is mechanical rather than conventional: an accepted edit
  re-derives every beat after the edited one, so any other queued proposal aimed at a downstream
  beat is stale **by construction**;
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
- **The critical section must not contain a provider call.** If accepting a turn triggers work
  that calls a model — the outline cascade in `docs/specs/story-outline.md` is one completion —
  holding `withJamLock` across it freezes the room for the length of a generation. Compute
  optimistically outside the lock, then take it once and commit, refusing with `portion_locked`
  if the boundary moved meanwhile. The check is also smaller than it looks: the lock window is a
  **prefix**, and a forward-only cascade need only test the earliest portion it touches.
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

## Relationship to the story outline

`docs/specs/story-outline.md` (RV-17) specifies a layer between the script and the reader: one
brief phrase — a **beat** — per portion, centralized so that many mechanisms (votes, chat, polls,
direct rewrites) can change the story without each learning to edit a screenplay. An edit to a
beat cascades forward and re-derives the script.

The two documents meet at a clean seam and neither subsumes the other:

- **This contract is the gate** — who may change the story, and the envelope the change travels
  in.
- **The outline is the change** — what a modification *is*, and what it does to the script.

In the outline's terms a proposal is a proposed edit, and accepting one admits it to the outline
queue. Read together they describe one path; read alone, each is missing the other half.

**Unresolved between them:** whether a beat edit is gated by a vote at all. This spec assumes
propose-and-accept; the outline's brief describes direct edits with a cascade and mentions no
voting. Both can be true — edit rights without a formal vote is still a gate — but which one the
product wants has not been decided, and it is the one question here that changes what gets built
rather than how. It needs the user, not a reconciliation between two agents.

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
- Whether voting is the mechanism at all, or whether beat edit rights replace it — see
  "Relationship to the story outline" above. This is a product decision, not a design gap.
- Which of the three exits in "Prerequisite" is taken. Nothing below it can be built until then.

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
