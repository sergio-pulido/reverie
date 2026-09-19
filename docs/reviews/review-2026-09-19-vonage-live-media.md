# Code Review — Vonage Live Media

**Date:** 2026-09-19  
**Reviewer:** AI Code Review Skill  
**Commit:** `37772e6`  
**Branch:** `main`  
**Files reviewed:** 39

## Scope

Reviewed the merged live-media and invite-lifecycle work: short-lived Vonage
tokens, consent records, browser teardown, Supabase RPC/RLS integration and the
probe script. The review was completed before a video-capable Vonage application
is configured, so no live session was created by this review.

## Findings

### Must Fix

1. **[Cost/correctness] A token request creates a new Vonage session before
   discovering that the Jam already has one.**
   - File: `api/live/token.ts:135-140`.
   - The handler calls `createVideoSession()` and only then invokes
     `ensure_jam_live_session`. That RPC returns the existing session on a
     conflict, but the newly created provider session is left unused. Every later
     participant opening the stage can therefore create an unnecessary external
     resource.
   - Fix: reserve/create the durable live-session row before provider creation,
     with a pending state or server-side compare-and-swap; only the caller that
     owns the reservation may create and finalize the Vonage session. Add a
     concurrent two-token test proving exactly one provider session is created.

### Should Fix

1. **[Bundle size] The dynamically imported Vonage client produces a 899 kB gzip
   `opentok` chunk.**
   - Evidence: `pnpm build` after installing the locked dependency reports
     `dist/assets/opentok-*.js` at 2.99 MB / 899 kB gzip.
   - It is separate from the initial app bundle, which is good, but live-stage
     entry should remain deferred until the user explicitly opens it and should
     be tested on the intended TV/network conditions.

2. **[Migration delivery] The two new migrations originally shared the
   `20260919200000` version prefix.**
   - The live-media migration is being renamed to `20260919210000` in the
     accompanying corrective commit so SQL-editor and CLI migration order are
     unambiguous. Apply it only once after the invite-lifecycle migration.

### Suggestions

1. Record safe request IDs and timing for session creation/token issuance, but
   never tokens, private keys, consent purposes or provider payloads.
2. Add an end-to-end browser test once valid credentials exist: permission denial,
   host/participant join, withdrawal, expiry, screen-share stop and reconnect.
3. Keep recording, archive, broadcast, captions and fal transformation disabled
   until their distinct consent and storage contracts exist.

## Positive Observations

- Token role derives from the caller's authenticated Supabase membership; the
  body schema rejects a client-provided role.
- The route is POST-only, same-origin, rate-limited and bounds request bodies.
- Consent has server-issued asset references, a bounded expiry and an owner-only
  withdrawal RPC; client teardown stops tracks on withdrawal, expiry and unmount.
- The adapter refuses account-level keys and incomplete application credentials;
  safe errors do not expose credentials or upstream bodies.
- `pnpm test` passed 142 tests, and after `pnpm install --frozen-lockfile`,
  `pnpm typecheck` and `pnpm build` passed.

## Verdict

- [ ] **APPROVE** — Ready to enable Vonage
- [x] **REQUEST CHANGES** — Do not configure a live Vonage application until
  session reservation prevents duplicate external sessions.

## Resolution

The accompanying change adds `20260919211000_live_session_reservation.sql` and changes the
token route to reserve a row before it contacts Vonage. The test suite now proves a pending
reservation makes no provider request. The remaining browser connection proof still requires
valid video credentials and an applied Supabase schema.

## Statistics

| Category | Count |
| --- | ---: |
| Must Fix | 1 |
| Should Fix | 2 |
| Suggestions | 3 |
| Files reviewed | 39 |
| Lines changed | +3,444 / -52 |
