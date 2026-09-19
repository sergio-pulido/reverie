# Internal API contracts v1

These are Reverie application contracts, not provider API endpoints.

## Implemented interfaces

- `GET /api/health`: `{ "status": "ok", "service": "reverie-movie-jam" }`, in local Express and a Vercel Node function. This reports process health, not database or provider readiness.
- Browser calls Supabase Auth for anonymous sign-in, then inserts/selects `jams` under RLS. A database trigger creates the active host membership.
- `GET /api/catalogue?query=&page=&pageSize=`: TV-first Discover reads the curated TMDB snapshot in `public.catalogue_titles` through the `search_catalogue_titles` RPC, as the caller's own Supabase session (`Authorization: Bearer <access token>`, required). Same-origin only, `GET`/`HEAD` only, Zod-validated query (`query` ≤ 120 chars, `page` 1–100, `pageSize` 1–48, default 24), per-instance rate limit of 30 requests per minute, and a database timeout. A non-empty query is ranked by `ts_rank` and then popularity; an empty query is ordered by popularity.
  - `200 { "status": "ok", "source": "tmdb", "items": [...], "page", "pageSize", "total", "hasMore", "attribution" }` — every record is a row of the TMDB snapshot, carrying the TMDB attribution. `availability` is always `[]`: the dataset has none. Catalogue identifiers are namespaced `cat:` so they can never be confused with generated Jam artifacts.
  - `200 { "status": "catalogue_not_configured", "code": "CATALOGUE_NOT_CONFIGURED", "safeMessage", "missing": [...] }` — the server has no Supabase URL/anon key (`missing` names them). The UI states this; it does not invent titles.
  - `4xx/5xx { "status": "error", "code", "safeMessage", "retryable" }` — codes are `INVALID_QUERY`, `METHOD_NOT_ALLOWED`, `CROSS_ORIGIN_BLOCKED`, `RATE_LIMITED`, `CATALOGUE_UNAUTHENTICATED` (401), `CATALOGUE_FORBIDDEN` (403), `CATALOGUE_UNAVAILABLE`, `CATALOGUE_INVALID_RESPONSE`. They never carry the token or a database error body.
  - There is no Titan catalogue API. `docs/specs/discover-titan-catalogue.md` is kept as history only.
- `POST /api/live/token`: issues one short-lived Vonage Video connection token to one active member of one jam. Same-origin only, `POST` only, `Authorization: Bearer <Supabase access token>`, body `{ "jamId": "<uuid>" }` and nothing else (an unknown field is rejected), 2 KB body cap, per-instance rate limit of 10 requests per minute.
  - `200 { "status": "ok", "authId", "sessionId", "token", "role", "expiresAt" }` — `authId` is the public application/project identifier the browser SDK needs. The token lasts 10 minutes (hard maximum 15). `role` is derived from the membership row (`host → moderator`, active member → `publisher`); a `role` in the request body is refused, never honoured.
  - `200 { "status": "live_not_configured", "code": "LIVE_NOT_CONFIGURED", "safeMessage", "missing": [...] }` — live media is switched off or not credentialed.
  - `4xx/5xx { "status": "error", "code", "safeMessage", "retryable" }` — `METHOD_NOT_ALLOWED`, `CROSS_ORIGIN_BLOCKED`, `RATE_LIMITED`, `INVALID_REQUEST`, `LIVE_UNAUTHENTICATED`, `LIVE_FORBIDDEN`, `LIVE_UNAVAILABLE`, `LIVE_UNAUTHORIZED`, `LIVE_TIMEOUT`, `LIVE_UNREACHABLE`, `LIVE_UPSTREAM_ERROR`, `LIVE_INVALID_RESPONSE`. None carries a credential, an upstream URL or an upstream body.
  - Identity comes from Supabase Auth verifying the presented access token; membership comes from the caller's own RLS-filtered `jam_members` row. The function holds no service-role key. Sessions are created with `archiveMode=manual`: nothing is recorded, broadcast or transformed. See `docs/specs/jam-live-media-vonage.md`.
- `POST /api/discover/turn` and `POST /api/discover/rank`: Discover's conversation. Same-origin only, `POST` only, `Authorization: Bearer <Supabase access token>` verified by Supabase Auth before any model call, per-instance rate limits of 20 and 30 requests per minute, at most 6 model calls in flight per instance, body caps of 80 KB and 96 KB. The browser holds the preference state and sends it; the server validates it with the engine's schema and trusts nothing in it. Nebius is called only here, only when `REVERIE_LIVE_ENABLED=true` and `NEBIUS_API_KEY` is set, with the model from the server allowlist; a client that disconnects aborts the call.
  - Turn body `{ "message": 1–500 chars, "state": <PreferenceState>, "previousQuestion": string | null }` → `200 { "status": "ok", "source": "nebius", "model", "turn": <TurnInput>, "acknowledgement", "question": string | null }`. `turn` has already been accepted by `applyTurn` against the sent state; the browser applies it again. A session that has used its 12 turns gets `409 TURN_LIMIT` without a model call. Budget: 700 output tokens, 12 s per attempt, 20 s overall, one retry.
  - Rank body `{ "state": <PreferenceState>, "candidates": [1–48 of { id, title, year?, genres, runtimeMinutes?, originalLanguage?, rating?, synopsis? ≤ 280 chars }] }` → `200 { "status": "ok", "source": "nebius", "model", "stateVersion", "ranking": [{ candidateId, utility }], "reasons": [≤ 3 of { candidateId, reason ≤ 160 chars }] }`. Candidates the state rules out are dropped before the model sees them; the ranking has passed `acceptFullRanking`, so it names only supplied, eligible ids. Budget: 1,200 output tokens, 15 s per attempt, 25 s overall, one retry.
  - `200 { "status": "unavailable", "code", "safeMessage" }` — the assistant could not help: `ASSISTANT_DISABLED`, `ASSISTANT_MISCONFIGURED`, `ASSISTANT_BUSY`, `ASSISTANT_TIMEOUT`, `ASSISTANT_UNUSABLE` (bad JSON or shape twice), `ASSISTANT_UNGROUNDED` (a quote not in the message, or a ranking naming an unknown or ineligible id, twice). The UI says so and falls back to the chips and the deterministic scorer.
  - `4xx { "status": "error", "code", "safeMessage", "retryable" }` — `METHOD_NOT_ALLOWED`, `CROSS_ORIGIN_BLOCKED`, `RATE_LIMITED`, `UNAUTHENTICATED`, `INVALID_REQUEST`, `TURN_LIMIT`. None carries the token, a prompt or a provider body.
- `POST /api/voice/transcribe`: Discover's voice input. Same-origin only, `POST` only, `Authorization: Bearer <Supabase access token>` verified by Supabase Auth before the recording is read, 20 requests per minute and at most 4 transcriptions in flight per instance. The body is the raw recording (`Content-Type` one of `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/wav`, parameters ignored), at most 1,000,000 bytes, refused on the declared length or while streaming. SLNG (`slng/deepgram/nova:3-en`, server allowlist, `us-east` unless `SLNG_REGION=us-west`) is called only here, only when `REVERIE_LIVE_ENABLED=true` and `SLNG_API_KEY` is set, with a 15 s timeout; a client that disconnects aborts the call. The recording is held in memory for the call and never stored or logged.
  - `200 { "status": "ok", "transcript": 1–500 chars, "audioSeconds": number | null, "model", "providerMs" }` — the final transcript only. The browser puts it in the conversation field; it becomes a turn only when the viewer sends it.
  - `200 { "status": "empty", "safeMessage" }` — no words were heard. Never a turn.
  - `200 { "status": "unavailable", "code", "safeMessage" }` — `VOICE_DISABLED`, `VOICE_MISCONFIGURED`, `VOICE_BUSY`, `VOICE_TIMEOUT`, `VOICE_FAILED` (SLNG rejected the audio, did not respond, or answered in an unexpected shape).
  - `4xx { "status": "error", "code", "safeMessage", "retryable" }` — `METHOD_NOT_ALLOWED`, `CROSS_ORIGIN_BLOCKED`, `RATE_LIMITED`, `UNAUTHENTICATED`, `UNSUPPORTED_AUDIO` (415), `RECORDING_TOO_LARGE` (413), `EMPTY_RECORDING`, `INVALID_REQUEST`.
- `WebSocket /api/voice/stream` (Node server only; not available on Vercel, where the browser uploads to `/api/voice/transcribe` instead): live partials for Discover's voice input. The upgrade is refused for a cross-origin page (403), over 20 connections a minute per client (429) or 4 open streams per instance (503). Browser → server: first `{ "type": "start", "accessToken" }` within 5 s (verified by Supabase Auth before SLNG is opened), then binary frames of 16 kHz mono 16-bit PCM (≤ 16 KB each, ≤ 22 s in total), then `{ "type": "stop" }`. Server → browser: `{ "type": "ready", "model" }`, `{ "type": "partial", "text" }` (display only), `{ "type": "final", "transcript", "timings": { firstPartialMs, stopToFinalMs, audioBytes } }` (an empty transcript means no words), or `{ "type": "error", "code", "safeMessage" }` (`VOICE_DISABLED`, `VOICE_MISCONFIGURED`, `UNAUTHENTICATED`, `INVALID_REQUEST`, `STREAM_NO_START`, `STREAM_TOO_LARGE`, `STREAM_TOO_LONG`, `STREAM_UPSTREAM`, `STREAM_NO_FINAL`), after which the socket closes. Audio is relayed as it arrives and never stored or logged.
- No HTTP room API or provider endpoint is implemented. Room membership and collaboration are Supabase RPCs, RLS-protected table access and Realtime subscriptions, described below.

### Implemented Supabase functions

| Function | Caller | Returns | Refuses |
| --- | --- | --- | --- |
| `request_jam_admission(p_invite_code, p_display_name)` | any authenticated session | `{ jamId, slug, title, memberStatus }` | no session (`28000`), name outside 1–32 characters (`22023`), unknown, revoked or expired invite (`P0002`), completed/closed jam (`22023`), previously removed caller (`42501`), more than 10 failed lookups in 10 minutes (`53400`) |
| `set_jam_member_status(p_jam_id, p_member_id, p_status)` | host only | `{ jamId, userId, displayName, role, status }` | non-host caller and the host's own row (`42501`), status other than `active`/`removed` (`22023`), unknown member (`P0002`) |
| `get_jam_invite(p_jam_id)` | host only | `{ jamId, slug, code, expiresAt, revokedAt, state }` | non-host caller (`42501`), unknown jam (`P0002`) |
| `rotate_jam_invite(p_jam_id, p_expires_in_minutes)` | host only | the new invite, same shape | non-host caller (`42501`), lifetime outside 5 minutes to 24 hours (`22023`) |
| `revoke_jam_invite(p_jam_id)` | host only | the revoked invite, same shape | non-host caller (`42501`) |
| `ensure_jam_live_session(p_jam_id, p_provider_session_id)` | active member | the jam's provider session id, storing the supplied one only if the jam has none | no session (`28000`), non-member (`42501`), a reference outside 16–512 characters (`22023`) |
| `withdraw_live_consent(p_consent_id)` | the consent's owner | `{ id, jamId, kind, assetRef, withdrawnAt }` | no session (`28000`), a consent belonging to anyone else (`42501`) |

`memberStatus` is `waiting` for an invite-only jam and `active` for a public one. A host calling it against their own jam gets their existing host membership back unchanged. Neither
function can create or promote a host. The browser has no insert, update or delete policy on
`jam_members`, so these functions are the only membership mutation path.

A repeated `request_jam_admission` from the same session is idempotent: the display name is
refreshed and the status is left alone, so a second submit never resets a pending admission
or re-admits a removed participant.

`state` is `active`, `expired` or `revoked`. A revoked or expired invite is refused with the
same `P0002` message an unknown code gets, and counts against the throttle, so a probe cannot
tell a lapsed invite from a code that never existed. The `completed`/`closed` refusal is
distinguishable on purpose; it is reachable only by a caller already holding a live invite
for that room. The throttle is keyed on `auth.uid()` and identities are anonymous, so it
bounds probing from one session rather than making enumeration impossible. `p_expires_in_minutes` is `null` for an invite that does not expire.

### Implemented table access

| Table | Select | Insert |
| --- | --- | --- |
| `jams` | host or any waiting/active member, **excluding `invite_code`, `invite_expires_at` and `invite_revoked_at`** | host only, `host_id = auth.uid()` |
| `jam_admission_attempts` | none | none (RLS on, no policies; reached only by `security definer` functions) |
| `jam_members` | own row; the host sees every row; an active member sees only the active roster | none |
| `jam_messages` | active members | active members, `author_id = auth.uid()` (defaulted, never sent by the browser) |
| `jam_proposals` | active members | active members, `status = 'queued'` |
| `jam_live_sessions` | active members | none (written only by `ensure_jam_live_session`) |
| `jam_live_consents` | active members | own row, `owner_id = auth.uid()`, active members |

No update or delete policy exists on `jam_messages` or `jam_proposals`: both are append-only
until the versioned scene contract below is implemented. `jam_live_consents` has no update or
delete policy either: a consent is granted by an insert and retired only by
`withdraw_live_consent`, and its `asset_ref` and expiry are stamped by a trigger, never by the
browser. A consent is effective only while `withdrawn_at is null and expires_at > now()`.

The three invite columns on `jams` are excluded from the column grants to `authenticated`
for both `select` and `update`. RLS answers which rows a caller may read; which columns of
a row they may read is a column privilege, so this is the only place it can be enforced. A
member therefore cannot re-share the entitlement, and a host cannot hand-write a predictable
code — both go through the host-only functions above, which run as owner.

### Implemented Realtime contracts

- Postgres Changes on `jam_messages` (INSERT), `jam_proposals` (INSERT), `jam_members`
  (all events) and `jam_live_consents` (all events), filtered by `jam_id` and delivered under
  the policies above. A withdrawal reaches the room as an update to the consent row, which is
  how another client stops using the reference.
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

| `POST /api/jams` | Register a jam and either generate its script from scratch/from a movie or import an existing script |
| `GET /api/jams/:id` | Read a generated jam snapshot |
| `GET /api/jams/:id/script.md` | Read the current revision rendered as markdown (a view; the structured script is the source of truth) |
| `PATCH /api/jams/:id/script/portions/:portionIndex` | Edit one portion's content (`action`, `dialogue`, `visualDirection`, `durationSeconds`) as a new revision; rejected with `portion_locked` at or below the lock boundary |
| `POST /api/jams/:id/script/revert` | Restore an earlier revision as a new revision (undo/redo); rejected with `portion_locked` if a played or locked portion would change |
| `GET /api/jams/:id/script/revisions` | List revision metadata (no script bodies) |
| `GET /api/jams/:id/script/revisions/:revision` | Read one full revision: structured script plus its rendered markdown |
| `GET /api/jams/:id/outline` | The current revision's beats with the strictest open stream's lock window, the pending-edit count and the current script (`docs/specs/story-outline.md`) |
| `POST /api/jams/:id/outline/edits` | Admit one outline edit (`set` or `reroll`) to the per-jam queue; idempotent on `requestId`; `202` with the edit record |
| `GET /api/jams/:id/outline/edits` | The edit ledger for a jam, newest first (at most 50) |
| `GET /api/jams/:id/outline/edits/:editId` | One edit record |
| `POST /api/jams/:id/sessions` | Attach a user session to a jam; returns the session plus a one-time owner token |
| `GET /api/jams/:id/sessions` | List a jam's sessions (public projections, never owner tokens) |
| `GET /api/sessions/:id` | Read one session |
| `PATCH /api/sessions/:id` | Owner-only (Bearer owner token) update of playback settings: `language`, `ambientation` |
| `GET /api/sessions/:id/script.md` | Read the shared script annotated with the session's playback settings |
| ~~`POST /api/jams/:id/join`~~ | Superseded: implemented as the `request_jam_admission` RPC above |
| ~~`POST /api/jams/:id/members/:memberId/admit`~~ | Superseded: implemented as the `set_jam_member_status` RPC above |
| `POST /api/jams/:id/scene/accept` | Host or configured vote rule accepts the next turn, as one serialized commit; refused with `portion_locked` if it would change a played or locked portion (`docs/specs/transactional-scene-contract.md`) |
| `POST /api/jams/:id/forks` | Create a version line rooted at a declared revision of a declared line (`docs/specs/script-forking-and-chat-editing.md`) |
| `GET /api/jams/:id/forks` | List a jam's version lines with their roots and revision counts |
| `GET /api/jams/:id/forks/:forkId/script.md` | Read a fork's latest revision as markdown |
| `PATCH /api/jams/:id/forks/:forkId/portions/:portionIndex` | Edit one portion of a fork; the playback lock boundary does not apply inside a fork |
| `POST /api/jams/:id/forks/:forkId/adopt` | Adopt a fork into the shared line; `expectedStateVersion`-guarded, all-or-nothing, refused with `portion_locked` |
| `POST /api/jams/:id/script/chat` | Turn a described change into a validated structured portion patch on a named line; the model emits a patch object, never text appended verbatim |
| `POST /api/jams/:id/references` | Request a short-lived, server-authorized upload destination for an image or clip; returns a server-issued `assetRef` (`docs/specs/multimodal-creative-turns.md`) |
| `GET /api/jams/:id/references/:assetRef` | Stream a stored reference from our own storage; never a storage or provider URL |
| `POST /api/jams/:id/close` | Close a room and release active resources |


The **shared playback clock** is a separate, room-wide position that every viewer derives from one server anchor, so two participants can compare where the room is. It is implemented as Supabase RPCs, not the Express routes above:

| RPC | Contract |
| --- | --- |
| `get_jam_playback(p_jam_id)` | Any active member or the host. Returns `{ jamId, status: "idle"｜"playing"｜"paused", elapsedMs, serverNow, stateVersion }`. |
| `start_jam_playback(p_jam_id)` | Host-only. Sets `status = "playing"` and stamps `started_at = now()`. Pressing play while already playing is a no-op and does not move the anchor. |
| `pause_jam_playback(p_jam_id)` | Host-only. Freezes `elapsedMs` and clears the anchor. |
| `reset_jam_playback(p_jam_id)` | Host-only. Returns the clock to `idle` at zero. |

The position is derived, never stored as a mutable counter: `elapsedMs = paused_elapsed_ms + (now() - started_at)` while playing, and `paused_elapsed_ms` otherwise. `serverNow` lets a browser correct for clock skew — it anchors to `elapsedMs` and advances with its own monotonic clock (`performance.now()`), so no participant's wall clock can move the room. Reads poll every 2.5s as an interim transport; the contract is Realtime events, so the poll interval is a single named constant a later slice replaces. The clock row is created by a trigger on `jams` and backfilled for existing rooms; the table has RLS enabled with no policies, so only the security-definer functions are reachable.

**One table, both representations.** `public.jam_playback` was introduced twice — once by the portion-playback work (`20260919190000`, cursor) and once by the clock work (`20260919230000`, anchor) — and `20260919225000_reconcile_jam_playback.sql` converges every database on a single table:

| Column | Meaning |
| --- | --- |
| `status` | Union vocabulary `idle｜priming｜playing｜paused｜finished`. `priming`/`finished` come from portion playback, `paused` from the clock. |
| `current_portion_index` | Portion cursor, `-1` until the first portion plays (the store maps this to in-memory `null`). |
| `started_at` | Wall-clock anchor, set exactly while `status = 'playing'`; enforced by `(status = 'playing') = (started_at is not null)`. |
| `paused_elapsed_ms` | Time accumulated before the current playing segment. |
| `state_version` | Compare-and-swap guard, shared by both. |

The reconciliation is idempotent and backfills before enforcing `NOT NULL`. It is required because `190000` sorts before `230000`: on a fresh database the cursor migration creates the table first, so the clock migration's `create table if not exists` no-ops and its `jam_playback_json` function would fail to compile against the missing `started_at` column.

`POST /api/jams` accepts an optional `format` object (`totalSeconds`, `portionMinSeconds`, `portionMaxSeconds`); omitted fields default to a 20-second script of 5-second portions. The jam stores its format and all generation and validation follow it.

The command is a discriminated union on `mode`:

- `mode: "generate"` (the default when `mode` is omitted) takes `source` as `from-scratch` or `from-movie`, calls the server-configured Nebius allowlist behind the generation concurrency gate, and stores revision 1 as the rendered markdown.
- `mode: "import"` takes `source: { kind: "imported-script", scriptTitle }` and `scriptMarkdown` (40–9000 characters). The pasted markdown is stored verbatim as revision 1, while a derived timed projection (`src/core/scriptImport.ts`) provides the portions the director uses as beats. Import makes **one** provider call — the outline fill-in that writes a beat per portion — only when a provider is configured and a generation slot is free; otherwise the jam is created with its beats missing and no call is made (RV-22). Text too short or too long for the selected format returns `invalid_script_import` (`400`, `retryable: false`).

Both modes answer `outline: { complete: boolean }` beside the jam: `false` means at least one portion has no beat, which the outline panel shows as missing rather than filling. Both modes accept an optional `jamId` — the room id created before the script — so the script and its revisions attach to the registered jam rather than a second server-minted id. Reusing an id that already has a script returns `jam_exists` (`409`). Success is `201 { jam, scriptMarkdown }`. The browser registry (`GET`-free: `src/lib/jams.ts#listJams`) reads `jams` under the existing RLS select policy, so `/jams` shows the rooms an identity hosts or has joined, newest first, hiding `completed`/`closed`.

## Outline edits

**Status: routes written on `codex/rv-22-outline-edits`, untested.** An outline edit is the one command every way of steering the story produces
(`docs/specs/story-outline.md`). `POST /api/jams/:id/outline/edits` takes
`{ requestId, intent: "set", beatIndex, summary }` or `{ requestId, intent: "reroll", beatIndex, reason? }`,
plus optional `expectedRevision` (the script revision the client read; behind → `409 stale_state_version`
with the current `revision`), `mechanism` (`direct | vote | poll | chat`, default `direct`) and
`authorId`. Admission checks, in order: the jam exists (`404 not_found`), a provider is configured
(`503 generation_disabled`), the beat exists (`400 invalid_command`), the beat is editable
(`409 portion_locked`), the revision is current, the queue has room (`409 queue_full`, at most 10 waiting).
A replayed `requestId` returns `200` with the record the first request created.

Edits are processed one at a time per jam. The cascade completion runs outside the per-jam critical
section; the commit takes it once and lands every rewritten portion as one revision, refusing
`portion_locked` if the boundary moved meanwhile and `stale_state_version` if the base revision was
replaced twice. The edit record's `status` is `queued | processing | landed | failed`, with
`baseRevision`, `revision`, a typed `error`, and `direction: { sent, refused }` for the beat sent to
open streams after the commit. Durations and structure are never rewritten.

## Beat locking and the live director

Portions are addressed by a zero-based global `portionIndex` in flattened scene order — the single address used by edits and by the director's beats (the markdown label `Portion 2.1` is a render, not the address). Structural edits (insert/delete/reorder of scenes or portions) are forbidden in v1, so indices stay stable. The structured script (scenes → portions) is the editing source of truth; markdown revisions are deterministic renders of it.

**The lock window comes from the stream.** A live director generates ahead of playback, so by the time a viewer sees beat N the provider is already committed to N+1. `src/core/directorBeats.ts` derives the window from where the stream has reached on the script clock:

- `beatIndex <= currentBeatIndex`: immutable (played or playing).
- `beatIndex == currentBeatIndex + 1`: **locked** — already with the provider.
- `beatIndex >= currentBeatIndex + 2`: freely editable.

Before the first chunk arrives, beat `0` is already locked: `configure` carried the whole script to the provider when the session opened. With no stream open, nothing is locked.

The same boundary answers both routes. `POST /api/jams/:id/director/session/:sessionId/direct` refuses a direction naming a closed beat with `beat_locked` (`retryable: false`, carries the beat window), and a script `PATCH`/`revert` at or below the boundary is refused with `portion_locked`. A jam may hold one stream per configuration, and an edit is only safe if it is ahead of all of them, so the strictest open stream sets the boundary (`DirectorStreamRegistry`). The JamStore stays persistence-only: edit and revert take `minEditablePortionIndex` and throw below it, and the router reads the guard in the same critical section as the mutation it protects, so the boundary cannot move between check and write.

**There is no per-portion generation.** Video is produced by one continuous director session, not by a queue of clips; the events `portion.locked`, `media.requested`, `media.ready` and `media.delayed` described elsewhere in this document belong to a pipeline that no longer exists.

## Planned Supabase mutation and Realtime contracts

Supabase Realtime carries authenticated room notifications over its managed WebSocket transport. Durable chat/proposals/votes use RLS-protected database writes; multi-row admission and scene transitions use constrained transactional RPCs. Broadcast cannot grant membership or accept a scene. The HTTP routes above remain design candidates, not available endpoints; admission may be implemented as an authenticated RPC instead. Each command has `schemaVersion`, `requestId`, `expectedStateVersion`, `type`, and typed payload. Events have `eventId`, `roomId`, `stateVersion`, `occurredAt`, `type`, and payload. Vercel functions handle privileged operations such as issuing Vonage session tokens and calling providers.

Commands: `chat.send`, `proposal.create`, `vote.cast`, `room.open`, `room.start`, `scene.accept`, `member.leave`, `audio.start`, and `audio.stop`.

`vote.cast` and `scene.accept` are the two commands that move the story, and they are specified in `docs/specs/transactional-scene-contract.md`: one effective vote per active member per proposal with `voter_id` pinned to `auth.uid()`; acceptance as a single atomic commit that marks the proposal `accepted`, supersedes the rest of the queue, increments a per-jam **story version** and the room's `stateVersion`, and enters `generating`. Story version and `stateVersion` are distinct — a vote moves the latter only. Both are `security definer` RPCs rather than browser table writes, because `jam_proposals` has no update policy and must not gain one. Generation runs after the commit, never inside it.

Attaching a reference to a proposal needs a carrier that does not exist: `jam_proposals.body` is text only. An attachment must be scoped by policy to a reference the author owns and whose consent is effective (`docs/specs/multimodal-creative-turns.md`).

Multimodal commands: `reference.upload.request`, `reference.upload.complete`, `reference.intent.set`, `liveMedia.join`, `liveMedia.leave`, `liveMedia.consent.set`, `broadcast.start`, `broadcast.stop`, and `archive.request`. A reference descriptor includes its owner, source type, declared purpose, lifetime, consent state, and a server-issued asset reference; it never accepts a browser-supplied provider URL.

Events: `room.snapshot`, `member.joined`, `member.waiting`, `member.admitted`, `presence.updated`, `transcript.partial`, `transcript.final`, `reference.ready`, `liveMedia.state`, `proposal.created`, `vote.updated`, `scene.processing`, `story.updated`, `artifact.updated`, `portion.locked`, `media.requested`, `media.ready`, `media.delayed`, `room.closed`, and `error`.

## Ordering and errors

State-changing commands must include the latest `expectedStateVersion`. A stale command receives a conflict error plus the current snapshot; it is never merged silently. Known `requestId` values are idempotent. The server serializes accepted scene transitions and discards late provider output after a room close or superseding scene version.

Errors expose `code`, `safeMessage`, `retryable`, and `requestId`. They never expose credentials, raw provider bodies, or internal prompts.

Catalogue responses use provider-approved identifiers and asset references. Generated Jam media always carries a separate generated-artifact identifier and must never impersonate a catalogue title.
