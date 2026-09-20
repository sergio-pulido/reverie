# Script forking and chat-driven editing

**Status: intended, not implemented.** This records the target shape of two capabilities named
in `docs/specs/script-screen-actions.md` sections 2 and 4 and left there as direction: copying
the script into an editable version, and revising a screenplay by describing the change instead
of hand-editing it. Neither has a route, a command, a schema or a control today.

## Problem

There is exactly one way to change a script right now:
`PATCH /api/jams/:id/script/portions/:portionIndex`, which appends a revision to the **shared**
script every participant is watching. That is correct for a room editing together and wrong for
everything else — trying an idea, preparing an alternative, reworking a scene while the room
plays. The only other door, `Open as markdown`, is a read-only link to the latest revision.

So a participant who wants to explore has two bad options: edit the shared document and impose
the experiment on everyone, or copy the text out of the product entirely and lose its structure,
its history and its portion addressing.

The second half of the problem is the editing *surface*. Portion-scoped PATCH is an API, not a
way to write a movie. The intended surface is a chat: say what should change, get a new version.

## Model — lines and revisions

Today's history is a single append-only sequence of revisions per jam
(`apps/server/jams.ts`; `src/core/scriptHistory.ts`). This spec adds one concept above it:

- A **version line** is a named sequence of revisions. Every jam has exactly one **shared line**
  — the one playback reads, the one `script.md` serves, the one that exists today.
- A **fork** is a new version line rooted at a **declared revision** of another line. The root is
  recorded; a fork always knows what it came from.
- Within a line, history stays **append-only**. Forking adds lines; it never rewrites a
  revision, and revert keeps working exactly as it does now (restore an earlier revision as a
  new one).

A fork is an **explicit user action**, never an automatic per-seat copy. Per-participant
`language` and `ambientation` overrides remain overrides: they select a configuration
(`docs/specs/configuration-keyed-streams.md`), they do not create a line and they never split
the room.

## What a fork may contain

**Structural edits stay forbidden, inside a fork as much as outside it.** A fork inherits its
root's scene and portion structure and its flat, zero-based `portionIndex` addressing; it may
change `action`, `dialogue`, `visualDirection` and `durationSeconds`, within the jam format's
hard portion bounds. It may not insert, delete or reorder portions.

This is not a limitation copied over by habit. Portion indices are the address used by
the single address shared by script edits and by the live director's beats. A fork that
renumbered portions would silently re-aim the lock boundary of every open stream.
Insertion becomes expressible only once portions carry stable ids, which
`docs/API_CONTRACTS.md` already names as the later extension that forks would require.

## The lock window applies at adoption, not at editing

Beats at or below `currentBeatIndex + 1` are immutable in the shared line, because they are played
or already with the provider — the window comes from the live director's position on the script
clock (`src/core/directorBeats.ts`), and with no stream open nothing is locked.

- **Inside a fork, every portion is editable.** A fork is not being played and nothing is being
  bought from it, so the lock boundary does not constrain it. A participant may rework portion 0
  while the room is watching portion 6.
- **Adopting a fork into the shared line is where the boundary bites.** An adoption is refused
  with `portion_locked` if it would change any played or locked portion — the same rule, the same
  error, the same requirement that the playback guard be read inside the same per-jam critical
  section as the write.

The consequence is worth stating plainly, because it is the trap: **a fork can always be
written, and cannot always be adopted.** A participant who reworks the opening of a movie that
is already playing has produced something the room can read but can no longer take. The screen
must say so while the fork is being edited — showing the current lock boundary against the fork's
changed portions — rather than discovering it at adoption.

## Adoption

Adopting is a state-changing command on the shared line and therefore carries the full envelope
from `docs/specs/transactional-scene-contract.md`: `schemaVersion`, `requestId`,
`expectedStateVersion`, serialized per jam, compare-and-swap, idempotent on replay.

- Adoption is all-or-nothing. A partial adoption — some portions taken, some refused — is not
  expressible.
- Adoption appends the result to the shared line as a normal revision. The fork is not deleted
  and its history is not merged in; only the resulting content lands.
- Who may adopt is the same question as who may accept a scene, and gets the same answer: the
  host, or the configured vote rule. A fork is a creative proposal at script scale.

## Chat-driven editing

The chat is the editing surface; versions are the result.

**Flow.** A participant describes a change. The server turns that into a **structured portion
patch** — the same shape `PATCH /api/jams/:id/script/portions/:portionIndex` already accepts —
validates it with the existing Zod schema, and appends it as a revision on the target line.

**The model emits data, never commands.** The provider is asked for a patch object and its
output is validated against the portion schema before anything is written. Output that does not
validate is refused and stated as such; it is never coerced, never partially applied, and never
appended as text the renderer will interpret. Participant input and model output are both data:
never executable instructions, never HTML. Existing script content fed to the model as context
carries the same treatment — a line of dialogue that reads like an instruction is dialogue.

**Provider boundary.** Any paid call goes through the server-configured Nebius allowlist behind
the generation concurrency gate, exactly as script generation does
(`apps/server/scriptwriter.ts`). It never silently falls back to a mock, and a disabled or
uncredentialed provider produces a typed refusal rather than a fabricated edit.

**Where it writes.** A chat edit targets a **line**. Pointed at a fork, it is unconstrained.
Pointed at the shared line, it is a normal portion edit and hits `portion_locked` at the
boundary like any other. The screen must make the target unmistakable; "which document am I
changing" is the failure mode this whole spec exists to remove.

**Scope.** One chat turn produces one patch to one portion. Multi-portion rewrites are a later
extension: a single turn that rewrites six portions is six chances for a schema failure to land
half a change, and the atomicity story for that is not written here.

## Contracts (planned, none implemented)

| Route | Purpose |
| --- | --- |
| `POST /api/jams/:id/forks` | Create a version line rooted at a declared revision of a declared line; returns the fork |
| `GET /api/jams/:id/forks` | List a jam's version lines with their roots and revision counts |
| `GET /api/jams/:id/forks/:forkId/script.md` | Read a fork's latest revision as markdown |
| `PATCH /api/jams/:id/forks/:forkId/portions/:portionIndex` | Edit one portion of a fork; no lock boundary applies |
| `POST /api/jams/:id/forks/:forkId/adopt` | Adopt a fork into the shared line; `expectedStateVersion`-guarded, refused with `portion_locked` |
| `POST /api/jams/:id/script/chat` | Turn a described change into a validated portion patch on a named line |

`POST /api/jams/:id/forks` already appears in `docs/API_CONTRACTS.md` as a planned route with
the gloss "fork from a declared past scene version"; the rows above replace that single line
with the shape the capability actually needs.

## Open questions (unspecified)

- Who owns a fork, who may read it, and whether a fork is visible to the room or private to its
  author until adopted.
- How many lines a jam may hold, and what evicts one. Every line is stored history.
- Whether a fork tracks its root line's later revisions in any way, or is frozen at its root
  until adopted.
- Whether adoption requires the fork to be rebased onto the shared line's current revision when
  the two have diverged in the same portion, and what the conflict surface looks like if so.
- Whether a fork may be played — which would make it a configuration-keyed stream question and
  a provider-load question, not just a storage one.
- The chat's context window: how much of the script the model sees, and how that cost is capped.
- Whether chat editing is available before a jam has started playing, when no boundary exists
  and the distinction between fork and shared line is at its least visible.

## Implementation status

**Nothing in this spec is implemented.** There is no fork, version line, adoption or chat-edit
route, service, store method, schema or control. `POST /api/jams/:id/forks` is a planned row in
`docs/API_CONTRACTS.md` and nothing more. See the register in
`docs/specs/intended-vs-implemented.md`.

What exists and would be built on: append-only revision history with revert
(`apps/server/jams.ts`, `src/core/scriptHistory.ts`), the structured script as the editing
source of truth with markdown as a render (`src/core/scriptMarkdown.ts`), the portion-scoped
patch schema and its duration bounds, the `portion_locked` guard and the per-jam critical
section that makes it safe, and the read-only markdown link on the script screen
(`src/ScriptScreen.tsx`).
