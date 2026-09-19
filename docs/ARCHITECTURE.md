# Architecture

Status: target architecture for the first public build.

## Data flow

Titan catalogue data → server-side catalogue adapter → validated real-title metadata → TV-first Discover UI. Separately: participant text, microphone, image, video clip, or Vonage live-media input → authenticated same-origin server → normalized creative turn with declared intent → Jam orchestrator → schema and story-state validation → queue and vote state → accepted scene direction → creative reasoning and media adapters → versioned creative artifacts and live scene events → all connected clients.

The client can optimistically render a pending idea, but the server is the only authority for membership, proposal ordering, votes, accepted turns, scene versions, budgets, and provider calls. A reconnect receives a bounded snapshot and event replay.

## Modules

- **core** — provider-free types and rules: room state, story version merge, queue/vote evaluation, artifacts, forks, deterministic ordering and validation.
- **jam** — host/member permissions, lobby, presence, admission, proposal and vote commands.
- **cinema** — screenplay, character, world, shot list, visual direction and scene artifact schemas.
- **catalogue** — licensed Titan title metadata, availability, discovery taxonomy, safe search/filtering, and attribution rules. It is distinct from generated Jam artifacts.
- **providers** — typed Nebius, SLNG, fal.ai, and future sponsor adapters. Transport quirks stop here.
- **live-media** — Vonage session/token lifecycle, participant media permissions, signaling, captions, broadcast/archive controls, and a normalized reference descriptor for the Jam core.
- **server** — session authorization, WebSocket lifecycle, rate/budget gates, orchestration, persistence boundary and safe error mapping.
- **web** — host console, participant/mobile room, audience display, transcript, queue, votes and generated media.

## Lifecycle and limits

The first demo intentionally uses one process and in-memory room state. Its limits must be shown honestly: restart clears rooms; process-local limits do not protect a multi-instance deployment. The system keeps bounded event history, payload sizes, active captures, generation requests, final turns, session duration and spending.

Raw audio and live camera are transient. Transcript/provider payload logging is disabled by default. Uploaded or recorded media needs explicit room-level consent, an owner, declared creative purpose, and an expiry/export policy. External outputs and user content are treated as untrusted data.

## Why a queue exists

Five simultaneous requests should create five candidate turns, not five contradictory generation calls. Participants can propose and vote while a scene is playing. At a defined scene boundary, the host or the vote rule accepts one direction, commits the next story version, updates the editable production package, and asks the media adapter to evolve the scene.
