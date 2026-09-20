# The story outline

**Status: implemented and verified offline; no provider call has ever been made.** The outline
projection, the cascade and its provider wiring, the beat fill-in, the per-jam edit queue, the
outline routes, the store commit and the client panel are built (RV-22) and covered by tests that
inject the completion instead of calling a model. The routes were also exercised against the real
local host with providers off. **No cascade and no fill-in has been run against Nebius from this
repository**, so the quality of a rewritten tail is specified and unobserved;
`docs/PROJECT_STATE.md` carries the dated receipt when one is run.

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

The product's word for this layer is "history": the room's history of what happens, segment by
segment. That name is already taken in this codebase: `src/core/scriptHistory.ts`,
`JamScriptHistory` and `scriptRevisionSchema` are the append-only **revision log**, an unrelated
concept that this layer sits on top of. The repository has already paid for one collision of
exactly this kind — `Jam` meant both the generated script and the room until it was split into
`JamRoom` (`docs/PROJECT_STATE.md`, "Room and script streams reconciled").

This document and the code therefore use **outline** for the layer and **beat** for one entry
(confirmed 2026-09-20). "Beat" also matches the vocabulary the live-director work arrived at
independently for a portion placed on the stream timeline, so the two halves of the system share
one word. When a brief says "history segment", read "beat".

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
  already the shared address for edits, the director's beat window and the lock boundary derived
  from it. A second addressing scheme is a second thing to keep in sync across every one of those
  surfaces.

`summary` is **optional** on the schema. Revisions written before the outline existed carry no
beats, and history is append-only, so they can never gain one. Any surface reading the outline
must render a missing beat honestly rather than inventing a phrase for it.

## Beats are born with the script

The outline is created when the script is created, not on first read. Three paths, one rule:
**a beat is written by the same act that writes the portion, and a beat that is missing is filled
in by one call, never invented locally.**

- **Generated scripts.** The scriptwriter's JSON shape carries `summary` per portion
  (`apps/server/scriptwriter.ts`), so the model writes the phrase and the prose in one
  completion, from one view of the story. The draft schema accepts `summary` as optional so a
  model that forgets one does not fail a paid script.
- **The fill-in.** After the script is finalized, any portion still without a beat triggers **one**
  completion over the whole script (`buildSummaryPrompt` / `applySummaries`,
  `src/core/outlineSummary.ts`; `ensureOutline`, `apps/server/outlineWriter.ts`). The reply is a
  flat list of exactly as many phrases as the script has portions, applied by position and refused
  on any count mismatch — the same rule the cascade uses. Two attempts; the second is told what was
  wrong with the first.
- **Imported scripts.** Import used to make no provider call. It now makes the fill-in call when a
  provider is configured, under the same generation concurrency gate as script generation; the
  import itself never waits on it. If no provider is configured, the gate is busy, or the call
  fails, the jam is still created and its beats are simply missing.

`POST /api/jams` reports the outcome as `outline: { complete: boolean }` beside the jam. A missing
beat is a fact the panel states ("no beat yet"), not a phrase it makes up. A `set` edit on such a
beat writes one; a `reroll` on one is allowed and tells the model the beat was unsummarised.

## The single edit intent

Every mechanism produces the same command. This is the seam the centralization decision exists to
create. It is `outlineEditCommandSchema` in `src/core/outlineEdit.ts`.

An **outline edit** names one beat and says what should happen to it:

- **`set`** — this beat becomes this phrase. Produced by a direct rewrite, by a poll that
  resolved to a winning phrase, or by a chat turn the server reduced to a concrete phrase.
- **`reroll`** — this beat should be something else; the model chooses, and is told what was
  rejected. Produced by a down-vote, or by a chat turn that expresses dissatisfaction without
  proposing a replacement. An optional `reason` (≤280 chars) travels with it as material.

Two intents rather than one, because the user's own example demands it: an up/down vote on a
future beat carries no replacement text. A down-vote is not "make it say X", it is "not this".
Collapsing `reroll` into `set` would force every voting mechanism to invent replacement prose it
was never given, which is exactly the fabrication this codebase refuses elsewhere.

The edit also records **which mechanism produced it** (`mechanism`: `direct | vote | poll | chat`,
default `direct`) and **who authored it** (`authorId`). That is audit and interface, not logic:
the queue treats every edit identically regardless of source, and no downstream behaviour may
branch on the mechanism. If it ever needs to, the mechanisms are not actually interchangeable and
this spec is wrong.

The envelope from `docs/specs/transactional-scene-contract.md` is carried as:

- **`requestId`** — a client-minted UUID. Replaying it returns the edit record the first request
  created, whatever state it is in now; nothing is performed twice. The register is the per-jam
  ledger of recent edits (bounded, below), so the window is the ledger's retention.
- **`expectedRevision`** — the script revision the client was looking at when it edited. This
  slice defines the outline's version *in terms of the revision log* rather than adding a second
  per-jam counter (the smell the scene contract names): a landed edit is a revision, so the
  revision number is the version. It is checked **at admission**: an edit made from a stale view
  is refused with `stale_state_version` and the current revision. It is not re-checked when the
  edit reaches the front of the queue, because being applied on top of the edits queued before it
  is the point of streaming them.

## Mechanisms are adapters

Each mechanism's responsibility ends at producing an edit. This slice ships the first one; the
rest are sketches, not contracts:

| Mechanism | Produces | Status |
| --- | --- | --- |
| Direct rewrite | `set` on the beat the author edited | Built: the outline panel's "Rewrite" |
| Direct rejection | `reroll` on the beat the author rejected | Built: the outline panel's "Not this" — one person's "no", not a tally |
| Up/down vote | `reroll` on a beat the room rejected | Unspecified: the tally rule that fires it |
| Poll | `set` carrying the winning phrase | Unspecified: who opens one, over which beats, how candidates are produced |
| Chat | `set` or `reroll`, resolved from prose | Unspecified: how a described change is pinned to a beat index |

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

As built (`OutlineEditQueue`, `apps/server/outline.ts`):

- **One FIFO per jam**, drained by one worker per jam. An edit's life is
  `queued → processing → landed | failed`, and every state is readable: the edit record carries
  `queuedAt`, `startedAt`, `finishedAt`, the `baseRevision` it was computed from, the `revision`
  it landed as, or a typed `error`.
- **Bounded.** At most 10 edits may wait per jam; the eleventh is refused with `queue_full`
  (retryable). The ledger keeps the last 50 records per jam, oldest dropped first; that ledger is
  also the `requestId` register.
- **Admission is cheap and honest.** Before an edit is queued the server checks that the jam
  exists, that a provider is configured (`generation_disabled` otherwise — no cascade is
  fabricated), that the beat exists, that it is not locked, that `expectedRevision` is current,
  and that the queue has room. An edit that passes is `202 Accepted` with its record.
- **An edit whose beat locks while it waits does not fail silently.** When it reaches the front
  the boundary is read again; a beat that closed meanwhile fails the edit with `portion_locked`,
  visible in the ledger and the panel.

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
the director's beat window and the lock boundary, and renumbering them would silently re-aim every
open stream.

**The model emits data, never commands.** Its output is validated against the portion schema
before anything is written; output that does not validate is refused, never coerced and never
partially applied. Existing story text fed back as context is material, not instruction — a line
of dialogue that reads like an order is dialogue.

The provider wiring (`runCascade`, `apps/server/outlineWriter.ts`) gives the model two attempts:
a reply of the wrong shape or the wrong length is fed back as a correction once, and a second
failure fails the edit with `invalid_cascade` (retryable — resubmitting is a new edit). A
provider that does not answer fails it with `generation_failed`.

## The lock window, which comes from the stream

Beats at or below the one already committed to the provider are immutable. The outline inherits
this, which is why the artifact is a view of **what is up to come** — the settled part of the
story is readable and not editable.

The boundary is **derived from the live stream**, not from a stored cursor. `src/core/directorBeats.ts`
answers it: `beatWindow` returns `{ currentBeatIndex, lockedBeatIndex, minEditableBeatIndex }`
from where the stream has reached on the script clock, and `isBeatLocked` tests one beat against
it. The rule is that a stream generates ahead of what a viewer sees, so the beat on screen and
the one already with the provider are both closed, and editing resumes two beats ahead. A jam may
hold one stream per configuration, and an edit is safe only if it is ahead of all of them, so the
**strictest** open stream sets the boundary (`DirectorStreamRegistry.beatWindow(jamId)`).

Two properties of this source have no analogue in the stored cursor it replaced, and both bear on
the queue:

- **With no stream open, nothing is locked.** The whole outline is editable before a session
  starts and after one ends. The same edit is therefore refused mid-session and accepted outside
  one, which makes the boundary check non-idempotent across that transition — which is why the
  `requestId` register stores the *outcome*, so a replay returns what happened rather than
  re-deciding.
- **Beat 0 is locked before the first chunk arrives**, because the configure message carried the
  script to the provider when the session opened. There is no moment where a live session has
  nothing committed.

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

## Serialization: the decision that unblocked the queue

Both this document and `docs/specs/transactional-scene-contract.md` forbade building the queue on
`withJamLock` alone: an in-process mutex serializes nothing once the routers run as many Vercel
function instances. That prerequisite named three exits and picked none. **One is now picked and
recorded in `docs/DECISIONS.md` (2026-09-20): script edits run in the one container process the
live director already requires.**

The argument is not that the mutex is good enough; it is that the process is already singular.
The director holds a long-lived WebRTC peer and therefore cannot be a serverless function
(`docs/DECISIONS.md`, RV-16), and the lock boundary is read from that same process's
`DirectorStreamRegistry`. A script edit that ran anywhere else could not read the boundary at all.
So the jams router, the outline queue and the director are one deployment unit by construction,
and within it a per-jam FIFO plus `withJamLock` is a real critical section, not a nominal one.

What that buys, and what it does not:

- The commit is a real compare-and-swap. `JamStore.commitScript(jamId, script,
  minEditablePortionIndex, { expectedRevision })` refuses with `PortionLockedError` if any portion
  below the boundary would change, and with `StaleRevisionError` if the current revision is not the
  one the cascade was computed from — a direct `PATCH` or a revert can land while a cascade is
  with the provider. The worker recomputes once against the new revision, then gives up with
  `stale_state_version`.
- Durability is a separate question and stays separate. The store is `InMemoryJamStore`; a restart
  loses the script, its revisions and the ledger together, which is the same loss the script
  already had. Moving the script into Postgres (`jam_scripts`, `jam_script_revisions`, the
  reserved RV-21) is for surviving restarts, and the row lock those migrations prescribe would
  then be the cross-process guarantee — it is not what makes today's queue correct.
- Deploying the jams router as a Vercel function is **not a supported deployment for edits**, and
  the register row that tracked that gap now says so instead of calling it unowned.

## The outline drives the live director too

A beat is also the direction text for the live director (`apps/server/directorStream.ts`). One
edited phrase drives both the rewritten script portion and what the stream is told to render.
The director's seam takes `{ body, authorId?, proposalId?, beatIndex? }` and makes no assumption
about where a direction came from, so a beat needs no translation to become one. A direction
naming a closed beat is refused with `beat_locked`, the stream-side counterpart of the
`portion_locked` a script edit gets.

As built: **after a cascade commits, the edited beat's new phrase is sent to every open stream of
that jam** as `direct({ body: summary, beatIndex, authorId })`. Only that one beat is sent, never
the rewritten tail — the director's `replan` flag means a burst of prompts would cancel down to the
last one and flood a bounded audit log with text no human asked for. The stream re-plans forward
from the phrase, which is what the cascade already did to the script. The edit record reports
`direction: { sent, refused }`; a refusal (`stream_not_ready`, `beat_locked`) is recorded and
never fails the edit, and with no stream open nothing is sent and nothing is wrong.

A direction is a control message on a stream that is already billing by wall clock; it adds no
provider cost of its own. The paid call in this path is the cascade completion, one per edit
regardless of how many streams are open.

Two constraints from the earlier design still hold:

- **The queue never opens or holds a director session.** A session bills a 60-second minimum of
  wall clock whether or not anyone is directing. An outline edit commits durably with no stream
  up; delivery is best-effort on top.
- **A rejected direction never transitions anything in the outline.** Generation runs after the
  commit, so a provider refusal leaves the accepted story intact — the rule
  `docs/specs/transactional-scene-contract.md` already fixes.

One consequence worth stating: the director's audit stores each direction **as sent**, so a reader
will sometimes see direction text matching no current beat. That is correct. A cascade can rewrite
a beat after its text was already sent, and the audit's job is to record what the provider was
actually asked for. The audit's `beatIndex` is what ties a recording back to the outline
afterwards; it must never be resolved back to the outline's *current* text.

## The client surface

`OutlinePanel` (`src/screens/OutlinePanel.tsx`) is one component mounted in two places: the
script screen, where the host reads the script they just created, and the Studio, where the room
steers. It reads `GET /api/jams/:id/outline` and the edit ledger on a short poll (the same
interim transport the director panel uses) and after every action, and it renders:

- every beat with its index, start time, scene heading and phrase — or "no beat yet" when the
  revision has none; it never invents one;
- the beat's state from the window: **played**, **generating** (locked), or **editable**, with
  the edit controls only on editable beats;
- "Rewrite" (a `set` with the typed phrase) and "Not this" (a `reroll`) on each editable beat;
- the ledger: what is queued, what is being rewritten, what landed as which revision, and what
  failed and why, in the server's own words.

The panel mints a `requestId` per action and sends the `revision` it last read as
`expectedRevision`, so an edit made from a stale view is refused rather than applied blind. The
script screen also takes the current script from the outline response, so the screenplay under
the panel is the revision the beats describe rather than the one the jam was created with.

In the Studio the script lives on the Express host, not in Supabase, so a room whose server has
restarted has no outline; the panel says that the script is not on this server rather than
showing an empty list. Editing follows the room's contribution rule (an active member), which is
a UI rule only — see the open question on authorization.

## Errors

Typed per the existing rule — `code`, `safeMessage`, `retryable`; never a credential, a raw
provider body or an internal prompt.

| Code | Meaning | Retryable |
| --- | --- | --- |
| `not_found` | the jam has no script on this server | no |
| `invalid_command` | the command does not validate, or names a beat the script does not have | no |
| `generation_disabled` | no provider is configured; no cascade is fabricated | no |
| `portion_locked` | the edited beat is played or is the generation buffer — at admission, when the edit reached the front of the queue, or when the boundary moved into the cascade's range before it committed | no |
| `stale_state_version` | `expectedRevision` is behind the current revision (at admission), or the revision changed twice under a cascade (at commit); the current revision is attached | yes, after re-reading |
| `queue_full` | ten edits already wait for this jam | yes |
| `invalid_cascade` | the model's rewrite did not cover the tail exactly, twice; nothing was written | yes, as a new edit |
| `generation_failed` | the provider did not answer or rejected the call; nothing was written | yes, as a new edit |
| `jam_ended` | the room has finished; its recording is the artifact and its story no longer moves | no |
| `beat_locked` | a direction names a beat the stream has already committed to (director route; recorded on the edit as a refused direction) | no |

`portion_locked` at admission is an HTTP `409` on the `POST`; the same code after admission is a
`failed` ledger entry, because the request that queued the edit has already been answered.

## Contracts

| Route | Purpose |
| --- | --- |
| `GET /api/jams/:id/outline` | `{ revision, script, beats[], window, pending }` — the ordered beats of the current revision with `portionIndex`, `summary?`, `durationSeconds`, `startSeconds`, `sceneIndex`, `sceneHeading` and `locked`; `window` is the strictest open stream's `DirectorBeatWindow` (nothing locked when no stream is open); `pending` is how many edits wait or are processing |
| `POST /api/jams/:id/outline/edits` | Admit one edit. Body: `{ requestId, intent: "set", beatIndex, summary }` or `{ requestId, intent: "reroll", beatIndex, reason? }`, plus optional `expectedRevision`, `mechanism`, `authorId`. `202 { edit }` on admission; `200 { edit }` for a replayed `requestId`; `409` for `portion_locked`, `stale_state_version` (with `revision`), `queue_full`; `503` for `generation_disabled` |
| `GET /api/jams/:id/outline/edits` | `{ edits[] }` — the ledger, newest first, at most 50 |
| `GET /api/jams/:id/outline/edits/:editId` | One edit record |

The edit record: `{ id, requestId, jamId, intent, beatIndex, summary?, reason?, mechanism,
authorId?, status, queuedAt, startedAt?, finishedAt?, baseRevision?, revision?, error?,
direction? }`.

`PATCH /api/jams/:id/script/portions/:portionIndex` is kept as the expert path for prose. It does
not touch `summary`, so a portion whose action was patched by hand keeps the beat it had; the beat
may then lag the prose until someone edits the beat. That is the honest trade for keeping one
write path per field rather than re-deriving a beat on every prose edit.

## Open questions (unspecified)

- **Who may edit.** The outline routes carry no authorization, like every other script route on
  the Express host today (the same hole `docs/INCONSISTENCIES.md` tracks for the director
  routes). The Studio hides the controls from non-members; the server does not refuse them.
  Room-scoped authorization for the local host is one decision for all of these routes, not one
  per route.
- ~~The ended room.~~ **Settled and enforced.** A jam carries a lifecycle
  (`live | playing | ended`, `src/core/jamLifecycle.ts`). An ended room's recording is its
  artifact, so its story stops moving: an edit is refused `409 jam_ended` at admission, and an
  edit already queued when the room ends fails with the same code rather than rewriting a film
  that was already shot.
- The vote tally rule, and whether it is per jam, per host or global. This spec fixes that the
  rule is server-owned, not what it is.
- How a chat turn is pinned to a beat index — by the model, by the participant, or by both.
- Whether a `reroll` may be refused by the model ("nothing better available") and what the room
  sees if so. Today the model always answers with a rewrite.
- Whether an edit may target multiple beats at once. One beat per edit is assumed throughout and
  keeps the atomicity story simple; a poll over a whole act would test that.

## Implementation status

Implemented (RV-22), verified offline with injected completions: `summary` requested by the
scriptwriter and accepted by the draft schema; the one-call fill-in for missing beats on generated
and imported scripts (`src/core/outlineSummary.ts`, `apps/server/outlineWriter.ts`); the edit
intent and command schemas (`src/core/outlineEdit.ts`); the cascade prompt for both intents and
its provider wiring; `JamStore.commitScript` with the boundary and revision guards; the per-jam
edit queue, worker and ledger and the four routes (`apps/server/outline.ts`); delivery of the
edited beat as a direction to every open stream; `DirectorStreamRegistry.beatWindow` and
`streamsFor`; the outline panel on the script screen and in the Studio.

Earlier (RV-17): the `summary` field, `buildOutline` and `beatAt` (`src/core/outline.ts`), and
the cascade schema and application (`src/core/outlineCascade.ts`).

Not implemented: the vote, poll and chat adapters; route authorization; a durable store for the
script and the ledger (RV-21).

**What the tests actually prove**, since "tested" is not one claim: that an edit rewrites the tail
and lands as one revision while settled beats are untouched; that durations survive a cascade;
that edits for one jam are applied strictly in order, each on the previous result; that a replayed
`requestId` returns the first outcome and pays for one cascade, not two; that a locked beat is
refused at the door, that a boundary moving under a running cascade refuses the commit and the
edit waiting behind it, and that both failures are visible in the ledger; that a competing edit
makes the worker recompute once and give up the second time rather than overwrite; that an
unexpected failure still settles the record so the jam's queue keeps moving; that a full queue is
refused; that the landed beat reaches every open stream of that jam and no other's, and that a
refused direction does not undo the commit; that no provider means no fabricated cascade; and that
the panel shows played, generating and editable beats, renders a missing beat as missing, and
sends `set` and `reroll` with the revision the reader was looking at. What they do not prove is
anything about a real model's output.
