# Reverie — Movie Jam

> Find a real film to watch by talking about what you are in the mood for, then open a room where a group writes a new short film together.

Reverie is an open-source HackBarna 2026 project with two separate modes. **Discover** searches a real movie catalogue: a curated snapshot of the TMDB dataset named by the Titan OS challenge. **Movie Jam** is a room where a host and admitted participants chat, queue proposals for what happens next, and work from a generated or imported screenplay. Proposals are shared with the whole room as they arrive. Voting on them and turning an accepted proposal into the next scene are not built yet: both wait on a versioned transactional contract that does not exist.

## What works today

### Discover

- **A real catalogue.** 27,839 released films from the TMDB dataset, held in `public.catalogue_titles` on the hosted Supabase project and searched with ranked full-text search. Titles, artwork and metadata are the dataset's own, and every screen that shows them carries the TMDB attribution. The dataset says nothing about where a film streams, so Discover never implies it.
- **Conversation, backed by Nebius.** The viewer types what they feel like watching. Nebius turns each message into constraints (genres, a runtime limit, an era), asks at most one clarifying question, and then reorders the shortlist the database returned. It cannot add a film the database did not return, and any quote it cites must appear word for word in the viewer's message. If Nebius is unavailable, Discover says so and ranks by genre match instead.
- **Refinement without the model.** Chips ("Something scary", "Under two hours", "From the nineties"), a rail showing what currently shapes the results, and "Not this one" to turn a title down.
- **One conversation at `/search`.** The screen opens on a field and a microphone and shows no film until you ask. Type or say a film's name or what you feel like; each answer's posters sit under the reply that produced them, and a refinement adds a block rather than rewriting the page. Filters have their own panel. A poster opens a preview with the film's page and "Start a Jam from this"; nothing plays a catalogue film. `/discover` leads to `/search`.
- **Built for a TV.** Laid out for 1920×1080 viewed from about three metres, fully usable with arrow keys, Enter and Escape. Each film has its own page at `/discover/:id`.

### Movie Jam

- **Rooms with real access control.** Supabase-backed rooms, anonymous identity, and a `/jams` list of the rooms you host or have joined. Invites work by code, link or QR, can expire, and can be rotated or revoked. A public room admits guests on arrival; an invite-only room holds them in a lobby until the host admits them. The host can remove anyone. Row-level security enforces each of these rules, not just the UI.
- **Shared chat and proposals.** Append-only, synchronized through Supabase Realtime, and reloaded from the database on every reconnect.
- **A shared playback clock.** The host starts, pauses and resets a room-wide timer anchored to the database's clock, so every participant sees the same position.
- **A screenplay to work from.** The host generates one from a short prompt (Nebius) or imports their own markdown. The script is split into timed portions. Each portion can be edited on its own, and every change is kept as a revision that can be restored.
- **An outline to steer from.** Every portion carries a one-phrase beat, written with the script. The room reads the beats instead of the screenplay, rewrites one or rejects it, and the story after it is re-derived in one model call and committed as a new revision. Edits queue one at a time per jam, respect the live director's lock window, and the changed beat is sent to any open stream as direction. Probed live on 2026-09-20 against the local stack: the model writes the beats with the script, and rewriting one re-derives the rest around it without changing any portion's length. Sending a beat to a live stream is still unobserved. The spec is `docs/specs/story-outline.md`.

- **An escape room.** A third source when a jam is created, beside starting from scratch and importing a script: a fixed world and a goal, authored as data in this repository, that the room shares control of one character inside. The rules decide what happened — a pure, offline module resolves a proposal into an advance, a refusal with the author's own reason, or something impossible here and now — and the model writes the prose and the shot from that outcome. Each location has one short looping shot, generated once and played while the room argues, so the screen is never dead while the next beat renders. It reuses the jam wholesale and is drawn inside the jam screen. Three scenarios ship. See [the scenario format](docs/specs/escape-room-scenario.md).
- **Opt-in live camera, microphone and screen (Vonage Video API).** Nothing is published until the participant consents. Each consent records its owner, purpose and expiry, and withdrawing it stops the track. Nothing is recorded. Opening a session and minting a token have been proven against Vonage, but a live stage between two browsers has not been tested.
- **Choosing to appear in the film.** A participant can agree to be a character in the film the room is generating. One frame from their own camera, taken on their own press and approved by them before it is used, becomes the character reference, and beats are generated with `minimax/h3-max/reference-to-video` so the person on screen is them. Agreeing is its own grant in the same consent register, separate from joining the room and separate from turning on a camera. Withdrawing is one press and stops the next beat immediately; beats already generated still show the person, and the room is told exactly that rather than being promised a recall. The frame never reaches another participant's browser. Both models were measured live; a room where nobody has agreed generates as it always did. See [the spec](docs/specs/appearing-in-the-film.md).

## Not built yet

- Voting on a Movie Jam's own proposal queue, and turning an accepted proposal into a scene. The Studio says this on screen. (An escape room has its own turn and vote, which are a narrower mechanism and do not implement that contract.)
- Generated video for a Movie Jam's script. The live director holds a real MiniMax H3 Max session but its media track has never been watched, and capturing it blocks the server. Video in an **escape room** works and is verified: see [Project state](docs/PROJECT_STATE.md) for the measured numbers.

- Voting, and turning an accepted proposal into a scene. The Studio says this on screen. Beat generation exists as a route (`POST /api/jams/:id/beats/:index/video`, Node server only) and both its models are verified live, but nothing in the Studio yet drives it, and `POST /api/jams` playback generation still returns `generation_disabled`.
- Voice input and transcription (SLNG), image and video-clip uploads, forks, recording, broadcast and export.
- Translated or re-styled playback per participant. A session stores those settings, but nothing renders them.

The Studio's scene panel is a static illustration, not generated output.

## Technology stack

| Layer | Technology | State |
| --- | --- | --- |
| Client | React, TypeScript, Vite | Discover, the jam list, create, join, lobby and Studio screens |
| Vercel functions | Node handlers in `api/` | `health`, `catalogue`, `catalogue-title`, `discover/turn`, `discover/rank`, `discover/critique`, `live/token`. A Vercel deployment has not been verified. |
| Local server | Express (`apps/server`) | Serves the app and the same handlers, plus the script, session and playback routes. Those routes run only here and keep their state in memory. |
| Collaboration | Supabase Postgres, Auth, RLS, Realtime | Hosted project migrated; `pnpm verify:realtime` passed 27/27 against it |
| Validation | Zod | Command and provider-response schemas at every boundary |
| Reasoning | Nebius (`Qwen/Qwen3-30B-A3B-Instruct-2507` for Discover) | Script generation and the Discover conversation, both verified live |
| Live media | Vonage Video API | Implemented. `pnpm probe:vonage` passed; the two-browser stage is untested. |
| Generated media | fal.ai | Two surfaces behind one model allowlist and one spend ceiling: `minimax/h3-max/text-to-video` for escape-room segments, verified live; the realtime `minimax/h3-max/director` handshake, whose media track is unverified |

| Generated media | fal.ai | Adapter behind a server-owned model allowlist. `minimax/h3-max/text-to-video` and `minimax/h3-max/reference-to-video` verified live (`pnpm probe:beat-video`); the live director's model is not. |
| Speech | SLNG | Planned, no code |
| Catalogue | TMDB snapshot in Postgres | Live: 27,839 films |
| Invites | `qrcode.react` | Link, QR, code, expiry, rotation and revocation |

Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are browser configuration. Provider secrets stay in ignored local environment files or server environment variables. Discover reads the catalogue through the `search_catalogue_titles` and `get_catalogue_title` functions using the viewer's own session. The server reads `SUPABASE_URL`/`SUPABASE_ANON_KEY` and falls back to the `VITE_` pair. Paid provider calls stay off until `REVERIE_LIVE_ENABLED=true`. There is no Titan API.

## Run it

For the local Docker stack, start Docker Desktop and run:

```bash
docker compose up --build --wait
```

Then open http://localhost:4317.

This starts local Supabase (Postgres, Auth, PostgREST, Realtime and a gateway), applies every migration, and serves the production build from the local Express host. `.env.compose` holds the local-only Supabase values; the app also loads an optional `.env.local` for server-side provider credentials. Stop the stack with `docker compose down`; database data stays in its named volume. This does not prove Vercel parity, and the script, session and playback stores reset when the app container restarts. `pnpm verify:realtime` passes 34/34 against this stack, including 7 playback-clock checks.

Without Docker:

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm dev
```

Then open http://127.0.0.1:4317.

Checks:

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm build
```

```bash
curl --fail http://127.0.0.1:4317/api/health
```

Create `.env.local` from `.env.example`, then follow [Supabase setup](docs/SUPABASE_SETUP.md) and [Vercel deployment](docs/VERCEL_SETUP.md). Without Supabase configuration the app runs as a clearly labelled, non-shareable local preview. A configured project that fails reports the failure and never falls back to the preview. Live checks against configured services: `pnpm verify:realtime`, `pnpm verify:shortlist`, `pnpm verify:conversation` and `pnpm probe:vonage`. `node --import tsx scripts/probe-escape-segment.mts` generates one real escape-room segment and reports what the model actually returned; it costs money, so run it deliberately.

Create `.env.local` from `.env.example`, then follow [Supabase setup](docs/SUPABASE_SETUP.md) and [Vercel deployment](docs/VERCEL_SETUP.md). Without Supabase configuration the app runs as a clearly labelled, non-shareable local preview. A configured project that fails reports the failure and never falls back to the preview. Live checks against configured services: `pnpm verify:realtime`, `pnpm verify:shortlist`, `pnpm verify:conversation`, `pnpm probe:vonage` and `pnpm probe:beat-video`. The last one generates two real clips and spends real money.

Design documents:

- [Architecture](docs/ARCHITECTURE.md)
- [Technology stack and provider strategy](docs/TECHNOLOGY_STACK.md)
- [Internal API contracts](docs/API_CONTRACTS.md)
- [State machines](docs/STATE_MACHINE.md)
- [The escape-room scenario format](docs/specs/escape-room-scenario.md)
- [Decisions](docs/DECISIONS.md)
- [User-journey runbooks](docs/user_journeys/README.md)
- [Contributor instructions](AGENTS.md)

## Status and known gaps

[Project state](docs/PROJECT_STATE.md) is the dated record of what exists and what has been verified. As of 2026-09-19:

- **Implemented:** a TV home at `/` (a hero, genre and era shelves that load as they approach, and a Movie Jam spotlight) under one top bar shared by every screen; create/join/studio routes; the TV-first `/search` conversation with title lookup, voice, a filter panel and film previews (`/discover` redirects to it; film pages stay at `/discover/:id`); the privileged `GET /api/catalogue` adapter; local preview; Supabase-backed room creation; the `/jams` registry; script generation from a prompt; script import that keeps the pasted markdown; invite-code entitlement; display names; the waiting lobby; host admission and removal; append-only chat and proposals synchronized through Supabase Realtime with reconnect snapshots; local and Vercel health handlers; and opt-in live media (camera, microphone, screen) behind `POST /api/live/token` with a consent register that records owner, purpose, expiry and a server-issued asset reference, where withdrawing consent stops the track and nothing is recorded, exported or transformed.
- **Verified against live services:**
  - the hosted Supabase project: `verify:realtime` 27/27, covering invites, lobby, admission, RLS, Realtime delivery, reconnect and removal
  - Discover over the live catalogue: `verify:shortlist`, and `verify:conversation` with Nebius, which passed three times
  - script generation through Nebius
  - Vonage session and token creation: `probe:vonage`
  - both beat models, plain and likeness: `probe:beat-video`, 5-second 768p clips in 5.8 s and 8.6 s
- **Verified locally only:** the shared playback clock, in two browsers on the local stack; 554/554 unit tests.
- **Not verified:** a Vercel deployment; a live Vonage stage between two browsers; the director model's media track; two browsers in one escape room. Hosted migrations were applied by hand, so no tracking table records them.

- **Not verified:** a Vercel deployment; a live Vonage stage between two browsers; the live director's fal model; likeness fidelity, since the beat probe's reference frame is a synthesised image rather than a photograph of a person. Hosted migrations were applied by hand, so no tracking table records them.
- **Not implemented:** everything under [Not built yet](#not-built-yet).
- **Deliberately blocked:** scene acceptance, which waits on a versioned transactional contract.

## Initial demo

The HackBarna demo will start with a host-led story, then reveal a QR code so audience members can join. The host admits participants, who submit and vote on twists. The winning direction becomes the next scene while the audience watches the movie take shape in real time.

## Status

Implemented: the public landing page at `/` (static HTML with real catalogue posters chosen at build time), the Movie Jam home at `/home`, create/join/studio routes, the TV-first `/discover` route with keyboard traversal and search, the privileged `GET /api/catalogue` adapter, local preview, Supabase-backed room creation, the `/jams` registry that lists the rooms you host or have joined, script generation from a prompt, script import that keeps the pasted markdown, invite-code entitlement, display names, the waiting lobby, host admission and removal, append-only chat and proposals synchronized through Supabase Realtime with reconnect snapshots, plus local and Vercel health handlers. Opt-in live media (camera, microphone, screen) is implemented behind `POST /api/live/token`
with a consent register that records owner, purpose, expiry and a server-issued asset
reference, and withdrawing consent stops the track; nothing is recorded, exported or
transformed. The Vonage credentials in this repository are account-level, not a video-capable
application, so a session has never been opened from here and the route reports
`live_not_configured` — see `docs/PROJECT_STATE.md` for the dated probe receipts. Voting,
scene acceptance and generation remain unimplemented; scene acceptance is deliberately blocked on a versioned transactional contract. No catalogue contract has been supplied, so Discover reports an unconfigured catalogue rather than showing titles. No hosted Supabase project has been migrated from this repository; the collaborative behaviour and RLS are verified against the local Docker stack (`pnpm verify:realtime`, 27/27) but not against a hosted database — run it against a configured project to produce that evidence. Hosted deployment also remains pending.
## Contributing

Every contributor works on a branch, opens a PR and merges it after checks; nobody pushes directly to `main`. Read [the collaboration workflow](docs/CONTRIBUTING.md) before editing shared files.

## License

[MIT](LICENSE)
