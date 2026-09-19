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
| `request_jam_admission(p_invite_code, p_display_name)` | any authenticated session | `{ jamId, slug, title, memberStatus }` | no session (`28000`), name outside 1–32 characters (`22023`), unknown, revoked or expired invite (`P0002`), completed/closed jam (`22023`), previously removed caller (`42501`), more than 10 failed lookups in 10 minutes (`53400`) |
| `set_jam_member_status(p_jam_id, p_member_id, p_status)` | host only | `{ jamId, userId, displayName, role, status }` | non-host caller and the host's own row (`42501`), status other than `active`/`removed` (`22023`), unknown member (`P0002`) |
| `get_jam_invite(p_jam_id)` | host only | `{ jamId, slug, code, expiresAt, revokedAt, state }` | non-host caller (`42501`), unknown jam (`P0002`) |
| `rotate_jam_invite(p_jam_id, p_expires_in_minutes)` | host only | the new invite, same shape | non-host caller (`42501`), lifetime outside 5 minutes to 24 hours (`22023`) |
| `revoke_jam_invite(p_jam_id)` | host only | the revoked invite, same shape | non-host caller (`42501`) |

`memberStatus` is `waiting` for an invite-only jam and `active` for a public one. A host calling it against their own jam gets their existing host membership back unchanged. Neither
function can create or promote a host. The browser has no insert, update or delete policy on
`jam_members`, so these functions are the only membership mutation path.

A repeated `request_jam_admission` from the same session is idempotent: the display name is
refreshed and the status is left alone, so a second submit never resets a pending admission
or re-admits a removed participant.

`state` is `active`, `expired` or `revoked`. A revoked or expired invite is refused with the
same `P0002` message an unknown code gets, so a probe cannot tell a lapsed invite from a
code that never existed. `p_expires_in_minutes` is `null` for an invite that does not expire.

### Implemented table access

| Table | Select | Insert |
| --- | --- | --- |
| `jams` | host or any waiting/active member, **excluding `invite_code`, `invite_expires_at` and `invite_revoked_at`** | host only, `host_id = auth.uid()` |
| `jam_admission_attempts` | none | none (RLS on, no policies; reached only by `security definer` functions) |
| `jam_members` | own row; the host sees every row; an active member sees only the active roster | none |
| `jam_messages` | active members | active members, `author_id = auth.uid()` (defaulted, never sent by the browser) |
| `jam_proposals` | active members | active members, `status = 'queued'` |

No update or delete policy exists on `jam_messages` or `jam_proposals`: both are append-only
until the versioned scene contract below is implemented.

The three invite columns on `jams` are excluded from the column grants to `authenticated`
for both `select` and `update`. RLS answers which rows a caller may read; which columns of
a row they may read is a column privilege, so this is the only place it can be enforced. A
member therefore cannot re-share the entitlement, and a host cannot hand-write a predictable
code — both go through the host-only functions above, which run as owner.

### Implemented Realtime contracts

- Postgres Changes on `jam_messages` (INSERT), `jam_proposals` (INSERT) and `jam_members`
  (all events), filtered by `jam_id` and delivered under the policies above.
- Private channel `jam:<jam id>`, authorized by `realtime.messages` RLS against active
  membership. Presence entries are `{ userId, displayName, at }` and are display state only.
- Every successful subscribe reloads the authorized snapshot. There is no event replay,
  because no persisted event log exists yet.
- Who is queued for admission is host-only information, enforced by the `jam_members` select
  policy rather than by which panel the client renders.
- A waiting participant holds no channel, because channel authorization requires *active*
  membership. Their access status is polled from their own `jam_members` row every 5 seconds
  until it becomes `active` (Postgres Changes take over) or `removed` (terminal). No read
  surface is added for this: `user_id = auth.uid()` is already in the select policy.

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

| `POST /api/jams/:id/playback/start` | Host-only: lock portion 0, request its video, enter `priming` |
| `POST /api/jams/:id/playback/advance` | Host-only: move playback to the next portion once its video is ready |
| `GET /api/jams/:id/playback` | Read playback state: current/locked portion indices, per-portion media status |
| `GET /api/jams/:id/portions/:index/video` | Stream a generated portion clip (HTTP Range, `video/mp4`); server-hosted, never a provider URL |

`POST /api/jams` accepts an optional `format` object (`totalSeconds`, `portionMinSeconds`, `portionMaxSeconds`); omitted fields default to a 4-minute script of 10–20 second portions. The jam stores its format and all generation and validation follow it.

## Portion playback, locking, and video generation

Portions are addressed by a zero-based global `portionIndex` in flattened scene order — the single address used by edits, playback, and media routes (the markdown label `Portion 2.1` is a render, not the address). Structural edits (insert/delete/reorder of scenes or portions) are forbidden in v1: the portion count is fixed at generation time and only `action`, `dialogue`, `visualDirection`, and `durationSeconds` are editable, so indices and generation job keys stay stable. Stable portion ids become a later extension if forks or insertion ever need them. The structured script (scenes → portions) is the editing source of truth; markdown revisions are deterministic renders of it (coordination ruling, 2026-09-19, contract agreed with jam-storage).

**Lock window.** Server-owned playback state on the jam: `playback: { status: "idle" | "priming" | "playing" | "finished", currentPortionIndex, stateVersion }`. Derived rules, never stored per portion:

- `portionIndex <= currentPortionIndex`: immutable (played or playing).
- `portionIndex == currentPortionIndex + 1` (or `0` while `priming`): **locked** — the generation buffer. Its text is pinned at the script revision current at lock time.
- `portionIndex >= currentPortionIndex + 2`: freely editable.

Any script edit that changes a portion at or below the locked index is rejected with `portion_locked` (`retryable: false`, includes the locked index and current `stateVersion`). Edits to later portions succeed as normal revisions. The JamStore stays persistence-only: portion edit and revert operations take a `minEditablePortionIndex` parameter and throw `PORTION_LOCKED` below it, and the router wires that parameter from the playback guard, which returns `{ minEditablePortionIndex, stateVersion }` in a single call. Playback state itself persists through the JamStore (`getPlayback`, `updatePlayback` with compare-and-swap on `stateVersion`); playback semantics — the advance rule, monotonicity — live outside the store. Per-jam mutations (`updatePortion`, `revertToRevision`, `updatePlayback`) serialize, and the router reads the guard in the same critical section as the mutation it protects, so the boundary cannot move between check and write. A revert whose target revision differs from the current one in any locked or played portion is rejected with `portion_locked` — no partial reverts. Duration edits must stay within the jam format's hard portion bounds, but the total-runtime tolerance is not re-enforced on live edits.

Pinning needs no store API: an advance commits the new cursor via `updatePlayback` first, then reads the current revision number `N` and pins `(jamId, portionIndex, N)`; because the boundary is already enforced and history is append-only, the locked portion's text at revision `N` is immutable.

**Advance rule.** `playback.advance` (host-only, `expectedStateVersion`-guarded) moves the cursor forward by exactly one portion, and only when the locked portion's video is `ready`; otherwise it fails with `media_not_ready` (`retryable: true`) and the room holds on the current portion (`media.delayed`). On a successful advance the next portion is locked, its text pinned, and its generation job enqueued — the pipeline stays exactly one portion ahead. Skipping is not expressible in the API.

**Generation jobs.** Locking a portion enqueues one job: `queued → submitted → generating → downloading → ready | failed` (`failed` carries `retryable`). Jobs are keyed by `(jamId, portionIndex, pinnedRevision)` and idempotent. The clip duration target is the portion's `durationSeconds` (within the jam format's hard bounds). Late provider output after `room.closed` is discarded (locked portions cannot be reverted, so a pinned generation is never superseded). Events: `portion.locked`, `media.requested`, `media.ready`, `media.delayed`.

**fal.ai boundary.** Calls go through a typed adapter in `apps/server/providers/fal.ts` behind `REVERIE_LIVE_ENABLED` and `FAL_KEY`, with a server-owned model allowlist (`FAL_MODEL` may only select from it), bounded generation concurrency, and per-jam clip-count and spend caps. The adapter is not claimed live until a dated probe receipt is recorded. Clients never receive fal URLs or request bodies.

**Delivery.** The server downloads each finished clip into its own storage and serves it at `GET /api/jams/:id/portions/:index/video` with Range support. Storage limits: at most `MAX_PORTIONS` (48) clips per jam, a per-clip size cap, and eviction of all clips on jam close or store eviction.

`GET /api/jams/:id/playback` as a polling surface is an interim mechanism only, until the `portion.locked` / `media.*` events ride Supabase Realtime; do not build on polling as the contract — the events above are the contract.

## Planned Supabase mutation and Realtime contracts

Supabase Realtime carries authenticated room notifications over its managed WebSocket transport. Durable chat/proposals/votes use RLS-protected database writes; multi-row admission and scene transitions use constrained transactional RPCs. Broadcast cannot grant membership or accept a scene. The HTTP routes above remain design candidates, not available endpoints; admission may be implemented as an authenticated RPC instead. Each command has `schemaVersion`, `requestId`, `expectedStateVersion`, `type`, and typed payload. Events have `eventId`, `roomId`, `stateVersion`, `occurredAt`, `type`, and payload. Vercel functions handle privileged operations such as issuing Vonage session tokens and calling providers.

Commands: `chat.send`, `proposal.create`, `vote.cast`, `room.open`, `room.start`, `scene.accept`, `member.leave`, `audio.start`, and `audio.stop`.

Multimodal commands: `reference.upload.request`, `reference.upload.complete`, `reference.intent.set`, `liveMedia.join`, `liveMedia.leave`, `liveMedia.consent.set`, `broadcast.start`, `broadcast.stop`, and `archive.request`. A reference descriptor includes its owner, source type, declared purpose, lifetime, consent state, and a server-issued asset reference; it never accepts a browser-supplied provider URL.

Events: `room.snapshot`, `member.joined`, `member.waiting`, `member.admitted`, `presence.updated`, `transcript.partial`, `transcript.final`, `reference.ready`, `liveMedia.state`, `proposal.created`, `vote.updated`, `scene.processing`, `story.updated`, `artifact.updated`, `portion.locked`, `media.requested`, `media.ready`, `media.delayed`, `room.closed`, and `error`.

## Ordering and errors

State-changing commands must include the latest `expectedStateVersion`. A stale command receives a conflict error plus the current snapshot; it is never merged silently. Known `requestId` values are idempotent. The server serializes accepted scene transitions and discards late provider output after a room close or superseding scene version.

Errors expose `code`, `safeMessage`, `retryable`, and `requestId`. They never expose credentials, raw provider bodies, or internal prompts.

Catalogue responses use provider-approved identifiers and asset references. Generated Jam media always carries a separate generated-artifact identifier and must never impersonate a catalogue title.
