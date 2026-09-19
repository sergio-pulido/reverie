# Decisions

## 2026-09-19 — Use Vercel and Supabase for the public prototype

The public prototype deploys the Vite frontend and privileged Node functions to Vercel, while Supabase provides Postgres, anonymous Auth, Row Level Security, Realtime, and later Storage. This gives the demo persistent room URLs and multi-browser collaboration without operating a custom WebSocket server on a serverless platform.

## 2026-09-19 — Retain a local same-origin development server

Superseded for deployment by the Vercel/Supabase decision above. Express remains the local Vite/static-preview host; persistent room state belongs in Supabase, and collaboration uses Supabase Realtime.

## 2026-09-19 — Keep sponsor technologies behind adapters

Nebius, SLNG, fal.ai, Titan, and any confirmed HackBarna sponsor capability are server-side integrations behind typed adapters. The product contracts do not depend on one model/vendor, and no provider is represented as available before a live probe confirms it.

## 2026-09-19 — Server owns collaborative story state

The server is authoritative for membership, queue ordering, votes, story versions, accepted scenes, and budgets. Clients render snapshots/events and can show pending feedback, but cannot commit a scene independently.

## 2026-09-19 — Use Titan catalogue records as real cinema, not synthetic content

The Discover experience renders Titan-provided real films and series faithfully. Catalogue metadata and generated Movie Jam artifacts have separate schemas, identifiers, and labels so the product never presents an invented/generated work as a real title or rewrites existing films as jokes.

## 2026-09-19 — Treat media as declared creative references

Images, uploaded clips, and live camera are inputs to a shared creative turn, not opaque prompt attachments. Each has an owner, consent state, declared purpose, lifetime, and server-issued asset reference. Live media uses Vonage for room transport and fal.ai only for explicitly permitted creative transformation.

## 2026-09-19 — Start with one same-origin local development server

The first runnable baseline serves the Vite client through the Node/Express process at `127.0.0.1:4317`. This keeps browser-to-server contracts and provider boundaries easy to iterate on locally. It is a local development baseline, not the public deployment configuration.

## 2026-09-19 — Align deployment and collaboration foundation

Vercel serves the Vite SPA and `/api` Node functions. API paths are excluded from the SPA rewrite; health does not assert provider/database readiness. Supabase owns identity and persistent state. No extra database, WebSocket service or provider integration is introduced.

The primary agent commits and pushes completed verified slices directly to `main`, including documentation. The collaborator uses isolated PR branches and auto-merge after checks. Fetch before publication, stage owned files explicitly, and never force-push shared history.

## 2026-09-19 — The invite code, not the room URL, is the entitlement

A jam carries a server-generated 8-character code from an alphabet with no I, O or U so it
can be read aloud in a room. A room URL can be screenshotted, indexed or forwarded; an
entitlement should be something the host hands out deliberately. Admission exchanges the
code and a display name for a membership row through a constrained `security definer`
function, and the browser has no write policy on `jam_members` at all.

## 2026-09-19 — Public jams admit on arrival, invite-only jams wait

A public jam activates a guest as soon as they present the code, because asking a host to
admit an audience one by one is the wrong default for a live demo. An invite-only jam keeps
the waiting lobby from `docs/STATE_MACHINE.md`. Removal is host-only in both cases and a
removed participant cannot re-enter with the same code.

## 2026-09-19 — Membership checks run through security definer helpers

A policy on `jams` that reads `jam_members`, while a policy on `jam_members` reads `jams`,
recurses. `is_jam_host`, `is_jam_member` and `is_active_jam_member` read with RLS bypassed
and are the single place membership is decided, for table policies and for the private
Realtime channel alike.

## 2026-09-19 — Rows are authority, Postgres Changes are notification, Broadcast is neither

Durable collaborative state is rows under RLS. Postgres Changes tell a subscriber that such
a row exists and are filtered by the same policies. Presence answers only "who is connected
right now". Broadcast carries no story state and grants nothing, so knowing a channel name
is never access.

## 2026-09-19 — Reconnect reloads a snapshot instead of replaying events

There is no persisted event log, so a client that misses events cannot be caught up by
replay without inventing one. Every successful subscribe reloads the authorized snapshot
and folds it over local rows, deduplicated by id and ordered by `(created_at, id)`. This is
correct with no extra infrastructure and stays correct when a replay log is added later.

## 2026-09-19 — Chat and proposals are append-only until a versioned scene contract exists

`jam_messages` and `jam_proposals` have insert and select policies and no update or delete
policy. Changing a proposal status is a scene transition, which `docs/API_CONTRACTS.md`
requires to carry `expectedStateVersion`, an idempotent `requestId` and a serialized commit.
Until that transactional contract is implemented, no client can fake one, and no generation
is wired to a proposal.

## 2026-09-19 — A configured Supabase failure is an error, never local state

The local preview exists only when Supabase is unconfigured, and says so on the screen. When
Supabase is configured and a call fails, the room shows a typed error and a retry. Silently
degrading into local React state would present a private draft as a shared room.

## 2026-09-19 — Only a message the schema authored reaches a participant

Every `raise exception` in the Reverie schema marks its message. `toJamError` forwards only
a marked message and replaces anything else with fixed safe text per SQLSTATE. Without that
rule a native Postgres error — an RLS violation or a unique-constraint failure — would
display a table, column or constraint name to whoever triggered it.

## 2026-09-19 — Who is waiting is host-only information

An active member reads the active roster; only the host reads the waiting rows. Enforcing
this in the `jam_members` select policy rather than in the component that renders the lobby
means a participant reading the table directly sees the same thing the UI shows them.
