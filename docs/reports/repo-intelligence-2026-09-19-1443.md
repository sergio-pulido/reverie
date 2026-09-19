# Repository Intelligence Report

**Repository:** Reverie Movie Jam  
**Date:** 2026-09-19 14:43 CEST  
**Auditor:** Codex (repo-intelligence-report v2)  
**Commit:** `a566c72`  
**Previous report:** N/A — first report

---

## 1. Quick Reference Card

| Dimension | Value |
| --- | --- |
| Repository Type | Single TypeScript web application with serverless deployment adapters |
| Repo Maturity | Active Development |
| Operational Maturity | Tested local foundation; live Supabase/Vercel integrations remain unverified |
| Primary Language / Runtime | TypeScript / Node.js >=22.17.1 |
| Frameworks | React 19, Vite 8, Express 4 |
| Data / real-time target | Supabase Postgres, Auth, RLS and Realtime |
| Package manager | pnpm 10.30.0 |
| Components | One web app, local Express host, Vercel functions, Supabase migrations |
| Test framework | Node test runner via TSX: 99 passing tests locally |
| CI/CD / containers | No workflow or container definition observed |
| Deployment target | Vercel, documented in `vercel.json` and `docs/VERCEL_SETUP.md` |
| Production confidence | Low: local tests/build pass, but no hosted deployment, migrated database or live room evidence exists. |

## 2. Executive Summary

Reverie now has substantive product behaviour rather than a landing-page prototype. It creates generated movie scripts through a guarded Nebius adapter, persists room metadata and membership through a Supabase design, admits guests by code, displays a waiting lobby, synchronizes durable messages/proposals and Presence in the Studio, and provides a keyboard-first `/discover` route. The route does not fabricate titles: `api/_lib/titan-catalogue.ts` returns an explicit unconfigured state until an authorized catalogue contract exists.

The strongest asset is the discipline at trust boundaries: Zod validates browser, database and upstream shapes; RLS migrations model the intended access rules; provider failures surface typed safe errors; and generated work, catalogue titles and collaboration state use separate domains. The biggest gap is operational: all Supabase claims are unit-tested but no migration has been applied to a live project, no two-browser Realtime proof exists, and there is no CI or hosted deployment evidence.

The next investment should be operational verification, not another large feature: apply the migrations to an isolated Supabase project and run `pnpm verify:realtime`. This converts the core audience journey from coded/tested to integrated evidence and is prerequisite for safely extending voting, Vonage or paid media generation.

## 3. Repository Structure

```text
reverie/
├── api/                    # Vercel health and catalogue functions
├── apps/server/            # Local Express host, script/session HTTP routes
├── src/                    # React screens, browser libraries and provider-free core
├── supabase/migrations/    # Room, lobby, script and Realtime/RLS schema history
├── tests/                  # Node/TSX unit and route tests
├── scripts/                # HTTP smoke and live-Realtime verification scripts
├── docs/                   # Architecture, decisions, setup and product specs
├── .env.example            # Public configuration names only
└── vercel.json             # Vite deployment and SPA rewrite configuration
```

The structure separates browser UI, server routes, Vercel functions, core rules and database migration logic clearly. The main boundary risk is that two execution paths coexist: local Express provides script/session routes, while Vercel functions currently expose only health/catalogue. That is deliberate but incomplete deployment wiring.

## 4. Architecture Overview

### Architecture Pattern

Hybrid modular monolith: React/Vite serves the browser; `apps/server/` is the local API host; `api/` contains Vercel functions; and Supabase is the intended durable collaboration boundary. `src/core/` is provider/browser independent, while `src/lib/` and `src/screens/` connect it to Supabase. This is supported by `apps/server/app.ts`, `api/catalogue.ts`, `src/lib/jamRoom.ts`, and the five ordered migrations.

### Key Architecture Decisions

- Supabase rows are durable collaboration authority; Postgres Changes and Presence notify clients (`docs/DECISIONS.md`, `src/lib/jamRoom.ts`).
- Invite code, not URL slug, is admission entitlement (`src/core/invite.ts`, `20260919160000_jam_lobby_admission.sql`).
- Script persistence is behind `JamStore`; the local implementation is in-memory, while Supabase schema exists for later substitution (`apps/server/jams.ts`, `20260919180000_jam_scripts.sql`).
- Catalogue records are namespaced `cat:` and only accepted after validation (`src/catalogue/contract.ts`, `api/_lib/titan-catalogue.ts`).
- Provider calls are server-side and gated; Nebius has a dated live probe, while Titan and Vonage do not (`apps/server/providers/nebius.ts`, `docs/DECISIONS.md`).

### Communication Patterns

- Browser → local API: REST routes in `apps/server/jams.ts` and `apps/server/sessions.ts`.
- Browser → Supabase: anonymous Auth, RLS-protected reads/writes/RPCs in `src/lib/*.ts`.
- Real-time: Supabase Postgres Changes plus private Presence channel in `src/lib/jamRoom.ts`.
- Vercel function → catalogue: `api/catalogue.ts` delegates to the Titan adapter; the actual upstream remains unconfigured.

## 5. Architecture Truth Table

| Concern | Actual Implementation | Evidence | Gaps / Notes |
| --- | --- | --- | --- |
| Authentication | Anonymous Supabase Auth in browser | `src/lib/jams.ts`, `src/lib/supabase.ts` | No live project verification. |
| Authorization | RLS policies and security-definer admission helpers | `20260919160000_jam_lobby_admission.sql` | SQL is unproven against a live database. |
| Durable room data | `jams`, `jam_members`, messages/proposals migrations | `supabase/migrations/` | Migrations have not been applied. |
| Real-time | Database subscriptions + Presence, not Broadcast authority | `src/lib/jamRoom.ts`, `20260919190000_jam_collaboration.sql` | No two-session evidence. |
| Script generation | Nebius adapter and bounded in-memory store | `apps/server/scriptwriter.ts`, `apps/server/jams.ts` | Durable `JamStore` not wired; provider outcome depends on configuration. |
| Catalogue | Validated Vercel/local adapter and TV UI | `api/_lib/titan-catalogue.ts`, `src/discover/` | No authorized Titan endpoint or real catalogue records. |
| Live media | Planned | `docs/ARCHITECTURE.md` | No Vonage dependency, function, token issuance or UI on `main`. |
| Observability | Health endpoint and typed safe errors | `api/health.ts`, `src/lib/errors.ts` | No structured logs, metrics, alerting or uptime checks. |
| Deployment | Vercel build/rewrite declaration | `vercel.json`, `docs/VERCEL_SETUP.md` | No hosted deployment proof or CI gate. |

## 6. Component Deep Dives

| Component | State | Evidence |
| --- | --- | --- |
| React application | Tested | Routes and screens in `src/main.tsx`, `src/screens/`, `src/discover/`; local build passes. Browser E2E is manual only. |
| Local API host | Tested | `apps/server/app.ts` wires health, catalogue, script and sessions; route tests in `tests/app.test.ts`, `tests/scriptRoutes.test.ts`, `tests/sessions.test.ts`. |
| Supabase collaboration | Partially Implemented | Full migration/client code plus 37 room-focused tests; no migrated project or `verify:realtime` receipt. |
| Discover adapter | Tested | Contract and adapter tests in `tests/catalogue.test.ts`; configured success is injected only, not a live catalogue. |
| Nebius generation | Partially Implemented | Typed adapter, safe disabled state and documented probe; no deployment/persistent storage. |
| Vonage media | Planned | `docs/` defines intent; no code on `main`. |
| fal playback/video | In Progress, unmerged | `origin/codex/rv-06-jam-video-generation` is five commits ahead with 1,019 changed lines; it is not present in `main`. |

## 7. Operational Reality

| Component | Exists | Runs locally | Integrated | Tested | Prod-ready | State |
| --- | --- | --- | --- | --- | --- | --- |
| SPA and local API | Yes | Yes | Partial | Yes | No | Tested |
| Script/session API | Yes | Yes | Local-only | Yes | No | Tested |
| Lobby/Realtime Studio | Yes | Not live-verified | Partial | Yes | No | Partially Implemented |
| Discover | Yes | Yes | Adapter/UI wired | Yes | No real upstream | Tested |
| Vercel deployment | Config only | N/A | Partial | Smoke script exists | No | Scaffolded |
| Vonage | No | No | No | No | No | Planned |

What works locally: health/API routing, script revision/session routes, strict script format behaviour, Discover’s unconfigured/error/UI states, invite parsing and client room state merging. `pnpm test` passed 99 tests; `pnpm typecheck` and `pnpm build` passed at this commit.

What must not be overstated: a real user cannot yet prove a persistent room flow without a Supabase project; Discover has no titles without a contracted endpoint; and scripts/sessions are in-memory on the local API path. `docs/PROJECT_STATE.md` accurately calls these gaps out.

## 8. Primary Journeys

| Journey | Actual path | Completeness |
| --- | --- | --- |
| Create a generated Jam script | Create screen → `POST /api/jams` → Nebius adapter → in-memory `JamStore` → rendered script | Partial: local/tested, not durable or deployed. |
| Join a room by invite | `/join` → code/name normalization → Supabase RPC `request_jam_admission` → waiting/active Studio state | Partial: code/RLS model is tested; live DB execution is unproven. |
| Host admits/removes guest | Studio → Supabase membership RPC → membership subscription → lobby/roster refresh | Partial: same live verification gap. |
| Send chat/proposal | Studio → append-only Supabase row → Postgres Change → merge/dedup snapshot | Partial: implementation and unit tests exist, no real Realtime receipt. |
| Discover a real title | `/discover` → `GET /api/catalogue` → Titan adapter → modal detail | Partial: UI/validation work; source is intentionally unavailable until an authorized contract arrives. |

## 9. Technology Stack

| Category | Technology | Version | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Language | TypeScript | 5.9.3 | `package.json`, strict `tsconfig.json` | Strict compile passes. |
| Browser | React / React DOM | 19.3.0 | `package.json` | Vite SPA. |
| Build | Vite | 8.3.0 | `vite.config.ts` | Local build passes. |
| Local API | Express | 4.22.3 | `apps/server/app.ts` | Local host, not production room service. |
| Data / auth / realtime | Supabase JS | 2.116.0 | `src/lib/supabase.ts` | No live project receipt. |
| Validation | Zod | 4.6.5 | `src/core/`, `api/_lib/` | Consistent boundary use. |
| Deployment | Vercel | config-driven | `vercel.json`, `api/` | Unverified deployment. |

## 10. Dependency Posture

| Signal | Observation |
| --- | --- |
| Lockfile | `pnpm-lock.yaml` exists. |
| Automated updates | An open remote Dependabot branch exists; no repository configuration was inspected. |
| Audit in CI | No CI workflow or audit command observed. |
| Vulnerability data | Not verified in this analysis; no audit was run. |

The defining dependencies are narrowly scoped: Supabase, Express, React/Vite, Zod, QR rendering and TSX. `ws` remains in the manifest but no production custom WebSocket server is wired; its necessity should be reassessed before launch.

## 11. Planning & Roadmap

| Phase | Done | In Progress | Pending |
| --- | ---: | ---: | ---: |
| Core creation, script and sessions | Yes | No | Durable script store |
| Discover | UI/adapter done | Awaiting authorized contract | Real title results |
| Lobby and Realtime | Code/migrations done | Live Supabase verification | Voting/scene transaction |
| Live media | No | Vonage worktree created but no branch diff | Consent, token/session lifecycle |
| Video/fal | No on main | Remote branch ahead of main | Review/merge/probe |

`docs/PROJECT_STATE.md` is current and separates delivered code from live verification. The project is moving quickly, but external credentials/contracts are now the critical path rather than UI implementation.

## 12. AI & Automation

`AGENTS.md` gives focused safety, provider, documentation and collaboration rules. `docs/CONTRIBUTING.md` documents direct-main and PR coordination. There is no `.github/workflows/`, lint script, hosted test gate, deploy workflow or automated audit observed. Tests execute only when contributors run `pnpm test`.

## 13. Documentation Assessment

| Document | Accuracy | Notes |
| --- | --- | --- |
| `README.md` | Mostly aligned | Lists implemented state and explicitly says catalogue/Supabase live gaps. |
| `docs/PROJECT_STATE.md` | Aligned | Strong operational chronology and next milestones. |
| `docs/API_CONTRACTS.md` | Partly forward-looking | Clearly describes pending transactional scene contract; needs update when fal branch merges. |
| `docs/VERCEL_SETUP.md` / `SUPABASE_SETUP.md` | Aligned | Setup is documented, not proven. |
| Specs under `docs/specs/` | Aligned | Discover, lobby and Realtime slices are specified. |

Missing: a CI policy, a production runbook, a live Supabase migration receipt, a Titan contract/adoption guide, and a Vonage live-probe record.

## 14. Fragility & Debt Hotspots

| Priority | Hotspot | Why Fragile | Evidence | Suggested Action |
| --- | --- | --- | --- | --- |
| 1 | Live Supabase boundary | RLS/Reconnection are only tested in isolation; the audience flow depends on them. | `scripts/verify-realtime.mjs` exists but no receipt; state docs say migrations are unapplied. | Migrate an isolated project and record two-session results. |
| 2 | Dual persistence paths | Scripts/sessions live in an in-memory Express store while rooms use Supabase design. | `apps/server/jams.ts`, `JamStore`, migrations 170000/180000. | Choose and wire persistent `JamStore` before public restarts matter. |
| 3 | Deployment parity | Vercel exposes only function files while local Express has more routes. | `api/` vs `apps/server/app.ts`, `vercel.json`. | Define which APIs ship as Vercel functions and smoke-test preview URL. |
| 4 | Parallel video work | The fal branch is 1,019 lines ahead and touches API contracts/state while Vonage is not started. | `origin/codex/rv-06-jam-video-generation`. | Review against media consent/token prerequisites before merge. |
| 5 | No CI | Passing local checks can regress after fast merges. | No `.github/workflows/`; scripts only in `package.json`. | Add minimal typecheck/test/build workflow. |

## 15. Risks & Recommendations

| # | Risk | Severity | Evidence |
| --- | --- | --- | --- |
| 1 | Private-room isolation could fail in actual Supabase configuration. | High | Migrations and RLS exist; no live verification. |
| 2 | Demo cannot show real Discover titles without an authorized Titan contract. | High | Adapter reports `catalogue_not_configured`. |
| 3 | Video branch could broaden paid generation before consent/live-media authorization is complete. | High | Unmerged fal branch exists; Vonage branch has no diff. |
| 4 | Direct merges lack automated gates. | Medium | No CI workflow observed. |

Recommendations: (1) apply migrations and run live Realtime verification; (2) obtain/catalogue contract or explicitly scope Discover demo to its honest unavailable state; (3) review the fal branch against a written media consent/token contract before merging; (4) deploy a preview and run smoke tests; (5) add CI for typecheck, tests and build.

Patterns worth keeping: schema validation at every boundary; explicit unavailable states instead of fake demos; durable-row authority separate from Realtime notification; and concise decision records with probe receipts.

## 16. Decision Support

1. **Verify Supabase end-to-end.** Operational, M. This is the blocker for the shared-room demo and validates the privacy model.
2. **Resolve Titan access.** Product, S/M depending on provider process. Without it, Discover remains a polished empty state.
3. **Gate media work behind consent and a live Vonage probe.** Architecture, M. Merge video generation only after room authorization and media lifecycle are enforceable.

Do not add voting/scene acceptance yet: `docs/API_CONTRACTS.md` correctly requires an idempotent, versioned transaction first. Do not label TMDB as Titan without explicit authorization. Keep the provider-free core and current adapter boundaries; invest in the Supabase store/verification path.

## 17. Cross-Project Comparison Card

| Dimension | Score | Evidence |
| --- | ---: | --- |
| Code Organization | 4/5 | Clear `src/core`, `src/lib`, `api`, `apps`, migrations and tests. |
| Architecture Clarity | 4/5 | ADRs/specs and boundaries are explicit; dual local/deploy paths remain. |
| Operational Clarity | 5/5 | State docs consistently separate tested, configured and unverified capabilities. |
| Type Safety | 4/5 | Strict TS and Zod boundaries; database behavior is not compiled/tested live. |
| Test Coverage | 3/5 | 99 meaningful local tests, no browser E2E/CI/live DB tests. |
| Documentation | 4/5 | Fresh architecture/setup/state/spec documents; no production runbook. |
| Security Posture | 3/5 | Strong intended RLS/error controls; no deployed verification. |
| API Design | 4/5 | Typed routes and safe errors; split serverless route surface is incomplete. |
| Data Model | 4/5 | Explicit migrations/RLS and domains; scripts remain in-memory locally. |
| Real-time Design | 4/5 | Correct row/notification/presence model; no live delivery receipt. |
| Deployment Readiness | 2/5 | Vercel config exists; no CI, preview or production proof. |
| Observability | 2/5 | Health/safe errors only; no metrics/logging/alerts. |
| Dependency Hygiene | 3/5 | Locked, compact dependencies; no automated audit/CI evidence. |
| Delivery Process | 3/5 | Worktrees/PR coordination works; lack of CI makes direct-main risky. |
