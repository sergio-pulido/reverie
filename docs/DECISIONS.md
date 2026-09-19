# Decisions

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

