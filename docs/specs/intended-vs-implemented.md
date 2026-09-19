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
| Configuration-keyed generated streams (one stream per distinct configuration) | Not implemented | A normalized key exists client-side (`configurationKey`, `src/core/portionPlayback.ts`) and the player threads it to the clip address | No stream registry, cache or per-configuration generation path; every key resolves to the jam's single stream, and the player says so on screen |
| Cap on distinct configurations + attach-to-active flow | Not implemented | None | No configuration cap, no active-configuration listing, no attach endpoint or UI. Note: `MAX_SESSIONS_PER_JAM = 32` (`apps/server/sessions.ts:12`) caps sessions, **not** configurations |
| Portion video-generation pipeline (adjacent, not configuration streams) | Implemented but gated/unprobed | `apps/server/playback.ts`, `apps/server/media.ts`, `apps/server/providers/fal.ts`, `apps/server/providers/falModels.ts`; caps at `apps/server/media.ts:4,35` | Not probed live; refuses with a typed error without `REVERIE_LIVE_ENABLED` + `FAL_KEY`; unrelated to per-configuration streams. Default model `minimax/h3-max/text-to-video`; portions bounded to `[5, 15]`s by the model (RV-16) |
| Live director (realtime WebRTC stream, directable while it runs) | Implemented but gated/unprobed | `apps/server/directorStream.ts`, `apps/server/director.ts`, `apps/server/directorSessions.ts`, `apps/server/directorRecordings.ts`, `apps/server/providers/falDirector.ts`, `src/core/directorProtocol.ts`, `src/core/directorAudit.ts`, `src/screens/JamDirector.tsx` | No session has ever been opened with a valid key and no stream has been watched. Gated by `REVERIE_DIRECTOR_ENABLED`. The SERVER is the WebRTC peer, so every direction is audited and the track is recorded; the browser watches the recording, not a live feed. Long-lived connection, so container-only — not a Vercel function |
| Playing the generated clips back | Implemented (local only) | `src/screens/JamPlayer.tsx`, `src/screens/usePortionPlayback.ts`, rules in `src/core/portionPlayback.ts` | Play and stop only, no seek; one stream per jam, so every configuration watches the same clips |
| Durable clip storage | Implemented, unprobed | `apps/server/supabaseMedia.ts`, bucket in `supabase/migrations/20260919233000_jam_portion_media.sql` | Needs `SUPABASE_SERVICE_ROLE_KEY`; no dated run against a real bucket yet. Without the key clips stay in memory and the store reports `durable: false` |
| Durable playback cursor | Not implemented | `JamStore.getPlayback`/`updatePlayback` exist (`apps/server/jams.ts:72`) but `PlaybackCoordinator` keeps its own `Map` (`apps/server/playback.ts`) | A restart returns a jam to `idle` while its clips remain |
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
