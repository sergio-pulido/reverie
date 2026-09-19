# Inconsistencies — docs vs. implementation

**Purpose.** This file tracks gaps between what the documentation says and what the code
actually does, across the whole repo (not just the script/session/stream surface covered by
`docs/specs/intended-vs-implemented.md`, which stays the detailed register for that area).
Docs are allowed to describe intended behavior ahead of the code — that's how a fast-moving
hackathon project should work — but an entry here must exist for every such gap, so nobody
mistakes an aspiration for a fact. When a gap closes (code catches up, or the doc is corrected),
move the row to **Resolved** with the commit/PR that closed it; don't delete history.

This file is refreshed periodically (see `## Maintenance`) by rebasing onto the latest `main`,
scanning recent merges for doc or behavior changes, and re-checking each open row.

**Categories:**
- **Doc ahead of code** — the doc describes a capability that doesn't exist yet.
- **Doc behind code** — the code does something the docs don't mention or describe incorrectly.
- **Contradiction between docs** — two doc files (or two sections of one file) disagree.
- **Stale claim** — a doc statement that was true once and no longer is.

## Open

| # | Title | Category | Doc claim | Actual state |
| --- | --- | --- | --- | --- |
| 1 | README "Status" section contradicts the rest of the file | Contradiction / stale | `README.md:152` says no catalogue contract and no hosted Supabase project migrated | `README.md:9-11,64,87,90` and `docs/PROJECT_STATE.md`'s newest entries say Discover serves a live TMDB-backed catalogue (27,839 rows) and `verify:realtime` passed 27/27 against a hosted project; `api/_lib/supabase-catalogue.ts` implements the live adapter |
| 2 | ARCHITECTURE.md claims Presence is implemented | Contradiction | `docs/ARCHITECTURE.md:37` lists Presence under "Implemented" | `docs/PROJECT_STATE.md:94`, `docs/SUPABASE_SETUP.md:100-102`, `docs/DECISIONS.md`, and `docs/user_journeys/03-live-room-collaboration.md:24-25` all say Presence is disabled; `src/core/room.ts:76` only defines an unused `presenceEntrySchema` type, no `.track()`/presence subscription anywhere in `src/lib/jamRoom.ts` |
| 3 | SUPABASE_SETUP.md migration list is missing 3 of 13 migrations | Doc behind code | `docs/SUPABASE_SETUP.md:9-15` lists 10 migrations ending at `20260919213000_persist_admission_throttle.sql` | `supabase/migrations/` has 13 files; missing are `20260919220000_catalogue_titles.sql`, `20260919221000_search_catalogue_titles.sql` (Discover/TMDB catalogue) and `20260919230000_jam_playback_clock.sql` (shared playback clock) — following the doc verbatim yields a project with no catalogue and no playback clock |
| 4 | STATE_MACHINE.md opening line is stale | Doc behind code | `docs/STATE_MACHINE.md:3` says "only draft rooms and active host membership are persisted; transitions, admission and media are not implemented" | Admission (`request_jam_admission`/`set_jam_member_status`, migration `20260919160000_jam_lobby_admission.sql`) and live-media consent (`jam_live_consents`, migration `20260919210000_jam_live_media.sql`, `api/live/token.ts`) are both implemented; only room-level `status` transitions remain unimplemented. Secondary: the documented media-reference lifecycle (`uploading`/`normalized`/`available`/`removed`) doesn't match the actual `jam_live_consents` model (`granted_at`/`expires_at`/`withdrawn_at` only) |
| 5 | GALTEA_AGENT_SPEC.md still describes a "Titan-provided catalogue" | Contradiction / stale | `docs/GALTEA_AGENT_SPEC.md:7,18` reference a "Titan-provided catalogue" | `docs/DECISIONS.md` and `docs/API_CONTRACTS.md:13` say the catalogue is a curated TMDB snapshot in Postgres and "there is no Titan API"; `api/_lib/supabase-catalogue.ts:16` confirms |
| 6 | UJ-01 gates the Discover "ready grid" on removed Titan env vars | Doc behind code | `docs/user_journeys/01-discover-and-navigation.md:8-9,21` and `docs/user_journeys/README.md:100` require `TITAN_CATALOGUE_URL`/`TITAN_API_KEY` | `docs/PROJECT_STATE.md` states `api/_lib/titan-catalogue.ts` and every `TITAN_*` variable are gone; zero hits for either var across `src/`, `apps/`, `api/`, `.env.example`. Real gating is Supabase config, already populated. Following the runbook as written misreports the grid section as permanently BLOCKED |
| 7 | UJ-01 tests a "Where to watch" block that was removed | Doc describes removed feature | `docs/user_journeys/01-discover-and-navigation.md:157-172` (steps 13-14) expects a "Where to watch" availability block and tests its link safety | `docs/PROJECT_STATE.md` says Discover "no longer renders a 'Where to watch' block"; `availability` is always `[]` per `docs/API_CONTRACTS.md:10`; no such markup in `src/discover/DiscoverScreen.tsx` |
| 8 | TECHNOLOGY_STACK.md says non-Vonage provider adapters don't exist | Doc behind code | `docs/TECHNOLOGY_STACK.md:66` — "Provider adapters beyond Vonage… do not yet exist" | `apps/server/providers/nebius.ts` and `apps/server/providers/fal.ts` are fully implemented, with a dated live-probe receipt in `docs/DECISIONS.md` |
| 9 | GALTEA_AGENT_SPEC.md's "Discover Agent" / "Story Director" have no code | Doc ahead of code | `docs/GALTEA_AGENT_SPEC.md:14-31` describes an NLU conversational Discover agent and a Story Director managing votes/conflicts | `src/discover/DiscoverScreen.tsx` is a plain text `<input>` search box; no chat UI or "Story Director" module anywhere. `docs/PROJECT_STATE.md` correctly frames this spec as not-yet-evaluated, but the spec file itself doesn't restate that framing, so it reads as current behavior in isolation |
| 10 | VERCEL_SETUP.md omits the already-implemented `api/live/token.ts` function | Doc behind code | `docs/VERCEL_SETUP.md:7` lists only `api/health.ts` and `api/catalogue.ts` as deployed functions | `api/live/token.ts` (Vonage token-minting, per `docs/API_CONTRACTS.md:14-18`) already exists. The doc's Environment section also never lists the `VONAGE_*` vars that function needs, despite `docs/TECHNOLOGY_STACK.md:56` requiring them |
| 11 | `docs/specs/intended-vs-implemented.md` has no row for the playback clock | Doc behind code | Register covers script/session/stream capabilities only | `docs/PROJECT_STATE.md`'s newest entry ("a shared, server-anchored playback clock") added `src/core/playbackClock.ts` and `jam_playback` RPCs as a new, separate mechanism with no corresponding register row yet |

## Resolved

_(none yet)_

## Maintenance

This branch/PR is kept up to date on a loop: rebase onto the latest `main`, scan merges since
the last pass for doc or behavior changes, re-verify each open row still holds (code anchors
still resolve, doc text hasn't already been fixed), add new rows for gaps introduced by recent
merges, and move closed rows to **Resolved**. Each pass amends this file and updates the PR;
see the PR description for the cadence.
