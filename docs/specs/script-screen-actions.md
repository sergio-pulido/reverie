# RV-12 — Script screen actions and playback sessions

## Problem

Once a jam's script exists, the script screen offers three ways to leave it — **Open the
studio**, **Open as markdown**, and **Start my session** — and they are easy to confuse. Two
live in the script header and one is a form in the "Your session" card; only one of them
touches the story. This spec records what each action is for, what it does on the server, and
where its boundary is, so the screen is not read as three variations of the same control. It
also records the intended evolution: **Open as markdown** becomes the door to an editable
version, and the screenplay is revised through a chat on this screen.

## The one mental model

There is **one authoritative script per jam** and **many playback seats**. The room collaborates
on the shared script in the Studio; each person's session stores the parameters that will skin
their own playback of that same script. Editing the script produces a new **version** rather
than overwriting the shared document: the editable markdown copy (section 2) and the intended
chat surface (section 4) both feed that append-only version history. No action on this screen
forks the story per seat.

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

## 3. Start my session — claim a personal playback seat

**Goal.** Attach *you* to the jam so it plays back your way, without touching the shared story.

**Behaviour.** The "Your session" form takes a display name plus settings — `language` (a
BCP-47-style tag) and free-text `ambientation` — and submits `POST /api/jams/:id/sessions`. The
server returns `201` with the session and a **one-time `ownerToken`**; a jam holds at most 32
sessions. After creation the card shows **Save my playback** (an owner-only
`PATCH /api/sessions/:id` carrying the bearer token) and a **My script view** link
(`GET /api/sessions/:id/script.md`).

**Boundary.** A session stores and exposes the parameters that *will* skin its owner's
playback; it does not translate or re-ambient the script yet. `renderScriptMarkdown` only
annotates the header with the owner's name, language and ambientation — the scene body is still
the shared script. Per-session generated playback is a later, budgeted provider step. The owner
token is issued once, is never listed, and must be treated as a secret.

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

