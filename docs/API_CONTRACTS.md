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
- **Appearing in the film** (Node server only; `docs/specs/appearing-in-the-film.md`). Every route takes `Authorization: Bearer <Supabase access token>`, resolves identity through Supabase Auth, and reads the caller's own membership and the room's consent register under the same RLS the browser is subject to. The server holds no privileged read of the register: it cannot see a consent the caller could not see themselves. Without Supabase configuration every route is `503 likeness_not_configured` — a server that cannot check consent does not act on it.
  - `PUT /api/jams/:id/likeness/:assetRef` — attaches the approved frame to the caller's own standing likeness grant. Body is the raw image (`image/jpeg` or `image/png`), at most 512 KB, square-ish, 256–1024 pixels each side. The reference was issued by the register's trigger; this route never mints one. `201 { assetRef, width, height, durable, expiresAt }`. Refusals: `frame_type_unsupported`, `frame_too_large`, `frame_unreadable`, `frame_too_small`, `frame_too_big` (400); `consent_not_found` (404); `not_yours`, `not_a_likeness_consent`, `withdrawn_or_expired` (403). "Not yours" and "not a likeness consent" carry the same sentence, so neither answer tells a prober anything about the other.
  - `GET /api/jams/:id/likeness/:assetRef` — the owner's own frame, `no-store`. It is never served to another participant, and no storage or signed URL ever reaches a browser. `404 no_frame` when a grant has no frame behind it.
  - `DELETE /api/jams/:id/likeness/:assetRef` — discards the frame behind the caller's own grant. A grant that has ended is the expected case here, not a refusal: the client calls this immediately after withdrawing.
  - `POST /api/jams/:id/beats/:index/video` — generates one beat from the portion at that flat index. **Whether anyone appears in it is not in the request body**: the server reads the register fresh at the instant of submission and `usableLikenesses` answers, so a withdrawal a second earlier is honoured without any cache to invalidate. At most three references, in the order granted, sent inline as `data:` URIs. `201 { index, model, requestId, generatedAt, elapsedMs, likeness: { standing, ownerIds }, durable, remainingBudgetUsd }`. `standing` is `none｜standing｜withdrawn_since`; `ownerIds` names owners, never references. Refusals: `frame_missing` (409) when a grant's frame never arrived — never a plain beat generated without that person; `budget_exhausted` (409); `beat_in_flight` (409); `too_many_beats` (429); `generation_disabled` (503) with no provider, never a mock; `beat_provider_unreachable`, `beat_provider_refused`, `beat_provider_unusable`, `beat_provider_timeout`, `beat_clip_too_large`, none of which carries a provider body, URL or credential.
  - `GET /api/jams/:id/beats/:index` — `{ index, model, requestId, generatedAt, elapsedMs, likeness }`. The `likeness` block is re-derived from the register on every read, so a beat made before a withdrawal reports `withdrawn_since` rather than `none`.
  - `GET /api/jams/:id/beats/:index/video` — the clip, served by this server. No provider or storage address is ever handed to a browser.
  - Server-owned model allowlist: `minimax/h3-max/text-to-video` for a plain beat, `minimax/h3-max/reference-to-video` when at least one grant stands. No request body, environment variable or provider response can widen it. Both reserve against the same `FAL_ASSET_BUDGET_USD` as the live director.
- `POST /api/discover/turn`, `POST /api/discover/rank` and `POST /api/discover/critique`: Discover's conversation. Same-origin only, `POST` only, `Authorization: Bearer <Supabase access token>` verified by Supabase Auth before any model call, per-instance rate limits of 20, 30 and 30 requests per minute, at most 6 model calls in flight per instance, body caps of 80 KB, 96 KB and 32 KB. The browser holds the preference state and sends it; the server validates it with the engine's schema and trusts nothing in it. Nebius is called only here, only when `REVERIE_LIVE_ENABLED=true` and `NEBIUS_API_KEY` is set, with the model from the server allowlist; a client that disconnects aborts the call.
  - Turn body `{ "message": 1–500 chars, "state": <PreferenceState>, "previousQuestion": string | null }` → `200 { "status": "ok", "source": "nebius", "model", "turn": <TurnInput>, "acknowledgement", "question": string | null }`. `turn` has already been accepted by `applyTurn` against the sent state; the browser applies it again. A session that has used its 12 turns gets `409 TURN_LIMIT` without a model call. Budget: 700 output tokens, 12 s per attempt, 20 s overall, one retry.
  - Rank body `{ "state": <PreferenceState>, "candidates": [1–48 of { id, title, year?, genres, runtimeMinutes?, originalLanguage?, rating?, synopsis? ≤ 280 chars }] }` → `200 { "status": "ok", "source": "nebius", "model", "stateVersion", "ranking": [{ candidateId, utility }], "reasons": [≤ 3 of { candidateId, reason ≤ 160 chars }] }`. Candidates the state rules out are dropped before the model sees them; the ranking has passed `acceptFullRanking`, so it names only supplied, eligible ids. Budget: 1,200 output tokens, 15 s per attempt, 25 s overall, one retry.
  - Critique body `{ "state": <PreferenceState>, "picks": [1–3 of the same candidate shape], "withheld": [≤ 48 titles] }` → `200 { "status": "ok", "source": "nebius", "model", "stateVersion", "critiques": [≤ 3 of { candidateId, why, watching, reservation }, each part ≤ 320 chars] }`. The picks are the only films the critic may write about, and a pick the state rules out is dropped before the model sees it, exactly as a candidate is on the ranking call; a request whose picks are all ruled out is `400 INVALID_REQUEST` with no model call. `withheld` is the rest of the row, which the critic is never shown and may not name. Unlike the ranking call, it is told to use what it knows about these films beyond the row — that knowledge is the point — and is fenced by what can be checked instead: a critique that names a withheld title, claims a running time or release year the row contradicts, invents a score, borrows a verdict from critics or audiences, or turns to face the viewer is refused whole, once with the reason and then for good. A part that runs long is cut back to its whole sentences rather than refused. A pick whose reservation is missing or hollow loses its critique; a recommendation with nothing against it is not published. Budget: 1,100 output tokens, 24 s per attempt, 36 s overall, one retry, temperature 0.6. Nothing it returns reaches the preference engine: a critique proposes no turn and carries no quote.
  - `200 { "status": "unavailable", "code", "safeMessage" }` — the assistant could not help: `ASSISTANT_DISABLED`, `ASSISTANT_MISCONFIGURED`, `ASSISTANT_BUSY`, `ASSISTANT_TIMEOUT`, `ASSISTANT_UNUSABLE` (bad JSON or shape twice), `ASSISTANT_UNGROUNDED` (a quote not in the message, or a ranking naming an unknown or ineligible id, twice). A critique that cannot be written answers the same way and costs the row nothing: it keeps the reasons the ranking produced and says nothing about the critic. The UI says so and falls back to the chips and the deterministic scorer.
  - `4xx { "status": "error", "code", "safeMessage", "retryable" }` — `METHOD_NOT_ALLOWED`, `CROSS_ORIGIN_BLOCKED`, `RATE_LIMITED`, `UNAUTHENTICATED`, `INVALID_REQUEST`, `TURN_LIMIT`. None carries the token, a prompt or a provider body.
- `POST /api/evaluate`: Discover's whole funnel behind one call, for an external evaluation harness (Galtea). `POST` only, same-origin rule as the other endpoints (a missing `Origin`, as a server-to-server call has, is allowed), per-instance rate limit of 30 requests per minute, 16 KB body cap. Authentication is a single static token: `Authorization: Bearer <GALTEA_EVAL_TOKEN>`, compared against the environment over SHA-256 digests so neither the value nor its length leaks through timing. A viewer's Supabase session is never accepted here, and the token is never logged, echoed or included in any response. It exists because Galtea calls one deployed endpoint and cannot hold an anonymous Supabase session, which expires inside an hour.
  - Body `{ "input": 1–500 chars, "history"?: [≤ 11 of 1–500 chars] }` and nothing else. `history` is earlier viewer messages, replayed through the same engine in order so a multi-turn case builds a real preference state; `input` is the message being evaluated. Each run uses a fresh throwaway session, so nothing carries between requests.
  - Internally it is not a second funnel. Interpret, rank and critique are `api/_lib/discover-funnel.ts`, the same three steps `/api/discover/turn`, `/api/discover/rank` and `/api/discover/critique` call, under the same concurrency cap; the shortlist is read with `toShortlistRead` and the same `fetchCatalogue` adapter `/api/catalogue` uses; the order is `orderByAssistant`, the browser's. The browser's fallbacks hold too: a ranking that does not arrive leaves the deterministic scorer's order, and a critique that does not arrive leaves the ranking's reasons, because that is what the viewer would have seen.
  - The catalogue is read as the server, never as the caller: `SUPABASE_SERVICE_ROLE_KEY` when it is set, otherwise a Supabase session the function signs itself into anonymously with `SUPABASE_ANON_KEY` and caches per process. The RPC is granted to `authenticated` and revoked from `anon`, so the anon key alone cannot read it.
  - `200 { "status": "ok", "output", "acknowledgement", "question": string | null, "subject": string | null, "filters": <CatalogueFilters>, "titles": [≤ 3 of { id, title, year: number | null, genres }], "critiques": { "<catalogue id>": { candidateId, why, watching, reservation } }, "total" }`. `output` is the text an evaluator grades: the acknowledgement, the question if there was one, then each pick with the critic's note on it — or, where the critic wrote nothing, the reason the ranking gave. `titles` are the picks in the order shown, `total` is how many catalogue titles match the state, and `critiques` is keyed by catalogue id and may be missing a pick or empty. `status` is the repository's usual discriminator; everything else is the field named.
  - `4xx/5xx { "status": "error", "code", "safeMessage", "retryable" }` — `METHOD_NOT_ALLOWED` (405), `CROSS_ORIGIN_BLOCKED` (403), `RATE_LIMITED` (429), `UNAUTHENTICATED` (401, with `WWW-Authenticate: Bearer`), `INVALID_REQUEST` (400), `EVAL_NOT_CONFIGURED` (503, no `GALTEA_EVAL_TOKEN` on this deployment), `TURN_REFUSED` (422, a replayed history the engine would not accept), the assistant's own `ASSISTANT_*` codes (503) when it could not interpret at all, and the catalogue's `CATALOGUE_*` codes when the shortlist could not be read. None carries the token, a prompt or a provider body.
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
| `jam_live_consents` | active members | own row, `owner_id = auth.uid()`, active members; one standing `likeness` row per participant per jam |

No update or delete policy exists on `jam_messages` or `jam_proposals`: both are append-only
until the versioned scene contract below is implemented. `jam_live_consents` has no update or
delete policy either: a consent is granted by an insert and retired only by
`withdraw_live_consent`, and its `asset_ref` and expiry are stamped by a trigger, never by the
browser. A consent is effective only while `withdrawn_at is null and expires_at > now()`.

`kind` is `camera`, `microphone`, `screen` or `likeness`. The first three permit publishing a
track to the live stage; `likeness` permits a participant's own approved frame to seed a
generated beat and permits no publishing at all, which `permittedKinds` enforces by filtering to
track kinds rather than by omission. The trigger issues a `likeness:` reference for a likeness
grant and a `live:` reference otherwise, and a partial unique index
(`jam_live_consents_one_standing_likeness`) allows one standing likeness grant per participant
per jam, so a withdrawal always withdraws the whole of what was agreed. See
`docs/specs/appearing-in-the-film.md`.

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

An outline edit is the one command every way of steering the story produces
(`docs/specs/story-outline.md`). `POST /api/jams/:id/outline/edits` takes
`{ requestId, intent: "set", beatIndex, summary }` or `{ requestId, intent: "reroll", beatIndex, reason? }`,
plus optional `expectedRevision` (the script revision the client read; behind → `409 stale_state_version`
with the current `revision`), `mechanism` (`direct | vote | poll | chat`, default `direct`) and
`authorId`. Admission checks, in order: the jam exists (`404 not_found`), a provider is configured
(`503 generation_disabled`), the beat exists (`400 invalid_command`), the beat is editable
(`409 portion_locked`), the revision is current, the queue has room (`409 queue_full`, at most 10 waiting).
A stopped room is **not** refused: stopping the stream ends the take, not the room, and the story a
room between takes is holding is the one the next take will shoot. A replayed `requestId` returns
`200` with the record the first request created, and is answered before every refusal above,
because a replay performs nothing and a reconnect must still learn what its edit did rather than
be handed a second copy of it.

Edits are processed one at a time per jam. The cascade completion runs outside the per-jam critical
section; the commit takes it once and lands every rewritten portion as one revision, refusing
`portion_locked` if the boundary moved meanwhile and `stale_state_version` if the base revision was
replaced twice. The edit record's `status` is `queued | processing | landed | failed`, with
`baseRevision`, `revision`, a typed `error`, and `direction: { sent, refused, skipped }` for the beat sent
after the commit to the open streams whose next beat it is — a direction steers what the provider
generates next, so a beat further ahead is committed without being sent. Durations and structure are never rewritten.

## The escape room

An escape room is a Movie Jam with a fixed world and a goal (`docs/specs/escape-room-scenario.md`).
It adds no room concept: the invite code, the QR, the lobby, admission, the roster and the chat
are the jam's. What it adds is the scenario's state, the turn the room is on, and the segments
generated from them. These routes run on the local Node server only, like the script, session and
director routes, and their state is in that process's memory.

**These are the only routes on this Express host that check who is asking.** They move a world a
whole room can see and they spend from a budget, so identity is Supabase Auth's answer to the
presented access token and the role is the caller's own `jam_members` row read under RLS with that
same token — this server holds no service-role key for it and can see no more than the participant
it is acting for. The answer is cached for 20 seconds on a SHA-256 digest of the token (never the
token), so a room polled by six people does not make twelve Supabase calls a second; the cost is
that an admission or a removal takes up to 20 seconds to be felt. Every command body is strict: an
unknown field is rejected rather than dropped.

| Route | Who | Contract |
| --- | --- | --- |
| `GET /api/escape-room/scenarios` | anyone | `200 { scenarios: [{ id, title, logline, characterName, goal, locationCount }] }` — this repository's own scenario files. Unauthenticated: the create screen offers them before anybody is a member of anything. |
| `POST /api/jams/:id/escape-room` | host | Body `{ scenarioId }`. `201 <snapshot>`. Refusals: `unknown_scenario` (400), `already_open` (409), `too_many_rooms` (409). |
| `GET /api/jams/:id/escape-room` | active member | `200 <snapshot>`, or `404 not_open` — which is the answer "this jam is not an escape room", not a failure. |
| `POST /api/jams/:id/escape-room/proposals` | active member | Body `{ body ≤ 280 chars, authorName? ≤ 32 }`. `201 { proposalId, snapshot }`. The author is the caller's own user id; an `authorId` in the body is rejected, never honoured. Refusals: `session_over`, `too_many_proposals` (24 a turn). |
| `POST /api/jams/:id/escape-room/votes` | active member | Body `{ proposalId }`. `200 <snapshot>`. One effective vote per participant; a second replaces the first. A proposal not on this turn's table is `404 not_found`. |
| `POST /api/jams/:id/escape-room/settle` | host | Closes the vote. Most votes wins; a tie, including a turn nobody voted on, goes to whichever was proposed first. The winner is resolved and filmed, the rest are discarded, and the next turn opens. `200 { beatId, snapshot }`. Refusals: `no_proposals` (409), `session_over` (409). |
| `GET /api/jams/:id/escape-room/segments/:mediaId` | active member | The clip's own bytes, from this server's storage. Never a provider or storage URL. `404 not_found`, or `503 media_unavailable`. |

Authorization failures are `escape_unauthenticated` (401), `escape_forbidden` (403) and
`escape_unavailable` (503), in the same `{ error: { code, safeMessage, retryable } }` shape as the
rest of this server. None carries a token, an upstream URL or an upstream body.

A `<video src>` sends no `Authorization` header, so the browser fetches a segment with the
viewer's own token and plays it as an object URL. The alternative was a credential in a URL or a
route that trusted an unguessable id.

### The snapshot

`EscapeSnapshot` (`src/core/escape/session.ts`) is the only thing the screen draws, and every
field is scenario state, the room's own vote, or the status of a generation this server actually
started:

- `location` — where the character is, with the author's description.
- `loop` and each beat's `media` — a `SegmentView`: `status` is `absent`, `generating`, `ready`,
  `failed`, `forgotten` (it was generated and this server no longer holds it — a server with no
  object storage keeps only its most recent segments), `not_configured` (no fal key or the live
  flag is off) or `ceiling_reached` (the spend ceiling refused it, or the session ended before it
  ran; nothing was sent to the provider). `seconds` is the clip's **measured**
  length, read from the file, not the length that was asked for.
- `progress` — what has been found, what is still shut, what is carried, how many things have
  happened, and whether the goal is reached. Counted from scenario state.
- `turn` — the proposals on the table with their real vote counts, this viewer's vote, and how
  many people have voted.
- `beats` — what the room has done, each with its narration and whether the model or the
  scenario's author wrote it.
- `ended` — `{ reason: "goal" | "spend_ceiling", tell }`, or null.
- `spend` — real money committed against `FAL_ASSET_BUDGET_USD`.
- `mediaDurable` — false when this server has no object storage, so segments die with it.

### Video

Segments are generated through the fal adapter's queue half
(`apps/server/providers/falSegments.ts`) with `minimax/h3-max/text-to-video`, entry `[0]` of a
server-owned allowlist that `FAL_MODEL` may select from and nothing else. Only an outcome that
advanced the world is filmed: a refusal already carries the sentence its author wrote. A beat's
duration comes from the scenario's action, clamped to the model's published `[5, 15]` band; a
location's loop is 5 seconds. What the model returns is measured
(`src/core/mediaDuration.ts`) rather than assumed — see `docs/DECISIONS.md` for the numbers.

Money is committed before the provider is called and settled after. A submit fal never accepted is
refunded; anything that failed after fal accepted the request is not, because fal may well have
run it. The director and the escape room debit **one** `SpendAccount`, so
`FAL_ASSET_BUDGET_USD` stays a ceiling on the process rather than one each feature gets a copy of.

## Beat locking and the live director

Portions are addressed by a zero-based global `portionIndex` in flattened scene order — the single address used by edits and by the director's beats (the markdown label `Portion 2.1` is a render, not the address). Structural edits (insert/delete/reorder of scenes or portions) are forbidden in v1, so indices stay stable. The structured script (scenes → portions) is the editing source of truth; markdown revisions are deterministic renders of it.

**The lock window comes from the stream.** A live director generates ahead of playback, so by the time a viewer sees beat N the provider is already committed to N+1. `src/core/directorBeats.ts` derives the window from where the stream has reached on the script clock:

- `beatIndex <= currentBeatIndex`: immutable (played or playing).
- `beatIndex == currentBeatIndex + 1`: **locked** — already with the provider.
- `beatIndex >= currentBeatIndex + 2`: freely editable.

Before the first chunk arrives, beat `0` is already locked: `configure` carried the whole script to the provider when the session opened. With no stream open, nothing is locked.

The same boundary answers both routes. `POST /api/jams/:id/director/session/:sessionId/direct` refuses a direction naming a closed beat with `beat_locked` (`retryable: false`, carries the beat window), and a script `PATCH`/`revert` at or below the boundary is refused with `portion_locked`. A jam may hold one stream per configuration, and an edit is only safe if it is ahead of all of them, so the strictest open stream sets the boundary (`DirectorStreamRegistry`). The JamStore stays persistence-only: edit and revert take `minEditablePortionIndex` and throw below it, and the router reads the guard in the same critical section as the mutation it protects, so the boundary cannot move between check and write.

**The script reaches the provider once, and a later rewrite does not follow it.** `configure`
carries the whole script when the control channel opens (`sendConfigure` in
`apps/server/directorStream.ts`, which has exactly one caller, on channel open), and nothing
re-sends it as the stream advances. A direction is the only other way text reaches the model, and
it carries `replan`: it steers what is generated **next** rather than naming a position, so a beat
far ahead cannot be delivered early without the stream rendering it immediately, out of order.

Together those leave a gap that belongs to this contract rather than to any one feature. An edit
committed to a beat beyond the imminent one is durable and correct in the script and the outline,
and an open stream will never show it. Outline delivery therefore addresses a stream only when the
edited beat is that stream's `minEditableBeatIndex` (`docs/specs/story-outline.md`). Closing the
gap means re-sending a beat as it *becomes* imminent, which needs something watching each stream's
position and pushing at the boundary; no delivery design in this repository does that today.

**Two ways of producing video, and they are not the same thing.** The live director is one continuous session billed by the second: it holds a peer connection and is directed as it runs. Beat generation (`POST /api/jams/:id/beats/:index/video`, above) is submit-and-wait: one finished clip per portion, which is the only path that can carry a participant's likeness, because a reference image is an input to a queued generation and not something that can be handed to an open stream. A jam may use either. The events `portion.locked`, `media.requested`, `media.ready` and `media.delayed` described elsewhere in this document still belong to a pipeline that does not exist; beat generation is a synchronous route, not an event stream, and the director's beat lock window does not apply to it.

### Director spend

Every director session response (`POST .../director/session`, `GET .../director/session/:sessionId`) carries `spend`:

| Field | Meaning |
| --- | --- |
| `budgetUsd` | The ceiling, from `FAL_ASSET_BUDGET_USD`. `0` when it is not set, which means nothing can be generated. |
| `usdPerSecond` | fal's price per generated second, from `REVERIE_DIRECTOR_USD_PER_SECOND`. |
| `minBilledSeconds` | The provider's per-session minimum (60), billed whether or not it is used. |
| `sessionUsd` | What this session has cost, from the seconds it has generated, capped at its reservation. |
| `remainingUsd` | The ceiling less everything committed, including this session. |

`GET /api/jams/:id/director/budget` answers the same `spend` with `sessionUsd: 0`, plus `configured` — whether a director is configured on this server at all, which is a different fact from having money left. It does not look the jam up: the budget belongs to the process, not to a room.

The figure is derived from generated seconds, never from the reservation. The reservation is the worst case the ledger commits up front so a dead browser tab cannot leak budget (`apps/server/directorSessions.ts`); quoting it back as spend would overstate every session that ran short. Currency is USD because fal prices in USD; it is never converted or re-labelled.

**Director session routes (container/Express host).** All under `/api/jams/:id/director`. The server is the WebRTC peer; a browser never talks to fal. Nothing on the provider path is probed on the delivery routes — a valid-key session has been opened for the handshake and the relay only.

- `POST /session` — body `{ configuration?, attachOnly? }`. Opens the stream for a configuration or joins the one already running for it: one paid stream per configuration, keyed `<jamId>:<configurationKey>`. `201` when opened, `200 { attached: true }` when joined; both carry `sessionId`, a **server-issued** `viewerId`, `liveDelivery`, `maxSessionSeconds`, `recordingDurable`, `state`, `beats`. `attachOnly: true` never opens a stream — it is what a screen sends on arriving in a room, so that walking in cannot start a paid session — and answers `404 no_stream` (`retryable: true`) when nothing is running. A stopped room may be played again: opening a session on it starts a new take with its own archive entry, and nothing here asks who is playing it. Refusals: `409 budget_exhausted | too_many_sessions | already_open`; `502 director_unavailable` when fal refuses the handshake (the reservation is released, nothing is billed); `503 director_disabled`.
- `GET /session/:sessionId` — `{ state, beats, audit, droppedAuditEntries }`. Any attached viewer may poll it.
- `POST /session/:sessionId/direct` — `{ body, authorId?, proposalId?, beatIndex? }` → `202 { promptVersion, state, beats }`; `409 beat_locked` (see above) or `409 stream_not_ready`.
- `POST /session/:sessionId/renew` — `{ viewerId? }` → `204`. A viewer id renews that viewer; without one only the session's own clock is refreshed. A viewer that was already dropped is not readmitted (`404`): attaching is what admits a viewer.
- `POST /session/:sessionId/end` — `{ viewerId? }` → `200 { lifecycle }`. With a viewer id, that viewer leaves and the session ends only when nobody is left watching **by any route**; without one the session ends outright, which is the Stop signal — anybody in the room may send it, and it stops the take rather than retiring the room. Invalid viewer data is refused rather than treated as an omitted id. Two viewer notions coexist — relay peers and counted viewer ids — and a session survives while either has an audience.
- `POST /session/:sessionId/watch` — `{ sdp }` (a browser offer) → `201 { answer: { type: "answer", sdp }, viewers }`. RTP relay: the browser peers with this server, which forwards a copy of the inbound track. Nothing is muxed.
- `GET /session/:sessionId/playlist.m3u8`, `GET …/init.mp4`, `GET …/segment/:n.m4s` — HLS delivery of the same stream as fMP4 segments, muxed in a worker thread. Off unless `REVERIE_DIRECTOR_HLS=true` (`503 live_delivery_disabled`); `503 unsupported_codec` when the negotiated codec cannot be carried by fMP4; `503 live_delivery_failed` when the muxer thread died (the session, its recording and `/end` are unaffected). The playlist is `no-store`; the init segment and media segments are immutable and cacheable. A segment that has left the live window answers `404` and is never substituted with another.
- `GET /recordings/:sessionId` — the stored WebM recording, served by this server only, when `REVERIE_DIRECTOR_RECORD=true` captured one.

### Reading a finished session — `/api/jams/:id/director/archive`

Served by **both** hosts, and the only director routes that are Vercel functions
(`api/jams/[id]/director/archive/[[...path]].ts`): they are plain reads of Supabase and
Storage, so reproducing a session needs no live process. The deployed function authenticates
the caller — Supabase Auth for identity, the caller's own `jam_members` row for membership,
`401 unauthenticated` / `403 forbidden` otherwise — and reads the index and the bucket with
that same token under the policies in `20260920110000_director_archive_reads.sql`. It holds
no service-role key. The Express copy on the container does **not** authenticate; it is local
tooling. A session belonging to another jam answers `404 not_found`, never `403`, so the
refusal cannot confirm that it exists.

- `GET /archive` — `{ durable, sessions }`, newest first. Each session carries `id`,
  `startedAt`, `complete`, `container`.
- `GET /archive/:sessionId` — `{ durable, session, segments, durationSeconds }`.
  `complete: false` is a session whose process died mid-stream; the segments listed are the
  ones that survived, and `durationSeconds` is summed from those rather than from what the
  session was expected to produce.
- `GET /archive/:sessionId/audit` — `{ durable, audit }`. Alongside the direction trail it
  carries `archive_opened` (the initial header is durable, `detail` is `<codec>/<container>`)
  and `archive_failed` (`detail` is the reason). Their absence means the sink was never
  called at all — no media track, or recording switched off.
- `GET /archive/:sessionId/playlist.m3u8` — the HLS **VOD** playlist, built from
  `jam_director_segments` at read time and carrying `EXT-X-ENDLIST`. This is the seekable
  form: every piece and its duration are listed, so reaching a minute fetches the piece
  holding it. `404` when the session stored nothing.
- `GET /archive/:sessionId/media/:name` — one stored object. The caller's `Range` is
  forwarded to Storage and its answer passed back, so `206` with `Content-Range` is normal.
- `GET /archive/:sessionId/pieces/:index` — initial header plus that piece, playable alone,
  with `X-Piece-Start-Seconds` and `X-Piece-Duration-Seconds`.
- `GET /archive/:sessionId/video` — the whole session as one file (header then pieces, which
  both containers concatenate). Plays in a bare `<video>`; deliberately `Accept-Ranges: none`,
  because a byte offset into a concatenation of separate objects is not an offset into
  anything that exists. Seeking belongs to the playlist.

A **session id is not a UUID** — the ledger mints `<base36 time>-<base36 count>` — so it is
validated by charset, not shape.

One media pipeline is selected per session. With HLS delivery on, the fMP4 segmenter feeds the live window and any MP4 archive sink registered through `createSegmentSinks`, under one numbering. With HLS off, the WebM piece recorder feeds the archive sinks instead. The session ledger is swept by the server every thirty seconds: a session with no current viewer is reclaimed after the idle window, and every session stops at `maxSessionSeconds` even if a viewer continues renewing.

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
