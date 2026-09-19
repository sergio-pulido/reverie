# Architecture

Status: target architecture for the first public build.

## Data flow

Participant text or microphone input → authenticated same-origin server → final transcript / typed turn → Jam orchestrator → schema and story-state validation → queue and vote state → accepted scene direction → creative reasoning and media adapters → versioned creative artifacts and live scene events → all connected clients.

The client can optimistically render a pending idea, but the server is the only authority for membership, proposal ordering, votes, accepted turns, scene versions, budgets, and provider calls. A reconnect receives a bounded snapshot and event replay.

## Modules

- **core** — provider-free types and rules: room state, story version merge, queue/vote evaluation, artifacts, forks, deterministic ordering and validation.
- **jam** — host/member permissions, lobby, presence, admission, proposal and vote commands.
- **cinema** — screenplay, character, world, shot list, visual direction and scene artifact schemas.
- **providers** — typed Nebius, SLNG, fal.ai, and future sponsor adapters. Transport quirks stop here.
- **server** — session authorization, WebSocket lifecycle, rate/budget gates, orchestration, persistence boundary and safe error mapping.
- **web** — host console, participant/mobile room, audience display, transcript, queue, votes and generated media.

## Lifecycle and limits

The first demo intentionally uses one process and in-memory room state. Its limits must be shown honestly: restart clears rooms; process-local limits do not protect a multi-instance deployment. The system keeps bounded event history, payload sizes, active captures, generation requests, final turns, session duration and spending.

Raw audio is transient. Transcript/provider payload logging is disabled by default. External outputs and user content are treated as untrusted data.

## Why a queue exists

Five simultaneous requests should create five candidate turns, not five contradictory generation calls. Participants can propose and vote while a scene is playing. At a defined scene boundary, the host or the vote rule accepts one direction, commits the next story version, updates the editable production package, and asks the media adapter to evolve the scene.
