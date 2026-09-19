# Architecture

Status: target architecture for the first public build. Vercel deploys the web application and privileged API functions; Supabase is the authoritative collaborative data layer.

## Data flow

Titan catalogue data → server-side catalogue adapter → validated real-title metadata → TV-first Discover UI. Separately: participant text, microphone, image, video clip, or Vonage live-media input → Supabase authenticated writes or privileged Vercel function → normalized creative turn with declared intent → Jam orchestrator → schema and story-state validation → queue and vote state → accepted scene direction → creative reasoning and media adapters → versioned creative artifacts and live scene events → all connected clients.

The client can optimistically render a pending idea, but Supabase-backed server rules are the authority for membership, proposal ordering, votes, accepted turns, scene versions, and room data. Vercel functions own privileged provider calls and budgets. The planned reconnect flow reloads an RLS-protected database snapshot; bounded event replay requires a future persisted event log.

## Modules

- **core** — provider-free types and rules: room state, story version merge, queue/vote evaluation, artifacts, forks, deterministic ordering and validation.
- **jam** — host/member permissions, lobby, presence, admission, proposal and vote commands.
- **cinema** — screenplay, character, world, shot list, visual direction and scene artifact schemas.
- **catalogue** — licensed Titan title metadata, availability, discovery taxonomy, safe search/filtering, and attribution rules. It is distinct from generated Jam artifacts.
- **providers** — typed Nebius, SLNG, fal.ai, and future sponsor adapters. Transport quirks stop here.
- **live-media** — Vonage session/token lifecycle, participant media permissions, signaling, captions, broadcast/archive controls, and a normalized reference descriptor for the Jam core.
- **server** — local Express development host; deployed privileged operations live in Vercel Node functions. No custom WebSocket lifecycle.
- **supabase** — Postgres room state, Auth identities, Row Level Security, Realtime room events, and later media-reference metadata/storage.
- **vercel** — frontend deployment plus Node functions for provider credentials, Vonage token creation, media signing, spend controls, and operations that cannot run in the browser.
- **web** — host console, participant/mobile room, audience display, transcript, queue, votes and generated media.

## Lifecycle and limits

The first public demo uses Vercel and Supabase rather than a process-local room server. Supabase persists room state and Realtime can broadcast collaborative updates; Vercel functions remain stateless. The system keeps bounded event history, payload sizes, active captures, generation requests, final turns, session duration and spending.

Raw audio and live camera are transient. Transcript/provider payload logging is disabled by default. Uploaded or recorded media needs explicit room-level consent, an owner, declared creative purpose, and an expiry/export policy. External outputs and user content are treated as untrusted data.

## Why a queue exists

Five simultaneous requests should create five candidate turns, not five contradictory generation calls. Participants can propose and vote while a scene is playing. At a defined scene boundary, the host or the vote rule accepts one direction, commits the next story version, updates the editable production package, and asks the media adapter to evolve the scene.

## Current implementation boundary

Implemented: room creation, invite entitlement with expiry, revocation and rotation, link
and QR sharing, display names, the waiting lobby, host admission and removal, append-only
chat and proposals, Postgres Changes, Presence, private channel authorization, reconnect
snapshots, route scaffolding and health handlers. Constrained `security definer` RPCs own
every membership mutation and every invite mutation; Broadcast and Presence are
notifications, not authorization or durable story state, and private rooms enforce both
table RLS and private-channel authorization. The invite columns on `jams` are additionally
withheld by column grant, because RLS scopes rows and not columns.

Not implemented: votes, scene transitions, forks, catalogue and every provider workflow.
Scene acceptance is deliberately absent because it requires the versioned transactional
command contract in `docs/API_CONTRACTS.md`. No Supabase project has been migrated and no
provider has been probed from this repository.
