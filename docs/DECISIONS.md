# Decisions

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

The live-edited script markdown is versioned as an append-only sequence of full snapshots behind the `JamStore` boundary. Undo restores an earlier revision as a new revision recording `restoredFromRevision`, so redo is just another restore and history is never rewritten; identical-content saves are ignored so autosave cannot flood the history. Full snapshots (≤30k chars, ≤500 revisions per jam) were chosen over diffs because a 4-minute script is small and restore must be trivial. The structured Zod-validated `JamScript` remains the generation-time authority; markdown revisions capture what the room edited afterwards. In Supabase this is `jam_scripts` (artifact) plus `jam_script_revisions` (history) hanging off the room row in `jams`, with no update/delete policies on revisions.

## 2026-09-19 — Start with one same-origin local development server

The first runnable baseline serves the Vite client through the Node/Express process at `127.0.0.1:4317`. This keeps browser-to-server contracts and provider boundaries easy to iterate on locally. It is a local development baseline, not the public deployment configuration.

## 2026-09-19 — Align deployment and collaboration foundation

Vercel serves the Vite SPA and `/api` Node functions. API paths are excluded from the SPA rewrite; health does not assert provider/database readiness. Supabase owns identity and persistent state. No extra database, WebSocket service or provider integration is introduced.

The primary agent commits and pushes completed verified slices directly to `main`, including documentation. The collaborator uses isolated PR branches and auto-merge after checks. Fetch before publication, stage owned files explicitly, and never force-push shared history.

## 2026-09-19 — Ship Discover as a configuration-driven adapter with an explicit unconfigured state

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
