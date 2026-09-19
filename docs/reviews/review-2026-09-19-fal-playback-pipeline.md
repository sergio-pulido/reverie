# Code Review — fal Playback Pipeline

**Date:** 2026-09-19  
**Reviewer:** AI Code Review Skill  
**Commit:** `b31b81f`  
**Branch:** `main`  
**Files reviewed:** 8

## Scope

Reviewed PR #3, now merged as `b31b81f`: portion locking, playback endpoints,
the fal queue adapter, in-memory clip storage, contracts and tests. The review
was performed after the automated merge, so this is a post-merge safety review,
not approval to enable the provider.

## Findings

### Must Fix

1. **[Security/cost] Playback endpoints have no authentication or host authorization.**
   - Files: `apps/server/playback.ts:234`, `apps/server/playback.ts:257`; router
     mounted in `apps/server/app.ts:21`.
   - `POST /api/jams/:id/playback/start` and `advance` are described as host-only,
     but accept no credential and perform no Supabase membership/host check. With
     `REVERIE_LIVE_ENABLED=true` and `FAL_KEY` configured, any caller who knows a
     Jam id can start the paid generation path or advance playback.
   - Fix: move these privileged operations to authenticated Vercel handlers (or
     add equivalent verified JWT middleware), derive caller identity server-side,
     require active host membership through Supabase, and add negative tests for
     unauthenticated, participant and removed-member callers. Do not set a live
     fal key before this is fixed.

2. **[Reliability/security] The advertised 64 MiB download cap is enforced only
   after the full response is allocated.**
   - File: `apps/server/providers/fal.ts:169-189`.
   - `response.arrayBuffer()` consumes an arbitrarily large response before
     `MAX_CLIP_BYTES` is checked. A malformed or hostile provider URL can exhaust
     function memory despite the cap.
   - Fix: reject an oversized `Content-Length` when supplied and stream the body
     through a bounded reader that cancels as soon as the accumulated bytes exceed
     the limit. Test both declared and chunked oversized downloads.

### Should Fix

1. **[Architecture] Playback state, jobs and clips are process-local, while the
   product is designed for Vercel + Supabase.**
   - Files: `apps/server/playback.ts:73-75`, `apps/server/media.ts:17-18`.
   - A restart loses the cursor, locks and clips; multiple server instances can
     disagree. The contract describes `JamStore` persistence, but the code has an
     explicit RV-07 TODO.
   - Fix: keep the feature disabled until the state and locking compare-and-swap
     are backed by the authoritative store, or explicitly limit this to a local
     single-process demonstration.

2. **[Correctness] The pinned revision number does not select the pinned structured
   content used to create the video prompt.**
   - File: `apps/server/playback.ts:202-213`, with prompt construction at
     `apps/server/playback.ts:328-338`.
   - The job stores a revision number but flattens `jam.script`, the creation-time
     structure. A later editable revision can therefore differ from what the job
     represents. The code documents the gap as RV-07.
   - Fix: store and retrieve a structured script snapshot by revision before
     enabling edits plus playback.

3. **[Security] Provider result URLs are accepted as any syntactically valid URL.**
   - File: `apps/server/providers/fal.ts:42-54`, `144-166`.
   - The adapter later server-fetches the returned address. Limit result URLs to
     HTTPS and documented fal delivery hosts, or use an authenticated provider
     download flow, so a malformed upstream result cannot become a server-side
     request target.

4. **[Delivery] The playback API is only mounted in the local Express host.**
   - Evidence: `apps/server/app.ts` mounts it, while the Vercel `api/` directory
     contains only health and catalogue functions.
   - Fix: design the Vercel function routes and deployment smoke tests before
     presenting this as deployable playback.

### Suggestions

1. Add a bounded retry policy and provider request-id observability that records
   safe identifiers and durations without prompts or provider payloads.
2. Connect `portion.locked` and `media.*` to the existing Supabase Realtime
   model before building UI polling around `GET /api/jams/:id/playback`.
3. Add lifecycle cleanup tests proving clip eviction after a Jam closes or its
   backing store evicts it.

## Positive Observations

- The provider is disabled unless both `REVERIE_LIVE_ENABLED=true` and `FAL_KEY`
  are present; tests confirm the disabled response through real app wiring.
- The model allowlist is server-owned, and clients do not receive provider URLs.
- Playback state has explicit transitions and optimistic state-version checks;
  tests cover lock derivation, early advance, stale state and Range responses.
- Concurrent generation is bounded at one, and clip storage limits both per-clip
  and per-Jam counts.

## Verdict

- [ ] **APPROVE** — Ready to merge
- [x] **REQUEST CHANGES** — Do not enable fal until the two must-fix issues are resolved.

The PR is already merged automatically. Keep `REVERIE_LIVE_ENABLED=false` and do
not configure `FAL_KEY` in a deployed environment until a corrective change is
merged and verified.

## Statistics

| Category | Count |
| --- | ---: |
| Must Fix | 2 |
| Should Fix | 4 |
| Suggestions | 3 |
| Files reviewed | 8 |
| Lines changed | +1,019 / -1 |
