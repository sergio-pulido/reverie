# Decisions

## 2026-09-19 — Generated streams are keyed by configuration, and a cap makes the room attach

Per-participant overrides select a configuration (today `language` + `ambientation`), and Reverie
generates **one stream per distinct configuration present in the room**, not one per participant:
two sessions with the same configuration receive the same stream. To keep paid generation and
storage from scaling with headcount, the server caps how many distinct configurations are held at
once. When the cap is full, a participant whose configuration is not active is shown the active
configurations and **attaches to one** instead of triggering a new generation. The cap is a
budget control in the same family as the provider model allowlist and the concurrency gate; it
must never silently fall back to a mock or generate outside the budget. This is intended, not
implemented: the cap value, eviction policy, configuration-key normalization, and whether
attaching rewrites session settings remain unspecified. See
`docs/specs/configuration-keyed-streams.md`.

## 2026-09-19 — A session is a seat in the collaborative room, with per-participant overrides

A jam has one collaborative room and one authoritative script; a `jam_sessions` record is a
participant's seat **in that same room**, not a separate playback space. The session carries
only per-participant overrides (`language`, `ambientation`) layered on the common behaviour, so
everyone still collaborates on the same shared activity. This refines "A jam session is one
user's playback seat" below: the variation is still stored and never forked into the script, but
the seat is understood to sit *inside* the shared room rather than beside it. Implementation gap:
the playback session (owner-token `JamSession`) and room membership (Supabase `jam_members`) are
currently separate records, and creating a session does not admit the participant. Unifying the
two is a design task, not shipped behaviour.

## 2026-09-19 — A draft that misses the runtime is corrected on the next attempt

The scriptwriter no longer sends the same prompt twice and then reports a fit failure. When a draft is outside the rescalable window, its actual total seconds, portion count, and whether it ran long or short are fed back into the next attempt together with the feasible portion band for the jam's target, so the retry is a directed correction. The same applies to a reply that fails the draft shape: the exact JSON shape is restated. Attempts stay bounded at four paid completions because each one costs money and the concurrency gate is the only other spend control; only after that cap does the fit miss become the typed, retryable `generation_failed` that a room can retry. The 0.8×–1.25× rescale window is unchanged — a draft too far off is still never silently stretched.

## 2026-09-19 — A jam registers its room first, and import is a first-class creation source

Creating a jam now registers the room before the script exists, and the pre-minted room id is passed to `POST /api/jams` as `jamId`, so one jam owns exactly one script and its revision history instead of a second, unrelated server id. `/jams` lists the rooms an identity can read (host or any member) and offers "start a new jam"; without Supabase it is an explicitly non-shareable browser-local registry, never presented as shared. Creation has two sources: generate from a prompt (Nebius, behind the existing gate) or import an existing script. Import makes no provider call, stores the pasted markdown verbatim as revision 1, and derives a word-boundary, format-bounded timed projection for playback; text that cannot fill or fit the runtime is refused with `invalid_script_import` rather than padded or shredded into mid-word fragments. The earlier "from an existing movie" prompt path stays supported by the API but is no longer a create-screen option, matching the product decision that a room brings its own script.

## 2026-09-19 — A live token is minted from membership, never requested

The browser asks for a live token with a jam id and its Supabase access token, and nothing
else; an extra `role` field is rejected rather than ignored. The function resolves identity
through Supabase Auth, reads the caller's own `jam_members` row with that same token — so it
is bound by the same RLS as the browser and needs no service-role key — and maps the result
to a Vonage role. A participant cannot hold a moderator token by asking for one, and cannot
hold any token while waiting or after removal. The token lasts ten minutes because rejoining
is cheap and a long-lived credential in a browser is not.

## 2026-09-19 — Consent is a row, and withdrawing it stops the track

A live contribution is permitted only while a `jam_live_consents` row for that owner and that
track kind is unwithdrawn and unexpired. The row records the declared creative purpose and a
server-issued `live:<uuid>` asset reference, so anything downstream cites the reference rather
than the raw feed. A database trigger issues that reference and clamps the lifetime, because a
reference the browser chose would not be server-issued and an expiry the browser chose would
not be a limit. Withdrawal is a `security definer` function that can stamp only the caller's
own row: there is no update or delete policy, so a consent record cannot be rewritten into
something its owner did not agree to. Expiry and withdrawal are the same answer to every
consumer, which is why nothing downstream has to know which one happened.

## 2026-09-19 — Live media records nothing by default

Sessions are created with `archiveMode=manual` and the slice contains no archive, broadcast,
RTMP, caption or transformation call at all. Recording, export and creative transformation are
separate permissions with their own consent fields and budgets; none of them may be reachable
as a side effect of a participant turning on a camera. fal.ai is not wired to a live feed here.

## 2026-09-19 — The Vonage credentials in this repository cannot open a video session

Two bounded probes on 2026-09-19 settled which credential shape exists. `POST
https://api.opentok.com/session/create` with an HS256 project JWT returned 403, and `GET
https://api.nexmo.com/v2/applications` with the same key and secret returned 200 listing zero
applications: these are valid Vonage *account* credentials, the configured
`VONAGE_APPLICATION_ID` is not reachable from that account, and no private key is supplied.
The adapter supports both documented shapes — an application id with an RS256 private key
against `video.api.vonage.com`, and a numeric legacy project key with an HS256 secret against
`api.opentok.com` — and accepts neither an account key nor a half-configured pair. Until a
video-capable application is supplied, `/api/live/token` answers `live_not_configured` and the
studio says live media is off. A working stage is not claimed on the strength of code that
compiles.

## 2026-09-19 — Script timing is a per-jam format with the 4-minute defaults

The total runtime and portion length band are per-jam parameters (`format`: total 10–900 seconds, portions 4–60 seconds, at most 48 portions) instead of global constants; omitting them keeps the established 4-minute, 10–20 second behaviour. The low floor exists for tiny test jams, and the scriptwriter's completion token budget scales with the expected portion count instead of paying a flat worst case. Hard bounds (±2 seconds) and the total tolerance (~6% of runtime) are derived from the chosen format, so the writer prompt, draft rescaling, and validation stay a single consistent system at any length. Stored scripts validate against a format-agnostic structural schema; strict timing is enforced at generation time against the jam's own format.

## 2026-09-19 — A jam session is one user's playback seat, not a copy of the script

Per-user variation (language, ambientation) lives in a `jam_sessions` record attached to the jam, never in a forked script: the room keeps one authoritative script and each session stores the parameters that will skin its owner's playback. In the local server, ownership is a bearer token issued once at session creation (Supabase RLS with `auth.users` ownership is the persistent equivalent, one session per user per jam). Sessions record playback parameters only; per-session generated media is a later, budgeted provider step.

## 2026-09-19 — Generated jam scripts are 4 minutes of 10–20 second scene portions

A jam starts from scratch (a small prompt) or from an existing movie (inspiration only, never a retelling). The script targets 240 seconds total, told in scene portions of 10–20 seconds (hard bounds 8–22 for coherence); a scene may hold several portions. Zod validates the model draft, and drafts within 190–300 seconds are deterministically rescaled and settled onto exactly 240 seconds — anything further off is a typed, retryable failure, never silently accepted. The script is stored as structured data (the authority) and rendered to markdown on request.

## 2026-09-19 — Nebius script generation runs behind a server-owned allowlist

`POST /api/jams` calls Nebius chat completions in JSON mode through the typed server adapter. The server owns the model allowlist (default `Qwen/Qwen3-235B-A22B-Instruct-2507`); `NEBIUS_MODEL` may only select an allowlisted model. Generation is enabled only when `REVERIE_LIVE_ENABLED=true` and a key is present — otherwise the endpoint returns a typed `generation_disabled` error instead of a mock. Probe receipt (2026-09-19): `GET /v1/models` 200; JSON-mode completion on the default model 200 in 0.85s, 39 tokens.

## 2026-09-19 — Jam persistence sits behind a JamStore interface

`createJamsRouter(store)` takes a `JamStore` (`createJam`, `getJam`) instead of owning data. The bounded in-memory store is the local development implementation; the Supabase-backed store (RV-03) replaces it without route changes, mirroring the Vercel/Supabase target architecture.

## 2026-09-19 — Use Vercel and Supabase for the public prototype

The public prototype deploys the Vite frontend and privileged Node functions to Vercel, while Supabase provides Postgres, anonymous Auth, Row Level Security, Realtime, and later Storage. This gives the demo persistent room URLs and multi-browser collaboration without operating a custom WebSocket server on a serverless platform.

## 2026-09-19 — Retain a local same-origin development server

Superseded for deployment by the Vercel/Supabase decision above. Express remains the local Vite/static-preview host; persistent room state belongs in Supabase, and collaboration uses Supabase Realtime.

## 2026-09-19 — Keep sponsor technologies behind adapters

Nebius, SLNG, fal.ai, Titan, and any confirmed HackBarna sponsor capability are server-side integrations behind typed adapters. The product contracts do not depend on one model/vendor, and no provider is represented as available before a live probe confirms it.

## 2026-09-19 — Server owns collaborative story state

The server is authoritative for membership, queue ordering, votes, story versions, accepted scenes, and budgets. Clients render snapshots/events and can show pending feedback, but cannot commit a scene independently.

## 2026-09-19 — Use Titan catalogue records as real cinema, not synthetic content

The Discover experience renders Titan-provided real films and series faithfully. Catalogue metadata and generated Movie Jam artifacts have separate schemas, identifiers, and labels so the product never presents an invented/generated work as a real title or rewrites existing films as jokes.

## 2026-09-19 — Treat media as declared creative references

Images, uploaded clips, and live camera are inputs to a shared creative turn, not opaque prompt attachments. Each has an owner, consent state, declared purpose, lifetime, and server-issued asset reference. Live media uses Vonage for room transport and fal.ai only for explicitly permitted creative transformation.

## 2026-09-19 — Script history is append-only full snapshots

The script is versioned as an append-only sequence of full snapshots behind the `JamStore` boundary. Undo restores an earlier revision as a new revision recording `restoredFromRevision`, so redo is just another restore and history is never rewritten; identical-content saves are ignored so autosave cannot flood the history. Full snapshots (≤500 revisions per jam) were chosen over diffs because a movie-jam script is small and restore must be trivial. In Supabase this is `jam_scripts` (artifact) plus `jam_script_revisions` (history) hanging off the room row in `jams`, with no update/delete policies on revisions. Amended same day: revisions snapshot the structured script, not markdown — see the next decision.

## 2026-09-19 — Structured script is the editing source of truth

Video playback needs portion-level locking (played portions immutable, the generation buffer pinned at a revision), which opaque markdown edits cannot support. Revisions therefore snapshot the structured `JamScript` and markdown became a deterministic per-revision render (it was never canonical — `renderScriptMarkdown` already varies per session). Edits are portion-scoped (`PATCH .../script/portions/:portionIndex`, flat zero-based index, structural edits forbidden in v1) and validate duration against the jam format's hard portion bounds only — the total-runtime tolerance is not re-enforced on live edits. The store stays persistence-only: edit and revert take a `minEditablePortionIndex` parameter wired by the router from the playback guard inside the same per-jam critical section (`withJamLock`), reverts that would change a locked portion are rejected outright (no partial reverts, so pinned text is immutable by construction), and playback state persists through `getPlayback`/`updatePlayback` under compare-and-swap while its semantics live in the playback module. Full contract: docs/API_CONTRACTS.md "Portion playback, locking, and video generation" (agreed with RV-06).

## 2026-09-19 — Start with one same-origin local development server

The first runnable baseline serves the Vite client through the Node/Express process at `127.0.0.1:4317`. This keeps browser-to-server contracts and provider boundaries easy to iterate on locally. It is a local development baseline, not the public deployment configuration.

## 2026-09-19 — Align deployment and collaboration foundation

Vercel serves the Vite SPA and `/api` Node functions. API paths are excluded from the SPA rewrite; health does not assert provider/database readiness. Supabase owns identity and persistent state. No extra database, WebSocket service or provider integration is introduced.

The primary agent commits and pushes completed verified slices directly to `main`, including documentation. The collaborator uses isolated PR branches and auto-merge after checks. Fetch before publication, stage owned files explicitly, and never force-push shared history.

## 2026-09-19 — Ship Discover as a configuration-driven adapter with an explicit unconfigured state

*Superseded by "The catalogue is a curated TMDB snapshot in Postgres; there is no Titan API" below.*

A credential named `TITAN_API_KEY` exists, but no Titan catalogue endpoint, request shape or response schema is published or supplied, and the Titan SDK publishes no content API. Rather than guess a base URL, substitute a different provider under Titan's name, or seed placeholder films, the catalogue adapter takes its endpoint from `TITAN_CATALOGUE_URL` and reports `catalogue_not_configured` until an authorized contract is supplied. The expected upstream contract is written down in `docs/specs/discover-titan-catalogue.md`, so adopting a real catalogue changes one adapter file and nothing else. An empty Discover screen that says why is honest; an invented catalogue is not.

## 2026-09-19 — Validate every catalogue record individually and drop what fails

A single malformed upstream record must not blank the whole page, and a partially trusted record must not be rendered as if complete. The adapter validates each record on its own, drops records that fail, and strips any non-`https` artwork or availability URL rather than rejecting the title around it. The browser re-validates the response it receives, so an unexpected shape becomes an explicit error state instead of a half-rendered title.

## 2026-09-19 — The invite code, not the room URL, is the entitlement

A jam carries a server-generated 8-character code from an alphabet with no I, O or U so it
can be read aloud in a room. A room URL can be screenshotted, indexed or forwarded; an
entitlement should be something the host hands out deliberately. Admission exchanges the
code and a display name for a membership row through a constrained `security definer`
function, and the browser has no write policy on `jam_members` at all.

## 2026-09-19 — Public jams admit on arrival, invite-only jams wait

A public jam activates a guest as soon as they present the code, because asking a host to
admit an audience one by one is the wrong default for a live demo. An invite-only jam keeps
the waiting lobby from `docs/STATE_MACHINE.md`. Removal is host-only in both cases and a
removed participant cannot re-enter with the same code.

## 2026-09-19 — Membership checks run through security definer helpers

A policy on `jams` that reads `jam_members`, while a policy on `jam_members` reads `jams`,
recurses. `is_jam_host`, `is_jam_member` and `is_active_jam_member` read with RLS bypassed
and are the single place membership is decided, for table policies and for the private
Realtime channel alike.

## 2026-09-19 — Rows are authority, Postgres Changes are notification, Broadcast is neither

Durable collaborative state is rows under RLS. Postgres Changes tell a subscriber that such
a row exists and are filtered by the same policies. Presence answers only "who is connected
right now". Broadcast carries no story state and grants nothing, so knowing a channel name
is never access.

## 2026-09-19 — Reconnect reloads a snapshot instead of replaying events

There is no persisted event log, so a client that misses events cannot be caught up by
replay without inventing one. Every successful subscribe reloads the authorized snapshot
and folds it over local rows, deduplicated by id and ordered by `(created_at, id)`. This is
correct with no extra infrastructure and stays correct when a replay log is added later.

## 2026-09-19 — Chat and proposals are append-only until a versioned scene contract exists

`jam_messages` and `jam_proposals` have insert and select policies and no update or delete
policy. Changing a proposal status is a scene transition, which `docs/API_CONTRACTS.md`
requires to carry `expectedStateVersion`, an idempotent `requestId` and a serialized commit.
Until that transactional contract is implemented, no client can fake one, and no generation
is wired to a proposal.

## 2026-09-19 — A configured Supabase failure is an error, never local state

The local preview exists only when Supabase is unconfigured, and says so on the screen. When
Supabase is configured and a call fails, the room shows a typed error and a retry. Silently
degrading into local React state would present a private draft as a shared room.

## 2026-09-19 — Only a message the schema authored reaches a participant

Every `raise exception` in the Reverie schema marks its message. `toJamError` forwards only
a marked message and replaces anything else with fixed safe text per SQLSTATE. Without that
rule a native Postgres error — an RLS violation or a unique-constraint failure — would
display a table, column or constraint name to whoever triggered it.

## 2026-09-19 — Who is waiting is host-only information

An active member reads the active roster; only the host reads the waiting rows. Enforcing
this in the `jam_members` select policy rather than in the component that renders the lobby
means a participant reading the table directly sees the same thing the UI shows them.

## 2026-09-19 — The invite is a column privilege, not only a policy

A member has to be able to read the room they are in. They must not be able to read the
room's invite code, or an admitted participant could forward the entitlement to anyone. RLS
cannot express that: it answers *which rows*, not *which columns of a row*. So the
table-level `select` and `update` grants on `public.jams` are dropped and re-issued per
column, excluding `invite_code`, `invite_expires_at` and `invite_revoked_at`.

The same grant closes a second hole. The host update policy would otherwise let a host write
`invite_code` directly — including a short, guessable, or previously revoked one. With the
column ungranted, the only writer is `rotate_jam_invite`, which runs as owner and always
draws from `generate_invite_code()`.

## 2026-09-19 — Rotation is revocation with continuity

`revoke_jam_invite` stamps `invite_revoked_at` and the room stops admitting anyone.
`rotate_jam_invite` mints a fresh code instead, which kills every outstanding link and QR in
the same instant while leaving the room open. Because the entitlement is a column on the
room rather than a row per guest, there is nothing left behind to expire separately, and
neither function touches anyone already in the room — removing a member is
`set_jam_member_status`, which is a different decision with a different audit meaning.

A refused invite reports exactly what an unknown code reports. If "this invite expired" and
"no such invite" read differently, a prober learns that a private room exists at that code.

## 2026-09-19 — Failed invite lookups are throttled, not only made improbable

Eight characters of a 31-symbol alphabet is roughly 39 bits, which is not guessable from a
browser. That is an argument about cost, not about permission, so `jam_admission_attempts`
counts failed lookups per authenticated user over a rolling 10-minute window and refuses
after ten. The table has RLS enabled and no policies at all, and neither helper is granted
to `authenticated`, so nobody can read it or drive another user's count up into a lockout.

Its limit is worth writing down rather than discovering later. The counter is keyed on
`auth.uid()`, and this product signs people in anonymously, so a determined attacker mints a
new identity and starts a new window. The throttle ends casual scripted probing from one
session; the entropy of the code is still the real barrier, and Supabase Auth's own limits
on anonymous sign-in are the backstop that has to be configured before a public audience.
Claiming the throttle alone makes enumeration impossible would be false.

## 2026-09-19 — A waiting participant polls, because it cannot subscribe

Realtime channel authorization requires *active* membership, so a participant in the lobby
holds no channel and cannot be pushed their own admission. The previous lobby told them the
page would update and then waited for a manual retry. Rather than widen Realtime
authorization to waiting members — which would hand a not-yet-admitted session a live view
of the room's channel — the lobby polls the single row it is already authorized to read,
its own `jam_members` row, every five seconds. Polling ends at `active`, where Postgres
Changes take over, and at `removed`, which will not change by waiting.

## 2026-09-19 — The local Supabase gateway must reproduce hosted preflight behaviour

The local stack exists to exercise the same client contracts as hosted Supabase, so its nginx
gateway echoes the browser's `Access-Control-Request-Headers` (and `Origin`, with credentials)
instead of a fixed allow-list. Supabase JS adds `Prefer`, `Accept-Profile` and
`Content-Profile` to PostgREST writes, and a fixed allow-list silently omits them, making the
browser block a write that hosted Supabase accepts. Reflecting the requested headers is safe
here because the gateway is bound to `127.0.0.1` only: the permissive surface never leaves the
developer machine. For the same reason the local anon JWT and its signing secret are public
and committed — they authorize only an ephemeral local database, and committing them keeps
`docker compose up` reproducible without weakening the rule that real provider secrets stay in
ignored `.env.local`.

## 2026-09-19 — A stored session is not trusted until the auth server confirms it

Supabase's `getSession` is a storage read: it returns whatever session the browser persisted,
including a user row that the project no longer has (a database reset deletes `auth.users`,
while the browser keeps its token). Trusting that identity made every room insert fail on the
`jams.host_id` foreign key, and the generic fallback hid the cause behind "The Jam room could
not be created." Identity is now confirmed once per page load with `auth.getUser()`; a 4xx
from the auth server means the identity is gone and a fresh anonymous sign-in replaces it,
while a network failure is surfaced rather than silently swapping the participant's identity.
The unmapped `23503`, `42P01`/`PGRST205` and `42883`/`PGRST202` codes now map to an
actionable message (reload to sign in again; apply the migrations) instead of a retryable
outage, because the two failures need different fixes.

## 2026-09-19 — The catalogue is a curated TMDB snapshot in Postgres; there is no Titan API

The Titan OS challenge supplies no catalogue API. Its brief names the Kaggle TMDB dataset as the
tool and judges on a TV-ready UI, real data and cost efficiency. Reverie therefore stops waiting
for an upstream that will not arrive. The catalogue is `public.catalogue_titles`, 27,839 films
curated from the dataset and held in the Supabase project the app already uses. The long tail
of the 1.5M rows is left out: it costs storage and index time and would never be recommended.

- **Reads run as the viewer.** `search_catalogue_titles` is `security invoker`, and the table's
  only policy is select for `authenticated`. Discover presents the viewer's anonymous session
  token, so the server holds no privileged key and the catalogue cannot be written through the API.
- **Rank lives in SQL.** PostgREST can filter on `document` but cannot order by `ts_rank`, so
  ranked search and its match count are one function returning one page. Title words are indexed
  with the `simple` configuration and plot text with `english`, so a query is matched both ways.
- **Cost is bounded by the page.** The function returns only the eight columns Discover maps, at
  most 48 rows, in one round trip. There is no `select *` and no table-wide fetch.
- **Availability is empty, not guessed.** The dataset says nothing about where a film streams, so
  every title has `availability: []`. The UI renders no "where to watch" block and no copy that
  implies one. The response says `source: "tmdb"`, not `"titan"`: labelling TMDB data as a
  Titan feed would misstate where the data comes from.
- **Attribution travels with the data.** Every title and every page carries the TMDB attribution
  that TMDB's terms require wherever its data or images appear.
- **Separation is unchanged.** Catalogue rows keep their TMDB ids behind the `cat:` namespace and
  their own table and schema. They are never merged with generated Movie Jam artifacts.

## 2026-09-19 — The room's shared position is derived, not stored

A synchronized player needs one thing before it needs a video element: a single position the
whole room agrees on. Storing a counter and incrementing it would drift the moment two writers
raced or a tab slept. Instead the database stores only an anchor — `started_at` while playing
plus the `paused_elapsed_ms` accumulated before it — and every reader derives the position as
`paused_elapsed_ms + (now() - started_at)`. Pausing freezes the derivation into
`paused_elapsed_ms` and clears the anchor; a check constraint keeps the two consistent.

The payload includes the server's own `serverNow`. A browser cannot trust its wall clock (it
may be minutes off) but it can trust the *difference* between two of its own monotonic
readings, so it anchors to the server's `elapsedMs` and advances with `performance.now()`.
That is why two viewers show the same counter without any clock synchronization protocol.
Polling every 2.5s is deliberately an interim transport isolated to one named constant; the
documented contract is `portion.locked`/`media.*` events over Realtime, and this slice must
not be built on as if polling were the contract. The clock is room-wide, not per user session:
the existing `jam_sessions` remain language/ambientation skins over the one shared script.

## 2026-09-19 — Discover refinement is filtered in SQL and ranked by the engine

- **Hard limits run in the database.** Every constraint the preference state holds becomes a
  filter on `search_catalogue_titles`, so the shortlist is the best 48 of the whole catalogue
  rather than 48 fetched rows with the misfits thrown away. The engine still re-checks every row
  it receives with `isEligible`, so a filter the SQL cannot express (a language refusal) is
  enforced in the browser instead of silently ignored.
- **A genre is both a dimension and a tag.** `genre.horror` carries "I want horror"; the tag
  `horror` is what `excludeTag` refuses, the only way to say "nothing scary". Refusing a genre
  also states it as unwanted, and wanting it lifts the refusal.
- **Wanted genres shape the shortlist, not only the order.** They restrict it to titles carrying
  at least one of them, ordered by how many, which is what makes "something scary" narrow the
  grid rather than reshuffle it.
- **The deterministic scorer crosses the same boundary a model will.** Its ranking goes through
  `acceptRanking`, so slice 5 can swap the ranker without changing what may reach the screen.
- **Chips are statements, not toggles on a hidden filter.** Each carries its sentence and cites
  quotes from it; withdrawing one is a turn whose transcript quotes what is withdrawn. A session
  holds twelve turns, after which the viewer is told to start over.

## 2026-09-19 — One jam_playback table, reconciled by a stacked migration

Two independent slices each created `public.jam_playback`: the portion-playback work
(`20260919190000_structured_script_revisions.sql`) with `current_portion_index`, and the shared
clock (`20260919230000_jam_playback_clock.sql`) with `started_at`/`paused_elapsed_ms`. They were
merged without knowing about each other, and the collision is not merely cosmetic: `190000` sorts
first, so on a **fresh** database it creates the table, the clock migration's `create table if not
exists` then silently no-ops, and its `jam_playback_json` function fails to compile because
`p_row.started_at` does not exist. On an **existing** database the reverse is true — the clock
table is present and the cursor column is missing. A migration that only worked for one history
would have left the other broken, and a fresh deploy is exactly the path CI and a new contributor
take.

Rather than edit either migration — databases have already applied them, and editing an applied
migration means the file no longer describes the database — a stacked migration
(`20260919225000_reconcile_jam_playback.sql`) sits between them and converges both histories on one
table carrying both column sets. It is idempotent and backfills before enforcing `NOT NULL`, so no
existing row can block it. `status` becomes the union `idle|priming|playing|paused|finished`, and
the anchor invariant is restated for the union as `(status = 'playing') = (started_at is not null)`
— priming and finished carry no anchor, which is correct because only a playing clock needs one.
The two representations stay deliberately distinct: the cursor is a `-1`-sentinel integer in
Postgres and `null` in memory, mapped at the store boundary so playback semantics never see `-1`.

Verified by applying the whole migration set in sorted order to a clean Postgres (the clock
functions compile and the table ends with all seven columns) and by applying it to the existing
local stack (which converges to the same shape). `pnpm verify:realtime` remains 34/34, including
the clock RPCs now running against the combined table.

## 2026-09-19 — Discover talks through the engine; the model never sees the catalogue

Discover's conversation makes two model calls per turn, and neither can put a film on screen that
the database did not return. The first (**interpret**) sees the viewer's message and a few lines
summarising the preference state, never catalogue data. It returns a `Decision`
(`src/conversation/decision.ts`): genre evidence as `genre.<slug>` with a quote and
explicit/inferred, a runtime limit and an era as three fixed slots, one acknowledgement and at most
one question. The decision becomes an ordinary engine turn and must pass `applyTurn`, which
refuses a quote that is not a literal substring of the message. That rule was not relaxed: when
the model first failed it, the prompt was fixed (emit only what the new message changes, with three
worked examples) and the retry now repeats the exact refusal. The second call (**rank**) sees only
the eligible shortlist and may only reorder it; its ranking must pass `acceptFullRanking`, which
refuses any id not supplied or ruled out, on the server and again in the browser.

The translation mirrors the chips so a sentence and a chip mean the same thing: an outright refusal
also excludes the genre, and wanting a refused genre lifts the refusal. Three rules are
deterministic rather than left to the model, and each is written down in `decisionToTurn`: an
inference never replaces what the viewer said outright (it is left out, and the engine would refuse
it anyway); asking for a genre outright retires the genres earlier guessed from a mood, so "a
comedy" after "something light" narrows comedy/family/romance to comedy; and the question is dropped
when the turn states anything outright, because a clear request must be answered, not questioned.

When the model ranks, its utility replaces the scorer's; nothing is blended. The scorer's 10%
position term stays for the deterministic fallback only, because an arbitrary term in the model's
order would make it unexplainable. The model reads every candidate but scores only its best twelve.
Asking it to score all 48 made the reply long enough that one of the first live runs timed out at 20
seconds. Titles it did not score follow, unmarked, in shortlist order. The top three carry a
one-line reason, shown in the spotlight and in each pick's accessible name.

Honesty rules for the UI: the grid is labelled "Ranked by the assistant" only when the model's
ranking was made for exactly this shortlist and state and was accepted in the browser. While it is
in flight the label reads "Ranking with the assistant…" and nothing is marked a top pick. When it
fails, the label reads "Ranked by genre match" and gives the reason. A shortlist is ranked only once
it has been loaded for the current filters, so the previous shortlist is never paid for again under
the new state. The assistant ranks only after the viewer has actually talked to it; chips alone use
the scorer.

Cost bounds: a token ceiling and a per-attempt timeout inside an overall deadline per call, at most
one retry (never after a provider timeout), the engine's 12-turn session cap enforced before any
call, per-instance rate limits and a concurrency cap of 6, a signed-in viewer verified by Supabase
Auth, and an abort when the client disconnects. Temperature is 0.2.

## 2026-09-19 — The film replaces the counter, and its clips outlive the process (RV-14)

The studio showed an elapsed-time counter — the room's shared position, host-driven, backed by
Supabase RPCs — and no way to watch the video the generation pipeline had been producing since
RV-06. The counter is a clock, not a film: extending it would have made a number look like
playback. So the reproducer was built fresh against the portion routes, and it takes the
counter's place in the studio. `PlaybackBar`, `usePlaybackClock`, `src/lib/playback.ts` and the
host-only clock RPCs are untouched but no screen mounts them; whether a room-wide position
returns beside the film, or goes, is a product decision nobody has made yet, and deleting a
working feature to answer it would have been the wrong way to ask.

**Play and stop, and no seek.** Not a simplification for its own sake: the cursor only moves
forward, the next portion is generated while the current one plays, and a clip that does not
exist yet cannot be scrubbed to. A progress bar would promise a timeline the server cannot
serve. Stop is local — it stops watching, and never rewinds the room.

**Advance when the clip ends, not when the next one is ready.** The snapshot can report the next
portion ready while the current one is still playing; advancing then would cut a portion short.
The viewer-side rules live in `src/core/portionPlayback.ts` as a pure function of the server's
snapshot (`nextPlayerAction`), so the screen holds no playback rules of its own and the rules are
testable without a DOM.

**The player asks by configuration, and says it shares one stream.** `configurationKey` normalizes
language-tag casing and whitespace in one place, and the clip address takes the key, so
per-configuration streams (`docs/specs/configuration-keyed-streams.md`) land without moving the
player. The key is deliberately **not** sent as a query parameter yet: the server serves one
stream per jam, and a URL implying a personal stream while everyone watches the same one would be
a claim the build cannot keep. The panel says so in words instead.

**Clips persist to a private Supabase Storage bucket.** The in-memory store lost every clip on
restart, which made paid generation buy the same portion twice. Clips now go to `jam-portions`
(migration `20260919233000`) when the server holds `SUPABASE_SERVICE_ROLE_KEY`, behind the same
`PortionMediaStore` boundary. Consequences taken deliberately:

- **The server holds a service-role key; the Vercel functions still do not.** `api/_lib/supabase-rest.ts`
  acts as the caller under RLS, and that stays true. Uploading generated bytes has no caller to
  act as — generation is a server-driven job — so the privileged path is confined to the local
  Express host, and the bucket has no `storage.objects` policies, so nothing else can reach it.
- **Participants still receive our own bytes.** The route is unchanged; no signed storage URL is
  handed out, so a clip cannot outlive the room's authorization checks.
- **A store that is not durable says so.** Without the key the bounded in-memory store is used and
  reports `durable: false`. A build never implies clips survived a restart that did not.
- **Presence is one listing per jam, not one request per portion.** Every playback poll asks about
  every portion; probing each one would multiply storage traffic by the portion count. The listing
  is cached for 5s, so another process's upload can take that long to appear.
- **A stored clip is never generated again.** `enqueue` now checks the media store before taking a
  provider slot. Without that, durable clips plus an in-memory job map would re-buy portion 0 on
  every restart — the exact spend leak durability was meant to close.

Open, and not silently fixed here: the cursor itself is still in memory. `JamStore.getPlayback`/
`updatePlayback` landed with RV-07 but nothing wires `PlaybackCoordinator` to them, so a restarted
server reads `idle` while its clips remain (it replays from portion 0 and regenerates nothing).
Rewiring that is a change to a freshly merged storage contract and belongs to whoever owns it.
Also unenforced: `start`/`advance` are host-only in the contract, and the player honours that, but
the Express routes carry no authorization — the UI boundary is not a security control.

Verified: `pnpm typecheck`, `pnpm test` (363/363 including the new core, storage and
already-stored-clip tests), `pnpm build`. Against the running local host with providers off, a
jam created from an imported script answered `idle` with four portions, `start` returned the
typed `generation_disabled`, the video route `404`, and advance `invalid_transition`. The screens
themselves were not opened in a browser this session: the shared Chrome profile was locked by
another session, so the UI states in UJ-02 section C are unrun.


## 2026-09-19 — One top bar, a layered Back, and a home that pays for what it shows

**Back is layered, and leaving goes to the parent.** Back from anywhere on a page scrolls to the
top and focuses the top bar; only Back on the bar leaves the screen. This is the published TV
convention for apps with top navigation, and it is what makes the bar reachable again from far
down a page when it has scrolled away. Leaving goes to the screen's parent (the three destinations
are siblings under the home; a jam's screens sit under Movie Jam), not simply to the previous
history entry: history is stepped back only when the entry behind is the parent, and replaced
otherwise, so tab-hopping between destinations never turns Back into a replay of the session. On
the home, Back on the bar is not taken: it belongs to the platform, which may exit the app.

**A film page opens with focus on the bar.** Its only action, "Not this one", changes the
viewer's preferences, so it must not receive a second press of OK. Landing on the bar's current
item keeps the page's old one-press Back, makes OK on that item close the page, and leaves Down to
enter it. The item names where the film was opened from, and choosing it closes the page through
the same path as Back, so history is never pushed on top of the film.

**A film opened from the home is a layer over the home**, as a film opened from the grid is a
layer over the grid. The home stays mounted and inert underneath, so it keeps its shelves, scroll
and focus, and the card that opened the film gets focus back when it closes, with nothing read
again.

**The home reads two shelves, then only what the viewer approaches.** `search_catalogue_titles`
counts every match on every call, so the home never fires every shelf on load. The hero and the
spotlight still come from those two reads rather than from requests of their own. Shelves already
read are kept for five minutes and shared between visits; a read in flight is joined. The
anonymous sign-in behind those reads became single-flight at the same time, because two eager
reads on a first visit could otherwise create two identities.

**Focus is marked until a pointer is used.** Browsers decide `:focus-visible` from pointer and
keyboard heuristics; a remote may give them neither, which left programmatic focus (the landing
item, the bar after Back) unmarked. The root records `data-input="pointer"` after a pointer is
used, and every focused control is marked until then.

**OK is handled by the app on the home and the bar**, as the Discover grid already does: the
browser's own Enter activation is prevented and the item is chosen once. Held repeats of OK and of
Back are swallowed, so holding a key cannot fall through to whatever the next screen focuses.

**Kept on purpose:** "Leave the room" in the studio. It ends the participant's presence (and with
it any live camera, microphone or screen tracks), which people in a live room look for; it is a
room action, not a way back. The explanation of a Jam (the illustration and the three steps) moved
to the create screen, where someone is about to start one.

**History entries carry a key and their opener's key.** Replacing an entry (which leaving does)
leaves any forward entries in place with a record that no longer describes what lies behind them.
Replaced keys are remembered for the tab session, and an entry whose opener was replaced is closed
by replacement rather than by stepping back into a screen it was never opened from.

**A shelf's height is fixed by construction, not measured.** Every card is two title lines and one
meta line tall, every card is one card wide, and a poster image fills its 2:3 box without sizing
it. The loading placeholder, a loaded shelf and a failed one then share one height computed from
those sizes, and the hero reserves its own tallest content the same way, so the page never moves
as reads arrive.

**Component tests run in jsdom.** The suite had no DOM, so focus hand-offs were checked only by
hand. The catalogue read is provided through a React context, which the app leaves at
`/api/catalogue` and tests replace with their own titles, so App-level tests exercise real posters
through the real code. `jsdom` is a dev dependency with no effect on the build; tests render
real screens, drive them with key events and fail on any React or jsdom error.

## 2026-09-19 — Discover voice: SLNG behind our server, final transcripts only, streaming with an upload underneath

Voice produces text for the conversation field and nothing else. Only a final transcript can
reach the field, and only the viewer sends it, so the engine's rule that every quote is a literal
substring of the sent message still holds, and a misheard sentence costs a correction rather than
one of the session's twelve turns. Partials are shown and never sent.

SLNG is called only from the server: `POST /api/voice/transcribe` (HTTP, one recording) and a
WebSocket relay at `/api/voice/stream` (live partials). The relay runs on the long-lived Node server
only. It is not a Vercel function, and the rule against a custom long-lived WebSocket server on
Vercel stands; there, the browser's socket fails and the recording is uploaded. The browser records
Opus for the upload and streams PCM at the same time, because SLNG's streaming route accepts only
linear16 and a failed stream must never lose what the viewer said.

SLNG's streaming route ignores every control message in its reference, so the end of an utterance
is found by appending silence and waiting until a result has heard past the stop point. Model
(`slng/deepgram/nova:3-en`) and region (`us-east`, or `us-west`) are server allowlists. Over HTTP,
the model is named explicitly (`nova-3-general`), because the upstream default is rejected whenever
an option is sent. Probe receipts and measurements are in `docs/PROJECT_STATE.md`.


## 2026-09-19 — Search is a conversation whose answers are snapshots

Finding something to watch moved from the Discover grid to `/search`, where the conversation is
the page and each answer's films sit under the reply that produced them. `/discover` now leads to
`/search`; a film's page keeps its address, `/discover/:id`, so no link breaks.

**A turn's films are a snapshot.** Once a result set is attached to an assistant line it is never
replaced or re-ranked, whatever the state becomes afterwards: a scrollback that rewrites itself is
worse than one that is honestly stale, and "how the search narrowed" is only visible if each step
keeps what it showed. Each turn's films are read and ranked for the state its own reply left,
by a preparer that outlives later changes: a filter changed or another message sent meanwhile
never alters what that turn shows, because a ranking is valid for one state only. The transcript
is bounded by turns (20), never by lines, so a turn leaves whole with its posters.

**Filters are a separate surface.** Genre, era and running time live in a panel with its own live
results, and changing them writes nothing to the conversation and rewrites no turn. They narrow
the same engine state, so the next turn composes with them. The panel orders by the scorer, so a
filter never costs a model call.

**Speech is shown, never sent.** Partials fill a pending line, merged by overlap, with chips and
a poster preview derived from them by a word list; only a final transcript reaches the field, and
only the viewer sends it. The engine's grounding rule applies to the sent text as before. Filler
(including a speech service's rendering of a trailing "or" as "four") fires nothing.

## 2026-09-19 — A catalogue film is found here, never played here

The catalogue is a curated TMDB snapshot for discovery. It is not a licence to show films, and
the data says nothing about where a film can be watched. So nothing in Reverie plays a catalogue
film or implies that it can: a film's preview offers its own page and "Start a Jam from this",
which opens the Movie Jam form seeded with a title and premise *inspired by* the film. That Jam
makes an original film; the seed names the catalogue film as its inspiration and never as its
content. Availability stays empty and unrendered, and the TMDB attribution stays wherever films
are shown, the preview included.
