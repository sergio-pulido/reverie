# Internal API contracts v1

These are Reverie application contracts, not provider API endpoints.

## HTTP interfaces

| Route | Purpose |
| --- | --- |
| `POST /api/jams` | Create a public, private, or link-invite Jam |
| `GET /api/jams/:id` | Read a safe room snapshot |
| `POST /api/jams/:id/join` | Request admission using a display name and invite entitlement |
| `POST /api/jams/:id/members/:memberId/admit` | Host-only lobby admission |
| `POST /api/jams/:id/scene/accept` | Host or configured vote rule accepts the next turn |
| `POST /api/jams/:id/forks` | Fork from a declared past scene version |
| `POST /api/jams/:id/close` | Close a room and release active resources |

## WebSocket interface

`WS /api/jams/:id/live` uses authenticated, same-origin upgrades. Each command has `schemaVersion`, `requestId`, `expectedStateVersion`, `type`, and typed payload. Events have `eventId`, `roomId`, `stateVersion`, `occurredAt`, `type`, and payload.

Commands: `chat.send`, `proposal.create`, `vote.cast`, `room.open`, `room.start`, `scene.accept`, `member.leave`, `audio.start`, and `audio.stop`.

Events: `room.snapshot`, `member.joined`, `member.waiting`, `member.admitted`, `presence.updated`, `transcript.partial`, `transcript.final`, `proposal.created`, `vote.updated`, `scene.processing`, `story.updated`, `artifact.updated`, `media.requested`, `media.ready`, `media.delayed`, `room.closed`, and `error`.

## Ordering and errors

State-changing commands must include the latest `expectedStateVersion`. A stale command receives a conflict error plus the current snapshot; it is never merged silently. Known `requestId` values are idempotent. The server serializes accepted scene transitions and discards late provider output after a room close or superseding scene version.

Errors expose `code`, `safeMessage`, `retryable`, and `requestId`. They never expose credentials, raw provider bodies, or internal prompts.
