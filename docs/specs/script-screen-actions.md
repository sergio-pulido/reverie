# RV-12 — Script screen actions and playback sessions

## Problem

Once a jam's script exists, the script screen offers three ways to leave it — **Open the
studio**, **Open as markdown**, and **Start my session** — and they are easy to confuse. Two
live in the script header and one is a form in the "Your session" card; only one of them
touches the story. This spec records what each action is for, what it does on the server, and
where its boundary is, so the screen is not read as three variations of the same control.

## The one mental model

There is **one authoritative script per jam** and **many playback seats**. The room collaborates
on the shared script in the Studio; each person's session stores the parameters that will skin
their own playback of that same script. No action on this screen forks the story.

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

## 2. Open as markdown — export the shared screenplay

**Goal.** Read, download or hand off the script as a portable text document.

**Behaviour.** A plain link to `GET /api/jams/:id/script.md`, opened in a new tab as
`text/markdown`. The route serves the **latest script revision** — the live document, including
edits the room has made — not a fresh re-render of the structured script.

**Boundary.** This is the shared, unpersonalized script: everyone gets the same bytes. The
personalized variant is **My script view**, which only appears after a session exists (below).

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

## Non-goals

- No forking of the script per user or per session.
- No translated or re-ambiented rendering of scene bodies.
- No scene acceptance, voting, or forks from this screen.
- No change to the shared script revision from any of the three actions.

## Contracts

- `GET /api/jams/:id/script.md` — latest markdown revision (shared, unpersonalized).
- `POST /api/jams/:id/sessions` — create a session, returns `{ session, ownerToken }`.
- `PATCH /api/sessions/:id` — owner-only update of `language` / `ambientation`.
- `GET /api/sessions/:id/script.md` — shared script annotated with the session's settings.

Endpoint shapes, limits and error codes are in `docs/API_CONTRACTS.md`; the session-as-seat
decision is recorded in `docs/DECISIONS.md`.

