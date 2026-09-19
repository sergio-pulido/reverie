# RV-12 — Script screen actions and playback sessions

## Problem

Once a jam's script exists, the script screen offers three ways to leave it — **Open the
studio**, **Open as markdown**, and **Start my session** — and they are easy to confuse. Two
live in the script header and one is a form in the "Your session" card. The core confusion is
that **Open the studio** and **Start my session** are the *same collaborative room*: the session
is simply your seat there, carrying per-participant overrides. This spec records what each
action is for, what it does on the server, and where its boundary is, so the screen is not read
as three variations of one control. It also records the intended evolution: **Open as markdown**
becomes the door to an editable version, and the screenplay is revised through a chat on this
screen.

## The one mental model

There is **one authoritative script** and **one collaborative room per jam**. A **session is a
participant's seat in that same room**, not a separate playback space: you take part in the same
shared activity as everyone else, and the session only carries per-participant **overrides**
(`language`, `ambientation`) that customize the common behaviour for you. Editing the script
produces a new **version** rather than overwriting the shared document: the editable markdown
copy (section 2) and the intended chat surface (section 4) both feed that append-only version
history. Overrides never fork the story or split the room.

## 1. Open the studio — enter the collaborative room

**Goal.** Leave the read-only script and enter the live room where the group directs the movie
together.

**Behaviour.** The button switches the client to the `studio` screen (`src/main.tsx`,
`ScriptScreen` → `onStudio`). It creates nothing and changes nothing: the URL already points at
the registered room `/jams/<slug>`, set when the script was created. Depending on
configuration it renders one of two things:

- **Configured + real slug** — `src/screens/Studio.tsx`: the Supabase-backed room, with the
  story conversation, the proposal queue, the live stage, the roster, and host-only lobby and
  invite controls. Membership, admission and authorization are server-owned.
- **No Supabase, or a `preview-` slug** — `PreviewStudio`: a clearly labelled local preview
  that states it is not a room and shares nothing.

**Boundary.** Opening the studio does not accept a proposal into a scene. Changing a proposal's
status needs the versioned transactional contract, which is not implemented; the Studio says so.
The room it opens is the same room a session belongs to (section 3): a session is your seat
here, plus per-participant overrides.

## 2. Open as markdown — read it, or copy it to edit

**Goal.** Read, download or hand off the script as a portable text document — and, when the
intent is to change it, begin from an **editable copy** rather than editing the shared script.
That editable copy is the action's main purpose; plain reading is the fallback.

**Behaviour today.** A plain link to `GET /api/jams/:id/script.md`, opened in a new tab as
`text/markdown`, serving the **latest script revision** — the live document, including edits the
room has made. There is no copy/fork step yet: the link is read-only and shared.

**Intended direction (not implemented).** `Open as markdown` should offer to **copy the script
into its own editable version**, so modifying it never overwrites the shared revision. The copy
is an explicit user action, not an automatic per-seat fork, and edits land in that version until
it is accepted. This builds on the existing revision model — `PUT /api/jams/:id/script` appends
a revision, `POST /api/jams/:id/script/revert` restores one — and the planned
`POST /api/jams/:id/forks` route in `docs/API_CONTRACTS.md`.

**Boundary.** The current link is the shared, unpersonalized script: everyone gets the same
bytes. The personalized variant is **My script view**, which only appears after a session exists
(below).

## 3. Start my session — your seat in the same collaborative room

**Goal.** Join the jam as a participant in the **same collaborative room**, carrying your own
playback overrides. It is the same room as **Open the studio**, not a parallel one.

**Behaviour.** The "Your session" form takes a display name plus settings — `language` (a
BCP-47-style tag) and free-text `ambientation` — and submits `POST /api/jams/:id/sessions`. The
server returns `201` with the session and a **one-time `ownerToken`**; a jam holds at most 32
sessions. After creation the card shows **Save my playback** (an owner-only
`PATCH /api/sessions/:id` carrying the bearer token) and a **My script view** link
(`GET /api/sessions/:id/script.md`).

**Model.** The session is your identity in the shared activity plus per-participant overrides
layered on the common behaviour. Everyone still collaborates on the same room and the same
script; the overrides change how it plays for you, not what the room is doing. Overrides select
a **configuration**, and each active configuration maps to one shared generated stream — held up
to a capped number of distinct configurations, after which participants attach to an existing
one. See `docs/specs/configuration-keyed-streams.md`.

**Boundary.** A session stores and exposes the parameters that *will* skin its owner's
playback; it does not translate or re-ambient the script yet. `renderScriptMarkdown` only
annotates the header with the owner's name, language and ambientation — the scene body is still
the shared script. Per-session generated playback is a later, budgeted provider step, keyed by
configuration rather than by person (`docs/specs/configuration-keyed-streams.md`). The owner
token is issued once, is never listed, and must be treated as a secret.

**Current gap — "same room" is intent, not wiring.** Today the playback session (`JamSession`,
authenticated by the owner token) and room membership (Supabase `jam_members`, Auth-owned) are
separate records: creating a session does not by itself admit you to the collaborative room, and
neither record derives from the other. Unifying a session with room membership is a design task,
not an existing behaviour.

## 4. Edit the screenplay through a chat (intended)

**Goal.** On this screen, the room should be able to revise the screenplay by describing the
change in a chat, rather than hand-editing markdown. The chat is the editing surface; versions
are the result.

**Intended direction (not implemented).** A chat message becomes a validated edit command that
produces a new **version** of the script, using the same revision boundary as the markdown edit
path (`PUT /api/jams/:id/script`) so history stays append-only and every change is reviewable
and revertible. Edits apply to the editable copy from section 2, not to the shared script.
Participant input and model output are treated as data, validated with Zod, and appended as
text — never executed as instructions or injected as HTML. Any paid provider call stays behind
the server-owned model allowlist, concurrency gate and spend limits, and never silently falls
back to a mock.

**Boundary.** There is no chat-to-edit route today, and no such control on the script screen.
The Studio's "story conversation" and proposal queue are a different surface, read-only until
acceptance. Scene acceptance itself still needs the versioned transactional contract.

## Non-goals

- No automatic per-user or per-session fork of the shared script; an editable copy is an
  explicit user action.
- No translated or re-ambiented rendering of scene bodies.
- No scene acceptance or voting from this screen.
- The three current actions do not modify the shared script revision.

## Contracts

- `GET /api/jams/:id/script.md` — latest markdown revision (shared, unpersonalized).
- `POST /api/jams/:id/sessions` — create a session, returns `{ session, ownerToken }`.
- `PATCH /api/sessions/:id` — owner-only update of `language` / `ambientation`.
- `GET /api/sessions/:id/script.md` — shared script annotated with the session's settings.

Endpoint shapes, limits and error codes are in `docs/API_CONTRACTS.md`; the session-as-seat
decision is recorded in `docs/DECISIONS.md`.

**Planned, not implemented:** a copy/version step behind `Open as markdown`, and the planned
`POST /api/jams/:id/forks` route (`docs/API_CONTRACTS.md`) that would create the editable
version; plus a chat-to-edit route that appends versions through the same revision boundary as
`PUT /api/jams/:id/script`. Neither route exists today.

## Implementation status

Actual vs intended, with code anchors, is tracked in `docs/specs/intended-vs-implemented.md`.
Short version: the three current actions and the session endpoints exist in the local Express
host; the **copy-to-version** step, **chat editing**, and **session-as-room-membership**
unification have **no code**. The script/session routes are also not deployed as Vercel
functions (only `api/health`, `api/catalogue` and `api/live/token` are).

