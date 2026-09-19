# Internal API contracts v1

These are Reverie application contracts, not provider API endpoints.

## Implemented interfaces

- `GET /api/health`: `{ "status": "ok", "service": "reverie-movie-jam" }`, in local Express and a Vercel Node function. This reports process health, not database or provider readiness.
- Browser calls Supabase Auth for anonymous sign-in, then inserts/selects `jams` under RLS. A database trigger creates the active host membership.
- `GET /api/catalogue?query=&page=&pageSize=`: TV-first Discover reads real catalogue records through a privileged server adapter. Same-origin only, `GET`/`HEAD` only, Zod-validated query (`query` ≤ 120 chars, `page` 1–100, `pageSize` 1–48, default 24), per-instance rate limit of 30 requests per minute, bounded upstream body, and an upstream timeout.
  - `200 { "status": "ok", "source": "titan", "items": [...], "page", "pageSize", "total", "hasMore", "attribution" }` — every record comes from the authorized upstream. Catalogue identifiers are namespaced `cat:` so they can never be confused with generated Jam artifacts.
  - `200 { "status": "catalogue_not_configured", "code": "CATALOGUE_NOT_CONFIGURED", "safeMessage", "missing": [...] }` — no authorized catalogue endpoint/credential is configured. The UI states this; it does not invent titles.
  - `4xx/5xx { "status": "error", "code", "safeMessage", "retryable" }` — codes are `INVALID_QUERY`, `METHOD_NOT_ALLOWED`, `CROSS_ORIGIN_BLOCKED`, `RATE_LIMITED`, `CATALOGUE_TIMEOUT`, `CATALOGUE_UNREACHABLE`, `CATALOGUE_UNAUTHORIZED`, `CATALOGUE_RATE_LIMITED`, `CATALOGUE_UPSTREAM_ERROR`, `CATALOGUE_REQUEST_REJECTED`, `CATALOGUE_INVALID_RESPONSE`, `CATALOGUE_RESPONSE_TOO_LARGE`. They never carry the credential, the upstream URL or the upstream body.
  - The upstream contract the adapter expects, and the `TITAN_CATALOGUE_URL` / `TITAN_API_KEY` / `TITAN_CATALOGUE_TIMEOUT_MS` configuration, are specified in `docs/specs/discover-titan-catalogue.md`. No Titan catalogue endpoint is published or supplied today, so this route answers `catalogue_not_configured`.
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

| `POST /api/discover/turns` | Apply a natural-language discovery refinement to real catalogue results |
| `POST /api/jams` | Create a jam and generate its script from scratch or from an existing movie |
| `GET /api/jams/:id` | Read a generated jam snapshot |
| `GET /api/jams/:id/script.md` | Read the current script markdown (the latest revision, including live edits) |
| `PUT /api/jams/:id/script` | Append a live markdown edit as a new script revision |
| `POST /api/jams/:id/script/revert` | Restore an earlier revision as a new revision (undo/redo) |
| `GET /api/jams/:id/script/revisions` | List revision metadata (no markdown bodies) |
| `GET /api/jams/:id/script/revisions/:revision` | Read one full revision including its markdown |
| `POST /api/jams/:id/sessions` | Attach a user session to a jam; returns the session plus a one-time owner token |
| `GET /api/jams/:id/sessions` | List a jam's sessions (public projections, never owner tokens) |
| `GET /api/sessions/:id` | Read one session |
| `PATCH /api/sessions/:id` | Owner-only (Bearer owner token) update of playback settings: `language`, `ambientation` |
| `GET /api/sessions/:id/script.md` | Read the shared script annotated with the session's playback settings |
| ~~`POST /api/jams/:id/join`~~ | Superseded: implemented as the `request_jam_admission` RPC above |
| ~~`POST /api/jams/:id/members/:memberId/admit`~~ | Superseded: implemented as the `set_jam_member_status` RPC above |
| `POST /api/jams/:id/scene/accept` | Host or configured vote rule accepts the next turn |
| `POST /api/jams/:id/forks` | Fork from a declared past scene version |
| `POST /api/jams/:id/close` | Close a room and release active resources |

`POST /api/jams` accepts an optional `format` object (`totalSeconds`, `portionMinSeconds`, `portionMaxSeconds`); omitted fields default to a 4-minute script of 10–20 second portions. The jam stores its format and all generation and validation follow it.

## Planned Supabase mutation and Realtime contracts

Supabase Realtime carries authenticated room notifications over its managed WebSocket transport. Durable chat/proposals/votes use RLS-protected database writes; multi-row admission and scene transitions use constrained transactional RPCs. Broadcast cannot grant membership or accept a scene. The HTTP routes above remain design candidates, not available endpoints; admission may be implemented as an authenticated RPC instead. Each command has `schemaVersion`, `requestId`, `expectedStateVersion`, `type`, and typed payload. Events have `eventId`, `roomId`, `stateVersion`, `occurredAt`, `type`, and payload. Vercel functions handle privileged operations such as issuing Vonage session tokens and calling providers.

Commands: `chat.send`, `proposal.create`, `vote.cast`, `room.open`, `room.start`, `scene.accept`, `member.leave`, `audio.start`, and `audio.stop`.

Multimodal commands: `reference.upload.request`, `reference.upload.complete`, `reference.intent.set`, `liveMedia.join`, `liveMedia.leave`, `liveMedia.consent.set`, `broadcast.start`, `broadcast.stop`, and `archive.request`. A reference descriptor includes its owner, source type, declared purpose, lifetime, consent state, and a server-issued asset reference; it never accepts a browser-supplied provider URL.

Events: `room.snapshot`, `member.joined`, `member.waiting`, `member.admitted`, `presence.updated`, `transcript.partial`, `transcript.final`, `reference.ready`, `liveMedia.state`, `proposal.created`, `vote.updated`, `scene.processing`, `story.updated`, `artifact.updated`, `media.requested`, `media.ready`, `media.delayed`, `room.closed`, and `error`.

## Ordering and errors

State-changing commands must include the latest `expectedStateVersion`. A stale command receives a conflict error plus the current snapshot; it is never merged silently. Known `requestId` values are idempotent. The server serializes accepted scene transitions and discards late provider output after a room close or superseding scene version.

Errors expose `code`, `safeMessage`, `retryable`, and `requestId`. They never expose credentials, raw provider bodies, or internal prompts.

Catalogue responses use provider-approved identifiers and asset references. Generated Jam media always carries a separate generated-artifact identifier and must never impersonate a catalogue title.
