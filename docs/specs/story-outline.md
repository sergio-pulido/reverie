# The story outline

**Status: core implemented, mechanisms intended.** The outline projection, the cascade prompt
and its application are in `src/core/outline.ts` and `src/core/outlineCascade.ts` and are tested
offline. The edit queue, the provider wiring, the input mechanisms and the client surface are
specified here and not yet built.

## Why an outline exists

A jam's script is a screenplay: scenes, portions, action, dialogue, visual direction. At the
default format that is four minutes of prose. It is the right artifact to *generate* and the
right artifact to *play*, and it is the wrong artifact to **steer**. A participant who wants to
change where the story is going cannot be asked to read a screenplay first, and a participant who
joins mid-jam cannot be asked to catch up on one.

The outline is the readable projection of that script: **one brief phrase per portion**, ordered,
coherent as a sequence, so that the whole film is glanceable. A participant sees what is coming
and can act on it.

That is the visible reason. It is not the load-bearing one.

## The centralization decision

**The goal is several ways to modify the story.** Up and down votes on parts of the future,
chat, polls, a direct rewrite of a phrase — and mechanisms nobody has thought of yet. This is the
product: a room steers a film together, and there should be many doors into that, suited to how
engaged each participant is and how much they want to type.

Without a central artifact, every one of those mechanisms has to know how to edit a screenplay.
Each would need to validate the portion schema, respect the playback lock window, keep the
runtime inside the jam format, preserve the flat portion indices that address generation jobs,
and serialize against every other mechanism. That is the same dangerous logic implemented four
times, diverging quietly, with four chances to corrupt a script the room has already paid to
generate.

**So the outline is a centralized intermediate artifact, and every mechanism is an input adapter
to it.** A mechanism's whole job is to produce one small, typed thing: an intent to change one
beat. Everything downstream of that — validation, locking, serialization, the rewrite of the
script, the cost — happens exactly once, behind a single boundary, no matter which door the
change came through.

The test of the design is that adding a fifth mechanism should be adding an adapter, and should
touch none of the machinery below. A mechanism that needs to reach past the outline and write the
script directly is a mechanism that has found a gap in this spec; close the gap rather than the
mechanism.

## Naming

The user's word for this layer was "history". That name is already taken in this codebase:
`src/core/scriptHistory.ts`, `JamScriptHistory` and `scriptRevisionSchema` are the append-only
**revision log**, an unrelated concept that this layer sits on top of. The repository has already
paid for one collision of exactly this kind — `Jam` meant both the generated script and the room
until it was split into `JamRoom` (`docs/PROJECT_STATE.md`, "Room and script streams
reconciled").

This document therefore uses **outline** for the layer and **beat** for one entry. "Beat" also
matches the vocabulary the live-director work arrived at independently for a portion placed on
the stream timeline, so the two halves of the system share one word.

## Where a beat lives, and why not somewhere else

A beat is the `summary` field of the portion it describes (`src/core/script.ts`), and the outline
is a pure projection of the script (`buildOutline`, `src/core/outline.ts`). There is no outline
table, no outline store and no outline revision log.

The alternative — a parallel structure holding phrases beside the script — was rejected for three
reasons:

- **It could drift.** Two stores holding two descriptions of the same moment will disagree, and
  the outline's entire value is being a trustworthy glance at the story. An outline that can lie
  is worse than no outline.
- **It would duplicate the revision machinery.** Script history is already append-only full
  snapshots with revert (`src/core/scriptHistory.ts`). A beat on the portion versions with that
  for free; a separate store would need its own history, its own revert, and its own answer for
  what happens when the two are reverted to different points.
- **It would need a second address.** Portions are addressed by a flat, zero-based index that is
  already the shared address for edits, playback, the lock window and generation job keys
  `(jamId, portionIndex, pinnedRevision)`. A second addressing scheme is a second thing to keep
  in sync across every one of those surfaces.

`summary` is **optional** on the schema. Revisions written before the outline existed carry no
beats, and history is append-only, so they can never gain one. Any surface reading the outline
must render a missing beat honestly rather than inventing a phrase for it.

## The single edit intent

Every mechanism produces the same command. This is the seam the centralization decision exists to
create.

An **outline edit** names one beat and says what should happen to it:

- **`set`** — this beat becomes this phrase. Produced by a direct rewrite, by a poll that
  resolved to a winning phrase, or by a chat turn the server reduced to a concrete phrase.
- **`reroll`** — this beat should be something else; the model chooses, and is told what was
  rejected. Produced by a down-vote, or by a chat turn that expresses dissatisfaction without
  proposing a replacement.

Two intents rather than one, because the user's own example demands it: an up/down vote on a
future beat carries no replacement text. A down-vote is not "make it say X", it is "not this".
Collapsing `reroll` into `set` would force every voting mechanism to invent replacement prose it
was never given, which is exactly the fabrication this codebase refuses elsewhere.

The edit also records **which mechanism produced it** and **who authored it**. That is audit and
interface, not logic: the queue treats every edit identically regardless of source, and no
downstream behaviour may branch on the mechanism. If it ever needs to, the mechanisms are not
actually interchangeable and this spec is wrong.

## Mechanisms are adapters

Each mechanism's responsibility ends at producing an edit. Sketches, not contracts:

| Mechanism | Produces | Still unspecified |
| --- | --- | --- |
| Direct rewrite | `set` on the beat the author edited | nothing; this is the simple case |
| Up/down vote | `reroll` on a beat the room rejected | the tally rule that fires it |
| Poll | `set` carrying the winning phrase | who opens one, over which beats, how candidates are produced |
| Chat | `set` or `reroll`, resolved from prose | how a described change is pinned to a beat index |

The tally rule for votes is deliberately **not** decided here, and deliberately **server-owned**
when it is — the same rule `docs/specs/transactional-scene-contract.md` already fixes for scene
acceptance: the browser renders an outcome and never computes entitlement.

This table is where the vote/accept machinery of the proposal queue meets the outline. A proposal
is a proposed edit; accepting one is admitting it to the queue below.

## Edits are serialized

Edits are **streamed**: admitted to a per-jam queue and processed strictly one at a time, each
cascade computed against the result of the one before it. Concurrent application is not
expressible.

This is forced by the cascade. Two edits applied in parallel would each re-derive the same tail
from a different starting story and the second would silently erase the first — and with many
mechanisms feeding one artifact, simultaneous edits are the normal case, not the edge case. A
queue also gives every mechanism the same fairness story without any of them implementing one.

The queue is the mechanism this session's work is named for, and it is where the command envelope
from `docs/specs/transactional-scene-contract.md` applies: `schemaVersion`, `requestId`,
`expectedStateVersion`, compare-and-swap, idempotent replay, serialized per jam. Reuse the per-jam
critical section in `apps/server/jams.ts` (`withJamLock`) rather than introducing a second one.

## The cascade

Changing one beat changes the beats after it. "She finds the key" becoming "she loses the key"
makes every later beat that assumed she had it wrong. The room asked for coherence, so coherence
is enforced rather than hoped for: **an edit re-derives every beat after the edited one, and
rewrites their portions.**

This is an explicit product decision with an explicit cost: a later beat that another participant
contributed can be rewritten by someone else's earlier edit. That is accepted. The alternative —
leaving the tail alone — produces an outline that contradicts itself, which defeats the artifact's
purpose.

Three engineering decisions bound it:

**One completion rewrites the whole tail, never one call per portion.** This is cheaper — one
paid call per edit regardless of reach, rather than up to forty-six — but the real reason is
quality: a model that sees the entire remainder at once writes a coherent tail, while a chain of
local rewrites is exactly the incoherence the cascade exists to prevent.

**Durations are never rewritten.** A cascade changes what happens, not how long it takes. The
runtime therefore stays inside the jam format by construction, with none of the fitting retries
that generation needs (`apps/server/scriptwriter.ts`), and the total can never drift out of
tolerance through repeated editing.

**Structure is never rewritten.** The model returns a flat list of exactly as many objects as the
tail has portions, re-attached to the existing scenes by position (`applyCascade`). A reply that
does not cover the tail exactly is refused rather than partially applied. Structural edits stay
forbidden for the reason they were always forbidden: flat portion indices are the address used by
generation job keys, and renumbering them would silently re-key every clip the room has bought.

**The model emits data, never commands.** Its output is validated against the portion schema
before anything is written; output that does not validate is refused, never coerced and never
partially applied. Existing story text fed back as context is material, not instruction — a line
of dialogue that reads like an order is dialogue.

## The playback lock window

Portions at or below `currentPortionIndex + 1` are immutable: played, or the generation buffer
(`docs/API_CONTRACTS.md`). The outline inherits this unchanged, which is why the artifact is a
view of **what is up to come** — the settled part of the story is readable and not editable.

The check is simpler than it first appears. The lock window is a *prefix* and a cascade only ever
runs forward, so if the edited beat is editable then every beat after it is too. **Only the edited
beat needs checking.** No clamping of the cascade's reach is required.

The real hazard is a race, not a boundary. A cascade takes a provider call's worth of wall clock,
and playback advances during it, so the boundary can move into portions the cascade is about to
write. Nothing may hold the per-jam critical section across a provider call — that would freeze
the room for every participant.

**So a cascade is computed optimistically and committed atomically:** run the completion outside
the lock, then take the critical section once and write every portion together, refusing with
`portion_locked` if the boundary moved into the range meanwhile. All-or-nothing, as the scene
contract requires. The honest cost is that a cascade in a fast-playing room can be paid for and
then discarded; that is preferred over a half-rewritten story or a frozen room.

**That atomicity is not yet real, and this spec must not be read as saying it is.** The critical
section available today is `withJamLock` (`apps/server/jams.ts`), an in-process mutex, and the
script it protects lives in `InMemoryJamStore` in the same process. That is sound in the local
Express host and serializes nothing once those routers are deployed as Vercel functions, where
many instances run at once. An outline commit is therefore *specified* as all-or-nothing and
*implemented* only as far as one process can enforce it.

`docs/specs/transactional-scene-contract.md` states the prerequisite in full and instructs that
the path not be implemented, or described as atomic, until one of its exits is chosen and
recorded in `docs/DECISIONS.md`. The same instruction governs this document: **the edit queue
below must not be built on `withJamLock` alone.** The exit that moves the script into Postgres
gives the cascade a real transaction and a real cross-instance row lock, and is the reason that
work is sequenced before the queue rather than after it.

## The outline drives the live director too

A beat is also the direction text for the live director (`apps/server/directorStream.ts`, RV-16).
One edited phrase drives both the rewritten script portion and what the stream is told to render.
The director's seam takes `{ body, authorId?, proposalId? }` and makes no assumption about where a
direction came from, so a beat needs no translation to become one.

This is the second consumer that justifies centralizing the artifact, and it constrains delivery:

- **Only the current or imminent beat is sent as direction.** A cascade rewrites many beats at
  once; sending all of them would be self-cancelling (the director's `replan` flag means only the
  last would reach a chunk) and would flood a bounded audit log, pushing out the record of what a
  human actually asked for. The stream reports `scriptOffsetSeconds` on its own timeline, and the
  outline carries each beat's cumulative `startSeconds`, so the beat in play is a lookup
  (`beatAtOffset`).
- **The queue never opens or holds a director session.** A session bills a 60-second minimum of
  wall clock whether or not anyone is directing. An outline edit commits durably with no stream
  up; delivery is best-effort on top. "No session open" and "session closed under me" are ordinary
  states, never errors.
- **A rejected direction never transitions anything in the outline.** Generation runs after the
  commit, so a provider refusal leaves the accepted story intact and is surfaced as delayed or
  failed media with an explicit retry — the rule `docs/specs/transactional-scene-contract.md`
  already fixes.

One consequence worth stating: the director's audit stores each direction **as sent**, so a reader
will sometimes see direction text matching no current beat. That is correct. A cascade can rewrite
a beat after its text was already sent, and the audit's job is to record what the provider was
actually asked for.

## Errors

Typed per the existing rule — `code`, `safeMessage`, `retryable`, `requestId`; never a credential,
a raw provider body or an internal prompt.

| Code | Meaning | Retryable |
| --- | --- | --- |
| `portion_locked` | the edited beat is played or is the generation buffer, or the boundary moved into the cascade's range before it committed | no |
| `stale_state_version` | `expectedStateVersion` is behind; the current snapshot is attached | yes, after reconciling |
| `invalid_cascade` | the model's rewrite did not cover the tail exactly; nothing was written | yes |
| `generation_disabled` | no provider is configured; no cascade is fabricated | no |
| `not_active_member` | the author is waiting, left or removed | no |

## Contracts (planned, none implemented)

| Route | Purpose |
| --- | --- |
| `GET /api/jams/:id/outline` | The ordered beats of the current revision, with indices, offsets and the lock boundary |
| `POST /api/jams/:id/outline/edits` | Admit one edit (`set` or `reroll`) to the queue; envelope-guarded |
| `GET /api/jams/:id/outline/edits` | The queue: what is pending, what is processing, what landed |

## Open questions (unspecified)

- The vote tally rule, and whether it is per jam, per host or global. This spec fixes that the
  rule is server-owned, not what it is.
- How a chat turn is pinned to a beat index — by the model, by the participant, or by both.
- Whether a `reroll` may be refused by the model ("nothing better available") and what the room
  sees if so.
- Queue depth, and what happens to a queued edit whose beat was locked by playback while it
  waited. It cannot simply fail silently.
- Whether an edit may target multiple beats at once. One beat per edit is assumed throughout and
  keeps the atomicity story simple; a poll over a whole act would test that.
- Whether the outline is regenerated for revisions that predate it, or whether those jams simply
  show no beats.
- Whether the existing `PATCH /api/jams/:id/script/portions/:portionIndex` is retired, kept as an
  internal path, or kept as an expert surface that must then re-derive the beat it invalidated.

## Implementation status

Implemented (`eedeb0a`, tested offline, no provider): the `summary` field on the portion schema,
`buildOutline` and `beatAtOffset` (`src/core/outline.ts`), and the cascade prompt, schema and
application (`src/core/outlineCascade.ts`).

Not implemented: the edit queue, the edit intent type, the provider wiring, every input mechanism
(direct, vote, poll, chat), the routes above, the client surface, and delivery into the director
seam.
