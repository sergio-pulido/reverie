# Intended vs implemented — script, sessions, streams and the scene contract

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
| Scene acceptance / voting from the studio | Not implemented | UI only says so: `src/screens/Studio.tsx:91` | No `scene/accept` route, service or store transition; planned row in `docs/API_CONTRACTS.md`. Target shape: `docs/specs/transactional-scene-contract.md` |
| Open as markdown (read-only) | Implemented (local only) | `src/ScriptScreen.tsx:41`; `apps/server/jams.ts:248` | Not exposed as a Vercel function (see below); no copy step |
| Copy the script into an editable version (fork-on-modify) | Not implemented | None | No route/service/store/UI; the only trace is the planned `POST /api/jams/:id/forks` row in `docs/API_CONTRACTS.md`. Target shape: `docs/specs/script-forking-and-chat-editing.md` |
| Chat-driven screenplay editing | Not implemented | None | No chat-to-edit route, command, Zod schema or UI; the Studio conversation/proposals are a separate surface. Target shape: `docs/specs/script-forking-and-chat-editing.md` |
| Create/read/update a session (language, ambientation) | Implemented (local only) | `apps/server/sessions.ts:67,100,109,118,144`; `src/ScriptScreen.tsx:80-128`; schema `src/core/session.ts` | Not exposed as a Vercel function |
| Session is the participant's seat in the collaborative room | Not implemented | None — the sessions router has no membership linkage (`apps/server/sessions.ts`); membership is Supabase `jam_members` | No shared id or derivation between `JamSession` and `jam_members`; no code makes a session admit a participant. Target shape: `docs/specs/session-as-room-seat.md` |
| Per-participant rendering (translate / re-ambient the script) | Not implemented | Only a header annotation: `src/core/scriptMarkdown.ts:28-35`; settings stored at `src/core/session.ts:16-21` | No generation or rendering of scene bodies from `language`/`ambientation` |
| Supabase-backed session persistence | Designed, not wired | Migration `supabase/migrations/20260919170000_script_format_and_sessions.sql` creates `jam_sessions` | No server code reads/writes `jam_sessions`; the router uses in-memory `InMemorySessionStore` (`apps/server/sessions.ts:32`). Target shape: `docs/specs/session-as-room-seat.md` |
| Configuration-keyed generated streams (one stream per distinct configuration) | Not implemented | A normalized key exists client-side (`configurationKey`, `src/core/portionPlayback.ts`) and the player threads it to the clip address | No stream registry, cache or per-configuration generation path; every key resolves to the jam's single stream, and the player says so on screen |
| Cap on distinct configurations + attach-to-active flow | Not implemented | None | No configuration cap, no active-configuration listing, no attach endpoint or UI. Note: `MAX_SESSIONS_PER_JAM = 32` (`apps/server/sessions.ts:12`) caps sessions, **not** configurations |
| Portion video-generation pipeline | **Removed** (RV-16) | — | Deleted along with the portion player, clip storage and the queue model allowlist. The live director is the only video path |
| Live director (realtime WebRTC stream, directable while it runs) | Implemented but gated/unprobed | `apps/server/directorStream.ts`, `apps/server/director.ts`, `apps/server/directorSessions.ts`, `apps/server/directorRecordings.ts`, `apps/server/providers/falDirector.ts`, `src/core/directorProtocol.ts`, `src/core/directorAudit.ts`, `src/screens/JamDirector.tsx` | No session has ever been opened with a valid key and no stream has been watched. Gated by `REVERIE_DIRECTOR_ENABLED`. The SERVER is the WebRTC peer, so every direction is audited and the track is recorded; the browser watches the recording, not a live feed. Long-lived connection, so container-only — not a Vercel function |
| Playing the generated clips back | **Removed** (RV-16) | — | `JamPlayer` and the portion player are deleted; the Studio and script screen mount `JamDirector` |
| Durable clip storage | **Removed** (RV-16) | — | Per-portion clip storage is gone. Director recordings use `apps/server/directorRecordings.ts`; durable reproduction of a session is RV-18 |
| Durable playback cursor | **Removed** (RV-16) | — | `JamStore.getPlayback`/`updatePlayback` and `PlaybackCoordinator` are all deleted; there is no cursor to persist. The lock window is derived live from the stream (`src/core/directorBeats.ts`) rather than stored |
| Script revision history (append / revert / list) | Implemented (local only) | `apps/server/jams.ts:257,274,292,304` | Not exposed as a Vercel function |
| Voting on proposals (`vote.cast`) | Not implemented | None | No votes table, RPC, tally rule or UI; `jam_proposals` has no update policy, so the illegal path is closed and the legal one is not open. Target shape: `docs/specs/transactional-scene-contract.md` |
| Story version + idempotent command envelope (`requestId`, `expectedStateVersion`) | Not implemented | None. `JamStore` holds no compare-and-swap at all since `updatePlayback` was deleted with the portion pipeline; the interface is append-only history plus `updatePortion`/`revertScriptToRevision` | No story version, no `requestId` register, no serialized scene commit, and no version guard to adopt — it has to be built |
| Script version lines (forks) and adoption | Not implemented | None. Single append-only revision line per jam: `apps/server/jams.ts`, `src/core/scriptHistory.ts` | No line concept, fork root, adoption command or conflict surface. Target shape: `docs/specs/script-forking-and-chat-editing.md` |
| Reference uploads (image / video clip) as creative contributions | Not implemented | None | No upload route, reference descriptor, reference store or private reference bucket. The pattern to copy is director recordings (`apps/server/objectStorage.ts`, `apps/server/directorRecordings.ts`) — references need their own bucket, not a prefix in one with different mime and size limits. Target shape: `docs/specs/multimodal-creative-turns.md` |
| Voice capture and transcription | Implemented for Discover; not implemented for the jam room | SLNG adapter `apps/server/providers/slng.ts` with a server-owned model allowlist, reached by `POST /api/voice/transcribe` and the `/api/voice/stream` WebSocket relay (`api/voice/transcribe.ts`, `apps/server/voiceStream.ts`, client `src/voice/`) | No jam-scoped `audio.start`/`audio.stop`, no `transcript.*` events, no room-scoped authorization, and no path from a transcript to a proposal. Reuse the adapter; do not add a provider |
| Proposals carrying references | Not implemented | `jam_proposals.body` is text 1–280 chars (`supabase/migrations/20260919190000_jam_collaboration.sql`) | No column or join table for attachments, and no policy scoping an attachment to a reference the author owns |
| Capturing a frame from the live stage as a stored reference | Not implemented | Live publish + consent only: `docs/specs/jam-live-media-vonage.md`, `jam_live_consents` | No capture action and no retention consent distinct from the publish consent |
| Cross-instance serialization of script mutations | **Gap, unowned** | `withJamLock` (`apps/server/jams.ts:104`) wraps the portion-edit and revert routes at `:366` and `:393` | An in-process mutex. Correct while the routers are local-Express-only; once deployed as Vercel functions each instance holds its own map and concurrent edits race silently. Narrowed but not closed by the portion pipeline's deletion — it still guards exactly the mutations the lock boundary protects |
| Story outline projection (beats over the script) | Implemented | `src/core/outline.ts` (`buildOutline`, `beatAtOffset`); `summary` on the portion schema, `src/core/script.ts` | No route serves it; no client surface renders it |
| Outline cascade (re-derive the tail from an edited beat) | Implemented, no provider wiring | `src/core/outlineCascade.ts` (prompt, reply schema, `applyCascade`) — pure and tested offline | Nothing calls a provider with the prompt; no completion is wired, so no cascade has ever run |
| Outline edit queue (serialized, envelope-guarded) | Not implemented, and blocked | None | No queue, no edit intent type, no `expectedStateVersion` handling, no atomic commit against the lock boundary. Blocked on the store prerequisite in `docs/specs/transactional-scene-contract.md`: `withJamLock` is in-process only, so it cannot serialize once deployed |
| Ways to modify the outline (direct, vote, poll, chat) | Not implemented | None | No adapter of any kind exists. Each produces one `set`/`reroll` intent; the gate that admits one is the acceptance contract above (`docs/specs/transactional-scene-contract.md`), and `jam_proposals` remains append-only with no update policy |
| Beat delivered as live director direction | Not implemented | Consumer exists (`apps/server/directorStream.ts`, RV-16, unmerged); `beatAtOffset` computes the current beat | Nothing calls `direct` with a beat; no producer is wired |

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
