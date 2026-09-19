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

## Next milestones

1. Apply every migration in `supabase/migrations` to a Supabase project and run
   `pnpm verify:realtime` to turn the lobby and Realtime work from implemented into verified.
2. Versioned transactional scene contract: atomic voting, `expectedStateVersion`, idempotent
   `requestId`, and serialized scene acceptance. Generation only after that contract exists.
3. Separate Titan Discover UI grounded only in verified catalogue records.
4. Vonage opt-in live-media controls and consent metadata; provider adapters after documented probes.
