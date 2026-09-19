# Intended vs implemented — script screen, sessions and streams

**Purpose.** Agents must be able to tell what the code actually does from what these specs
intend. This is a living register: every entry names the capability, its status, the code that
exists today (with anchors), and what does not exist. Nothing here is a claim that an intended
behaviour works.

**Statuses:**
- **Implemented** — reachable code exists; treat as actual behaviour.
- **Implemented (local only)** — exists in the local Express host, not in a deployed function.
- **Designed, not wired** — schema/config exists but no running code reads or writes it.
- **Implemented but gated/unprobed** — code exists behind a flag or credential and has not been
  verified live.
- **Not implemented** — no code path exists; the only trace is a doc or a UI note.

## Register

| Capability | Status | Code today | Missing code |
| --- | --- | --- | --- |
| Open the studio (real room or labelled local preview) | Implemented | `src/main.tsx:130` (`onStudio`), `src/main.tsx:135-141`; `src/screens/Studio.tsx`; `PreviewStudio` in `src/main.tsx:193` | — |
| Scene acceptance / voting from the studio | Not implemented | UI only says so: `src/screens/Studio.tsx:91` | No `scene/accept` route, service or store transition; planned row at `docs/API_CONTRACTS.md:109` |
| Open as markdown (read-only) | Implemented (local only) | `src/ScriptScreen.tsx:41`; `apps/server/jams.ts:248` | Not exposed as a Vercel function (see below); no copy step |
| Copy the script into an editable version (fork-on-modify) | Not implemented | None | No route/service/store/UI; the only trace is the planned row `POST /api/jams/:id/forks` at `docs/API_CONTRACTS.md:110` |
| Chat-driven screenplay editing | Not implemented | None | No chat-to-edit route, command, Zod schema or UI; the Studio conversation/proposals are a separate surface |
| Create/read/update a session (language, ambientation) | Implemented (local only) | `apps/server/sessions.ts:67,100,109,118,144`; `src/ScriptScreen.tsx:80-128`; schema `src/core/session.ts` | Not exposed as a Vercel function |
| Session is the participant's seat in the collaborative room | Not implemented | None — the sessions router has no membership linkage (`apps/server/sessions.ts`); membership is Supabase `jam_members` | No shared id or derivation between `JamSession` and `jam_members`; no code makes a session admit a participant |
| Per-participant rendering (translate / re-ambient the script) | Not implemented | Only a header annotation: `src/core/scriptMarkdown.ts:28-35`; settings stored at `src/core/session.ts:16-21` | No generation or rendering of scene bodies from `language`/`ambientation` |
| Supabase-backed session persistence | Designed, not wired | Migration `supabase/migrations/20260919170000_script_format_and_sessions.sql` creates `jam_sessions` | No server code reads/writes `jam_sessions`; the router uses in-memory `InMemorySessionStore` (`apps/server/sessions.ts:32`) |
| Configuration-keyed generated streams (one stream per distinct configuration) | Not implemented | None | No configuration key, stream registry, cache or generation path |
| Cap on distinct configurations + attach-to-active flow | Not implemented | None | No configuration cap, no active-configuration listing, no attach endpoint or UI. Note: `MAX_SESSIONS_PER_JAM = 32` (`apps/server/sessions.ts:12`) caps sessions, **not** configurations |
| Portion video-generation pipeline (adjacent, not configuration streams) | Implemented but gated/unprobed | `apps/server/playback.ts`, `apps/server/media.ts`, `apps/server/providers/fal.ts`; caps at `apps/server/media.ts:4,35` | Not probed live; refuses with a typed error without `REVERIE_LIVE_ENABLED` + `FAL_KEY`; unrelated to per-configuration streams |
| Script revision history (append / revert / list) | Implemented (local only) | `apps/server/jams.ts:257,274,292,304` | Not exposed as a Vercel function |

## Deployment gap (important for agents)

The `jams`, `sessions` and `playback` routers are mounted **only** in the local Express host
(`apps/server/app.ts`). The Vercel functions present are `api/health.ts`, `api/catalogue.ts` and
`api/live/token.ts` only. So every script/session/playback route above is local/static-preview
tooling until a privileged function is added; `docs/API_CONTRACTS.md:102-106` lists the session
routes under "Planned privileged HTTP interfaces" for that reason.

## How to keep this current

When one of these lands, move its row to **Implemented** with the new code anchor and delete the
"missing code" note. When a new intended behaviour is documented, add a row in the same change so
the register never drifts from the specs.
