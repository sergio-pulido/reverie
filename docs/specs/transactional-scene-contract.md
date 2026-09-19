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

## What this contract owns — and what it does not

The product's shape, as the user states it: **any modification to the history triggers a refactor
downstream, and modifications are made from one centralized place.** The different elements of the
product interact with that history manager. There are several ways to edit it — up and down votes
on parts of the future, chat, polls, direct rewrites — and **the definition of those ways is the
subject of other efforts, not this document.**

So the boundary is:

| | Owned here | Owned elsewhere |
| --- | --- | --- |
| The envelope every modification travels in — `expectedStateVersion`, idempotent `requestId`, serialization, the atomic commit | ✅ | |
| The gate — that a modification is authorized, and refused when it would touch a played or locked portion | ✅ | |
| What a modification *is*, and how it cascades into the script | | `docs/specs/story-outline.md` |
| The ways to trigger one — voting rules, polls, chat, direct edit | | other efforts |

Voting appears below as **one mechanism, described to show what the envelope must carry** — not as
the definition of how the product decides. Its rules are somebody else's to fix, and this document
deliberately does not fix them.

The centralization is the load-bearing part. Because every mechanism reaches the history through
one manager, the envelope, the version counter and the lock boundary are written once here rather
than re-implemented per mechanism. A mechanism that writes to the history any other way is a bug,
however it is triggered.

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
| The lock boundary | The Node process — derived from the live director's position on the script clock (`src/core/directorBeats.ts`), across a jam's open streams (`DirectorStreamRegistry`) |
| The per-jam critical section | `withJamLock` (`apps/server/jams.ts:104`), a Node mutex |

A Postgres `security definer` function cannot read a Node mutex, an in-memory script, or a
stream position held in another process. So "the proposal becomes accepted **and** the story
version increments, or neither does" has no mechanism today, and neither does reading the lock
boundary inside the same critical section as the commit.

The portion-playback pipeline that used to hold a cursor was deleted when the live director
became the only video path, and that **did not** dissolve this problem — it moved where the
boundary comes from without moving which process owns it.

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

**Exit 1 has more ground under it than the table suggests.** The tables it needs already exist as
unread migrations — `jam_scripts`, `jam_script_revisions` (with `script jsonb`) and `jam_playback`
— and the mechanism is prescribed in **two independent places** in the repository:

- the comment on the `JamStore` interface (`apps/server/jams.ts:39-42`) requires that a Supabase
  implementation serialize per-jam mutations with, for example, a transaction holding a row lock
  on the jam's script row. Read its example list with care: it names `updatePlayback`, which no
  longer exists — the comment outlived the method when the portion pipeline was deleted. The
  prescription holds for the mutations that remain, `updatePortion` and `revertScriptToRevision`;
- the trailing note in the structured-revisions migration
  (`supabase/migrations/20260919190000_structured_script_revisions.sql:40-41`, after the
  `jam_playback` policies) instructs to take a transaction-level lock on the jam's `jam_scripts`
  row before reading the lock boundary or writing.

Those are not two mentions of one idea. They were written by different slices of work — the
storage work and the structured-revisions work — which arrived at the same row-lock design without
coordinating. Convergent evidence from independent authors is what makes exit 1 look like the
shape the system was always heading for, rather than a preference formed while writing this
document.

One constraint shapes the implementation: the server reaches Postgres only through
`@supabase/supabase-js`, so it gets one transaction per request, which means the mutating half has
to be `security definer` functions — the pattern `request_jam_admission` and
`set_jam_member_status` already use. If exit 1 is taken, claims 1 and 7 hold simultaneously and
this contract is implementable as written.

**A defect the current arrangement hides, and exit 1 also fixes.** `withJamLock`
(`apps/server/jams.ts:104`) is an in-process mutex. The routers it protects are mounted only in
the local Express host today, so it works; the moment they are deployed as Vercel functions, many
instances run at once and a per-process mutex serializes nothing — each invocation gets its own
empty map, and concurrent edits race with no error and no warning. Any exit that keeps
serialization in Node must replace that mutex with something cross-instance; exit 1 gets it from
the database transaction.

Deleting the portion pipeline narrowed this without closing it. The playback compare-and-swap it
used to guard is gone, but the mutex still wraps the two mutations that remain — the portion-edit
and revert routes — and those are precisely the ones the lock boundary protects. The exposure is
one subsystem's worth rather than three, and it matters more than before, because the boundary
being enforced is now real.

## Voting — one mechanism, shown for its requirements

Per the boundary above, the voting *rules* belong to another effort. What follows is what the
envelope must support if voting is among the mechanisms, and it is written to be read that way.
The user's brief for the outline names up and down votes on parts of the future history, chat and
polls together as intended mechanisms, so this is one adapter of several, not the path.

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

## Interaction with the beat lock window

The script's tail is already protected, and the protection is real rather than nominal. Per
`docs/API_CONTRACTS.md`, "Beat locking and the live director": **the lock window comes from the
stream.** A live director generates ahead of playback, so by the time a viewer sees beat N the
provider is already committed to N+1. `src/core/directorBeats.ts` derives the window from where
the stream has reached on the script clock:

- `beatIndex <= currentBeatIndex`: immutable (played or playing).
- `beatIndex == currentBeatIndex + 1`: **locked** — already with the provider.
- `beatIndex >= currentBeatIndex + 2`: freely editable.

Two properties of that source matter to this contract and did not hold under the old
portion-cursor model. **With no stream open, nothing is locked** — so an acceptance that would be
refused mid-session succeeds before one starts, and the same command is not idempotent across
that transition. And beat `0` is locked before the first chunk arrives, because `configure`
carried the whole script to the provider when the session opened. A jam may hold one stream per
configuration, and an edit is safe only if it is ahead of all of them, so the **strictest** open
stream sets the boundary (`DirectorStreamRegistry`).

This boundary is newly load-bearing. The predecessor `PlaybackGuard` defaulted to "everything
editable" and was never wired, so `portion_locked` could not fire at all; every statement below
was theoretical when first written and is now enforced.

An accepted scene turn is an edit like any other, and **the lock boundary wins**:

- An acceptance whose committed change would touch a played or locked beat is refused with
  `portion_locked`, carrying the boundary it violated. It is not silently dropped and not
  partially applied. `portion_locked` answers a script `PATCH` or revert; a direction naming a
  closed beat is refused with `beat_locked`. Same boundary, two doors, and an acceptance that
  produces both a script edit and a direction must not be able to pass one and fail the other.
- The guard must be read **inside the same per-jam critical section** as the acceptance commit,
  exactly as the portion-edit router already does, so the boundary cannot move between check and
  write. Note what the boundary now depends on: a stream advancing in real time. It can move
  between two reads for reasons that have nothing to do with the commit.
- **The critical section must not contain a provider call.** If accepting a turn triggers work
  that calls a model — the outline cascade in `docs/specs/story-outline.md` is one completion —
  holding `withJamLock` across it freezes the room for the length of a generation. Compute
  optimistically outside the lock, then take it once and commit, refusing with `portion_locked`
  if the boundary moved meanwhile. The check is also smaller than it looks: the lock window is a
  **prefix**, and a forward-only cascade need only test the earliest portion it touches.
- Structural edits remain forbidden in v1. An accepted turn rewrites the content fields of
  freely-editable portions; it does not insert, delete or reorder them. The justification has
  changed with the pipeline — flat indices are no longer a generation job key, because there are
  no per-portion generation jobs — but it has not weakened: `portionIndex` is the single address
  shared by script edits and by the director's beats, so renumbering would silently re-aim every
  open stream's boundary.

This is the constraint most likely to be missed: the scene contract is a *story* contract, but it
commits into a script whose tail a provider is already generating from.

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

**Settled.** This was briefly an open question — whether a beat edit is gated by a vote at all —
and it is not open. Both briefs say the same thing: there are to be several ways to modify the
history (up and down votes on parts of the future, chat, polls, direct rewrites), the history is
centralized precisely because there are several, and defining those ways is other efforts' work.
Voting is therefore one mechanism among several rather than the path or a displaced alternative,
and this contract is the envelope all of them travel in.

One naming hazard survives, and it is real rather than hypothetical. A vote on a **beat** — "not
this one", producing a re-roll intent with no replacement text — and a vote on a **proposal** —
deciding whether it is accepted — are different objects. Both are wanted. Both will be called
"voting" in the UI unless someone names them apart.

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
- What supplies serialization, now that nothing in `JamStore` does. The compare-and-swap that
  used to live on the playback record went with it, so whichever exit is taken has to build
  serialization rather than inherit it.
- Which of the three exits in "Prerequisite" is taken. Nothing below it can be built until then.

## Implementation status

**Nothing in this spec is implemented.** There is no votes table, no `vote.cast` or
`scene.accept` RPC, no story version column, no `requestId` register, and no serialization
around a scene commit. What exists is the refusal: `jam_proposals.status` has the right
vocabulary and **no update policy**, so the illegal path is closed even though the legal one is
not open. See the register in `docs/specs/intended-vs-implemented.md`.

**There is no longer a compare-and-swap anywhere in `JamStore` to reuse.** An earlier draft of
this spec pointed at `updatePlayback`, which guarded on `stateVersion` and failed with
`stale_state_version`; it was deleted with the portion pipeline, along with `getPlayback`. The
interface is now `createJam`, `getJam`, `updatePortion`, `revertScriptToRevision`,
`getScriptRevision`, `getScriptAtRevision`, `getCurrentScriptRevision` and `listScriptRevisions`
— append-only history with no version guard. So `expectedStateVersion` has to be built, not
adopted. What does survive and should be built on: `withJamLock`, `PlaybackGuard`,
`minEditablePortionIndex` and `PortionLockedError` (`apps/server/jams.ts`), and the beat window
in `src/core/directorBeats.ts` that now drives them.
