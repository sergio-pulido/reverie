# Internal API contracts v1

These are Reverie application contracts, not provider API endpoints.

## Implemented interfaces

- `GET /api/health`: `{ "status": "ok", "service": "reverie-movie-jam" }`, in local Express and a Vercel Node function. This reports process health, not database or provider readiness.
- Browser calls Supabase Auth for anonymous sign-in, then inserts/selects `jams` under RLS. A database trigger creates the active host membership.
- No HTTP room API or provider endpoint is implemented. Room membership and collaboration are Supabase RPCs, RLS-protected table access and Realtime subscriptions, described below.

### Implemented Supabase functions

| Function | Caller | Returns | Refuses |
| --- | --- | --- | --- |
| `request_jam_admission(p_invite_code, p_display_name)` | any authenticated session | `{ jamId, slug, title, memberStatus }` | no session (`28000`), name outside 1–32 characters (`22023`), unknown code (`P0002`), completed/closed jam (`22023`), previously removed caller (`42501`) |
| `set_jam_member_status(p_jam_id, p_member_id, p_status)` | host only | `{ jamId, userId, displayName, role, status }` | non-host caller and the host's own row (`42501`), status other than `active`/`removed` (`22023`), unknown member (`P0002`) |

`memberStatus` is `waiting` for an invite-only jam and `active` for a public one. A host calling it against their own jam gets their existing host membership back unchanged. Neither
function can create or promote a host. The browser has no insert, update or delete policy on
`jam_members`, so these functions are the only membership mutation path.

### Implemented table access

| Table | Select | Insert |
| --- | --- | --- |
| `jams` | host or any waiting/active member | host only, `host_id = auth.uid()` |
| `jam_members` | own row; the host sees every row; an active member sees only the active roster | none |
| `jam_messages` | active members | active members, `author_id = auth.uid()` (defaulted, never sent by the browser) |
| `jam_proposals` | active members | active members, `status = 'queued'` |

No update or delete policy exists on `jam_messages` or `jam_proposals`: both are append-only
until the versioned scene contract below is implemented.

### Implemented Realtime contracts

- Postgres Changes on `jam_messages` (INSERT), `jam_proposals` (INSERT) and `jam_members`
  (all events), filtered by `jam_id` and delivered under the policies above.
- Private channel `jam:<jam id>`, authorized by `realtime.messages` RLS against active
  membership. Presence entries are `{ userId, displayName, at }` and are display state only.
- Every successful subscribe reloads the authorized snapshot. There is no event replay,
  because no persisted event log exists yet.
- Who is queued for admission is host-only information, enforced by the `jam_members` select
  policy rather than by which panel the client renders.

## Planned privileged HTTP interfaces

| Route | Purpose |
| --- | --- |

| `GET /api/catalogue` | Read validated, real-title catalogue records allowed by the Titan integration |
| `POST /api/discover/turns` | Apply a natural-language discovery refinement to real catalogue results |

| ~~`POST /api/jams/:id/join`~~ | Superseded: implemented as the `request_jam_admission` RPC above |
| ~~`POST /api/jams/:id/members/:memberId/admit`~~ | Superseded: implemented as the `set_jam_member_status` RPC above |
| `POST /api/jams/:id/scene/accept` | Host or configured vote rule accepts the next turn |
| `POST /api/jams/:id/forks` | Fork from a declared past scene version |
| `POST /api/jams/:id/close` | Close a room and release active resources |

## Planned Supabase mutation and Realtime contracts

Supabase Realtime carries authenticated room notifications over its managed WebSocket transport. Durable chat/proposals/votes use RLS-protected database writes; multi-row admission and scene transitions use constrained transactional RPCs. Broadcast cannot grant membership or accept a scene. The HTTP routes above remain design candidates, not available endpoints; admission may be implemented as an authenticated RPC instead. Each command has `schemaVersion`, `requestId`, `expectedStateVersion`, `type`, and typed payload. Events have `eventId`, `roomId`, `stateVersion`, `occurredAt`, `type`, and payload. Vercel functions handle privileged operations such as issuing Vonage session tokens and calling providers.

Commands: `chat.send`, `proposal.create`, `vote.cast`, `room.open`, `room.start`, `scene.accept`, `member.leave`, `audio.start`, and `audio.stop`.

Multimodal commands: `reference.upload.request`, `reference.upload.complete`, `reference.intent.set`, `liveMedia.join`, `liveMedia.leave`, `liveMedia.consent.set`, `broadcast.start`, `broadcast.stop`, and `archive.request`. A reference descriptor includes its owner, source type, declared purpose, lifetime, consent state, and a server-issued asset reference; it never accepts a browser-supplied provider URL.

Events: `room.snapshot`, `member.joined`, `member.waiting`, `member.admitted`, `presence.updated`, `transcript.partial`, `transcript.final`, `reference.ready`, `liveMedia.state`, `proposal.created`, `vote.updated`, `scene.processing`, `story.updated`, `artifact.updated`, `media.requested`, `media.ready`, `media.delayed`, `room.closed`, and `error`.

## Ordering and errors

State-changing commands must include the latest `expectedStateVersion`. A stale command receives a conflict error plus the current snapshot; it is never merged silently. Known `requestId` values are idempotent. The server serializes accepted scene transitions and discards late provider output after a room close or superseding scene version.

Errors expose `code`, `safeMessage`, `retryable`, and `requestId`. They never expose credentials, raw provider bodies, or internal prompts.

Catalogue responses use provider-approved identifiers and asset references. Generated Jam media always carries a separate generated-artifact identifier and must never impersonate a catalogue title.
