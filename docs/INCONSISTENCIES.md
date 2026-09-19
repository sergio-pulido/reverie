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
| 2 | ARCHITECTURE.md claims Presence is implemented | Contradiction | `docs/ARCHITECTURE.md:37` lists Presence under "Implemented" | `docs/PROJECT_STATE.md:94`, `docs/SUPABASE_SETUP.md:100-102`, `docs/DECISIONS.md`, and `docs/user_journeys/04-live-room-collaboration.md:24-25` (renamed from `03-` when the journeys were split) all say Presence is disabled; `src/core/room.ts:76` only defines an unused `presenceEntrySchema` type, no `.track()`/presence subscription anywhere in `src/lib/jamRoom.ts` |
| 3 | SUPABASE_SETUP.md migration list is missing 7 of 17 migrations | Doc behind code | `docs/SUPABASE_SETUP.md:9-15` lists 10 migrations ending at `20260919213000_persist_admission_throttle.sql` | `supabase/migrations/` has 17 files; missing are `20260919190000_structured_script_revisions.sql` (structured script as editing source of truth), `20260919220000_catalogue_titles.sql`, `20260919221000_search_catalogue_titles.sql` (Discover/TMDB catalogue), `20260919225000_reconcile_jam_playback.sql` (converges the two independently-introduced `jam_playback` tables), `20260919230000_jam_playback_clock.sql`, `20260919231000_constrained_catalogue_shortlist.sql` and `20260919232000_catalogue_title_detail.sql` — following the doc verbatim yields a project missing the catalogue, film-detail RPC, shortlist RPC, playback clock and structured-script columns entirely. Gap widens every time a migration lands without a SUPABASE_SETUP.md update |
| 4 | STATE_MACHINE.md opening line is stale | Doc behind code | `docs/STATE_MACHINE.md:3` says "only draft rooms and active host membership are persisted; transitions, admission and media are not implemented" | Admission (`request_jam_admission`/`set_jam_member_status`, migration `20260919160000_jam_lobby_admission.sql`) and live-media consent (`jam_live_consents`, migration `20260919210000_jam_live_media.sql`, `api/live/token.ts`) are both implemented; only room-level `status` transitions remain unimplemented. Secondary: the documented media-reference lifecycle (`uploading`/`normalized`/`available`/`removed`) doesn't match the actual `jam_live_consents` model (`granted_at`/`expires_at`/`withdrawn_at` only) |
| 5 | GALTEA_AGENT_SPEC.md still describes a "Titan-provided catalogue" | Contradiction / stale | `docs/GALTEA_AGENT_SPEC.md:7,18` reference a "Titan-provided catalogue" | `docs/DECISIONS.md` and `docs/API_CONTRACTS.md:13` say the catalogue is a curated TMDB snapshot in Postgres and "there is no Titan API"; `api/_lib/supabase-catalogue.ts:16` confirms |
| 6 | UJ-01 gates the Discover "ready grid" on removed Titan env vars | Doc behind code | `docs/user_journeys/01-discover-and-navigation.md:8-9,21` and `docs/user_journeys/README.md:102` require `TITAN_CATALOGUE_URL`/`TITAN_API_KEY` | `docs/PROJECT_STATE.md` states `api/_lib/titan-catalogue.ts` and every `TITAN_*` variable are gone; zero hits for either var across `src/`, `apps/`, `api/`, `.env.example`. Real gating is Supabase config, already populated. Following the runbook as written misreports the grid section as permanently BLOCKED |
| 8 | TECHNOLOGY_STACK.md says non-Vonage provider adapters don't exist | Doc behind code | `docs/TECHNOLOGY_STACK.md:66` — "Provider adapters beyond Vonage… do not yet exist" | `apps/server/providers/nebius.ts` and `apps/server/providers/fal.ts` are fully implemented, with a dated live-probe receipt in `docs/DECISIONS.md` |
| 9 | GALTEA_AGENT_SPEC.md's "Movie Jam Story Director" has no code | Doc ahead of code | `docs/GALTEA_AGENT_SPEC.md:21-27` describes an agent turning contributions into structured story changes (premise, characters, scene/shot intent), keeping coherent story state, and describing group conflicts | No such module anywhere in `src/`, `apps/`, or `api/` (searched "Story Director", scene voting, conflict description). Voting/scene acceptance are separately marked "not implemented" (see the script-screen register). `docs/PROJECT_STATE.md` correctly frames the whole spec as not-yet-evaluated, but the spec file itself doesn't restate that framing |
| 10 | VERCEL_SETUP.md omits the already-implemented `api/live/token.ts` function | Doc behind code | `docs/VERCEL_SETUP.md:7` lists only `api/health.ts` and `api/catalogue.ts` as deployed functions | `api/live/token.ts` (Vonage token-minting, per `docs/API_CONTRACTS.md:14-18`) already exists. The doc's Environment section also never lists the `VONAGE_*` vars that function needs, despite `docs/TECHNOLOGY_STACK.md:56` requiring them |
| 11 | `docs/specs/intended-vs-implemented.md`'s two oldest rows have stale code anchors | Doc behind code | Register's "Open as markdown" row cites `apps/server/jams.ts:248`; "Script revision history" row cites `apps/server/jams.ts:257,274,292,304` | Confirmed stale: line 248 now falls inside `getCurrentScriptRevision`/`requireEntry`, and 257-304 is router setup (rate-limit map, `POST /api/jams` handler), not the markdown-read or revision-history endpoints. The RV-07 structured-script rewrite (283 lines in `jams.ts`) moved everything without these two rows being revisited — meanwhile the register's other rows (player, durable clip storage, durable playback cursor, playback clock) were kept current by `b3cb511`, so this is localized drift, not full staleness. Flagging for that register's own maintainer, not fixing here (out of this file's scope) |

| 12 | `playback/start` and `playback/advance` are documented host-only but the routes enforce no authorization | Doc ahead of code (security-relevant) | `docs/API_CONTRACTS.md:117-118,168` says `POST /api/jams/:id/playback/start` and `/playback/advance` are "Host-only"; `docs/user_journeys/02-reproduce-the-video.md:185` repeats the same claim as a test assertion | `apps/server/playback.ts:250-271` (`start`) and `:273-`(`advance`) check only that the jam exists and the state machine allows the transition (`idle`/`priming`/`playing`) — no session token, no host-id comparison, no caller identity check of any kind. Any client that knows a jam id can start or advance its playback. Contradicts `AGENTS.md`'s "the server owns... authorization" rule. Neither `docs/DECISIONS.md` nor `docs/PROJECT_STATE.md` flags this as a known gap (per a peer session's report, it's an unowned loose end, not a recorded decision like the in-memory playback cursor) |

## Resolved

| # | Title | Closed by | Note |
| --- | --- | --- | --- |
| 7 | UJ-01 tested a "Where to watch" block that was removed | `5eb75d2` (feat: give each film its own page and let the Discover grid grow) | Step 14 of `docs/user_journeys/01-discover-and-navigation.md` now reads "Nothing implies where to watch" and asserts the block's *absence*, matching the actual `availability: []` behavior |
| 9 (Discover Agent half) | GALTEA_AGENT_SPEC.md's Discover Agent had no code | `156c9ad` (feat: let Discover hold a conversation through Nebius) | `api/discover/turn.ts` + `src/conversation/decision.ts` now interpret free-text messages server-side into a grounded Decision (genre evidence with quotes, runtime, era, at most one clarifying question); a quote not present in the message is refused, the model never sees the catalogue, and its ranking must pass `acceptFullRanking`. Matches the spec's "understand natural-language requests… ask a concise clarifying question… ground each recommendation" bullets closely enough to close this half. The Story Director half is still open — see row 9 above |

## Maintenance

This branch/PR is kept up to date on a loop: rebase onto the latest `main`, scan merges since
the last pass for doc or behavior changes, re-verify each open row still holds (code anchors
still resolve, doc text hasn't already been fixed), add new rows for gaps introduced by recent
merges, and move closed rows to **Resolved**. Each pass amends this file and updates the PR;
see the PR description for the cadence.
