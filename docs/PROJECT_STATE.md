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
- Durable updates arrive through Postgres Changes; Presence reports who is connected;
  Broadcast is not used as authority. Realtime channel `jam:<id>` is private and authorized
  through `realtime.messages` RLS against active membership.
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

- The server now owns a per-jam playback cursor with a derived lock window: played portions are immutable, the next portion is locked as the generation buffer, and only later portions stay editable (contract in `docs/API_CONTRACTS.md`). Advancing is host-driven, `expectedStateVersion`-guarded, and only possible one portion at a time once the locked portion's clip is ready.
- Locking a portion enqueues a bounded video-generation job (concurrency 1); finished clips land in a capped in-memory `PortionMediaStore` and stream to clients at `GET /api/jams/:id/portions/:index/video` with Range support. Clients never receive provider URLs. `GET /api/jams/:id/playback` is the polling surface until Realtime events land.
- A typed fal.ai queue adapter exists behind `REVERIE_LIVE_ENABLED` + `FAL_KEY` with a server-owned model allowlist. It is NOT probed: no fal model has been verified, no credentials exist in the repo, and playback start returns a typed `generation_disabled` error until live configuration is provided. A dated probe receipt in `docs/DECISIONS.md` must precede any claim that generation works.
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

## Next milestones

1. Apply every migration in `supabase/migrations` to a Supabase project and run
   `pnpm verify:realtime` to turn the lobby, invite lifecycle and Realtime work from
   implemented into verified. This is the single blocking gap in the collaboration slice.
2. Supply an authorized catalogue contract (`TITAN_CATALOGUE_URL` plus a credential) and
   re-probe `/api/catalogue` against it; Discover renders real titles as soon as it validates.
3. Versioned transactional scene contract: atomic voting, `expectedStateVersion`, idempotent
   `requestId`, and serialized scene acceptance. Generation only after that contract exists.
4. Supply a video-capable Vonage application (`VONAGE_APPLICATION_ID` plus
   `VONAGE_PRIVATE_KEY`), run `pnpm probe:vonage` for the session/token receipt, then verify
   the live stage in two browsers against a migrated Supabase project.
