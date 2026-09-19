# A session is the participant's seat in the room

**Status: intended, not implemented.** `docs/specs/script-screen-actions.md` section 3 states
the model — "a session is your seat in the same collaborative room" — and then records that it
is intent, not wiring. This document is the target design for closing that gap, plus the
Supabase-backed persistence it depends on. No code derives a session from a membership today.

## Problem

Two records describe the same person in the same room, and neither knows about the other.

| | `JamSession` | `jam_members` |
| --- | --- | --- |
| Identity | a one-time bearer `ownerToken` | Supabase Auth `auth.uid()` |
| Storage | in-memory `InMemorySessionStore` (`apps/server/sessions.ts`) | Postgres under RLS |
| Authority | the local Express host | the database |
| Carries | `displayName`, `language`, `ambientation` | `role`, `status`, `displayName` |
| Created by | `POST /api/jams/:id/sessions` | `request_jam_admission` |

Creating a session does not admit you to the room. Being admitted to the room does not give you
a session. The display name is stored twice and can disagree. The product says these are one
thing; the code says they are two, and every feature built on "the participant" has to pick one
and be wrong about the other.

The concrete cost is already visible: per-participant playback overrides live on the session,
but who is actually in the room lives on the membership — so configuration-keyed streams
(`docs/specs/configuration-keyed-streams.md`) cannot answer "which configurations are present
among this room's participants" without joining two records that have no join key.

## Model — one seat, derived from membership

**Membership is the authority. A seat is a facet of it, never a parallel record.**

- A **seat** exists for exactly one `(jam, identity)` pair, and only where a `jam_members` row
  exists. The seat's key *is* the membership's key; there is no separate session id to reconcile.
- A seat carries only what membership does not: the per-participant playback overrides
  (`language`, `ambientation`). Role, status and admission stay on the membership row.
- Display name lives on the membership row, which already has it and already validates it
  (1–32 characters, refreshed idempotently by `request_jam_admission`). The seat does not
  duplicate it.

**Creating a seat must never grant membership.** This is the security property the unification
has to preserve. Admission is `request_jam_admission` plus host approval, and nothing else. A
seat write by someone with no membership row is refused, not treated as a request to join — the
browser has no insert policy on `jam_members` precisely so that admission has one door, and
adding a second door through the settings surface would undo `docs/specs/jam-lobby-admission.md`.

## Identity replaces the owner token

The `ownerToken` exists for one reason: the local Express host has no notion of who is calling.
Supabase Auth does. Once seats are membership-scoped rows, ownership is `owner_id = auth.uid()`,
enforced by RLS, and **the owner token disappears entirely**.

That is a simplification, not a migration cost: it removes a bearer secret that is issued once,
never listed, never recoverable, and currently compared with `timingSafeEqual` in application
code. One fewer secret to leak is the point.

The schema for this already exists and is unused. `public.jam_sessions`
(`supabase/migrations/20260919170000_script_format_and_sessions.sql`) has `owner_id` referencing
`auth.users`, `unique (jam_id, owner_id)`, the same language and ambientation constraints as
`src/core/session.ts`, owner-scoped insert/select/update/delete policies and a host read policy.
It is **designed, not wired**: no server code reads or writes it.

## The deployment gap closes by itself

The sessions router is mounted only in the local Express host, so every session route is
local/preview tooling — it is listed under "Planned privileged HTTP interfaces" in
`docs/API_CONTRACTS.md` for that reason.

Membership-scoped seats need **no privileged function at all**. Reading and writing your own
overrides is an owner-scoped RLS row: the browser does it directly against Supabase, the same
way it already reads `jams` and writes `jam_messages`. The route that needs deploying stops
being a route.

The one surface that still needs a server is the **personalized script render**
(`GET /api/sessions/:id/script.md`), because it renders a script the browser does not hold — and
today it only annotates a header anyway (`src/core/scriptMarkdown.ts`). Whether that stays a
route or becomes a client render of data the client already has is an open question below.

## Lifecycle — the seat follows the membership

`joining (UI) → waiting → active → left | removed` (`docs/STATE_MACHINE.md`).

- **waiting** — a seat may hold overrides, but they buy nothing: a waiting participant holds no
  channel and reads no room state. Letting someone choose their language while waiting is good
  product; letting it be visible to the room is not.
- **active** — the seat is live. Its overrides select a configuration, and the room's distinct
  configurations are now answerable from a single query over active members, which is what
  `docs/specs/configuration-keyed-streams.md` needs.
- **left / removed** — the seat stops being counted among the room's configurations at once. A
  removed participant's overrides must not keep a configuration alive, or a stream stays bought
  for someone who is gone.

Whether a removed participant's overrides are retained (so a re-admitted person gets their
settings back) or discarded is an open question. `request_jam_admission` refuses a previously
removed caller outright, so retention has no path back today.

## Cardinality

Two caps currently exist and mean different things:

- `MAX_SESSIONS_PER_JAM = 32` (`apps/server/sessions.ts`) — in-memory sessions per jam.
- `unique (jam_id, owner_id)` on `jam_sessions` — one seat per identity per jam.

Under this model the uniqueness constraint is the real rule and the numeric cap becomes a
**membership** cap, not a session cap. It must not be confused with the configuration cap, which
is a separate budget control over distinct configurations, not over people
(`docs/specs/configuration-keyed-streams.md` makes the same warning about the same constant).

## Open questions (unspecified)

- Whether the seat is a column set on `jam_members` or a separate `jam_sessions` row keyed to it.
  The migration already chose a separate table; nothing has validated that choice against use.
- Whether the personalized script render stays a server route or becomes a client-side render.
- Whether overrides survive removal and re-admission.
- What happens to the in-memory `SessionStore` and its routes: deleted, or kept as the
  no-Supabase local-preview path. Keeping them means two code paths for one concept, which is
  the problem this spec is closing.
- Whether the host may read another participant's overrides. The migration's host read policy
  says yes; no product decision has been recorded.
- Migration of existing in-memory sessions: there are none that survive a restart, so this is
  probably "no migration", but it should be said rather than assumed.

## Implementation status

**Nothing in this spec is implemented.** No code derives a session from a membership, no shared
id exists between `JamSession` and `jam_members`, and no server code reads or writes
`jam_sessions` — the router uses `InMemorySessionStore` (`apps/server/sessions.ts`). See the
register in `docs/specs/intended-vs-implemented.md`.

What exists: the session schema and validation (`src/core/session.ts`), the session routes in
the local Express host (`apps/server/sessions.ts`), the "Your session" card
(`src/ScriptScreen.tsx`), the unwired `jam_sessions` table with the right ownership model, and
the membership, admission and RLS machinery this design makes the single authority
(`docs/specs/jam-lobby-admission.md`, `docs/specs/jam-invite-lifecycle.md`).
