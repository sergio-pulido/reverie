# Project state

## 2026-09-19 — Public repository initialized

- The public HackBarna 2026 Movie Jam vision is documented in the root README.
- The target stack, provider boundaries, application contracts and state machines are defined as implementation guides.
- No application code, provider connection, model access, generated media, or live multi-user capability has been claimed or implemented in this repository yet.

## 2026-09-19 — Executable foundation and first screen

- The repository now has a React/Vite client and a same-origin TypeScript Node/Express server.
- `pnpm dev` starts the local experience at `http://127.0.0.1:4317`; `GET /api/health` confirms the server is running.
- The initial Movie Jam landing screen presents the host and invite entry points. Those controls intentionally communicate their next implementation step; no room, provider, or live collaboration behavior exists yet.
- Package installation, type checking, production build, and local health route have been verified.

## 2026-09-19 — Multimodal direction specified

- The public product now specifies text, voice, image, video clip, and opt-in live camera contributions as first-class creative turns.
- Vonage Video API is selected as the intended live-media integration for WebRTC rooms, broadcast/watch, archive, captions, and signaling; fal.ai remains the intended visual transformation layer.
- This is documentation only. No Vonage credentials, package, provider probe, upload pipeline, or live camera behavior has been added yet.

## 2026-09-19 — Titan real-catalogue direction specified

- Titan's supplied movie catalogue is the source for the TV-first Discover experience and real-title recommendations.
- Movie Jam generated work remains separate from catalogue records and must be explicitly labelled as generated.
- No Titan catalogue credentials, API contract, or real catalogue data has been added yet.

## 2026-09-19 — Galtea evaluation specification added

- `docs/GALTEA_AGENT_SPEC.md` defines the Discover Agent and Movie Jam Story Director behaviour, refusal boundaries, grounding rules, and adversarial evaluation scenarios.
- It is ready to upload as a product specification during Galtea onboarding; no Galtea account, SDK, or evaluation run has been added yet.

## 2026-09-19 — Persistent-room foundation selected

- Vercel is the deployment target for the Vite frontend and privileged provider functions.
- Supabase is selected for Postgres, anonymous participant identity, RLS, persistent Jam URLs, and Realtime collaboration.
- The initial migration and setup guide are committed, but no Supabase project credentials or live database migration have been applied yet.

## 2026-09-19 — Persistent Jam URL client foundation added

- The frontend now uses `/jams/new`, `/jams/<slug>`, and `/join` routes, with a Vercel SPA rewrite for direct navigation.
- When `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are configured and the initial migration has been applied, room creation performs anonymous sign-in and persists a host-owned Jam record in Supabase.
- Without that configuration, the UI explicitly creates a local preview URL and labels it as non-shareable; it does not present local state as a persistent room.
- Room membership, invite lookup, proposal persistence, Realtime subscriptions, voting, and host admission remain the next milestones.

## 2026-09-19 — Jam creation writes a real 4-minute script

- `POST /api/jams` creates a jam from scratch (small prompt) or from an existing movie (inspiration only) and generates a full script through the Nebius adapter: ~240 seconds across scenes split into 10–20 second scene portions, validated with Zod and deterministically settled onto the 4-minute target.
- `GET /api/jams/:id` returns the jam; `GET /api/jams/:id/script.md` renders the script as a labelled generated-work markdown document.
- The create screen offers both sources, shows typed safe errors, and renders the generated script with per-portion time ranges before opening the studio preview. Verified live on 2026-09-19: both source kinds returned 201 with 240-second scripts (8.5s and 30.4s latency); dated Nebius probe receipts are in `docs/DECISIONS.md`.
- Generated scripts are in-memory behind a `JamStore` interface (bounded, restart clears them); rate limits, payload caps, and a concurrency gate guard the paid provider call. Supabase persistence of scripts is a follow-up branch.

## 2026-09-19 — Script format parameters and per-user jam sessions

- The script format is now a per-jam parameter: `POST /api/jams` accepts `format` (`totalSeconds` 10–900, `portionMinSeconds`/`portionMaxSeconds` 4–60, at most 48 portions), defaulting to the previous 4-minute, 10–20 second behaviour. The 10-second floor keeps tiny test jams (e.g. 20 seconds of 5-second portions) possible, and the completion token budget scales with the expected portion count. The scriptwriter prompt, draft rescaling, and strict validation all follow the jam's stored format.
- A jam session attaches one user to a jam: it holds a display name plus playback settings (`language` as a BCP-47-style tag, free-text `ambientation`) that skin the shared script per owner. Creating a session returns a one-time owner token; only its bearer can PATCH the settings. `GET /api/sessions/:id/script.md` renders the shared script annotated with that session's playback settings.
- Sessions live in-memory behind a `SessionStore` interface beside `JamStore`; the Supabase migration `20260919170000_script_format_and_sessions.sql` mirrors the format columns and an owner-scoped `jam_sessions` table (RLS, one session per user per jam) for the persistent path.
- Actual translated/re-ambiented playback generation (provider calls per session) is intentionally not implemented yet; sessions currently record and expose the parameters that will drive it.

## 2026-09-19 — Script markdown gains persistent revision history

- The `JamStore` boundary now versions the script markdown: creating a jam records revision 1 (the rendered script), `PUT /api/jams/:id/script` appends live edits, and `POST /api/jams/:id/script/revert` restores an earlier revision as a new one (undo/redo without rewriting history). Revision metadata and full snapshots are served by the new revision routes, and `script.md` serves the latest revision rather than a re-render.
- `POST /api/jams` accepts an optional `jamId` so a script can be created under the client-created Supabase room row instead of a second server-minted id.
- `supabase/migrations/20260919180000_jam_scripts.sql` adds `jam_scripts` and `jam_script_revisions` under host-scoped RLS; it has not been applied to a live Supabase project yet, and the working store remains the in-memory implementation. A Supabase-backed `JamStore` is the next storage milestone.

## 2026-09-19 — Script editing becomes portion-scoped over structured revisions

- Revisions now snapshot the structured script; markdown is rendered per revision on demand. `PUT /api/jams/:id/script` (whole-markdown, never consumed by any client) is replaced by `PATCH /api/jams/:id/script/portions/:portionIndex`, which edits one portion's content fields and validates duration against the jam format's hard bounds. Structural edits are forbidden in v1, keeping flat portion indices stable.
- Lock enforcement per the RV-06 contract: edit and revert operations take `minEditablePortionIndex`, wired by the router from a playback guard inside the same per-jam critical section; below-boundary edits and reverts that would change locked portions return `portion_locked` with the locked index and playback `stateVersion`. The guard defaults to fully open until the playback module lands.
- `JamStore` also persists playback state (`getPlayback`/`updatePlayback` compare-and-swap on `stateVersion`, `stale_state_version` on mismatch) and exposes `getScriptAtRevision` for pinned portion reads. Migration `20260919190000_structured_script_revisions.sql` swaps the revisions markdown column for `script jsonb` and adds host-readable, server-written `jam_playback`; still not applied to a live project, and the in-memory store remains the working implementation.

## 2026-09-19 — Deployment and documentation aligned

- Vercel config defines the Vite build/output and SPA routing that excludes API paths; `/api/health` has a Node handler shared with local Express.
- Local production preview supports deep links and returns JSON 404s for unknown API routes.
- README, architecture, stack, contracts, contributor guidance and setup guides now consistently use Supabase as room authority and Realtime transport.
- Hosted Vercel deployment, Supabase project configuration/migration execution and live provider probes remain unverified. Existing join UI and Studio contributions are still placeholders/local state.

## 2026-09-19 — Invite entitlement, lobby and host admission added

- Every jam carries a server-generated 8-character `invite_code`. The invite, not the room
  URL, is the entitlement; knowing a slug grants nothing.
- `request_jam_admission` and `set_jam_member_status` are constrained `security definer`
  functions. The browser has no insert, update or delete policy on `jam_members`, so a
  participant cannot admit themselves, promote themselves to host or re-enter after removal.
- An invite-only jam places a guest in `waiting`; a public jam admits on arrival. The host
  admits and removes from a lobby panel.
- A waiting participant reads only their own membership row, an active member reads only the
  active roster, and only the host can see who is queued for admission. That is a policy on
  `jam_members`, not a choice about which panel the client renders.
- Every message these functions raise is marked, and the client shows only marked messages.
  A native Postgres error naming a table or constraint is replaced by fixed safe text.

## 2026-09-19 — Studio connected to Supabase Realtime

- `jam_messages` and `jam_proposals` are append-only tables readable and writable only by an
  active member. `author_id` defaults to `auth.uid()` and the insert policy pins it there, so
  author identity always comes from Auth.
- Durable updates arrive through Postgres Changes, filtered by the RLS policies on their
  source tables. Presence and Broadcast are not enabled on the hosted Supabase transport.
- Every successful subscribe reloads the authorized snapshot, so a reconnect closes its gap
  with durable state instead of replaying events. Rows are deduplicated by id and ordered by
  `(created_at, id)` so two clients converge.
- Connection state (`connecting · live · reconnecting · offline · denied`), subscription
  cleanup and visible typed errors are implemented. A configured Supabase project that fails
  reports the failure; it never degrades into local state.
- Scene acceptance and generation are deliberately absent: changing a proposal status needs
  the versioned transactional contract, and no update policy exists for one.

## 2026-09-19 — TV-first Discover shipped with an unconfigured catalogue

- `/discover` is a separate TV-first route from Movie Jam: couch-distance type, a high-contrast focus ring, roving arrow-key traversal, `Enter`/`Space` to open a title, `Escape` to close and restore focus, and `Tab` trapped inside the detail dialog. Search is debounced; loading, empty, error and catalogue-not-configured states are distinct.
- `GET /api/catalogue` is implemented as a Vercel Node function shared with the local Express host. It validates the query with Zod, bounds page size and query length, rate limits per instance, refuses cross-origin browser calls, times out the upstream call, caps the upstream body, validates every upstream record individually, and maps failures to typed safe errors that never carry the credential, the upstream URL or the upstream body.
- Catalogue identifiers are namespaced `cat:` so a catalogue record can never be confused with a generated Jam artifact.
- **The catalogue is not configured and shows no titles.** `TITAN_API_KEY` exists locally, but no Titan catalogue contract accompanies it. The published Titan developer surface, `https://docs.titanos.tv/titan-sdk`, was fetched on 2026-09-19: the Titan SDK exposes device info, accessibility, app launch and remote-control key mapping, and publishes no catalogue, content, title-metadata or search API. The preparation material records Titan as product context with "no Titan API assumed". No base URL was guessed and no film was invented; `/api/catalogue` reports `catalogue_not_configured` and the UI states it.
- The adapter's real network path was exercised end to end: a live outbound HTTPS request through `fetchCatalogue` to a real host returned non-contract content and was rejected as `CATALOGUE_INVALID_RESPONSE`, and the same failure was observed rendering in `/discover`.
- Verified locally: `pnpm typecheck`, `pnpm test` (9 adapter and validation tests), `pnpm build`, and `scripts/smoke.mjs` against a local production preview covering `/discover`, `/api/catalogue`, the query limits and the same-origin guard. Browser checks covered all four Discover states, arrow/Enter/Escape traversal, focus restore, and a 375px layout with no horizontal overflow. These are local checks, not a hosted deployment.

## 2026-09-19 — Room and script streams reconciled

- Two parallel streams landed on the same files. `src/core/jam.ts` stays the generated-script
  domain; the room/membership domain moved to `src/core/room.ts` with its type renamed
  `JamRoom`, so the two `Jam` meanings no longer collide.
- `LiveScene` and `Notice` moved into `src/chrome.tsx` alongside `Header`/`Footer` instead of
  being duplicated per screen.
- Room tests moved to `tests/` to match the existing suite; `pnpm test` runs one glob.
- The collaboration migration was renumbered to `20260919190000` to clear the
  `20260919170000` version collision with the script-format migration.
- Create still generates a script and then persists the room; a room that fails to persist
  now says so instead of letting the script screen imply a shareable room exists.

## 2026-09-19 — Opt-in live media on the Vonage Video API

- Camera, microphone and screen are implemented as opt-in live contributions. `POST
  /api/live/token` validates the caller's Supabase session, reads that caller's own
  `jam_members` row under RLS, refuses anyone who is not `active` or whose jam is
  `completed`/`closed`, derives the Vonage role from the membership (`host → moderator`,
  member → `publisher`), and returns a 10-minute token. A `role` in the request body is
  rejected, not ignored; the function holds no service-role key and the browser never sees a
  Vonage secret.
- `supabase/migrations/20260919210000_jam_live_media.sql` adds `jam_live_sessions` (one
  provider session per jam) and
  `jam_live_consents`, the register recording owner, track kind, declared purpose, a
  server-issued `live:<uuid>` asset reference, and an expiry. A trigger issues the reference
  and clamps the lifetime, so neither is the browser's to choose. There is no update or
  delete policy: `withdraw_live_consent` is the only retirement path and can stamp only the
  caller's own row.
- `supabase/migrations/20260919211000_live_session_reservation.sql` reserves live-session
  creation in Postgres before the server contacts Vonage. A concurrent opener receives a
  short retryable pending state, so only the reservation owner can create and finalise the
  provider room.
- Withdrawal stops use, not just the record. The owner's client unpublishes and calls
  `stop()` on the underlying tracks at once, and the row change reaches the room through
  Postgres Changes. Expiry behaves identically with no call at all, re-evaluated on a timer.
- Joining the stage publishes nothing. A track starts only while its own consent is
  effective, a refused browser permission is a stated outcome rather than a silent retry, and
  leaving, unmounting the studio or ending a screen share from the browser's own bar destroys
  the publisher and stops its tracks.
- Nothing is recorded. Sessions are created with `archiveMode=manual`, and no archive,
  broadcast, RTMP, caption or fal.ai transformation call exists in this slice. Those are
  separate permissions and are not enabled as a side effect of joining.
- **The provider cycle is not verified, and the credentials in this repository cannot verify
  it.** Two bounded probes were run on 2026-09-19. `POST https://api.opentok.com/session/create`
  with an HS256 project JWT returned 403: the supplied `VONAGE_API_KEY` is an 8-character
  account key, not a numeric video project key. `GET https://api.nexmo.com/v2/applications`
  with those same account credentials returned 200 with zero applications, so the configured
  `VONAGE_APPLICATION_ID` is not reachable from this account and no `VONAGE_PRIVATE_KEY`
  exists. The adapter therefore refuses both credential shapes and `/api/live/token` answers
  `live_not_configured`. Supply a video-capable application (id plus private key) and run
  `pnpm probe:vonage` to produce the session/token receipt.
- Verified locally: `pnpm typecheck`, `pnpm test` (142 passing, 24 of them covering this
  slice: role derivation, consent effectiveness and expiry, purpose bounds, device-permission
  classification, credential-mode selection, HS256 and RS256 token signatures verified
  against the secret and a generated key pair, lifetime clamping, `archiveMode=manual` on the
  wire, typed upstream failures that carry no upstream detail, and the route's method,
  origin, body, authentication and membership refusals), `pnpm build`, and `scripts/smoke.mjs`
  against a local production preview. The route was exercised over HTTP: `GET` → 405,
  cross-origin → 403, and the unconfigured POST → `live_not_configured`.
- **Not verified:** no browser has connected to a Vonage session from this repository, so the
  client publish/subscribe path, reconnection and the consent-to-track loop are implemented
  and unit-tested at their pure boundaries but unproven end to end. That needs both a
  video-capable Vonage application and a migrated Supabase project.

## Foundation verification

Passed: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, `git diff --check`; `PORT=4328 pnpm start` with `SMOKE_BASE_URL=http://127.0.0.1:4328 node scripts/smoke.mjs` verified health, three SPA deep links and unknown-API 404. No lint script exists. These are local checks, not a hosted deployment or live database test.

## Lobby and Realtime verification

Passed locally after merging the script-generation work from `main`: `pnpm typecheck`,
`pnpm build`, `pnpm test` (90 passing, of which 37 cover the room slice: invite-code and
display-name normalization, merge/dedup ordering, contribution rules, schema rejection, and
refusal to forward a native Postgres message to a participant), and `scripts/smoke.mjs`
against a local production server.

**Not verified:** no Supabase project credentials exist in this repository, so neither
migration has been applied to a database and `scripts/verify-realtime.mjs` has not been
run. Two-session collaboration, RLS enforcement, Realtime delivery, reconnect recovery and
removal are therefore specified and implemented but unproven. Run
`SUPABASE_URL=... SUPABASE_ANON_KEY=... pnpm verify:realtime` against a migrated project to
produce that evidence.

## 2026-09-19 — Portion playback, locking, and video-generation pipeline (RV-06)

- The edit-lock window is derived from the live director's position on the script clock: the playing beat and the one already with the provider are closed, and edits resume two beats ahead. With no stream open, nothing is locked.
- The portion-by-portion video pipeline is **removed** (RV-16): there is no per-portion generation, no clip store and no queue model. The live director is the only video path. See `docs/DECISIONS.md`.
- A live-director path exists for `minimax/h3-max/director`, a realtime WebRTC model. **The server is the WebRTC peer** (`werift`), so every direction is originated and audited server-side and the media track is recorded to storage; the browser can ask for direction but has no route to the provider (`apps/server/directorStream.ts`, `apps/server/director.ts`, `apps/server/directorRecordings.ts`, `src/core/directorAudit.ts`, `src/screens/JamDirector.tsx`). Because it holds a long-lived peer connection it belongs to the container process and cannot run as a Vercel function. It is gated behind `REVERIE_DIRECTOR_ENABLED` and is NOT probed — no session has been opened with a valid key and no stream has been watched.
- Playback state and the edit-lock guard are in-memory pending the RV-07 structured-script store rework; the pinned portion text currently reads from the creation-time structured script (structural edits are forbidden in v1, so indices are stable). Verified: `pnpm typecheck` and `pnpm test` (60/60) locally.
## 2026-09-19 — Invite lifecycle, QR sharing and a lobby that actually updates

- An invite can now end. `jams` carries `invite_expires_at` and `invite_revoked_at`;
  `rotate_jam_invite` mints a new code (killing every outstanding link and QR),
  `revoke_jam_invite` closes the room to new arrivals, and `get_jam_invite` is the only
  read path. All three are host-only `security definer` functions.
- The invite columns are excluded from the column grants on `public.jams` to
  `authenticated`, for `select` and `update` alike. An admitted member can read the room
  but not its entitlement, and a host cannot hand-write a predictable code. RLS could not
  express this: it answers which rows, not which columns of a row.
- A revoked or expired invite is refused with the same message an unknown code gets and
  counts against a throttle: `jam_admission_attempts` allows ten failed lookups per user per
  ten minutes. Because identities are anonymous, that throttle ends scripted probing from one
  session rather than making enumeration impossible; the code's ~39 bits and Supabase Auth's
  anonymous sign-in limits remain the real barrier, and the latter is still unconfigured.
- The host has an invite panel: the link, a QR of that same URL rendered with
  `qrcode.react`, the code in large type to read aloud, the current lifecycle state, and
  rotate/revoke controls. The panel never decides access; it renders what the database says.
- The lobby no longer promises an update it could not deliver. A waiting participant holds
  no Realtime channel — channel authorization requires *active* membership — so the lobby
  polls its own `jam_members` row every five seconds and stops at `active` or `removed`. A
  refusal now reads as a refusal instead of a slow network.
- A repeated join request is idempotent at the database: the display name refreshes, the
  status does not, so a second submit cannot reset a pending admission or re-admit someone
  the host removed.

### Verification

Passed locally after rebasing onto the RV-06 playback work: `pnpm typecheck`, `pnpm test`
(118 passing, 13 of them new and covering
invite state derivation, revocation outranking expiry, an unparseable expiry, the host-facing
description never leaking a raw timestamp, rotation-lifetime bounds, the invite-code schema
rejecting lookalikes, a jam row no longer carrying `invite_code`, and the throttle mapping to
a marked retryable error), `pnpm build`, and `scripts/smoke.mjs` against a local production
server (9 checks). In the browser: an invite link prefills the code on `/join`, and the local
preview is still labelled non-shareable. The QR was rendered through `qrcode.react` with the
real `inviteUrl` output and produced a 37x37-module SVG carrying an accessible title.

**Not verified:** the live-project check is blocked by the extension-schema correction below.
The column grants, throttle, lifecycle functions and two-session host/participant journey
remain unproven until `scripts/verify-realtime.mjs` completes against the migrated project.

## 2026-09-19 — Supabase production check found an extension-schema fix

- The first live-project verification reached the database using anonymous sessions and the
  publishable key, but Jam creation stopped at `public.generate_invite_code`: Supabase places
  `pgcrypto` functions in `extensions`, while the security-definer function deliberately has
  a `public`-only search path. `20260919212000_fix_invite_code_randomness.sql` now qualifies
  `extensions.gen_random_bytes(8)`. Apply it, then rerun `pnpm verify:realtime`; no
  collaboration, RLS or Realtime assertion has been claimed as passed before that rerun.
- Supabase Cloud rejects policy changes on its service-owned `realtime.messages` table. The
  hosted collaboration transport therefore uses public channels only for Postgres Changes,
  whose durable tables enforce their own RLS; Presence and Broadcast remain disabled.
- `20260919213000_persist_admission_throttle.sql` returns typed denied-admission results so
  failed invite attempts commit their throttle counter instead of being rolled back with an
  exception.

## 2026-09-19 — Jam registry and script import (RV-08)

- Every jam now registers its room first and passes that room id to `POST /api/jams` as `jamId`, so the generated or imported script and its revision history attach to that exact room instead of a second, server-minted id.
- `/jams` is the registry: it lists the rooms this identity hosts or has joined (RLS-scoped `jams` select, newest first), hides `completed`/`closed`, and offers "start a new jam". Home's primary action opens it. Without Supabase it reads a browser-local preview registry and labels it non-shareable.
- Creation offers two sources: a from-scratch prompt (Nebius, generation-gated) or an imported script. Import makes no provider call, keeps the pasted markdown verbatim as revision 1, and derives a word-boundary, format-bounded portion projection; text too short or too long for the runtime is refused with `invalid_script_import` rather than padded or split mid-word.
- Verified locally: `pnpm typecheck`, `pnpm test` (111 passing, including the import route and the projection), `pnpm build`, and `scripts/smoke.mjs` against a production server covering the new `/jams` deep link. The import path was exercised live against the built server: `POST /api/jams` with `mode: "import"` returned 201 and `script.md` returned the exact pasted markdown, while `mode: "generate"` without a provider returned the typed `generation_disabled` 503.
- Not verified: no Supabase project is migrated, so the RLS-scoped remote registry is implemented and unit-tested but not exercised against a live database. The API still accepts `from-movie`, but the create screen no longer offers it.

## 2026-09-19 — Local Supabase Docker stack runs the production build

- `docker compose up --build --wait` at the repository root starts Postgres, Auth with
  anonymous sign-in, PostgREST, Realtime, an nginx gateway on `127.0.0.1:54321`, a one-shot
  migration runner, and the production Vite/Express app on `127.0.0.1:4317`. The migration
  runner applies every `supabase/migrations` file once (tracked in
  `reverie_local.schema_migrations`) and then reloads the PostgREST schema cache.
- Three local-only fixes were needed to match hosted Supabase. The nginx gateway returned a
  fixed CORS allow-list that omitted the PostgREST headers Supabase JS sends (`Prefer`,
  `Accept-Profile`, `Content-Profile`), so Chrome blocked the `jams` insert at preflight; it
  now echoes `Access-Control-Request-Headers`. The Express host reads `HOST` so it can bind
  `0.0.0.0` inside the container. The migration runner grants `jams` insert plus the live-mode
  tables, and deliberately leaves `jams` select/update to the per-column grants from
  `20260919200000_jam_invite_lifecycle.sql` so a table-level grant cannot silently re-expose
  the invite columns.
- The stack was reconciled onto newer `main` commits (RV-08 invite lifecycle, live media and
  the jam registry) without force push. It now applies all ten migrations, and the invite
  lifecycle works locally: a host reads the code only through `get_jam_invite`, while a direct
  select of `invite_code` is refused with `42501`.
- The client no longer treats `new` as a room slug: loading `/jams/new` resolves to the create
  screen with no slug, instead of opening a studio for a room called "new".
- `.env.compose` holds only public, local-only values (the local anon JWT and its signing
  secret) and is committed so the documented command works from a fresh clone.
- `pnpm verify:realtime` ran for the first time, against this stack: 27/27 checks covering the
  invite lifecycle (host-only reads, no hand-writing, rotation/revocation, throttle), lobby
  placement, refusal of self-admission and direct membership inserts, host admission,
  cross-session Postgres Changes delivery, reconnect snapshot recovery, outsider denial and
  removal. One earlier run flaked on a single message delivery after admission and passed on a
  clean re-run; that check subscribes and waits one second before the insert. Only the local
  stack is proven — no hosted project has been migrated from this repository.
- Verified against the running stack: anonymous Auth `200`; `POST /rest/v1/jams` from the app
  origin `201` with the returned columns excluding the invite; `get_jam_invite` `200`; direct
  `invite_code` select `403` (`42501`); `/api/health` and the `/jams/new` guard correct;
  `pnpm typecheck` and `pnpm test` (148 passing). This is a local development stack: it does
  not prove Vercel parity and the in-memory script/session/playback stores still reset when the
  app container restarts.

## 2026-09-19 — Script generation self-corrects runtime misses (RV-10)

- `writeJamScript` no longer fails after sending the same prompt twice. A draft
  that cannot be fitted to the jam's runtime is retried with targeted feedback:
  the next prompt carries the rejected draft's actual total seconds, its portion
  count, whether it ran long or short, and the feasible portion band for the
  target. A reply that fails the draft shape is retried with the exact JSON
  shape restated.
- Attempts are bounded at four paid completions, so the cost of a stubborn
  provider is capped; only after that do we return the existing typed, retryable
  `generation_failed`, which the create screen can retry without losing the
  already-registered room. The 0.8×–1.25× rescale window is unchanged.
- The provider completion is now an injectable argument of `writeJamScript`, so
  the retry loop is tested offline: a too-short draft is corrected into an exact
  240-second script, an unusable shape is retried, and an uncorrectable draft
  stops after the bounded attempts (`tests/scriptwriter.test.ts`).
- Verified locally: `pnpm typecheck` and `pnpm test` (153 passing). No live
  provider call was made for this change, so provider behaviour is implemented
  and unit-tested here, not claimed as a live probe.

## 2026-09-19 — Room creation recovers from a dead persisted identity

- A persisted Supabase session can outlive the user it names, for example after the project
  database is reset. `getSession` reads that record straight from local storage, so the app
  trusted a deleted `auth.uid()`; the `jams` insert then failed on the orphaned `host_id`
  foreign key (`23503`) and surfaced as "The Jam room could not be created."
- `ensureUserId` now confirms a stored identity with `auth.getUser()` before trusting it. A
  4xx auth rejection discards the dead local session and mints a fresh anonymous identity, so
  room creation heals itself; a network failure is reported instead, so a flaky connection
  never silently replaces the participant's identity.
- `toJamError` now maps the codes this exposed: `23503` to a recoverable session message and
  the missing-table/function codes (`42P01`/`PGRST205`/`42883`/`PGRST202`) to a
  `not_configured` message naming the unapplied migrations, instead of a generic outage.
- Verified against the local Docker stack: with a stored session whose user was deleted,
  `GET /auth/v1/user` `403` → local sign-out → anonymous signup `200` →
  `POST /rest/v1/jams` `201`. `pnpm typecheck` and `pnpm test` (157 passing).

## 2026-09-19 — Script screen actions specified (RV-12)

- `docs/specs/script-screen-actions.md` records the goal and boundary of the three
  script-screen actions: **Open the studio** (enter the collaborative room), **Open as
  markdown** (the shared, unpersonalized screenplay export), and **Start my session** (a
  personal playback seat on the same script).
- It states the one mental model behind them — one authoritative script and one collaborative
  room per jam, where a session is a participant's **seat in that same room** carrying only
  per-participant overrides — and repeats the standing gap: a session records and exposes
  playback parameters only; translated or re-ambiented rendering, and per-session generated
  media, are not implemented.
- `docs/DECISIONS.md` records that session-as-room-seat model, including the current gap that
  the owner-token playback session and Supabase `jam_members` membership are still separate
  records that do not imply one another.
- It also records the intended (not implemented) direction: **Open as markdown** becomes the
  door to an editable script **version**, and the screenplay is revised through a **chat** on
  this screen, appended as versions rather than overwriting the shared script.
- `docs/specs/configuration-keyed-streams.md` records the intended playback economics: generate
  **one stream per distinct configuration**, not per participant; cap the number of distinct
  configurations the server holds; and, when the cap is full, show the active configurations so
  participants **attach** to an existing one instead of triggering new paid generation.
- `docs/specs/intended-vs-implemented.md` is the register that separates actual behaviour from
  intended, with code anchors: the copy-to-version step, chat editing, session/room-membership
  unification, Supabase-backed session persistence and configuration-keyed streams have **no
  code** (or no wiring), and the script/session routes are local Express only, not Vercel
  functions.
- Documentation only; no code or runtime behaviour changed.

## 2026-09-19 — Live-project verification: 27/27

- Before the rerun, one anonymous RPC call showed the hosted database still ran the old
  `request_jam_admission`: `request_jam_admission('ZZZZZZZZ', 'Probe')` returned
  `data: null` with `P0002 jam: invite not found`. The raised exception rolled back the
  `record_failed_admission` write in the same transaction, so the throttle never counted.
- `20260919213000_persist_admission_throttle.sql` was then applied by hand in the Supabase SQL
  Editor (the repo has no CLI link or service-role key). The same probe now returns
  `{ status: "error", code: "invite_not_found" }` with no error.
- `scripts/verify-realtime.mjs` now awaits the channel's `SUBSCRIBED` acknowledgement before
  writing the row it expects over Realtime, instead of sleeping one second.

### Verification

Passed against the hosted project: `pnpm verify:realtime` 27/27, including the throttle, which
trips after 11 failed lookups (limit: ten failures per user per ten minutes). Also passed:
`pnpm probe:vonage` (session create, publisher token, token bound to the session), `pnpm test`
(143/143), `pnpm typecheck`, `pnpm build`.

**Not verified:** the live stage in two real browsers; the throttle across the window reset
(the check proves the lockout, not the ten-minute expiry); migration history on the hosted
project (it was applied by hand, so no tracking table records it). Each run of
`verify-realtime` leaves a `verify-room-*` jam behind, and it has to be deleted by hand.

## 2026-09-19 — Discover serves real films from a TMDB snapshot in Postgres

- **There is no Titan catalogue API.** The Titan OS challenge supplies none; its brief names the
  Kaggle TMDB dataset as the tool. The catalogue is now `public.catalogue_titles`: 27,839
  released, non-adult films with a poster, an overview and at least 50 votes, curated from the
  dataset's ~1.5M rows and loaded into the hosted Supabase project.
- `supabase/migrations/20260919220000_catalogue_titles.sql` creates the table, a weighted
  `document` tsvector (title A, genres B, keywords C, overview D) with GIN, trigram and btree
  indexes, and a select-only RLS policy for signed-in viewers.
  `20260919221000_search_catalogue_titles.sql` adds `search_catalogue_titles(search, page_number,
  page_size)`, a `security invoker` function that returns one page and the match count. A
  non-empty query is ranked with `ts_rank` (English and simple configurations, whichever scores
  higher), then by popularity. An empty query is ordered by popularity. PostgREST filters can
  match `document` but cannot order by rank, which is why this is a function.
- `api/_lib/supabase-catalogue.ts` replaces the Titan adapter. It calls that function with the
  viewer's own access token, so the read goes through RLS, and it maps only the columns Discover
  renders. Posters come from `image.tmdb.org/t/p/w500` and backdrops from `w780`. Every title and
  every page carries the TMDB attribution. `availability` is always `[]` because the dataset has
  none, and Discover no longer renders a "Where to watch" block or copy that implies streaming.
  The response `source` is now `"tmdb"`. `api/_lib/titan-catalogue.ts` and every `TITAN_*`
  variable are gone.
- Discover signs the viewer in anonymously if needed and sends `Authorization: Bearer`;
  `/api/catalogue` answers 401 without it.
- Cost: one round trip per page, and no `select *`. A 24-title page is about 12.7 KB. Measured on
  the hosted database, a broad query ("love", 4,105 matches) runs in about 20 ms, and the deepest
  empty-query page in about 12 ms.
- Verified: step-0 checks against the live project (27,839 rows; `heist dream` ranks Inception
  first by `ts_rank`, 0.197 vs 0.092). Then `pnpm test` (147/147), `pnpm typecheck` and
  `pnpm build`. `/discover` was checked against the live project in a browser: real posters and
  titles, Inception first for `heist dream`, and a detail dialog with runtime, genres, synopsis
  and attribution and no availability. No console errors.
- **Not verified:** a Vercel deployment of this change. The server needs `SUPABASE_URL` and
  `SUPABASE_ANON_KEY` (or the `VITE_` pair) at runtime. The new function was applied by hand
  through the session pooler, like the earlier migrations, so no tracking table records it.

## 2026-09-19 — Discover looks and navigates like a TV app

- Discover is laid out for a 1920×1080 screen read from about three metres: everything sits
  inside a 5% title-safe inset, poster titles are 24px, metadata and body text 20–22px, and the
  grid shows seven posters per row at 1920px, built from each title's `posterUrl`.
- A spotlight beside the search shows the focused poster's title, year, runtime, genres and a
  three-line synopsis over its `backdropUrl`. It repeats what the focused button announces, so it
  is hidden from assistive technology. Below 1100px it and the backdrop give way to the search.
- Focus is visible without relying on colour: the focused poster scales up, gains a 6px ring,
  shows an "OK Details" label and underlines its title.
- Remote navigation: when posters load and nothing holds focus, the first poster takes it. Arrows
  move one poster and stop at the edges, a short last row is reachable from the row above, Up
  from the top row goes to search, Down from the bottom row goes to the pager (Left/Right between
  its buttons, Up or Escape back to the grid). Enter or Space opens a title, and Escape closes it
  and restores focus. Escape (or a remote's Back key) on the grid returns to search. Escape in an
  empty search leaves Discover. The key mapping is the pure `gridMove` in
  `src/discover/gridMove.ts`, used by `useGridNavigation`.
- The TMDB attribution is a fixed bar at the bottom of the screen whenever titles are shown,
  using the response's attribution text. Nothing on the screen implies a title can be streamed.
- Unchanged: the catalogue contract, the adapter, search, paging, and the loading, empty, error
  and not-configured states (now in larger type).
- Verified: `pnpm test` (155/155, including `tests/gridNavigation.test.ts` for arrow movement,
  edges, row exits and Enter opening the focused title), `pnpm typecheck`, `pnpm build`. Checked
  in a browser at 1920×1080 against the live catalogue: initial focus, arrows, Enter opening the
  detail, Escape restoring focus, Down to the pager, Up back, Escape to search, the empty state,
  and a 375px layout with no horizontal overflow. No console errors.
- **Not covered by automated tests:** the DOM wiring (focus, scrolling, pager hand-off). The test
  suite has no DOM, so `gridMove` is tested directly and the wiring was checked in the browser.

## 2026-09-19 — A shared, server-anchored playback clock

- The Studio now shows a room-wide counter that every participant derives from one server
  anchor. The host starts, pauses or resets it; the database stamps the anchor with its own
  `now()`, so two viewers can compare positions and agree. This is the coordination layer a
  synchronized player needs, without yet deciding what the player renders.
- Position is derived, never a mutable counter: `elapsedMs = paused_elapsed_ms + (now() -
  started_at)` while playing, `paused_elapsed_ms` otherwise. The payload carries `serverNow`,
  so a browser corrects for skew by anchoring to `elapsedMs` and advancing with its own
  monotonic clock (`performance.now()`) — no participant's wall clock can move the room.
- New `jam_playback` table (RLS on, no policies) plus `get`/`start`/`pause`/`reset` security
  definer RPCs. Reads are limited to active members and the host; only the host may control
  it. A redundant start is a no-op and never moves the anchor.
- Client: `src/core/playbackClock.ts` (pure derivation), `src/lib/playback.ts` (RPCs),
  `src/screens/usePlaybackClock.ts` (2.5s poll + local tick), `src/screens/PlaybackBar.tsx`.
  Polling is the documented interim transport; the contract is Realtime events.
- Verified live in two browsers on the local stack: both showed `0:05` at the same moment,
  tracked `0:12 → 0:19` together, and froze together at `0:25` on pause before resetting to
  `0:00`. `pnpm verify:realtime` now includes 7 clock checks (34/34 passing); `pnpm typecheck`,
  `pnpm test` (166 passing) and `pnpm build` all pass. What the player shows remains undecided.

## 2026-09-19 — Discover refines: shortlist, rank, "not this one"

- Discover now narrows as the viewer states what they want. A rail of chips sits between the
  search and the grid; each chip is a sentence ("Something scary", "Under two hours", "From the
  nineties") and carries the quotes cited from it, which the preference engine accepts only as
  literal substrings of that sentence. Chips cover exactly what the catalogue holds: seven genre
  preferences, three genre refusals, two runtime limits and three eras. There is no mood, tone
  or pace chip, because TMDB carries no such data.
- A second rail shows everything currently shaping the result (wanted genres, each constraint,
  the count of turned-down titles) and how many titles match; any item can be removed, and
  "Start over" begins a new session. A chip that is already applied shows as pressed and
  withdraws itself when chosen again.
- "Not this one" in the title dialog adds the title to `rejectedCandidateIds` through the new
  `rejectCandidate`; it leaves the grid at once and does not return unless the viewer brings
  turned-down titles back from the rail (`restoreRejected`).
- `src/catalogue/domain.ts` is the engine vocabulary used everywhere: dimensions `genre.<slug>`
  for the 19 genres, attributes `runtimeMinutes` and `year`, tags for the 19 genre slugs plus
  `lang.<code>`, no flags. `candidates.ts` maps a title to a Candidate and omits a runtime or
  year the title does not carry. `scorer.ts` scores eligible titles 0..1 (90% genre affinity
  weighted by confidence, 10% shortlist position as tie-break) and passes that ranking through
  `acceptRanking`; its top three are marked "Top pick". `shortlistFilters.ts` turns the state
  into database filters. `refinements.ts` defines the chips and the withdrawal turns.
- `supabase/migrations/20260919231000_constrained_catalogue_shortlist.sql` replaces
  `search_catalogue_titles` with a ten-argument form (the first three unchanged): runtime and
  year bounds, wanted and refused genres, and turned-down ids, all filtered in SQL against an
  indexed `genre_slugs` column. A missing runtime or date never satisfies a bound. It still
  returns only the mapped columns plus `original_language`, at most 48 rows. A refined Discover
  reads one ranked shortlist of 48 instead of paging; the unrefined browse and search are the
  same call as before.
- Verified: `pnpm test` (293/293 on this slice, 302/302 after merging the playback clock; including row-to-candidate mapping, the scorer, constraint
  push-down into the RPC body and the migration, chip grounding and rejection), `pnpm typecheck`,
  `pnpm build`. The migration was applied by hand in the SQL Editor; `pnpm verify:shortlist`
  against the live project: 27,839 → 4,055 with "something scary" → 3,902 with "under two hours"
  → 3,901 after "not this one", 4,054 after removing the runtime limit with the rejected title
  still absent, and never more than 48 rows. The same sequence was checked in a browser at
  1920×1080, with remote navigation grid → active rail → chips → search, and at 375px with no
  horizontal overflow.
- **Not covered by automated tests:** the rail DOM wiring (focus hand-off between rails and after
  a rejection). It was checked in the browser.

## 2026-09-19 — Discover speaks to the viewer, films get pages, the grid grows

- Copy: the Discover header now reads `DISCOVER`, `What are we watching tonight?` and one line,
  "Say what you’re in the mood for, then narrow it down together." It no longer asserts that the
  films are real, names TMDB, or lists what the product does not do; grid states say "films",
  not "catalogue titles"; the home link reads "Find something to watch". The guarantee is
  unchanged where it is enforced: the adapter, the contract and the tests. TMDB attribution is
  still on every screen that shows TMDB data (the grid's footer bar and every film page).
- Film pages: the detail dialog is gone. A film opens at `/discover/:id` (the TMDB id), which
  survives a reload and works with back/forward. `src/lib/routes.ts` holds the pathname matching
  that `main.tsx` did by hand, now with one parameter segment; there is still no router. The
  page shows the backdrop large (TMDB `w1280`), the poster, and only the fields the record
  holds: title, original title when it differs, tagline, year, running time, score with votes,
  genres, synopsis, release date, original and spoken languages, keywords and an IMDb link.
  An absent field produces no line at all (`src/discover/filmFacts.ts`); availability stays
  empty and unrendered. A "What to do with this film" group is where future actions go; it
  holds only "Not this one", which works as before. Escape or a remote's Back returns to the
  grid with focus on that film, however the page was opened (OK, a URL, or browser Forward).
- The page is drawn as a fixed full-screen layer over an `inert` grid, so the grid keeps its
  scroll position, loaded pages and focus target underneath. Opened from the grid, closing it
  steps back in history; reached by URL, it replaces itself with `/discover`. Reached by URL,
  the grid is not read until the viewer goes to it.
- Data: `supabase/migrations/20260919232000_catalogue_title_detail.sql` adds
  `get_catalogue_title(title_id bigint)`: one row by primary key as `jsonb`, security invoker,
  `search_path = ''`, executable by `authenticated` only, returning `null` for an unknown id and
  none of the internal columns. `search_catalogue_titles` is untouched, so the grid stays lean
  and a film page pays for exactly one row. `GET /api/catalogue-title?id=` (`api/catalogue-title.ts`,
  `api/_lib/supabase-catalogue-title.ts`) validates the id, requires the viewer's token, maps
  the row (a score only with votes behind it; zero runtime, blank tagline and malformed IMDb
  ids dropped) and answers 404 for an unknown film.
- Endless grid: the Previous / Next / Page control is gone. `src/discover/pageFeed.ts` appends
  pages of the unchanged page-based query when focus enters the last row (the trigger a remote
  uses) or when the end of the grid comes within 900px of the viewport (mouse and touch). One
  request is in flight at a time and triggers during it are dropped, not queued; appended titles
  never displace the ones on screen, so focus does not move; the last page (or the query's page
  100) ends the feed silently. A failed page shows "More films could not be loaded" with
  "Try again" at the end of the grid, reachable with Down from the last row, and keeps
  everything loaded; retrying returns focus to the grid. A new search or refinement starts at
  page 1 at the top. Poster boxes are 2:3 before their image loads. A refined shortlist stays a
  single ranked read of 48 and never pages.
- Verified: the migration was applied by hand in the SQL Editor; against the live project, a
  signed-in call for 27205 returned Inception's full record, an anonymous call was refused
  (`42501`), a title with no tagline returned `null` for it, and an unknown id returned `null`.
  `pnpm test` (340/340, including `tests/routes.test.ts`, `tests/catalogueTitle.test.ts`,
  `tests/filmFacts.test.ts`, `tests/pageFeed.test.ts`, `tests/discoverCopy.test.ts`),
  `pnpm typecheck`, `pnpm build`. In a browser at 1920×1080 against the live project: arrow
  keys into the last row loaded page 2 (24 → 48) with focus kept; wheel scrolling loaded page 2;
  a forced page failure showed the retry with 48 posters kept, and retrying appended with focus
  back on the grid; opening a film changed the URL, cost one `catalogue-title` request, and
  Escape returned focus to that film with the grid's scroll position unchanged; Forward then
  Back did the same; reloading `/discover/976573` rendered the same page with no list request;
  `/discover/abc` (no request) and `/discover/1` (404) say the film is not there; a film with a
  zero runtime and no tagline shows neither; "Not this one" from a film page removed it from the
  grid and focused its old place; nothing overflows at 375px.
- **Not covered by automated tests:** the DOM wiring (the IntersectionObserver, focus hand-offs,
  the film layer). It was checked in the browser. The browser tool could not press native
  buttons with Enter or Space (it failed the same way on existing buttons), so the "Try again"
  button was checked by click; Down from the last row does reach it.

## 2026-09-19 — Discover holds a conversation (Nebius)

- A field above the chips takes the viewer's own words ("Tell me what you’re in the mood for…").
  Each message is one engine turn: `POST /api/discover/turn` asks Nebius to **interpret** it into a
  `Decision` (genre evidence with quotes, a runtime limit, an era, one acknowledgement, at most one
  clarifying question), turns that into a `TurnInput` and passes it through `applyTurn`, which
  refuses any quote that is not literally in the message. The browser applies the same turn through
  the same engine, then the unchanged path runs: state → SQL filters → shortlist → candidates. The
  model never sees the catalogue in that call.
- Once the viewer has talked to it, `POST /api/discover/rank` sends the eligible shortlist (id,
  title, year, runtime, genres, score, a 280-character synopsis) and the model **ranks** it. Its
  ranking must pass `acceptFullRanking` on the server and again in the browser, so it can only
  reorder films the database returned. Its utility replaces the scorer; the scorer's position term
  is no longer part of the model's order. The top three are picks with a one-line reason, shown in
  the spotlight and in the card's accessible name. The grid says which ranking it shows: "Ranked by
  the assistant", "Ranking with the assistant…" (no picks marked) or "Ranked by genre match" with
  the reason.
- One clarifying question at most per turn, only when nothing concrete has been said; a turn that
  states anything outright drops the question. Answering it narrows: an outright genre retires the
  genres guessed from a mood. "Actually nothing scary" refuses and excludes horror, as the chip does.
- Failure never breaks Discover: provider disabled, timeout, bad JSON or failed grounding after one
  retry answers `unavailable` with a reason. The conversation then says "The assistant is
  unavailable: … Use the chips to refine; results are ranked by genre match.", the scorer ranks, and
  nothing is labelled as the model's. Chips, the rail, "not this one", film pages and the endless
  grid are unchanged.
- Bounds: 700/1,200 output tokens, 12 s/15 s per attempt inside 20 s/25 s, one retry and none after a
  provider timeout, the engine's 12-turn cap checked before any call, 20/30 requests per minute and
  6 concurrent calls per instance, a Supabase-verified viewer, abort on client disconnect. Every
  call is server-side; the key never reaches the browser. `completeJson` gained optional
  `timeoutMs`, `temperature` and `signal`; `NebiusError` carries a `kind`.
- Code: `src/conversation/` (decision, wire contract, transcript), `api/discover/{turn,rank}.ts`,
  `api/_lib/discover-{assistant,prompts,http}.ts`, `src/discover/{ConversationBar.tsx,
  useConversation,useAssistantRanking,rankedShortlist,assistantClient}.ts`, `orderByAssistant` in
  the scorer module and `acceptFullRanking` in the engine (`acceptRanking` is now its top three).
  `useCatalogue` reports which query and filters its state was loaded for.
- Verified: `pnpm test` (400/400, including `tests/conversationDecision.test.ts`,
  `tests/discoverAssistant.test.ts`, `tests/discoverEndpoints.test.ts`,
  `tests/conversationFallback.test.ts`), `pnpm typecheck`, `pnpm build`. `pnpm verify:conversation`
  against the live project and Nebius (`Qwen/Qwen3-30B-A3B-Instruct-2507`) passed three times:
  "something light for a Friday night" → one question ("Would you like a comedy, a family film, or
  something under 90 minutes?") and 13,204 matching titles ranked by the assistant; "A comedy,
  please" → no question, 9,942, all comedies; "actually nothing scary" → horror excluded, 9,304;
  "A scary film under two hours" from a fresh session → no question, 3,902. Interpret took 0.8–5.4 s
  and ranking 4.5–11 s per call, depending on provider load. The same three turns were checked in a
  browser at 1920×1080 against the live project. With `REVERIE_LIVE_ENABLED=false` the panel stated
  the fallback, a chip still narrowed to 9,942 titles labelled "Ranked by genre match", and no rank
  call was made. Nothing overflows at 375px.
- **Known gaps:** ranking latency is the slow part of a turn and sits within 4 s of its per-attempt
  timeout under load. The rate limit and concurrency cap are per instance. The React wiring
  (the panel's focus hand-offs, `useConversation` and `useAssistantRanking` and their races) is
  checked in the browser, not by automated tests (the repository has no component test harness);
  their decisions are pure functions that are tested, and the browser tool again could not submit with Enter, so the Ask button was clicked. A
  chip shows as pressed when the assistant inferred the same genre.

## 2026-09-19 — Reproducing the film, and durable clips (RV-14)

- The generated video has a player. `THE FILM` panel (`src/screens/JamPlayer.tsx`) runs on the
  script screen and in the Studio, bound to `GET /api/jams/:id/portions/:index/video`: play and
  stop only, no seek, one pip per portion showing what the server has. It polls
  `GET /api/jams/:id/playback` every 5s, starts the jam, and advances **when the clip in the
  element ends** — never when generation finishes — so a ready portion cannot cut the current one
  short. The viewer-side rules are a pure function of the server snapshot in
  `src/core/portionPlayback.ts`.
- It replaces the room's elapsed-time counter in the Studio. `PlaybackBar`, `usePlaybackClock`,
  `src/lib/playback.ts` and the clock RPCs are untouched but unmounted; no screen shows a room
  position today.
- The player asks for its clip under the viewer's own session configuration (language,
  ambientation), normalized once in `configurationKey`. Every key still resolves to the jam's one
  stream and the panel says so; the cap and attach flow remain unimplemented
  (`docs/specs/configuration-keyed-streams.md`).
- Generated clips persist. `SupabasePortionMediaStore` writes to the private `jam-portions`
  bucket (`supabase/migrations/20260919233000_jam_portion_media.sql`) when
  `SUPABASE_SERVICE_ROLE_KEY` is set — server-only, no `storage.objects` policies, and
  participants still receive our own bytes. Without the key the bounded in-memory store is used
  and reports `durable: false`. A clip the store already holds is never generated again.
- Still open: the playback cursor is in memory, so a restarted server reads `idle` while its
  clips remain (`JamStore.getPlayback`/`updatePlayback` exist but nothing wires the coordinator to
  them); `start`/`advance` are host-only in the contract and in the UI, but the Express routes
  carry no authorization; and these routes remain local-host only, not Vercel functions.

## 2026-09-19 — One top bar on every screen, and a TV home

- **One top bar** (`src/shell/TopBar.tsx`) is rendered at the top of every screen: the home,
  Discover, a film page (inside its own layer) and every Movie Jam screen (registry, create,
  script, join, studio, local preview). It carries the brand (a pointer link home, left out of the
  remote's path), three destinations (`Home`, `Discover`, `Movie Jam` → `/jams`) and a search
  icon, and holds no text field. The current destination is marked by an outline as well as
  brighter text; a focused item fills light, gains a white ring and grows.
- **Search** opens Discover with its search field focused: from any screen, in place on Discover,
  and from a film page (which closes the way Back would before the field takes focus).
- **Remote conventions** (`src/shell/useRemoteConventions.ts`, `src/shell/keys.ts`). Back anywhere
  on a page scrolls to the top and focuses the bar; a film page scrolls its own layer and the
  screen under it keeps its place. Back on the bar leaves for the screen's parent: Discover,
  Movie Jam and join → home; create and studio → the registry; the script → its setup; a film
  page → wherever it was opened from. History is stepped back only when the entry behind is that
  parent; otherwise the entry is replaced, so repeated Back climbs to the home instead of
  replaying the session. On the home, Back on the bar is left to the platform. Back is known by
  name (`Escape`, `GoBack`, `BrowserBack`, `XF86Back`), by the key codes 461 and 10009, and as
  Backspace outside a text field. Up from the first thing on a page reaches the bar. A held Back
  never leaves, a held OK acts once, and a key pressed with nothing focused lands on the bar.
- **No on-screen back buttons.** Removed `← Back to your jams`, `← Back to Reverie` (registry,
  join), `← Back to setup`, `← All films` and the `Back to Reverie` buttons (join refused, studio
  error, local preview). A film page that names no film no longer offers `Browse films`. The
  studio keeps `Leave the room` (was `Leave`) as a room action.
- **Discover** keeps its search, chips, conversation and grid; its own header (brand, `DISCOVER`,
  a Movie Jam button) is replaced by the bar. Keys that changed: Back on the grid, on a rail, in an
  empty search or in an empty conversation field now goes to the bar (it used to go to the search,
  to the field above, or out of Discover). Escape still clears a typed search or draft first. Up
  from the search field reaches the bar.
- **Film pages** open with focus on the bar's current item, which names where the film was opened
  from (`Home` or `Discover`): one Back, or OK, closes the page, and Down enters it. Up from the
  first control returns to the bar and Back inside the page returns to the bar. A film opened from
  the home is a layer over the home, which stays mounted and inert underneath; closing it puts
  focus back on the card that opened it and reads nothing again. It offers no `Not this one`,
  because there is no grid to take it out of.
- **History records where each screen was opened from** (`src/shell/history.ts`): each entry the
  app creates carries a key, and a pushed entry records the path and key of the entry behind it.
  An entry replaced by leaving is remembered (for the tab session), so an entry reached again with
  the browser's Forward whose opener has since been replaced closes to its parent by replacement,
  not by stepping back into the wrong screen. A film counts as opened from the home by the screen
  its opener path resolves to, so a home served at another path behaves the same.
- **The home** (`/`, `src/home/`) replaces the marketing landing: a full-width hero, eight shelves
  (Science fiction, Comedies, From the nineties, Animation, Thrillers, From the eighties,
  Documentaries, From the 2010s) read through `search_catalogue_titles` with `includeGenres` or
  `minYear`/`maxYear` and twelve titles each, and the Movie Jam spotlight after the second shelf.
  The hero is the first title with a backdrop in the first shelf's own read, so it costs no
  request, and it is not repeated in that shelf. Shelves run to the right edge so the last card
  on screen is cut by it (7.3 across at 1920px, 2.4 at 375px). Posters are 2:3 boxes before they
  load (the image fills the box and never sizes it), every card is exactly one card wide, and a
  card's text is always two title lines and one meta line, so a shelf is the same height loading,
  loaded or failed. The hero reserves the height of its tallest content (two title lines, one line
  of facts, three of synopsis, the action), so it does not grow when its film arrives either.
- **Focus on the home** is decided by the pure `rowMove` (`src/home/rowMove.ts`). Left and Right
  move along a row and stop at its ends. Up and Down change row and land on the item last focused
  there (the first, on a first visit). Up from the first row reaches the bar. A row still loading
  holds focus rather than being skipped. A failed shelf keeps `Try again` focused while it retries
  and hands focus to its first card when it loads. OK is handled by the app, once, instead of being
  left to the browser's Enter.
- **Cost.** Only the first two shelves are read when the home opens. Each later shelf is read when
  it comes within 480px of the viewport or when focus enters the shelf above it, one read at a
  time. A loaded shelf is kept for five minutes (coming back to the home shows it at once and
  reads nothing), a read already in flight is joined, and failures are not kept. A home under a
  film page reached by URL reads nothing until the page closes.
- **Anonymous sign-in is single-flight** (`createIdentity` in `src/lib/session.ts`). Two reads
  started together on a first visit (the home's two eager shelves) could each find no session and
  sign in anonymously twice; they now share one attempt.
- **The Movie Jam spotlight** is a full-width banner over a real film still (the last backdrop of
  the second shelf, credited `Still from <title> (<year>)`) with two focusable actions: `Start a
  Movie Jam` (→ `/jams/new`) and `Join with an invite` (→ `/join`). The illustration and the three
  "how it works" cards moved to the create screen, beside and below the form (after the form on a
  narrow screen).
- **Focus is visible from across a room**: scale, a white ring and a dark-on-light swap on every
  remote-driven control, including Discover's chips, fields and buttons, the film page's actions
  and the Movie Jam screens' buttons and form fields (a ring, a lighter field and a slight lift).
  With reduced motion, nothing scales and the page jumps instead of gliding. A remote gives the browser no reason to match `:focus-visible`, so the
  root carries `data-input="pointer"` only after a pointer is used, and until then every focused
  control is marked.
- **TMDB attribution** is on the home as soon as a shelf has loaded, on every film page and on
  Discover. Availability is still never rendered.
- **Component tests.** `jsdom` 29.1.1 (dev only), `tests/dom.ts` and `tests/render.tsx` render
  real screens and fail a test on any React or jsdom error. `pnpm test` now runs
  `tests/*.test.ts` and `tests/*.test.tsx`. The home's shelves and the Discover grid read the
  catalogue through `CatalogueReadProvider` (`src/discover/CatalogueReadContext.tsx`), which the
  app leaves at `/api/catalogue` and a test replaces with its own titles, so App-level tests drive
  real posters through the real code.

### Verification

- `pnpm test` (502/502, run twice), `pnpm typecheck`, `pnpm build`. New tests:
  `tests/topBar.dom.test.tsx` (the bar on every screen, including a film page from each origin,
  the script and the studio; no field in it; no back button anywhere, by visible text or accessible
  name; search from the home, from Discover and from a film page; landing, Left/Right, OK),
  `tests/home.dom.test.tsx` (two reads on open; a lazy shelf read once when it approaches or when
  focus reaches the shelf above; no further read when the catalogue is not configured or the
  first shelf is empty; the hero not repeated in its shelf; the spotlight's still and actions;
  2:3 placeholders; attribution; Up from the hero reaches the bar and Down returns; Up from the
  first shelf reaches the hero; Left/Right stay in the row; Up/Down land on the remembered item;
  waiting on a loading shelf; OK once; Back from four rows down; Back by key code 461; Back on the
  home's bar left to the platform; a retry keeps focus), `tests/app.dom.test.tsx` (through the
  whole app over a test catalogue: two reads and landing on the hero; a film opened from a shelf
  keeps the same home mounted and inert, closes by stepping back and returns focus to its card; a
  home served at another path; no film shown under another film's address; Back from a Discover
  poster; OK opens a poster but a held OK does not; a film reopened by Forward after its grid entry
  was replaced; Down on a film page with nothing to focus moves the page),
  `tests/backConvention.dom.test.tsx` (Discover's search, conversation and chips; Back on the bar
  goes home with and without history; a film page closes with one Back or by choosing its
  destination without adding history; Up and Back inside it; the Movie Jam screens' fields keep
  Backspace, Up and a held Enter or Space; climbing to parents; held Back; held OK; the invite
  panel), and the pure `tests/remoteKeys.test.ts`, `tests/rowMove.test.ts`,
  `tests/homeShelves.test.ts`, `tests/identity.test.ts`. The availability check now scans every
  component that draws a title. Fourteen deliberate regressions (Up from the hero, the eager
  count, Back handling, the film page's bar, Left wrapping into another row, an extra lazy read, a
  seed not tied to its film, the grid ignoring a held OK, a replaced opener, the origin by exact
  path, Down on an empty page, the home unmounting under a film, the first landing reading a
  shelf, the grid's Back going to search) each failed the suite.
- An independent review in five areas (navigation, regressions, cost, tests, the brief's
  constraints), each finding checked by a second reviewer trying to refute it, confirmed twenty
  defects; all are fixed above, and seven findings were refuted.
- In a browser against the live project. At 1920×1080: the home with two `/api/catalogue` reads
  (`pageSize=12`), a third as focus reached the second shelf; a remote walk hero → shelves →
  spotlight → shelves with each row fully on screen; Back from four rows down to the bar at the
  top; a film opened from a shelf over the home with one `catalogue-title` read, closed back to its
  card with the home unmoved and nothing read again; Discover, Back from the grid to the bar; the
  registry and the create screen with the illustration and the steps; the bar legible over a
  film's backdrop. Measured every 50 ms while the home loaded, the hero and the first three shelves
  never changed height at 1920×1080 (605, 548.4), 1280×720 (466, 423.5), 960×540 (444, 487.8) or
  375×812 (440, 363.2). At 375×812: the home, the spotlight, Discover, a film page and the create
  screen (the illustration after the form), with no horizontal overflow and the bar fitting with a
  16px margin. No console errors from the app.
- **Not verified / known gaps:** nothing was run on a TV set, so the TV engines' own focus and key
  behaviour is unproven. Some sets open their on-screen keyboard when a field is focused by script,
  and Down from the bar on Discover focuses its search field. On webOS the app manifest must set
  `disableBackHistoryAPI` for the Back layering to receive the key. The Movie Jam forms are reached
  from the bar (Down lands on their first field) but are not arrow-navigable beyond it. The browser
  used for these checks does not turn a synthetic Enter into a click, one reason OK is handled by
  the app on the home, the bar and the grid.

## 2026-09-19 — Discover takes voice: press to talk through SLNG

- A **Speak** control sits left of the conversation field. From the field, Left reaches it; OK
  starts recording, OK again stops (20 s at most). While recording it turns red, counts down and
  shows a live level bar; while the microphone opens, OK again cancels. The recording is uploaded to
  `POST /api/voice/transcribe`, which sends it to SLNG and returns the **final transcript only**. The
  transcript lands in the field, focused, after anything already typed, and is **not sent**: the
  viewer reads it, corrects it and presses OK. A transcript therefore enters Discover through the
  exact path a typed message does, and the engine's grounding rule (every quote must be a literal
  substring of the message) applies to the text the viewer actually sent.
- Where SLNG sits: browser microphone → MediaRecorder (Opus/WebM, 32 kbps) → our same-origin
  endpoint (Supabase-verified viewer, rate limit, size and time bounds) → SLNG
  `https://us-east.api.slng.ai/v1/stt/slng/deepgram/nova:3-en` → transcript → conversation field →
  `POST /api/discover/turn` (Nebius) → engine → shortlist. The SLNG key is used only in
  `apps/server/providers/slng.ts`; a scan of every file in `dist/` found neither the key, its name,
  its `slng_cu_` prefix nor any SLNG host.
- Audio is the viewer's media contribution, for one purpose: the transcript. It stays in memory in
  the browser until uploaded and on the server for the length of the call, and is never stored or
  logged.
- Failure never blocks typing: refused permission, no microphone, a microphone that does not open
  within 15 s, no network, SLNG disabled, rejected or slow, and an empty transcript each end in a
  plain notice under the field and the idle control. Nothing is ever put in the field or sent unless
  SLNG returned words.
- Provider facts, checked on 2026-09-19 against SLNG's live `GET /v1/catalog/models` and the API
  reference: `slng/deepgram/nova:3-en` is SLNG-hosted in the US (east, west, central), Australia and
  India, not in the EU. Over HTTP, any request option makes the upstream model default to "latest",
  which it rejects (`400 The requested model (Some("latest")) was not found`); naming
  `model=nova-3-general` fixes it, so the adapter always sends it with `punctuate=true`.
- **Measurements (stage 1, HTTP), 2026-09-19.** Method: Google Chrome from a separate profile on
  this Mac, whose microphone was fed a speech clip (macOS `say`, six Discover requests, 1.1–2.7 s of
  speech with 0.4 s of silence before it and 1.5 s after) through Chrome's fake capture device; the
  page was driven by DevTools key events (Left, OK, wait until 0.5 s after the speech ended, OK),
  against `pnpm dev` and the live SLNG API. "Stop → transcript" is the app's own User Timing measure,
  from the OK that stops recording to the transcript arriving in the browser; "provider" is the
  server's own time for the SLNG call. The machine is in Barcelona and the model runs in us-east.
  - 15 runs, none failed outright: stop → transcript 600, 610, 697, 715, 734, 759, 794, 794, 799, 823, 843, 976,
    1,025, 1,038 and 3,185 ms — median 794 ms, mean 959 ms, 14 of 15 under 1.1 s. Provider 419–762 ms
    (median 509 ms), except the 3,185 ms run, whose provider call took 3,036 ms. The difference,
    about 150–300 ms, is the browser finishing the recording and the upload.
  - Transcripts were exact in 13 of 15 runs, including punctuation. Two runs of the first clip
    ("Something light and funny for a Friday night.") came back as "Something" and "Something like":
    both were the first launch of a batch, and the recording carried only 0.90 s and 1.02 s of audio,
    so the fake capture device stopped supplying sound; three reruns of the same clip captured
    3.24–3.30 s and transcribed it exactly. They are counted in the 15 above as runs, not as
    transcription errors.
  - Audio sent: 6,618–11,140 bytes for 2.0–3.4 s, **2.5–3.5 KB/s (20–28 kbps)**, Opus in WebM at a
    48 kHz capture rate, mono, requested at 32 kbps. Chosen because Opus holds speech clearly at that
    rate and is about an eighth of the 32 KB/s of 16 kHz 16-bit PCM, and because the browser's own
    recorder produces it, with no encoding code in the page.
  - A spoken turn end to end: "Something light and funny for a Friday night." was spoken into the
    page, transcribed in 2,134 ms (provider 518 ms; the rest went before the upload, most likely the
    page's first session check, which was not timed separately), sent with OK, accepted by the engine (Nebius acknowledged "Something
    lighthearted and funny for Friday night."), and narrowed Discover to 13,204 titles ranked by the
    assistant, with Comedy, Family and Romance active.
  - Cost: SLNG's published API price for `slng/deepgram/nova:3-en` is **$0.0065 per audio minute**
    (model catalogue, docs.slng.ai/models/catalog/speech-to-text). A typical Discover request is 2–4 s
    of audio, **about $0.0002–$0.0004 per spoken turn**, so 1,000 spoken turns cost about $0.33. This
    assumes per-second billing; SLNG does not state a per-request minimum. The live catalogue API
    reports `min_price: 41` `microdollars_per_min` for the same model, which disagrees with the
    published table; the published price is the one used here.
- Code: `apps/server/providers/slng.ts`, `api/voice/transcribe.ts`, `src/voice/`
  (`contract`, `recorder`, `voiceClient`, `voiceState`, `useVoiceInput`),
  `src/discover/VoiceButton.tsx`, the field and its Left key in `ConversationBar.tsx`.
- Verified: `pnpm test` (422/422, with `tests/voiceTranscribe.test.ts` and `tests/voiceState.test.ts`),
  `pnpm typecheck`, `pnpm build`. In the built-in browser pane, where microphone access is blocked,
  Speak showed "Microphone access was refused. Type what you want instead…" and the field kept
  working.
- **Known gaps:** no person has spoken into it yet; the audio came from synthesised speech through
  Chrome's fake microphone, so room noise, distance from a TV and accents are untested. The
  recorder, level meter and hook are checked in the browser, not by automated tests; their decisions
  (`voiceState`) are pure functions that are tested. The rate limit and concurrency cap are per
  instance.

## 2026-09-19 — Discover voice streams live partials through SLNG

- While the viewer speaks, what has been heard so far appears under the field ("Hearing · A scary
  film under two hours."), updating as they talk. Partials are **display only**: they never enter
  the field and are never sent. On stop, the stream's final transcript lands in the field exactly as
  stage 1's did, editable and not submitted.
- Path: the page taps the microphone into a 16 kHz audio context (AudioWorklet), sends 100 ms
  frames of 16-bit PCM over a same-origin WebSocket, `/api/voice/stream`, to our Node server, which
  checks origin, rate (20 connections a minute), concurrency (4), the viewer's Supabase token (first
  message, within 5 s), frame and total size, and relays the audio to SLNG's WebSocket
  (`wss://us-east.api.slng.ai/v1/stt/slng/deepgram/nova:3-en`) with the key on the server side only.
  SLNG's `Results` are validated with Zod; `is_final` segments make the transcript, interim ones only
  the display.
- Checked live on 2026-09-19, and not in SLNG's reference: this route accepts only `linear16`
  (`encoding must be canonical linear16 for this qualified STT provider route` for WebM/Opus), and
  rejects every control message the reference lists (`finalize`, `close`, `keepalive` each close
  the socket with 1008). So on stop the relay appends 700 ms of silence, and answers as soon as a
  result has heard past the point where the viewer stopped (`start + duration`), or SLNG marks
  `speech_final`, with nothing pending. If no final comes within 3 s, the stream fails.
- Fallback: the Opus recording from stage 1 runs alongside the stream the whole time, in memory. If
  the socket cannot open, drops, errors, times out, or returns no words, the recording is uploaded
  to `POST /api/voice/transcribe` and the viewer loses nothing. Vercel functions cannot hold a
  WebSocket, so a deployed build takes this upload path; the live stream needs the Node server
  (`pnpm dev`, `pnpm start`, the Docker image).
- **Measurements (stage 2, streaming), 2026-09-19.** Same method, clips and machine as stage 1.
  - 15 runs: stop → transcript in the field 104, 166, 167, 232, 239, 247, 252, 259, 259, 271, 295,
    299, 320, 326 and 2,136 ms — **median 259 ms**, 14 of 15 under 330 ms (stage 1's median was
    794 ms). The server's own stop → final was 92–319 ms (median 234 ms) in all 15, including the
    2,136 ms run, whose extra time was spent in the browser and was not isolated.
  - **Time to first partial**: 1,212–1,401 ms from the start of recording (median 1,245 ms). Each
    clip starts with 0.4 s of silence, so that is about 0.8–1.0 s after the first word. The server
    measured 1,094–1,282 ms from the first audio frame it received.
  - Transcripts were exact in 13 of 15. The two others were the first clip in each batch, where the
    fake microphone again delivered only 0.94 s of audio (30,208 bytes); the relay transcribed what
    it got ("Something"). Punctuation can differ from HTTP: "A scary film under two hours. Please."
  - Failed runs: the first streaming run after a server restart, before the endpoint rule above
    existed, received no results from SLNG; the stream answered empty after 3 s and the upload
    fallback put the full sentence in the field 3,897 ms after stop. Not reproduced in 17 later runs.
    Forced faults in the page: a socket that never opens → upload, full sentence, 970 ms; a socket
    closed 1.5 s into recording → upload, full sentence, 566 ms.
  - Audio sent: **32,000 bytes a second** (16 kHz, 16-bit, mono linear16; 98,304 bytes for a 3.07 s
    recording), about ten times the Opus upload, because this route accepts nothing else. 16 kHz is
    the rate the model is tuned for and the lowest that keeps speech intelligible to it.
  - A streamed turn end to end: "A scary film under two hours. Please." — three partials on screen
    while speaking, the final in the field 271 ms after stop, sent with OK, accepted by the engine,
    Discover narrowed to 3,902 titles, Horror and Under 120 min, ranked by the assistant.
  - Cost: the same published $0.0065 per audio minute (SLNG's table gives one price per model). A
    streamed request is the recording plus 0.7 s of appended silence, 3–4 s for a typical request,
    **about $0.0003–$0.0004 per spoken turn**. A turn that falls back pays for both.
- Code: `src/voice/{streamProtocol,streamClient,pcmCapture}.ts`, `apps/server/voiceStream.ts`
  (attached to the Node server in `apps/server/index.ts`), stream parsing and `hear` in
  `apps/server/providers/slng.ts`, `streamedAnswer` in `voiceState`, and the partial line in
  `ConversationBar`.
- Verified: `pnpm test` (435/435, with `tests/voiceStream.test.ts` driving the relay over a real
  local socket against a scripted SLNG), `pnpm typecheck`, `pnpm build`; the rebuilt `dist/` again
  contains no key, key name, key prefix or SLNG host.
- **Known gaps:** as in stage 1, no person has spoken into it; synthesised speech through Chrome's
  fake microphone only. The streaming path cannot run on Vercel. The 0.94 s capture on a cold
  browser launch is attributed to the fake device, not proven.

## 2026-09-19 — Subtitle and audio-description availability (slice 11)

Metadata only: no subtitle file or text is fetched, stored, shown or given to a model.

- **Schema.** `supabase/migrations/20260919234000_catalogue_title_accessibility.sql` adds the
  companion table `catalogue_title_accessibility` (`subtitle_languages text[]`, `subtitle_count`,
  `subtitle_checked_at`, `subtitle_source`, `has_audio_description boolean`,
  `audio_description_source`, `audio_description_checked_at`) and extends `get_catalogue_title`
  with a left join. Null = never checked / unknown, `'{}'` = checked and none found. Check
  constraints keep each answer whole and sourced. Read-only to `authenticated`. **Not applied yet:
  Sergio applies it.**
- **Film page.** The facts list gains "Subtitles" ("14 languages", or up to three named) and
  "Audio description: Available". Not checked, checked-none, and a sourced no all render nothing.
- **Backfill.** `pnpm backfill:accessibility subtitles | audio-description | sql`
  (`apps/backfill/`). Offline, resumable through JSONL ledgers in the ignored `.backfill/`, and it
  logs each skip with its reason. It holds no write credential: `sql` emits one upsert file for the
  database owner to apply. A test fails if `api/`, `src/` or `apps/server/` imports it.

### What was checked, and what the sources actually returned

- **Catalogue join key.** Read as an anonymous viewer: 27,839 titles, 27,796 with a usable
  `imdb_id`, 43 without. Those 43 can never be checked and keep no row.
- **OpenSubtitles.** The docs (opensubtitles.stoplight.io: Getting started, Best practices, Search
  for subtitles, Search for features, API subscription prices, Subtitle exports) say: an
  `Api-Key` and a named `User-Agent` on every request. 5 requests per second per IP, 40 per 10
  seconds on `/features`. Search is unlimited, and only `/download` has a quota (5 per IP per
  24 h without a user; free search results are cached 24 h). The client builds no URL except
  `/features?imdb_id=N`, paced 400 ms apart. Unauthenticated probes returned `401 No API KEY in
  request` for `/features`, and `403 You cannot consume this service` for an uncached
  `/subtitles`. The Matrix `/subtitles` answer arrived only as a Cloudflare cache hit: 839
  subtitles, 17 pages. That is why `/features` (one request, with per-language
  `subtitles_counts`) is used instead. The opensubtitles.com terms page sits behind a bot check
  and was **not read**. **No OpenSubtitles backfill has run: there is no `OPENSUBTITLES_API_KEY`.**
  The `/features` parsing follows the documented response and is unit-tested. It has not been seen
  against a live authenticated response yet.
- **Audio Description Project.** There is no API or export. `adp.acb.org/adp-search` is a public
  HTML table (robots.txt does not exclude it), 50 rows a page, with an IMDb link and providers per
  row. The full "Movies Only" crawl ran on 2026-09-19: 202 of 202 pages, 8,156 distinct IMDb ids,
  one page every 3 s. Joined to the catalogue, that gives **4,304 sourced yeses of 27,839 films**,
  59 of the 100 most popular. Spot checks: Inception, The Matrix, Birdman, War of the Worlds and
  Zombieland are listed (Apple TV Store, Prime Video, HBO Max, and others). Parasite and Spirited
  Away are not listed, so they stay unknown. The source never yields a no, so nothing is written as
  `false`.
- **Verified against a throwaway local Postgres 17** (stub roles plus the real catalogue ids, not
  the hosted project): the migration applies and reapplies. The generated file (4,304 upserts)
  applies and reapplies idempotently. `get_catalogue_title` returns the film's own row with the
  three states distinct. Half-answers, bad codes, contradictory counts, an unsourced AD value,
  writes by `authenticated`, and calls by `anon` are all refused. This check caught a real bug
  before hand-off: an unqualified `title_id` parameter was shadowed by the joined column and
  returned an arbitrary film. It is now `get_catalogue_title.title_id`, with a test.
- `pnpm test`, `pnpm typecheck` and `pnpm build` pass.

Still to do for "done": (1) apply the migration; (2) apply
`.backfill/accessibility/accessibility-upserts.sql` as the database owner (psql, or the SQL
editor); (3) create an OpenSubtitles API consumer, set `OPENSUBTITLES_API_KEY`, run
`pnpm backfill:accessibility subtitles --limit 50`, check the ledger, then run it in full (about
3 h at 2.5 req/s) and re-emit and apply the SQL; (4) open a sample of film pages to see the
facts. The ADP directory is newest-first, so re-crawl it by deleting `adp-pages.jsonl`. Pages
shift while it grows.
## 2026-09-19 — Next-increment target functionality specified

- Four capabilities that the product intends and the code does not have are now specified as
  target documents under `docs/specs/`, each opening with an explicit
  "Status: intended, not implemented" line: the versioned transactional scene contract
  (`transactional-scene-contract.md`), script version lines and chat-driven editing
  (`script-forking-and-chat-editing.md`), the session-as-room-seat unification
  (`session-as-room-seat.md`), and multimodal contributions as creative turns
  (`multimodal-creative-turns.md`).
- The through-line is that nothing gains a second authority path. A reference becomes a story
  input only by being attached to a proposal; a fork changes the shared script only by being
  adopted; both land through the same command envelope as scene acceptance
  (`expectedStateVersion`, idempotent `requestId`, serialized commit), and all of them are
  refused with `portion_locked` where they would touch a played or locked portion.
- The beat lock window is the constraint these specs are written around rather than against: a
  fork may edit any beat, and may not always be adopted; an accepted turn is an edit like any
  other; structural edits stay forbidden because `portionIndex` is the single address shared by
  script edits and the director's beats, so renumbering would re-aim every open stream's
  boundary. After RV-16 the window comes from the live director's position on the script clock
  (`src/core/directorBeats.ts`) rather than a portion cursor — the rule is unchanged, its source
  is not, and it is enforced for the first time: the predecessor guard defaulted to "everything
  editable" and was never wired, so `portion_locked` could not previously fire.
- `docs/specs/intended-vs-implemented.md` gains seven rows and cross-links, `docs/API_CONTRACTS.md`
  gains the planned fork, chat and reference routes plus the vote/accept RPC shape, and
  `docs/STATE_MACHINE.md` now marks the scene lifecycle as wholly unimplemented and the
  media-reference lifecycle as live-only.
- Reconciled against every active workstream before landing, which corrected three claims. The
  scene contract now opens with a **prerequisite**: its atomic commit crosses two systems, because
  `jam_proposals` is in Postgres while the script (`InMemoryJamStore` is the only `JamStore`;
  nothing reads `jam_scripts`), the playback cursor and `withJamLock` are all in the Node process
  — so the acceptance path must not be built, or called atomic, until one of three named exits is
  chosen. Voice is no longer described as missing: the SLNG speech-to-text adapter exists and is
  Discover-scoped, so the jam room needs room-scoped commands and an attachment path, not a
  provider. And the live-media exclusions are now explicitly about participant media travelling
  inward, distinct from a generated stream travelling outward to viewers.
- The scene contract's scope is now drawn where the product draws it: **any modification to the
  history triggers a refactor downstream, and modifications are made from one centralized place**,
  which the product's other elements interact with. There are several ways to edit it — up and
  down votes on parts of the future, chat, polls, direct rewrites — and defining those ways is
  other efforts' work. So the contract owns the envelope (`expectedStateVersion`, idempotent
  `requestId`, serialization, the atomic commit) and the gate (authorization, and refusal at the
  lock boundary); `docs/specs/story-outline.md` owns what a modification is and how it cascades;
  and voting appears only as one mechanism among several, shown for what the envelope must carry
  rather than as the way the product decides. Centralization is what lets the envelope, the
  version counter and the lock boundary be written once instead of per mechanism.
- Also recorded there, and now a register row of its own: `withJamLock` is an in-process mutex, so
  the serialization protecting portion edits and reverts is correct in the local Express host and
  silently insufficient the moment those routers deploy as Vercel functions, where each instance
  holds its own map. Deleting the portion pipeline narrowed this gap without closing it — the
  playback compare-and-swap it guarded is gone, but the mutex still wraps the two mutations the
  lock boundary protects. Relatedly, `JamStore` no longer holds a compare-and-swap of any kind,
  so `expectedStateVersion` has to be built rather than adopted.
- **Documentation only.** No application code, test, migration or provider call was added or
  changed in this slice, and nothing here is a claim that any of it works.

## 2026-09-19 — A public landing page at `/`

- `/` is the public landing: Hero, Director (next), Movie Jam, Discover, Community (next), the
  loop and a closing call to action, in that order. The app's own home moved to `/home`
  (`HOME_PATH`); Discover, film pages, the conversation and Movie Jam are unchanged, and their
  "back" actions now land on `/home`. Every "Open Reverie" and "Ask it what to watch" opens
  `/discover`; "Start a Movie Jam" opens `/jams`. Director and Community say "Next · not yet
  available" and have no button. Community's two shorts are invented illustrations, drawn as
  "Generated" tiles and never with a poster. The TMDB attribution is in the footer. The only
  figures are 27,839 films and "built over one weekend", plus the illustrations' own counts.
- The posters are real catalogue titles, chosen when the app is built. A landing visitor has no
  session and `catalogue_titles` is readable only by signed-in viewers, so the build signs in
  anonymously with the public anon key, as any browser opening Discover does, and reads through
  `fetchCatalogue`, the adapter behind `/api/catalogue`, under unchanged RLS. No key is exposed and
  no policy changed; each build creates one anonymous user. The shelf is the twelve most popular
  titles without horror or thriller, the Community pair the next two, and the Discover
  illustration's four picks the "gentle" shortlist (drama or family, without horror, thriller,
  crime, war, action, science fiction or mystery). Only genres are filtered; no film is chosen or
  refused by name.
- `/` is static HTML. The build renders `LandingPage` to markup and writes it as `dist/index.html`
  with one 3.4 KB stylesheet and no script, and moves the app's shell to `dist/app.html`, which
  `vercel.json` and the production Express server serve for every other path. In development, and if
  the app itself ever reaches `/`, `main.tsx` renders the same component, loaded lazily so no other
  screen downloads it. Posters sit in 2:3 frames with their size stated, so nothing moves when they
  arrive.
- Fonts are self-hosted latin subsets of exactly the faces the page uses: Instrument Serif 400
  roman and italic, DM Sans limited to weights 400–600 with its optical size kept (62 KB to 34 KB),
  and JetBrains Mono 400. 85 KB from the page's own origin instead of 114 KB from Google's two.
  Their OFL licences sit beside them in `src/landing/fonts/`.
- Without a readable catalogue the build warns and the page renders without its poster rows. On
  Vercel (`VERCEL=1`) the build fails instead: a deployed landing must show real films.
- Code: `src/landing/` (the page, its sections, `films.ts`, `landing.css`, `prerender.tsx`,
  `LandingRoute.tsx`), `scripts/landing-films.ts` (the build-time read), `scripts/landing-plugin.ts`
  (the virtual module and the static page), `landing` and `/home` in `src/lib/routes.ts`.
- Verified: `pnpm test` (432/432, including `tests/landingFilms.test.ts`,
  `tests/landingBuildFilms.test.ts`, `tests/landingPage.test.ts` and `tests/routes.test.ts`),
  `pnpm typecheck`, `pnpm build`; the build read the live catalogue in about a second. Measured in
  Chrome, element by element: at 1920×1080 the page is 5,458 px tall; at 375 px nothing overflows,
  the header stays one line and stays stuck while scrolling, and all 18 posters load at 342×513 into
  frames already that shape. On a throttled phone profile (150 ms RTT, 1.6 Mbps, 4× CPU, 375×812,
  cold cache, median of seven): first and largest contentful paint 744 ms, and layout shift 0.013;
  the same layout with its fonts loaded from Google painted at 960 ms with a shift of 0.024.
  "Open Reverie" reaches Discover; Discover's Movie Jam button reaches `/home`; a build without
  Supabase warns and one with `VERCEL=1` fails.
- Two layout choices worth knowing: below 440 px the header's in-page "Discover" link is hidden,
  because brand, link and button need about 390 px and the button would otherwise wrap onto two
  lines; and the page clips horizontal overflow with `overflow-x: clip`, because `hidden` would
  stop the sticky header from sticking.
- **To confirm (page copy):** the Discover illustration shows a "Gentle ×" chip,
  but Discover has no mood chips (it filters by genre, runtime and era); and the Movie Jam copy
  lists voice-note, image and clip turns, while a turn today is a text proposal or the live camera
  stage. **Known gaps:** the catalogue's popularity order surfaces softcore titles in several
  decades, which is why the shelf filters by genre; the posters change only when the app is
  rebuilt; the remaining layout shift is the web-font swap (preloading the fonts removed it but
  delayed the first paint by about 250 ms); not yet deployed to Vercel from here.

## 2026-09-19 — Finding something to watch is one conversation, at `/search`

- **Routes now.** `/` home · `/search` search (new) · `/discover` and `/discover/` → replaced by
  `/search` on arrival (history record kept), no longer a browsing surface · `/discover/:id` film
  page, unchanged address, drawn over whatever opened it (the home, or search; over an empty search
  when reached by URL, and closing it then replaces it with `/search`) · `/jams` · `/jams/new` ·
  `/join` · `/jams/:slug`. `movedPath` in `src/lib/routes.ts` is the redirect rule, and
  `screenFromPath` resolves a moved path to the screen it moved to. The API routes are unchanged.
- **The top bar** is Home · Search · Movie Jam. Search replaces Discover as a destination and
  carries the lens beside its name; the separate search icon is gone. Choosing Search from
  anywhere lands in the field (closing a film page opened from search first, as before). Back
  from search goes to the bar, then home.
- **At rest** the screen is one line ("What do you feel like watching?"), the voice control and
  the field. Nothing else: no films, no filters, no send button until something is typed, and no
  catalogue read until the viewer sends something or speaks. Typing alone previews nothing; a
  spoken request previews posters while it is being said (below).
- **A turn is a block**: the viewer's message, the reply, and a row of up to twelve posters under
  it, with a caption saying whose order it is ("Ranked by the assistant", "Ranked by genre match",
  "Title matches") and how many films matched. A refinement appends a block. Earlier blocks keep
  the films they showed: the transcript (`src/conversation/transcript.ts`) now numbers turns, and an
  assistant line carries its turn's result set as a snapshot that `attachResults` never replaces.
  The six-line cap is gone; the transcript keeps the last 20 turns, dropping the oldest turn whole.
  Each waiting turn prepares its own films (`TurnFilms`) for the state its reply left: a filter
  changed, or another message sent, while they are read and ranked changes nothing about that
  turn. When its filters are the ones in effect it shares the live read instead of making its own.
  A ranking that fails or times out leaves the scorer's order, captioned with the reason.
- **One field, no modes.** `messageIntent` (`src/search/intent.ts`) looks a message up as a title
  when it reads like one (at most six words, no question mark, nothing that frames a request such
  as "I want" or "something", and no genre, running time or era heard in it); everything else goes
  to the assistant. A lookup reads `/api/catalogue` with the words as the query and no filters,
  and answers "Here's what I found for “…”." with what it found. A lookup that finds nothing sends
  the same message to the assistant. Known trade-off: a title made of genre words ("Scary Movie")
  is sent to the assistant, which narrows by genre.
- **Filler never fires.** `carriesRequest` (`src/search/filler.ts`) is false for hesitation and
  framing alone ("um", "I want", "something", a bare "or"), for a short answer ("yes", "neither")
  unless the assistant is waiting on a question, and for a number word straight after "want" or
  "like", which is how the live speech service hears a trailing "or" ("I want four"). Filler
  typed and sent says "Say a little more…" and sends, reads and asks nothing; a spoken final that
  is filler is not put in the field.
- **Voice** is the same pipeline (endpoint, SLNG adapter, relay and upload fallback unchanged).
  What changed is the screen:
  - The control is an inline SVG icon, with no words and no countdown: a microphone at rest, a
    red stop square with a red level halo while recording, dimmed while the microphone opens or
    the transcript finishes. `voiceName` gives the accessible name for each state.
  - While the viewer speaks, a pending line appears in the conversation and fills with the partial
    transcript. Partials are merged by overlap (`mergePartial`, `src/voice/partialMerge.ts`): a
    partial is trusted from where it begins, what came before is kept, a word cut short is
    finished, and a fragment already shown changes nothing, so words are never doubled.
  - Genres, a refusal, a running time and an era heard so far appear as chips while the viewer is
    still speaking (`detectPreferences`, a literal word list), and a row of posters previews
    against them laid over what is already narrowing (`previewFilters`, one debounced catalogue
    read per change of what was heard). Nothing heard in filler, so filler previews nothing.
  - On stop, the final transcript goes in the field, focused, and the pending line stays up as
    "Not sent yet", mirroring the field until it is sent or cleared. It is never sent for the
    viewer. Partials are display only: only a sent final ever reaches the assistant, and the
    engine's literal-quote grounding applies to it unchanged.
- **Filters are their own surface.** A Filters control in the strip (shown once a turn has
  happened) opens a panel with every genre but TV Movie, six eras and three running times, as
  plain filters (`FILTER_GROUPS` in `src/catalogue/refinements.ts`, grounded in their own words
  and applied through the engine like the old chips). The panel shows the live count and the
  matching films, ordered by the scorer, so toggling a filter costs no model call. Choosing a
  filter says nothing in the conversation and rewrites no turn's films; the next turn composes
  with it. The strip beside the field shows everything narrowing the results, each removable,
  with the live count and "Start over".
- **A film's preview.** Selecting a poster (click, OK, or a mouse resting on it for 650 ms, never
  on focus) opens a modal over the conversation: backdrop, poster, title, year, running time, score
  (from the film's single detail row, which fills in when it arrives), genres and synopsis. No record
  in the catalogue carries accessibility flags, so none are shown. It traps focus, closes on Back
  or Escape and returns focus to the card. Its two actions: **Open the film page** (the film's
  page, and Back returns to the card) and **Start a Jam from this** (`/jams/new` with the title
  "Inspired by <film>" and a premise opening on the synopsis's first sentence, `jamSeedFrom`).
  Nothing offers to play or stream a catalogue film. The hover rule is pure (`createDwell`): only a
  mouse or pen that actually moved, a fresh wait per card, and a card whose preview just closed
  stays quiet until the pointer leaves it.
- **Remote navigation** follows the app's axis rule through `rowMove`: Up and Down move between
  turns' poster rows, the strip and the field, landing on the item last focused in each row;
  Left and Right move along a row. Up from the first row reaches the bar; Down from the bar lands in
  the field. OK presses the focused control once, handled by the app. Back from anywhere on the
  page goes to the bar; in the field, Escape first clears what was typed.
- **Removed**, because `/search` absorbs them: `DiscoverScreen`, `ConversationBar`,
  `RefinementBar`, the endless-grid feed (`pageFeed`, `useCatalogue`) and grid navigation
  (`gridMove`, `useGridNavigation`), with their tests (`gridNavigation`, `pageFeed`,
  `discoverCopy`) and the grid's styles. The film page, artwork, attribution, status panels and
  catalogue client stay in `src/discover/`. `useConversation`, `useAssistantRanking`,
  `useRefinement`, `useVoiceInput` and `VoiceButton` are reused, not copied: the conversation hook
  gained the lookup and snapshot attachment, the two assistant calls read from an
  `AssistantProvider` a test can replace, and the voice hook merges partials.
- Code: `src/search/` (`SearchScreen`, `SearchTranscript`, `ResultRow`, `ResultCard`,
  `FilmPreview`, `FilterPanel`, `NarrowingStrip`, `PendingVoice`, `Composer`, `TurnFilms`, `search.css`, the pure
  `words`, `filler`, `intent`, `detect`, `dwell`, `jamSeed`, `results`, and the hooks `useSearch`,
  `useShortlist`, `useVoicePreview`, `useHoverPreview`, `useRows`).

### Verification

- `pnpm test` 611/611 (554 before; 25 grid-only tests removed with their modules), `npx tsc
  --noEmit` clean, `pnpm build` passes. New tests: `tests/partialMerge.test.ts` (the overlap merge,
  including every two-piece cut of a sentence and every growing prefix), `tests/searchRequest.test.ts`
  (the filler predicate, the lookup-or-conversation decision, preference detection and preview
  filters), `tests/transcript.test.ts` (turns, the turn bound, snapshots never replaced),
  `tests/previewDwell.test.ts` (the dwell rule and the Jam seed), filter groups in
  `tests/refinements.test.ts`, routes and Back parents, and `tests/search.dom.test.tsx`, which drives
  the whole app over a test catalogue and a test assistant whose turns go through the real engine:
  no film and no read before the first request; a title answered by a lookup without the
  assistant; a lookup that finds nothing sent to the assistant; a request answered with the
  assistant's ranked posters; a refinement appending a block while the first keeps its posters;
  filler firing nothing; remote navigation between turns and rows; the preview opening on OK but
  never on focus or a held OK, trapping focus, closing on Escape and on key code 461 with focus
  back on its card, opening the film page and returning to the card, and starting a Jam with the
  seeded title and premise; the filter panel narrowing without saying anything in the
  conversation; `/discover` landing on `/search`; a turn keeping the films for its own state when a
  filter comes off while they load, and two turns each getting their own films when the second
  message goes before the first's are ready (both fail when a turn is given the current state
  instead, checked by making that change).
- An independent review of the diff found that a filter removed while a turn's films were loading
  changed what that turn attached, and that a message sent before a turn's shortlist arrived left
  it with no films; both are fixed above and covered by those two tests. It also flagged the voice
  preview reading the catalogue before any message is sent, which is the intended behaviour: the
  preview follows what is said, and nothing is read for typing alone.
- In the built-in browser at 1920×1080 against the live project and Nebius: the resting screen; a
  typed "something funny for a Friday night" answered and ranked by the assistant (9,942 films,
  Barbie, Elemental, The Super Mario Bros. Movie as picks); "a scary film under two hours" then
  "from the nineties please" as two blocks (3,902 then 311 films, Scream, Bride of Chucky, Child's
  Play 2). In that run, made before each turn prepared its own films, the first block's row kept the
  scorer's order because its ranking had not returned when the second message went; with
  `TurnFilms` it keeps waiting for its own ranking instead. A later turn whose ranking timed out at the
  provider showed the scorer's order captioned "Ranked by genre match · 3,659 films — The assistant
  did not answer in time." Remote walk between rows; the preview by OK (The Nun II,
  "2023 · 1 h 50 min · 6.5 / 10"), Escape back to the card, its film page at `/discover/968051` with
  Search current in the bar, Back to the card with both turns kept; the filter panel by remote
  (1,345 films for horror-comedies from the nineties under two hours) and back to Filters with the
  transcript unchanged; "Start a Jam from this" filling the form. At 375×812: no horizontal overflow
  at rest or after a lookup ("Inception" first of three title matches). One live message ("actually
  from the nineties") was answered `unavailable` by the unchanged assistant path; the page said so.
- **Spoken into it**, in Google Chrome (separate profile) with synthesised speech (macOS `say`) on
  Chrome's fake microphone, driven by DevTools key events (Left to the microphone, OK, OK), against
  `pnpm dev` and the live SLNG stream. The fake microphone could only read the clip with Chrome's
  audio-service sandbox off (`--disable-features=AudioServiceSandbox`); with it on, Chrome logs that
  it cannot read the file and the page, correctly, said "Nothing was heard."
  - "Um, I want something… something funny, from the nineties.": recording at 0.9 s; the pending
    line read "I want something." at 3.2 s with no chip and no posters (filler); "I want something.
    Something funny." at 4.6 s with a Comedy chip, not a doubled "something"; preview posters
    (Barbie, Elemental) at 5.2 s; "… From the nineties." at 6.5 s with Comedy and 1990s and the
    preview redrawn (Forrest Gump, Toy Story). On stop the final was in the field, focused, "Not sent
    yet", zero turns, and still zero 1.7 s later; OK sent it; answered "A funny film from the
    nineties, got it.", ranked by the assistant, 1,209 films, Toy Story, Toy Story 2, Hercules as
    picks. First partial 2.4 s after recording started; stop → final 3.0 s (the relay waited out its
    final timeout on this clip, which ends in six seconds of silence).
  - "Um… I want… uh… or…": the service dropped "um" and "uh" and heard "I want four."; no chip, no
    preview; before the number rule it was put in the field and sent, after it nothing went in the
    field, the page said "Say a little more…", zero turns.
  - After a typed "a thriller": "Nothing scary, and under two hours please." filled the line word
    by word, No Horror at 11.6 s, a preview of thrillers without horror at 11.9 s, Under 120 min at
    12.5 s; stop → final 286 ms over the stream; not sent until OK; answered "No horror, and under
    two hours — got it." as a second block (3,301 films) with the first block unchanged.
- **Not verified / known gaps:** a person has not spoken into it; the speech was synthesised and fed
  through a fake microphone. Nothing ran on a TV set. The hover-to-open is unit-tested and wired to
  pointer events but was not exercised with a real mouse dwell in a browser. The voice parts of the
  screen (pending line, chips, preview) are covered by the pure functions' tests and the Chrome runs,
  not by DOM tests, since jsdom has no microphone. The engine's twelve-turn cap counts filter toggles
  too, so a heavy filter session hits "That is as much as one conversation holds" sooner. The
  `docs/user_journeys/01-discover-and-navigation.md` runbook still describes the grid in its
  sections B and C; it is marked as such until it is rewritten for `/search`. Removing a filter while
  a turn's films load was tried live but the assistant was timing out at the time, so the removal
  landed while the reply itself was in flight; that case is covered by the DOM test only.

## 2026-09-19 — The story outline: a centralized artifact the room steers (RV-17)

- An **outline** sits between the script and the reader: one brief phrase (a **beat**) per
  portion, ordered and coherent, so a participant sees what is coming without reading four
  minutes of screenplay. It is called the outline, not "history", because `scriptHistory.ts`
  already owns that word for the revision log.
- It is centralized because the product goal is **several ways to modify the story** — up/down
  votes on future beats, chat, polls, direct rewrites, and more later. Each is an **input
  adapter** producing one typed intent (`set` or `reroll`) against one beat; validation, locking,
  serialization, the script rewrite and the cost all happen once behind a single boundary instead
  of once per mechanism. Rationale and the full decision set are in
  `docs/specs/story-outline.md` and `docs/DECISIONS.md`.
- A beat is the portion's own `summary` field, not a parallel store, so it cannot drift from the
  portion it describes and versions with the existing append-only revisions for free. The flat
  portion index stays the single address shared with edits, playback, the lock window and
  generation job keys. `summary` is optional: revisions written before the outline can never gain
  one and must be rendered honestly as missing.
- Editing a beat re-derives every later beat in **one** completion (not one per portion), rewrites
  text only — never `durationSeconds`, so the runtime cannot drift — and never changes scene or
  portion structure. The lock window applies unchanged; because it is a prefix and a cascade runs
  forward, only the edited beat needs checking. A cascade is computed outside the per-jam critical
  section and committed atomically inside it, refused with `portion_locked` if playback advanced
  into its range meanwhile.
- The same beat is the live director's direction text (RV-16's `DirectionRequest`), so one edited
  phrase drives both the rewritten script and the stream. Only the current or imminent beat is
  sent; the queue never opens or holds a billed director session.
- Implemented and verified locally on `codex/rv-17-story-outline`: the `summary` field, the
  outline projection with cumulative offsets, stream-offset lookup, and the cascade prompt, schema
  and application — all provider-free and tested offline. `pnpm typecheck` clean, `pnpm test`
  426/426 including 9 new tests.
- **Not implemented:** the edit queue, the edit intent type, provider wiring, every input
  mechanism (direct, vote, poll, chat), the outline routes, the client surface, and delivery into
  the director seam. No provider call has been made for a cascade, so cascade quality is specified
  and unit-tested at its pure boundaries, not demonstrated.

## 2026-09-20 — One integration path for everyone (RV-20)

Delivery now has a single rule instead of two: rebase onto the latest `main`, push the branch,
open a PR, merge the PR. The previous split between a "primary agent" pushing directly and a
"collaborating developer" going through PRs is retired — see `docs/DECISIONS.md` for why. `AGENTS.md`,
`docs/CONTRIBUTING.md` and `README.md` are updated; no code changed.

## 2026-09-20 — The outline is real: beats born with the script, a serialized edit queue, a panel to steer from (RV-22)

- **Beats at creation.** The scriptwriter asks for a `summary` per portion in the one script
  completion; any portion still without one is filled by a single fill-in completion over the
  whole script (`src/core/outlineSummary.ts`, `apps/server/outlineWriter.ts`), refused on a count
  mismatch. Imports get the same fill-in when a provider is configured, under the generation gate.
  `POST /api/jams` answers `outline: { complete }`; a missing beat is shown as missing, never
  invented.
- **The edit queue** (`apps/server/outline.ts`): `POST /api/jams/:id/outline/edits` admits one
  `set` or `reroll` edit per request (`src/core/outlineEdit.ts`), idempotent on `requestId`,
  refused at admission with `portion_locked`, `stale_state_version` (`expectedRevision` behind),
  `queue_full` (10 waiting) or `generation_disabled`. One worker per jam drains a FIFO: the
  cascade completion runs outside the lock, then `JamStore.commitScript` lands every portion as
  one revision inside `withJamLock`, guarded by the boundary and the base revision. The ledger
  (last 50 per jam) is readable at `GET /api/jams/:id/outline/edits`.
- **Serialization decision recorded** in `docs/DECISIONS.md`: the jams router, the queue and the
  director are one container process, so the per-jam critical section is real. The
  cross-instance row in `docs/specs/intended-vs-implemented.md` is closed as a deployment
  constraint rather than left unowned.
- **An ended room's story is frozen.** Now that a jam carries a lifecycle, an edit to an `ended`
  room is refused `jam_ended` at admission, and one already queued when the room ends fails with
  the same code rather than rewriting a film that was already shot.
- **Delivery to the director.** After a commit the edited beat's phrase is sent as a direction
  carrying `beatIndex`, but **only to a stream whose next beat it is** (`minEditableBeatIndex`):
  a direction steers what the provider generates next, so sending a distant beat would render it
  out of order rather than schedule it. The consequence, stated rather than hidden: a beat edited
  further ahead never reaches an already-open stream, because the script went to the provider once
  at session open and nothing re-sends it. Refusals and skips are recorded on the edit and never
  fail it. No session is opened for delivery, and a direction adds no charge to a session already
  billing for time.
- **Client.** `OutlinePanel` on the script screen and in the Studio: beats with played /
  generating / editable state, "Rewrite" and "Not this" on editable beats, the ledger, and honest
  "no beat yet" and "no script on this server" states. `GET /api/jams/:id/outline` also returns
  the current script so the screenplay under the panel follows the revision the beats describe.
- **Verified offline:** `pnpm typecheck` clean, `pnpm test` 787/787 (58 new, covering the edit
  schemas, the fill-in, both provider retry loops, the queue's ordering, idempotency, lock and
  stale-revision refusals, queue limit, worker recovery, direction delivery, the store commit and
  the panel), `pnpm build`. Also exercised against the real local host with providers off: an
  imported jam answers `outline.complete: false` with every beat honestly missing, `GET
  /api/jams/:id/outline` serves the beats with nothing locked and no stream open, an edit is
  refused `503 generation_disabled`, a command without a `requestId` is refused `400`, and an
  unknown jam is `404`.
- **Probed live on 2026-09-20**, against the local Docker stack (`docker compose up --build
  --wait`, `reverie-local`) with Nebius configured from `.env.local`. This is the first cascade
  this repository has ever run against a model:
  - **Beats arrive with the script.** `POST /api/jams` (generate, default 20s/5s format) answered
    `201` in 4.1s with `outline: { complete: true }` and a phrase on all four portions — so the
    scriptwriter's `summary` request is honoured in the same completion and the fill-in call was
    not needed.
  - **A `set` edit cascaded coherently.** Rewriting beat 1 to "he loses his lantern in the
    current" landed as revision 2 in 2.0s. Beat 0 was untouched, all four durations were
    unchanged, and the tail re-derived *around the loss*: the next beat became "Finds door by
    faint bioluminescence". That the model reasoned from the removed lantern is the coherence the
    cascade exists for, observed rather than assumed.
  - **A `reroll` replaced a rejected beat.** "He finds a barnacled door standing upright" with the
    reason "too predictable" became "He spots a human figure motionless on the seabed", and the
    tail followed, in 2.6s.
  - **The envelope held.** A replayed `requestId` answered `200` with the same edit id and
    `landed` rather than editing again; an edit carrying `expectedRevision: 1` against revision 3
    was refused `409 stale_state_version` with the current revision attached; the ledger listed
    both landed edits newest first.
- **Still not verified:** delivery into a live director stream. No director session was opened, so
  nothing was sent to a provider that bills by the second and `direction` read
  `{ sent: 0, refused: 0, skipped: 0 }` throughout. The lock window was therefore open the whole
  run (`minEditableBeatIndex: 0`), so `portion_locked` was not exercised live. The route
  authorization gap is unchanged: no script or outline route on the Express host checks the
  caller.

## 2026-09-19 — The director stream is delivered live to the whole room (RV-19)

- The shared stream is now watchable while it runs. A session serves an HLS playlist and fMP4
  segments (`playlist.m3u8`, `init.mp4`, `segment/:n.m4s` under
  `/api/jams/:id/director/session/:sessionId`), so every viewer on a configuration reads the same
  plain HTTP addresses. Segments are immutable and cacheable; the playlist never is. A second
  viewer costs a cache hit rather than a second paid session, and no viewer holds a socket.
- **The peer had been offering VP8 only, and nothing had noticed.** werift 0.24.4 defaults to VP8
  alone, and the director built a bare `RTCPeerConnection`, so fal could never have sent H.264
  whatever it supports. That matters because werift's `Mp4Container` carries `avc1` and `opus` and
  nothing else. The offer now carries both codecs and prefers the one its selected container can
  mux — H.264 for HLS/fMP4, VP8 for recording-only WebM. A codec the active muxer cannot carry
  produces a typed `unsupported_codec` and no segments, never an undecodable playlist.
- **Muxing runs in a worker thread.** A real 480p session with a recorder attached drove Node to
  99% CPU and stalled the event loop, so `/api/health` and the route that ends the paid session
  both stopped answering — a server that cannot answer is a server that cannot stop spending.
  `SegmentMuxer` takes serialized RTP and emits segments with no knowledge of peers or HTTP; the
  main thread only serializes and posts. A dead worker stops delivery and touches neither the
  recording nor `/end`, and stopping is bounded at two seconds then terminated.
- One segmenter per session fans segments out to sinks, so live delivery and durable archiving
  publish the same bytes under the same numbering rather than muxing two timelines the audit
  trail could drift between.
- **Viewers are counted, as a spend control.** Each checks in under a server-issued id; one
  leaving no longer ends the stream for the room, and the last one leaving settles the session
  instead of letting it be reclaimed ninety seconds later at full reservation. A reclaimed
  session now tells the router to stop the stream it was paying for.
- **Opening a jam that is streaming shows the film, and only its owner directs it.** The screen
  attaches to whatever is running for its configuration; the attach is `attachOnly` and can never
  open a stream, so arriving in a room cannot start a paid session — a participant who arrives
  before the host presses start gets a retryable `no_stream` and waits. Non-hosts are given no
  controls rather than disabled ones. The host's Stop ends the stream for the room; the host
  merely leaving the screen only detaches them.
- Playback takes the native HLS path on Safari and iOS — the only one that works on iPhone, where
  MSE does not exist — and hls.js elsewhere. A browser that can do neither is told so.
- Live delivery is off unless `REVERIE_DIRECTOR_HLS=true`, alongside recording's own
  `REVERIE_DIRECTOR_RECORD`, and stays off until a real session shows `/end` answering while the
  worker is mid-segment.
- **A post-rebase review caught the main-thread recorder switched back on.** The explicit consumer
  list the router builds bypassed the `config.record` default, so every session muxed WebM on
  the server thread again. The flag now gates whether the recorder exists at all. The same pass
  decoupled the segmenter from the HLS flag — segments are muxed whenever any sink wants them, and
  `createSegmentSinks` is the per-session seam the durable archive (RV-18) plugs into — and made a
  dead muxer thread report `worker_failed` rather than masquerade as a codec problem.
- **A review of the finished branch found six spend/liveness bugs, three introduced by
  auto-attach** (docs/DECISIONS.md): the join poll releasing the session mid-handshake so fal
  billed an untracked stream and the next Start bought a second one; a participant's tab close
  ending the room's stream; the relay's last-peer rule disagreeing with `/end` about who counts as
  watching; `renew` refreshing the session clock before validating the viewer id, so a stale
  renewal kept a viewerless stream billing; the segmenter feeding a dead muxer every packet; and
  `viewerId` read by hand instead of through a schema. Both spend races carry tests verified to
  fail with the fix reverted.
- Verified: `pnpm typecheck`, `pnpm test` (671 passing, 31 covering this slice: playlist shape and
  target-duration rounding, the sliding window and its refusal to reuse an evicted address, viewer
  attach/detach/renew and reclaim, the delivery routes served real bytes through an injected live
  sink — which is what proves `segment/:sequence.m4s` parses — and refused honestly, the archive
  seam receiving a segmenter with live delivery off, and the real worker thread starting,
  returning a codec verdict and stopping within bounds), `pnpm build`.
- **Not probed, and not claimed.** No Director session has been opened with a valid key on this
  branch. Which codec fal answers now that H.264 is offered, its keyframe cadence — which sets
  segment length and therefore live latency — and whether segment starts correspond to the `chunk`
  messages' `chunk_index`/`script_offset_seconds` are all unknown. No synthetic H.264 was fed
  through the muxer either, so muxing of real frames is unexercised.

## 2026-09-20 — The shell opens: five destinations, and a real account menu

- **Two new screens.** `/catalog` (`src/catalog/CatalogScreen.tsx`) and `/community`
  (`src/community/CommunityScreen.tsx`) are screens of their own in `src/lib/routes.ts`, each with
  its path constant (`CATALOG_PATH`, `COMMUNITY_PATH`) and each a top-bar destination. Both go back
  to the home, as Discover does. Nothing redirects to or away from either. Both are deliberately
  placeholders — the shared bar, a heading and one sentence saying the page is being built — and
  both read no data, so the slices that take those files over start from a blank body.
- **The bar's destinations** are now Home (`/home`), Discover (`/discover`), Catalog (`/catalog`),
  Movie Jam (`/jams`) and Community (`/community`), in that order, on every screen, declared once
  as `BAR_DESTINATIONS`.
- **An account menu at the trailing edge** (`src/shell/AccountMenu.tsx`). The avatar is a circle
  carrying the initials of the display name the viewer gave a room (`jam_members.display_name`),
  over a colour *derived* from their Supabase user id (`src/shell/avatar.ts`), so it is the same on
  every visit without anything being stored. With no name it shows a neutral mark and no initials;
  no name, email or photo is invented. The menu shows the name (or "Signed in"), Account — present,
  focusable and deliberately doing nothing yet — and Log out. See `docs/DECISIONS.md` for why this
  surfaces the real anonymous session rather than a fabricated identity.
- **Log out is a real sign-out.** `signOutViewer` (`src/lib/session.ts`) ends the Supabase session
  and forgets the identity confirmed during this page load, so the next `ensureUserId` mints a new
  anonymous user; the app then leaves for `/`.
- **Remote traversal.** The avatar is the last stop on the bar's Left/Right axis, OK opens the
  menu and focus moves into it, Up and Down walk its items and stop at its ends, Back (`Escape`,
  `GoBack`, `BrowserBack`, `XF86Back`, Backspace, the TV key codes) closes it and returns focus to
  the avatar without leaving the screen. Focus is trapped while it is open: Tab cycles inside it
  and the bar's own Left/Right does not run underneath.
- **The bar on a phone.** The brand and the account are pinned and the destinations strip shrinks
  and scrolls inside the bar, so five destinations plus the avatar fit 360px with no horizontal
  page scroll.
- **Verified.** `npx tsc --noEmit` clean; `pnpm test` 766/766 (was 728), including routes and Back
  parents for both new screens, the five destinations in order on every screen, the avatar colour
  being stable for a given user id, the menu's traversal and focus return, Account doing nothing,
  Log out signing out and landing on `/`, and the CSS contract behind the 360px fit.
- **Measured in a browser** against the hosted Supabase project, at 360×780 and 1920×1080:
  `document.documentElement.scrollWidth - window.innerWidth` is `0` at both widths on `/catalog`,
  `/community` and `/home`; at 360px the destinations strip is 265px holding 424px of content and
  scrolls inside the bar, and at 1920px it does not scroll at all. Log out was run for real: the
  stored session was removed, the app landed on `/`, and the next visit signed in as a different
  anonymous user (`c2f120dd…` → `3965a8c4…`) whose avatar drew a different derived colour.

## 2026-09-20 — Search on a phone

`/search` was drawn for a television and read badly in one hand. The screen now has a phone
layout of its own, inside `src/search/` only:

- At rest the heading and the field stand near the top of the screen instead of its middle, so a
  software keyboard opening under them covers nothing. A phone keyboard does not resize the page —
  it shrinks what is visible and leaves the page its height — so `useViewport` reads the visual
  viewport and publishes the height left and what is covered; the sticky dock and both layers
  stand on that, and `dvh` covers the browsers that resize the page instead.
- The field has its own shorter invitations: the television's eight-word placeholder was cut
  mid-word in a 264-pixel field.
- The composer's send button keeps its arrow and gives its word to a screen reader, which returns
  40 pixels to the field; the microphone keeps a thumb-sized circle at the field's leading edge.
- A turn's row runs from the gutter off the right edge, snaps its cards to the gutter and keeps a
  sideways drag to itself. The strip's chips are 44 pixels tall and Filters stays at its leading
  edge. The filter panel's chips wrap rather than scroll, and Done stays against the bottom.
- The preview fills the screen as a sheet rather than being a centred dialog taller than the
  screen, and carries a close control there — a full-height sheet leaves no backdrop to press. A
  remote still closes it with Back and never sees one.

Nothing about the engine, the turn snapshots, the two preview actions or the remote's focus model
changed. Verified in Chrome at 360×800 and 390×844, and held by DOM tests at 360 that read the
real stylesheet at that width (`tests/searchPhone.dom.test.tsx`).

## 2026-09-20 — Director archive review hardening (RV-18)

- The live writer and archive reader now share one resolved index and recording store. In
  fallback mode this matters: two separate in-memory instances made a successfully written
  archive invisible to the read routes in the same process.
- Every live-session route scopes a session id to the jam id in its URL. A session id from one
  room can no longer direct, watch, renew, read, or end another room's stream or completion row.
- A playing room may keep its existing configuration-keyed streams; it becomes `ended` only
  when the last one stops, so ending one language cannot strand another paid stream.
- The WebM muxer refuses H.264 until the fMP4 muxer is selected upstream. It no longer accepts
  H.264 WebM output that the archive could mislabel as `video/mp4`.
- Archive writes truncate at the last durable prefix after an init or piece failure, Storage's
  wrapped 404 is distinguished from unrelated HTTP 400 failures, empty archives do not render a
  broken player, and the audit identity sequence is explicitly granted to `service_role`.
- After integrating the latest shell work, logging out now leaves the authenticated shell through
  an injectable navigation boundary. Production replaces the document with the static `/` landing;
  raw component tests can verify the route without asking Node to resolve Vite-only landing assets.
- Verified locally: `pnpm typecheck`; 87/87 affected tests covering the app wiring, archive,
  worker boundary, routes, lifecycle, and DOM surface; full `pnpm test` 814/814; `pnpm build`.

## 2026-09-20 — Catalog browses the whole catalogue; Discover keeps the conversation

The repository now has two ways to reach a film, and they do not overlap. `/discover` is the
conversation (RV-15). `/catalog` is browsing: a title search field, the refinement chips, a grid of
posters that grows as the viewer reaches the end of it, and the TMDB attribution. There is no
conversation bar and no voice control on it, and nothing on it turns a title down. See
`docs/DECISIONS.md` for why the two are kept apart.

**What the screen is made of** (`src/catalog/`):

- `CatalogScreen.tsx` — the screen. It reads `/api/catalogue` through the same
  `CatalogueReadContext` the home and search read, so a test renders it over its own titles.
- `useCatalogue.ts` — page 1 of a query and the feed that grows from it. Unrefined it pages at
  `CATALOGUE_LIMITS.pageSizeDefault` (24); refined it reads one shortlist of
  `CATALOGUE_LIMITS.shortlistSize` (48) with every filter applied in Postgres, and stops paging. A
  typed query is debounced 320 ms; a new query or refinement starts again from page 1 and aborts
  whatever the old one had in flight.
- `pageFeed.ts` — the feed, its single in-flight request and the two triggers that ask for the next
  page: focus reaching the last row (a remote moves focus, not the scrollbar) and the end of the
  grid nearing the viewport (mouse and touch). A trigger during a request is dropped, not queued;
  a page repeating titles already shown appends only the new ones, so nothing on screen moves and
  focus stays where it was. After a failure nothing is retried behind the viewer's back.
- `gridMove.ts` / `useGridNavigation.ts` — roving focus over the grid. Arrows move one poster and
  stop at the edges, a short last row is reachable from the row above, Home/End jump to the row
  edges, OK opens, and Back is left to the app, which returns it to the top bar. The column count
  is read from the live grid layout rather than assumed.
- `RefinementBar.tsx` — the chips, and a second rail naming everything currently narrowing the
  grid, each removable, with the live match count. Every chip maps to data the catalogue holds
  (genre, runtime, release year); there is no mood or pace chip, because nothing could honour one.
- `catalog.css` — the screen's own styles. It sits on `.discover-shell` for the page frame, the
  poster box, the status panels, the retry, the spinner and the attribution, and adds the head, the
  chips, the grid and the end of the feed.

**Ranking is named, never implied.** Unrefined, the grid is the order the catalogue query answers
and nothing claims otherwise. Refined, the shortlist is ordered by the deterministic scorer
(`orderShortlist(..., { phase: "idle" }, false)`) and the line above the grid says *Ranked by genre
match*. Catalog never calls the assistant, so it can never show a model's order or a "Ranking…"
state it will not reach.

**A film opens over the catalogue.** Choosing a poster navigates to `/discover/:id`, and the app
draws the film page as a layer over `CatalogScreen`, which stays mounted and `inert` underneath —
so its pages, its scroll and its focus target survive. However the page closes (Escape, the bar's
Catalog, the browser's Back), focus returns to the poster it was opened from. `App.tsx` now decides
that from the history entry the film was opened from (`FILM_LAYER_OVER`), which makes the home's
previous special case one rule covering both screens; every other film page, including one reached
by URL, still belongs to Discover.

**Remote and phone.** A remote lands on the bar, Down reaches the search field, Down again the
chips, Down again the grid; Up from the grid's top row returns to the chips. On a phone the
backdrop and the spotlight step aside, the head becomes the search alone, the chip rails scroll
sideways at a 44px-tall hit size, and the grid is two posters across.

**Verified.** `npx tsc --noEmit` clean. `pnpm test` 832 passing, including 24 new tests: the pure
feed and grid rules (`tests/pageFeed.test.ts`, `tests/gridNavigation.test.ts`) and the screen
through the whole app (`tests/catalog.dom.test.tsx`) — the first page and its attribution, one
field and no conversation or voice, the bar→field→chips→grid walk and Back, a typed title, growing
by a page without moving what is shown, narrowing to a named shortlist and widening again, and a
film opening over the catalogue and handing its poster back the focus.

**Measured in a browser** against the hosted Supabase project, at 1440×900 and 390×844: scrolling
to the end appended pages 2 and 3 (`/api/catalogue?query=&page=2|3&pageSize=24`, 72 posters, the
first 24 unmoved); the *Something scary* chip issued
`/api/catalogue?query=&page=1&pageSize=48&includeGenres=horror`, reported "4,055 titles match",
captioned the grid *Ranked by genre match* and removed the feed end; typing "blade runner" answered
with the Blade Runner titles; opening a poster left the catalogue mounted, `inert` and at scroll
1200, and closing it returned focus to that same poster, still on screen.
`document.documentElement.scrollWidth - clientWidth` is `0` at both widths.

**Known gap, not caused by this work.** Six tests in `tests/directorPieces.test.ts` and
`tests/directorPieceMuxer.test.ts` (the muxer worker boundary) fail on this machine — 2 failed, 4
cancelled — identically before and after this change, on an untouched checkout of `main`. Nothing
in this slice touches the director.

## 2026-09-20 — A Director session: one person, one film, at /director/:slug

- **A screen of its own, under Movie Jam.** `/director/:slug` is a `director`
  screen in `src/lib/routes.ts` whose Back parent is `/jams`
  (`src/shell/keys.ts`) and whose top-bar destination is `jam`. **No sixth
  destination was added**: `BAR_DESTINATIONS` still holds five, and they still
  fit 360px. The Movie Jam list gains the second way to start — **With
  people** (the Studio) or **Alone** (the Director session) — which is where
  the choice belongs. See `docs/DECISIONS.md` for why.
- **Three zones.** *The stage* in three states: empty (it asks for the first
  shot), generating (the live stream, the seconds it has produced and the beat
  it is on), and still (the finished session held as a frame, with the room's
  shared playback clock under it, a playhead and a tick at each beat
  boundary). *The timeline*: every beat with its number, start, duration and
  phrase, in one of five states — written (dashed), generating (solid accent),
  ready (outlined), locked (solid muted) and blocked (marked differently
  again). The closing rule is `src/core/directorBeats.ts`'s, asked through
  `isBeatLocked` rather than restated. *The direction column*: the session's
  turns, each carrying the beat it steered in that beat's own treatment, with
  hover and focus in either direction lighting the other.
- **The shared playback clock now has a client.** The four security-definer
  functions and their migration have existed since the playback work and were
  exercised by `verify:realtime`, but nothing in the app read them.
  `src/lib/playbackClock.ts` and `src/core/playbackClock.ts` bind them: the
  database stays the authority, and a browser only advances the reading it was
  given by time it measured locally.
- **Spend is real.** Director session responses carry `spend`, and
  `GET /api/jams/:id/director/budget` answers before a paid session exists,
  with `configured` alongside it. The session figure is derived from the
  seconds the provider generated, honours fal's 60-second per-session minimum,
  is capped at the session's reservation, and is shown in USD against
  `FAL_ASSET_BUDGET_USD` — never converted, never a placeholder. When the
  budget left cannot pay for a beat's seconds that beat is blocked on the
  timeline and the composer says so on its own line.
- **The composer** is press-and-hold to speak (the app's existing SLNG relay,
  recorder and partial merge, with a `hold` gesture added to the shared voice
  control), a text field, and attach. Direct sends each finished transcript on
  its own; Review is stopped and closes the microphone.
- **Deliverables**, in a drawer, each in its real state: the script as
  markdown (served, ready when this server holds a script), the timed script
  (written in the browser from the outline's own offsets), the audio
  description (**not made — nothing in this build writes one**) and the video
  file (absent, then generating while a session runs, then the session's
  recording). A row that is not ready carries no control at all.
- **Built for 1920, 1440 and 390.** Two columns on a desk with the direction
  column at its own measure; one column on a phone with the composer sticky at
  the bottom and the beats running off the gutter. The remote's focus model is
  the app's own (`useRows`, moved from `src/search/` to `src/shell/` because it
  is the app's axis convention, not Discover's).
- **Not implemented, and drawn as absent rather than faked:** per-beat stills
  (the stream is recorded whole and never sampled per beat), per-beat variants
  (nothing generates a second take), a reference library, and the audio
  description. **Attach fans out its four intents for real and then stops**:
  there is no upload route and no reference store, so nothing can carry an
  image or clip to the film, and the composer says so
  (`docs/specs/multimodal-creative-turns.md`).
- **Verified.** `npx tsc --noEmit` clean; `pnpm test` 870/870 (was 776),
  including the beat states and the turn-to-beat link, the spend arithmetic and
  the server's spend responses, the deliverables' states, the route and its
  Back parent, and the screen itself at 1920, 1440 and 390 against the real
  stylesheet.
- **Measured in a browser** at 1920×1080, 1440×900 and 390×844 against the
  hosted Supabase project, on a jam created through the app from an imported
  script (6 beats, 0:30): `document.documentElement.scrollWidth -
  window.innerWidth` is `0` or negative at all three; the timeline's row
  scrolls inside its zone (356px visible of 874px at 390) instead of widening
  its column; the deliverables drawer served
  `/api/jams/<id>/script.md`; and the attach flow produced its four labels and
  then the "no reference store" line. `GET .../director/budget` answered
  `{"configured":false,...,"budgetUsd":20}` — this machine has
  `FAL_ASSET_BUDGET_USD` set and no director credential — so the stage said
  "The live director is not configured on this server" and refused to open a
  session.
- **Not verified:** a live Director stream. No fal director credential is
  configured here, so no session has been opened, no frame generated and no
  recording written from this screen. The generating and still stage states,
  the live beat states, the turn trail and the video deliverable are exercised
  by tests against a fake server, not against fal.

## 2026-09-20 — The escape room: an authored world, rules that decide, and a loop that covers the wait

An **escape room** is a Movie Jam with a fixed world and a goal. The room shares control of one
character; the film is what the character does. It reuses the jam wholesale — invite code, QR,
lobby, admission, roster, chat — and is drawn as a configuration of the jam screen, in the slot
the live director occupies otherwise, rather than as a screen of its own. It is the third source
on create, beside starting from scratch and importing a script.

- **Three original scenarios ship as data** (`src/core/escape/scenarios/`), each with a different
  spine so the rooms do not play the same: *The Night Audit* (killing the magnetic lock takes the
  lights with it), *Cold Sill* (the bulkhead will not undog while the porch is filling) and *The
  Understudy* (the trap is counterweighted and the score is inside the hamper standing on it).
  All three are solvable in ten or eleven steps. The format is specified in
  `docs/specs/escape-room-scenario.md`.
- **The rules decide what happened; the model only tells it.** `src/core/escape/rules.ts` is
  pure — no network, no React, no clock, no randomness — and resolves a proposal into exactly one
  of three outcomes: it advances the world, it fails for a sentence the author wrote, or it is
  impossible here and now. The model is handed the resolved outcome and writes the prose and the
  shot; it is never asked whether the key fits the drawer. A beat the model did not narrate says
  the scenario told it.
- **The turn.** Participants propose in their own words, vote (one effective vote each,
  replaceable), and the host closes it. The winner is resolved and filmed; every other proposal is
  discarded rather than queued.
- **Latency is answered by the idle loop.** A location's five-second loop is generated once on
  arrival and plays while the room argues and while the next beat renders. A finished beat cuts in
  over it exactly once and hands the screen back when it ends. A late beat is simply a longer
  loop; one that fails leaves the loop running and says so.
- **Video** is `minimax/h3-max/text-to-video` through the fal adapter's queue half
  (`apps/server/providers/falSegments.ts`), entry `[0]` of a server-owned allowlist. The director
  and the escape room debit one `SpendAccount`, so `FAL_ASSET_BUDGET_USD` stays a ceiling on the
  process. The session ends when the goal is reached or when that ceiling refuses the next
  segment.
- **These routes check who is asking**, unlike the other routes on this Express host: identity is
  Supabase Auth's answer to the presented token, the role is the caller's own `jam_members` row
  read under RLS, and the answer is cached for 20 seconds on a digest of the token.

**Measured against the live model** on 2026-09-20 (`scripts/probe-escape-segment.mts`, two
generations): 15s asked → **15.104s** measured, 9,795,075 bytes, playable 25.3s after submit; 5s
asked → **5.184s**, 3,792,092 bytes, playable 8.7s after submit. Both `video/mp4`. The model
overshoots and not proportionally, so a clip's length is read from its own header
(`src/core/mediaDuration.ts`) rather than assumed, and a beat takes longer to make than it takes
to watch — which is why the loop exists.

**Verified live in a browser**, against the hosted Supabase project and the real model, on
2026-09-20: a room opened from the create screen (loop committed $0.40), "grab the deck spanner
off the wall" resolved, was narrated by Nebius ("Ozan Rills unclips the deck spanner from the
wall, its metal cold against his wet palm.") and filmed at a measured 15.1s (committed $1.60
total); the losing proposal was discarded; the beat cut in over the loop and handed the screen
back when it ended; and "undog the bulkhead door and get through" was refused with the author's
sentence, not filmed, with spend unchanged.

**Three dead screens the browser found and no test had.** A `<video src>` sends no Authorization
header, so every clip 401'd — the bytes are now fetched with the viewer's own token and played as
an object URL, and the loop is held while a beat's bytes arrive rather than swapped out for it.
`autoPlay` on a muted video left the element on its first frame, so it is asked to play when it
appears and again when it says it can. And a hidden tab pauses its video with nothing to resume
it, so playback restarts when the tab is visible.

**Two more found by re-reading the seams.** A jam id out of the path was interpolated into the
PostgREST query that reads the caller's membership, and Express decodes `%26` — so an id carrying
`&` would have added filters to a query this server has to trust. RLS scopes every row to the
caller either way, so this narrowed that read rather than widening it, but every id these routes
mint or accept is a v4 UUID and is now required to be one, the media id on its way to an object
key included. And rooms were never reclaimed: nothing closes one, so a server would fill its
twenty-four slots and refuse the twenty-fifth host forever. A room nobody has read in half an
hour is dropped when a new one is opened.

**Two more from a code review.** A server with no object storage keeps only its most recent
segments, and it was dropping them silently — leaving the session reporting a shot as `ready`
behind a URL that answers 404, with the screen falling back to the loop saying nothing. A dropped
segment is now its own status and says so. And a session that had ended on the spend ceiling could
still buy the next location's idle loop, because only the beat checked; nothing is bought after a
session ends now, and generation checks again when it runs rather than only when it is decided.

**Verified:** `npx tsc --noEmit` clean; `pnpm test` 887/887 (766 before this work began);
`pnpm build` succeeds. The tests cover the rules' three outcomes and their invariants, exhaustive
solvability of all three scenarios, the turn and the spend ceiling, the fal adapter's allowlist
and error shapes, the routes' authorization and id checks, idle room reclamation, a dropped
segment, the mp4 duration reader, and the panel and create screen in a document.

**Not implemented / not verified:** two browsers in one escape room; any of this on Vercel (these
routes are local-Node only and their state is in that process's memory, like the script, session
and director routes); Realtime events for the room (it polls every three seconds, one named
constant); durable segments without `SUPABASE_SERVICE_ROLE_KEY`, which this environment does not
have, so segments were held in memory and the panel said so; and a session actually ending on the
spend ceiling against the live model — that path is covered by tests, not by a receipt. The
room's own turn and votes live in the escape session on the server and do **not** use
`jam_proposals`, which remains append-only with no vote: the versioned transactional scene
contract is still unimplemented and still blocks the Movie Jam's own proposal queue.

## 2026-09-20 — Appearing in the film, and the beat that is made from it

A participant can choose to be a character in the film the room is generating. One frame from
their own camera becomes the character reference and beats are generated with
`minimax/h3-max/reference-to-video`. The consent model is the feature; the full rules are in
`docs/specs/appearing-in-the-film.md`.

- **The register grew a kind, not a twin.** `likeness` joins camera, microphone and screen in
  `jam_live_consents` (`20260920100000_likeness_consent.sql`). The trigger issues its reference
  with a `likeness:` prefix and still clamps the lifetime; the insert policy still pins
  `owner_id = auth.uid()`; there is still no update or delete policy, so a grant is retired only
  by `withdraw_live_consent`. A partial unique index allows one standing likeness grant per
  participant per jam. `likeness` is not a track kind: `permittedKinds` filters to track kinds
  explicitly, so agreeing to appear starts no camera and a camera grant seeds no beat.
- **The frame is taken on a press, seen, and approved.** `AppearInFilm` opens the camera on a
  press and takes nothing by opening, captures on a second press, shows the picture back, and
  sends it only on a third press that declares what it is for. The camera closes as soon as the
  picture is taken. The frame is square, 256–1024 pixels, at most 512 KB, and lives in the
  private bucket under `likeness/<jamId>/<uuid>`; no signed URL is minted and `GET
  /api/jams/:id/likeness/:assetRef` serves it to its owner alone.
- **Withdrawal is one press, immediate, and honest about the past.** It stops the likeness being
  used by any beat generated from then on. Beats already generated still show the person, and the
  panel says exactly that rather than implying a recall. `describeBeatLikeness` is three-valued
  (`none` / `standing` / `withdrawn_since`) so a withdrawal can never reclassify an existing beat
  as having used nobody.
- **Generation.** `POST /api/jams/:id/beats/:index/video` on the Node server. Whether anyone
  appears is not in the request body: the server reads the register fresh under the caller's own
  RLS at the instant of submission, and `usableLikenesses` answers, so there is no cache to
  invalidate. Frames travel inline as `data:` URIs, at most three per beat. A grant whose frame
  never arrived is `409 frame_missing`, never a plain beat generated without that person. No
  provider is `503 generation_disabled` and no Supabase is `503 likeness_not_configured`; neither
  is ever a mock.
- **One budget.** `FAL_ASSET_BUDGET_USD` now covers both ways this process spends: the director's
  session ledger and beat generation reserve against a shared `FalBudget`, so the stated total is
  the real ceiling.
- A jam where nobody has agreed generates a plain beat through
  `minimax/h3-max/text-to-video`, exactly as it would have before this existed.

### Verified against the live models

`pnpm probe:beat-video`, 2026-09-20, 5-second 768p clips through the real adapter:

| | model | submit → downloaded clip | reported inference | clip |
| --- | --- | --- | --- | --- |
| Plain beat | `minimax/h3-max/text-to-video` | 5.8 s | 2.5 s | 4.6 MB mp4 |
| Likeness beat | `minimax/h3-max/reference-to-video` | 8.6 s | 3.0 s | 4.2 MB mp4 |

A likeness beat took **1.48× the wall clock** and 1.2× the inference. Both models returned a
playable mp4. Two earlier measured facts shaped the code: the queue tracks a request under
`minimax/h3-max`, not under the endpoint id its published schema declares, so the adapter
follows the `status_url` and `response_url` the submit response returns (validated to be https
on the queue host) rather than constructing them; and a reference below 256×256 is refused with
`image_too_small`, which is why `checkFrame` refuses it here first.

**Cost was not measured.** No queue response carries a price, so the rates in `.env.example` are
fal's published figures read from their model listing on 2026-09-20 — $0.08/s at 768p for
reference-to-video against $0.04/s promotional for text-to-video — and both defaults are the
list rate so a stale default never understates the bill. The reference frames themselves are free
at our caps: the provider includes 4,096 reference tokens and a 1024×1024 image is 1,024, so
three references fit inside the allowance.

### Verified against a real Postgres

The whole migration chain was applied in order to a scratch PostgreSQL 14 instance with the
Supabase roles, `auth.uid()` and the default API-role grants in place. Every migration applied
(`20260919220000_catalogue_titles.sql` needs Supabase's `extensions` schema and was skipped),
and the consent rules were then exercised as two real participants:

- a likeness insert carrying `https://evil.invalid/face.jpg` and a 99-hour expiry was stored
  with a trigger-issued `likeness:` reference and a clamped lifetime
- a camera grant in the same room still got the `live:` prefix
- a second standing likeness grant was refused by `jam_live_consents_one_standing_likeness`
- granting on another participant's behalf was refused by the row-level security policy
- `update` reached 0 rows and `delete` removed none, there being no policy for either
- a non-member read 0 rows of the register and, naming the consent id exactly, was refused
  withdrawal; an active member of the room who was not the owner was refused identically; the
  owner's own withdrawal succeeded, and a fresh grant was then allowed

### Run in a browser, against the hosted project

`pnpm dev` on port 4357, an imported-script jam created for the purpose
(`likeness-check-4c3dc2f8`), Studio opened as its host:

- The panel renders beside the live stage and reads the register without error. The stage's
  own contribution selector still offers Camera, Microphone and Screen and nothing else, so the
  new kind did not leak into the list of things that can be published.
- With nobody agreed it says "Nobody has agreed to appear. Beats are generated without anyone
  in the room," and the badge reads NOT IN IT.
- Pressing "Turn on my camera" with camera access refused said "Your browser refused access.
  Allow it in the address bar, then try again." Nothing was captured, nothing was claimed, and
  the panel stayed at NOT IN IT. The capture and approval steps themselves were not reachable
  in this environment, which has no camera.
- **The hosted project has not had the migration applied, and it fails closed.** Driving the
  real client path (`agreeToAppear`) returned "That consent could not be recorded"; the
  underlying refusal was `23514`, the register's old kind check. The feature is inert there
  until `20260920100000_likeness_consent.sql` is applied — it does not half-work.
- That refusal was reported as `unavailable`, which read as a transient fault and invited a
  retry that would send the same value again. `23514` is now mapped to `invalid_input`,
  not retryable, naming a possibly missing migration.

### Verification

- `npx tsc --noEmit` clean, `pnpm test` 822/822 (was 790), `pnpm build` passes. New tests:
  `tests/likeness.test.ts` (14, the pure rules), `tests/likenessRoutes.test.ts` (22, the routes
  over a fake Supabase and a fake provider) and `tests/appearInFilm.dom.test.tsx` (9, the panel).
- The consent gate was checked by breaking it: removing the effectiveness filter from
  `usableLikenesses` fails 9 tests across all three files, including the three that hold
  withdrawal, expiry and the standing of an already-generated beat.
- **Not verified:** likeness *fidelity*. The probe's reference frame is a synthesised 512×512
  image, which measures the round trip honestly and says nothing about how well a face survives
  it; no photograph of a person has been sent. The migration has not been applied to the hosted
  Supabase project. The whole path has not been run end to end in a browser against a live room,
  so the panel's capture, approval and withdrawal are covered by DOM tests and the routes by
  their own tests, but the two have not been exercised together. Durable frame and clip storage
  needs `SUPABASE_SERVICE_ROLE_KEY`; without it both stay in memory and the routes report
  `durable: false`.
## 2026-09-20 — Director broadcast review hardening (RV-19)

- The server now performs its own thirty-second session sweep. Idle reclaim no longer depends on
  a later browser request, and `maxSessionSeconds` is enforced as the hard paid-session ceiling,
  not merely used to calculate a budget reservation.
- The opening guard covers the durable index write as well as the provider handshake. A viewer's
  three-second attach poll cannot release a valid reservation while the index write is inside its
  ten-second timeout window.
- Session teardown stops and bounds the HLS segmenter worker, releases its RTP listeners, flushes
  its tail and finishes its sinks. With HLS enabled, that one fMP4 pipeline feeds both the live
  window and the MP4 archive; with HLS disabled, the WebM piece recorder remains the archive path.
- Codec preference follows that pipeline: H.264 first for HLS/fMP4, VP8 first for recording-only
  WebM, with both retained as fallbacks.
- Invalid viewer bodies cannot become a host stop, and every HLS read route verifies that the
  session belongs to the jam named in the URL.
- The client allows only one attach poll in flight, pauses it during a host start, detaches a
  viewer allocated after unmount, and sends unload-time detach with fetch keepalive. The ended
  recording player is no longer rendered twice.
- The newer `/director/:slug` screen merged from `main` now uses the same room-wide contract:
  attach-only polling, viewer-specific renew/detach, HLS selection, and host-only Stop/direction
  across button, keyboard and voice paths.
- Verified after merging the latest `main`: `pnpm typecheck`; `pnpm test` 1143/1143; `pnpm build`;
  `git diff --check`.
- No live provider session was opened. H.264 muxing, keyframe cadence, latency and CPU under real
  fal media remain unverified.

## 2026-09-20 — Search narrows by what the film is about

"A film about a family with some pets" used to return comedies and family films: the assistant
could describe a request only as genres, a runtime and an era, so the pets were discarded when the
message was interpreted, and no ranking could get them back — the shortlist had already been
chosen by genre. A turn may now carry a **subject**, the viewer's own words for what the film is
about, and it reaches `search_catalogue_titles`' `search` argument. The full rules are in
`docs/specs/search-conversational.md`; the reasoning is in `docs/DECISIONS.md`.

- **The engine carries it, grounded.** `PreferenceState.subject` is `{ phrase, sourceTurnId }` or
  null; a turn carries `setSubject` and `clearSubject`. A subject is grounded one word at a time —
  every word of it must be a word of the message — because a search phrase is the sentence with
  the filler dropped and so is rarely a literal substring. One invented word refuses the whole
  turn with `ungrounded_quote`, exactly as an ungrounded quote does. `TurnInput` is now the
  schema's *input* type, so a turn that says nothing about the subject simply omits both fields;
  `AcceptedTurn` is what the engine reads once the defaults are filled in.
- **Composition.** A later subject replaces the one in effect; a turn silent about the subject
  leaves it standing; the narrowing strip shows it first as *About "…"* and takes it off with the
  same press as a genre. The interpret step can only set one — removing a refinement is the
  strip's job.
- **It narrows, it does not rank.** `toShortlistRead(state)` returns `{ subject, filters }` as one
  value, because they are one request and a read keyed on the filters alone would reuse an answer
  found for different words. `useShortlist` takes that read. `orderShortlist`, `rankCandidates`
  and the scorer are untouched.
- **Words that match nothing widen rather than empty.** When a subject returns zero films the same
  filters are read again without it and the row says *The words "…" found no films, so these match
  everything else you asked for.* Only the words are dropped, never the filters.
- **The prompt says a subject is not a genre**, so "a family with some pets" stops being flattened
  into `genre.family`, and a message that says what the film is about is answered rather than
  questioned.

### Verified against the live catalogue and the live assistant

`pnpm verify:shortlist`, 2026-09-20, hosted Supabase, 27,839 titles:

| read | total | first titles |
| --- | --- | --- |
| `search: "family with pets"` | 35 | Marcel the Shell with Shoes On, Hachi: A Dog's Tale, My Pet Dinosaur |
| `include_genres: ["family"]` | 2,588 | Elemental, Carl's Date, Spy Kids: Armageddon |
| `search: "heist goes wrong"` | 8 | The Getaway, Sleepless, To Steal from a Thief |
| `search: "loses their memory"` | 23 | Tell Me Who I Am, Detective Conan: Captured in Her Eyes, Palombella Rossa |
| `search: "zzqqxx nothingness"` + comedy | 0 | — (the comedy filter alone still matches 9,942) |

Selecting by plot and selecting by genre do not return the same films, and a genre filter still
narrows the words further: "family with pets" plus the Family genre is 25 of the 35.

`pnpm verify:conversation`, 2026-09-20, `Qwen/Qwen3-30B-A3B-Instruct-2507` through the real
endpoints. The four turns that existed before still pass. Three new cases, each reported with
what the filters alone return (**before**) and what the viewer's words return (**after**):

| message | subject heard | filters | before | after |
| --- | --- | --- | --- | --- |
| "a film about a family with some pets" | `family with pets` | none | 27,839 · Blue Beetle, Gran Turismo, The Nun II | 35 · Marcel the Shell with Shoes On, Hachi: A Dog's Tale, My Pet Dinosaur |
| "a heist that goes wrong" | `heist goes wrong` | none | 27,839 · Blue Beetle, Gran Turismo, The Nun II | 8 · The Getaway, Sleepless, To Steal from a Thief |
| "someone who loses their memory" | `loses their memory` | none | 27,839 · Blue Beetle, Gran Turismo, The Nun II | 23 · Tell Me Who I Am, Detective Conan: Captured in Her Eyes, Palombella Rossa |

The assistant named **no genre** in any of the three, which is the point: a genre-only funnel had
nothing to narrow with and would have answered each of them with the unrefined catalogue, or with
a guess ("family" for the pets, "crime" for the heist) that selects the wrong 2,588 or 3,399. A
fourth case, "a comedy about zzqqxx nothingness", found 0 for the words and 9,942 for the comedy
filter alone, so the fallback has a real shortlist to widen to.

The script talks to the real provider, and the provider is sometimes slow: two runs on 2026-09-20
failed at the first turn with `ASSISTANT_TIMEOUT` (an interpret call took 7.6 s against a 12 s
per-attempt budget) and the next run passed unchanged. A timeout there is the provider, not the
funnel; a refusal names its own code and says which quote or word was refused.

**One regression was caused and fixed here.** Inserting the subject rules into the middle of the
interpret prompt renumbered the rules the model already followed, and it began answering "A
comedy, please" with the lowercase quote "a comedy", which the engine refused as ungrounded —
`pnpm verify:conversation` failed at the second turn on two consecutive runs, where `main` passed.
The subject rules are now appended as rules 8 and 9 so nothing is renumbered, and rule 2 says
outright that a quote keeps the capitals the message used. Three probe runs and the full script
then quoted "A comedy" every time.

### Verification

- `npx tsc --noEmit` clean. `pnpm test` 1,117/1,124 — the seven failures are the pre-existing
  `directorPieces`, `directorPieceMuxer` and `directorRoutes` ones, unchanged from `main`. New
  tests: `tests/preferenceSubject.test.ts` (12, grounding and composition), and cases added to
  `conversationDecision`, `refinements`, `shortlistFilters` and `search.dom` (30 new in all).
- The widening guard was checked by making the words match nothing in the DOM test: the row still
  shows films and carries the sentence naming the words that found none.
- **Not verified:** the screen has not been driven in a browser against the hosted project for
  this change; the strip's subject chip, its removal and the widening notice are covered by DOM
  tests over the fake catalogue and assistant, not by a live session. Subject quality is the
  model's: the prompt steers it to drop "film", "someone" and the like, and the three cases above
  show it doing so, but a phrase that keeps such a word will match nothing and fall back rather
  than fail — "someone who loses their memory" read literally matches 0 titles, where
  "loses their memory" matches 23.

## 2026-09-20 — Anybody in the room plays and stops the take (RV-23)

- Joining a jam with "With people" showed a player and no controls: `JamDirector` took a
  `canDrive` prop and only the host got Start, Stop and the direction box. The prop is gone.
  Everyone in the room gets the same two signals and the same field, on both entrances — the
  room screen and the solo `/director/:slug` screen — and the control is called **Play**.
- Nothing was relaxed on the server: the director session routes have never had an
  authorization check, so the UI now says what the server already did. Membership
  authorization on those routes remains an open, unowned gap.
- `ended` is no longer terminal, reversing the RV-18 decision: a stopped room plays again as
  a new session with its own archive entry, and the badge reads **STOPPED**. With the stop
  signal in everybody's hands, a terminal stop would let any participant retire a room for
  everyone with one press. The director's `409 jam_ended` refusal on start is gone, and so is
  the outline queue's refusal to edit a stopped room — a room between takes is where the next
  take's story gets written. `jam_ended` survives only where it is still true: a request for a
  live stream that has stopped, answered with a pointer to the archive.
- The session poll now treats `not_found` as the stop it is — most stops arrive from somebody
  else's browser — and shows that take's recording with Play enabled instead of sitting on a
  dead player. Adopting a session clears the previous take's recording, which would otherwise
  blank the frame.
- The viewer count is untouched. It is spend control, not ownership: closing a tab is still a
  detach, Stop is still the only whole-room end, the last watcher leaving still settles the
  session, and the sixty-second minimum still makes Play a spend control.
- Verified: `pnpm typecheck`; `pnpm test` 1209/1209; `pnpm build`.
- **Not verified:** no fal session was opened, so a second take against real provider media,
  and what two archived sessions look like in one room, are unobserved. Two browsers have not
  been driven against one room, so "somebody else stopped it" is covered by a DOM test rather
  than by two live clients.

## 2026-09-20 — One door to the three experiences, and a shell that reads on a phone

The app's navigation now says what Reverie actually offers, and the whole of it was driven in a
real browser at 390×844.

**The landing's front door opens the app.** All three "Open Reverie" calls to action pointed at
`/discover`, a screen inside the app, so the home was skipped entirely. They open `/home`. "Ask it
what to watch" keeps Discover, through a constant of its own; "Start a Movie Jam" now opens the
door below.

**The TMDB credit is the page's footer, not a bar over it.** It was fixed across the bottom of the
viewport, which at 390px was a four-line banner covering the shelf it was crediting. It is in the
page's flow at the foot of the content, scrolling with it and sized as a credit. It is still on
every screen that shows a TMDB record, and still not behind a link — that is the licence
obligation. Every screen that reserved a band for it (`--attribution-height` /
`--attribution-space` on the home, Discover, Catalog and search) no longer has to.

**`/about`** carries what Reverie is, every provider with what this repository actually calls it
for (Supabase, Nebius, SLNG, Vonage, fal with MiniMax H3, TMDB — each line written from its
adapter), who built it and what each person worked on, and that it was made at HackBarna 2026. It
is reached from the page's footer, from the account menu and from the landing's footer, and is
deliberately not a destination: `destinationOf` now answers `null` for a screen that belongs to
none, and the bar marks nothing while it is open.

**`/create` is one door to three experiences**, each described by what it is: Director (alone),
Movie Jam (with people), Escape Room (a room solves a place). Each opens the flow it already had.
The registration form (still `/jams/new`, screen renamed `newJam`) knows which of the three it is
registering. A finished Director film opens in its own session at `/director/:slug`. Where the
escape room's routes are absent — they are the local Node server's — the door says so in the
server's own words, offers nothing, and states that the other two are unaffected.

**`/jams` is Yours**, the same path, listing Movie Jams, Director sessions and escape rooms, each
card saying which it is and opening where it belongs. A jam row does not record which of the three
it was started as and the routes that would say are the local server's, so `src/lib/startedKinds.ts`
records what was chosen at the door, in this browser, on the same terms `jamConfiguration.ts`
already takes; a room with nothing recorded is shown as a Movie Jam, which is what a jam row is.

**The bar's five are Home, Discover, Catalog, Create, Yours.** Community is gone as a destination:
films made in Reverie are a "Made in Reverie" shelf on the home and a source filter in Catalog,
both reading the public rooms this viewer can read. `/community` redirects to the home so a shared
link still lands.

**On a phone the destinations move to a fixed bottom bar** — one icon and one short label each,
clearing the safe-area inset, Create drawn as a filled action. It is the same list moved by CSS,
so nothing is rendered twice and the remote's focus order is untouched; above 720px the bar is
exactly what it was. The bar slides down by what the visual viewport says the keyboard covers, and
the Discover dock stands on whichever of the two is taller, so neither is ever in the other's
space.

**The Discover composer** drops its heavy permanent ring for a hairline and a soft ground, puts
half a thumb between the field and the microphone, and makes both a comfortable thumb tall on a
phone. The focused state is the loud one, and still appears for a keyboard and a remote through
the existing `:root:not([data-input="pointer"])` guard.

### Verified

- `npx tsc --noEmit` clean. `pnpm test` 1132 tests, 1125 pass; the only failures are the six
  pre-existing `directorPieces`/`directorPieceMuxer` worker tests and `directorRoutes`' "a second
  viewer on the same configuration attaches to the one stream", which fail identically on
  untouched `main` on this machine (baseline before this work: 1094 tests, 1087 pass, 3 fail,
  4 cancelled).
- New tests: `tests/about.dom.test.tsx` (4), `tests/create.dom.test.tsx` (4),
  `tests/yours.dom.test.tsx` (5), `tests/madeInReverie.dom.test.tsx` (9) and
  `tests/bottomBar.test.ts` (11, replacing `topBarNarrow.test.ts`).
- In a browser at 390×844, against the hosted Supabase project and the local Node server: all
  three "Open Reverie" links resolve to `/home`; the credit sits at the foot of the home, the
  catalogue and a film page rather than over them; `/about` reads top to bottom; the door renders
  the three, and with `/api/escape-room/scenarios` answering 404 the escape card states it while
  the other two stay choosable; choosing Director wrote a real 20-second script through Nebius and
  landed in `/director/untitled-movie-jam-03541218`; opening a public escape room recorded
  `reverie.started-kind.<id>=escape` and Yours then listed it as ESCAPE ROOM with one way in;
  the Made in Reverie shelf and Catalog's filter both showed that room, and both said nothing had
  been made yet before it existed; `/community` replaced itself with `/home`.
- The bottom bar was measured rather than eyeballed: with the keyboard reading at `0px` it sits at
  781–844 in an 844-tall viewport, and at `330px` it sits at 1111, off the screen. At 1280×800 the
  destinations are back in the top bar in its flow, only Discover carries a mark, and Right still
  walks Home, Discover, Catalog, Create, Yours, then the account.

### Not verified

- A real software keyboard. The visual-viewport reading was driven by setting `--search-keyboard`
  by hand, which exercises exactly the property the stylesheet consumes but is not a phone.
- `useViewport` publishes that reading only while the Discover screen is mounted, so the bottom
  bar does not step aside for a keyboard opened on another screen. Nothing else docks to the
  bottom of a page, so nothing is covered today; a screen that does would have to publish it too.
- "Made in Reverie" on a second identity. Everything shown was read as the host of its own rooms;
  there is no policy granting a browser a wider read of `jams`, so a public gallery would need a
  migration that does not exist.

## 2026-09-20 — A refused Play said nothing where Play is (RV-24)

- Pressing Play against a server with `REVERIE_DIRECTOR_ENABLED` unset looked like nothing
  happening. The server answered `503 director_disabled` correctly and the screen did render
  the reason — at the foot of the player card, under the direction log and a paragraph of
  notes. The notice now sits directly under Play and Stop, above the direction field, and a
  DOM test asserts its position rather than merely its presence (it fails with the old
  placement).
- Two comments in `JamDirector` still described the host-owned start RV-23 removed. Corrected.
- `REVERIE_LIVE_ENABLED=true` does not buy the director: it is gated separately by
  `REVERIE_DIRECTOR_ENABLED` because it bills per second with a sixty-second minimum
  (`.env.example` says so). That is the configuration this bug was hiding.
- Verified: `pnpm typecheck`; `pnpm test` 1210/1210; `pnpm build`. Reproduced against the
  running local stack before and after: `GET /director/budget` answered `configured: false`,
  and `POST /director/session` answered `503 director_disabled`.

## 2026-09-20 — The room says what it is doing, and what it costs (RV-24)

- **A refused Play said nothing where Play is.** The server answered `503 director_disabled`
  correctly and the screen rendered the reason at the foot of the card, under the direction log
  and a paragraph of notes. It now sits directly under Play and Stop, and a DOM test asserts its
  position rather than its presence (it fails with the old placement).
- **The emphasis follows the take.** While one runs, Stop is the primary control and Play is a
  disabled "Playing" label; idle, it is the other way round. On both the room screen and the
  solo Director stage.
- **The cost is stated before the press and while it runs.** The room reads
  `GET /director/budget` on mount and the session snapshot's `spend` on every poll — both were
  being thrown away. Idle: the 60-second minimum, where the take stops itself, and that opening
  one *holds* the whole ceiling against the budget until it settles (the number that surprises).
  Live: what this take has cost, what is left, and the cap. `GET /director/budget` now also
  carries `maxSessionSeconds`, so the commitment can be named before a session exists.
- **Two silences broken.** A relay that cannot attach now says so (an empty frame under a
  PLAYING badge read as a take that was not running), and a failed Stop says so — it is the one
  failure on this screen that leaves money being spent.
- **The direction field is gone.** Steering a take belongs to the outline queue, where the
  room's mechanisms (vote, poll, chat) queue a beat edit and the server decides what reaches the
  provider. A free-text box beside the player was a second, unqueued way in. The direction log
  stays: it shows every direction that reaches the take, whichever mechanism sent it.
- **`draft` is retired** (`20260920110000_jam_starts_live.sql`). Nothing ever wrote a status
  other than the default, so every registry card read DRAFT for its whole life — including
  rooms that were playing. A jam is live the moment it exists: the default is now `live`,
  existing rows are moved, `draft` leaves the check constraint, and the registry reads the
  server's `live | playing | ended` lifecycle instead of the column. `jamStatusSchema` still
  *accepts* `draft`, deliberately: a database without this migration must not have its rows
  dropped by a stricter parser.
- Verified: `pnpm typecheck`; `pnpm test` 1215/1215; `pnpm build`. The migration was applied to
  the local stack and checked: both existing rooms read `live`, and the column default is
  `'live'`.
- **Not verified:** no fal session was opened, so the live cost line has been exercised against
  a fake spend payload rather than a real take.

## 2026-09-20 — One endpoint Galtea can call: `POST /api/evaluate`

Galtea evaluates a deployed agent by calling one HTTP endpoint. Discover's three conversational
endpoints are no use to it: each needs a viewer's Supabase session, and an anonymous one expires
inside an hour, so a token pasted into an evaluation suite would die partway through the run.

**`POST /api/evaluate` runs the whole funnel for one viewer message** — interpret, apply the turn
the engine accepted, read the catalogue for the state that produced, rank, critique — and answers
with what the viewer would have seen. The body is `{ "input", "history"? }`; the history is
earlier viewer messages replayed through the same engine in order, so a multi-turn case is a real
conversation rather than a state handed in. Each request runs in a fresh throwaway session.

**It is authenticated by one static token**, `Authorization: Bearer <GALTEA_EVAL_TOKEN>`, held in
the environment and compared over SHA-256 digests so neither the value nor its length leaks
through how long the check takes. A viewer's Supabase token is never accepted here, and the eval
token is never logged, echoed or returned. With no `GALTEA_EVAL_TOKEN` configured the endpoint is
`503 EVAL_NOT_CONFIGURED` rather than open. `.env.example` carries the placeholder; the real value
lives only in the ignored `.env.local` and in the Vercel project.

**It is not a second funnel.** The three model steps moved out of the handlers into
`api/_lib/discover-funnel.ts` — `interpretStep`, `rankStep`, `critiqueStep`, each behind the same
in-process concurrency cap — and `/api/discover/turn`, `/api/discover/rank` and
`/api/discover/critique` now call them too, so there is one implementation with two callers. The
shortlist is `toShortlistRead` plus the same `fetchCatalogue` adapter `/api/catalogue` uses, the
order is `orderByAssistant`, and `toRankCandidate` moved from the browser's `assistantClient` into
`src/conversation/contract.ts` so both paths map a title the same way. The browser's fallbacks
hold as well: a ranking that does not arrive leaves the deterministic scorer's order, and a
critique that does not arrive leaves the ranking's reasons. Only a failure to interpret ends the
call, because then there is no turn to read the catalogue for.

**The catalogue is read as the server, never as the caller.** The harness has no Supabase session
and must not be given one. `search_catalogue_titles` is granted to `authenticated` and revoked
from `anon`, so the anon key alone cannot read it; `api/_lib/supabase-server-session.ts` resolves
`SUPABASE_SERVICE_ROLE_KEY` when it is set, and otherwise signs the server in anonymously with the
anon key and caches that session per process. Without either there is no catalogue, and the
endpoint says so rather than answering with nothing.

### Verified

- `npx tsc --noEmit` clean. `pnpm build` clean.
- `pnpm test`: 1336 tests, 1325 pass, 3 fail, 8 cancelled. The failures are the pre-existing
  `directorPieces` / `directorPieceMuxer` worker-thread tests, which fail the same way on this
  machine without this change.
- New: `tests/evaluateEndpoint.test.ts` (10) over a fake provider and a fake catalogue — the four
  ways a token can be wrong, a missing configuration, four malformed bodies, the single-turn case,
  the multi-turn case (the history's genre and the message's length are both in the catalogue
  read, and the film the constraint rules out appears nowhere in the answer), the titles and the
  critic's reasons in `output`, and both fallbacks.
- Against the local Node server on port 4387, the real Nebius provider and the hosted Supabase
  project, with no `SUPABASE_SERVICE_ROLE_KEY` set — so the anonymous server session is the path
  that ran:
  - no header, a wrong token and a token in the wrong scheme each answered `401 UNAUTHENTICATED`;
    a body of `{"nope":1}` answered `400 INVALID_REQUEST`.
  - `{"input":"a scary film under two hours"}` answered 200 with
    `filters {maxRuntime: 119, includeGenres: ["horror"]}`, 3,902 matching titles, picks
    *The Nun II* (2023), *Talk to Me* (2023) and *No One Will Save You* (2023), and a critique on
    each — three parts apiece, in `output`.
  - `{"input":"actually nothing scary, a comedy about a heist that goes wrong","history":["something for a Friday night","nothing over two hours"]}`
    answered 200 with `subject "heist goes wrong"` and
    `filters {maxRuntime: 119, includeGenres: ["comedy","thriller"], excludeGenres: ["horror"]}`:
    the length came from the history's second message, the horror exclusion and the subject from
    the message being evaluated. Both turns of the history were really replayed.

### Not verified

- No call against the deployed Vercel function. Everything above ran through the local Express
  server, which mounts the same handler.
- The `SUPABASE_SERVICE_ROLE_KEY` branch of the server session. No such key is configured here, so
  only the anonymous path has a receipt.
- No Galtea run. The response shape is what the brief asked for; whether an evaluator grades
  `output` well is not something a unit test can answer.

## Next milestones

1. Done: every migration is on the hosted project and `pnpm verify:realtime` passes 27/27.
   Next, adopt a Supabase CLI link so future migrations get applied and tracked, not pasted.
2. Done: Discover serves the TMDB snapshot. Next, deploy it and confirm that `/api/catalogue`
   answers `ok` on Vercel with the Supabase server variables set.
3. Versioned transactional scene contract: atomic voting, `expectedStateVersion`, idempotent
   `requestId`, and serialized scene acceptance. Generation only after that contract exists.
4. `pnpm probe:vonage` passes with the application credentials; next, verify the live stage in
   two browsers against the migrated Supabase project.
