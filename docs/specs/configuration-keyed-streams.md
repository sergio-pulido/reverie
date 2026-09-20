# Configuration-keyed generated streams

**Status: partly implemented, for the live director only.** The live director generates one
stream per distinct configuration and viewers attach to it. The stored-portion playback path
still serves one stream per jam, and the cap's *visible* half — showing the room's active
configurations and choosing one — does not exist. See "Implementation status" below for the
line-by-line position.

## Problem

Per-participant overrides (`language`, `ambientation`, per `docs/specs/script-screen-actions.md`)
mean playback can differ from person to person. If Reverie generated a distinct stream for every
participant, paid generation and storage would scale with headcount. The cost driver should be
the number of **distinct configurations actually present in the room**, not the number of people.

## Model

- A **configuration** is the normalized tuple of per-participant playback overrides — today
  `language` + `ambientation`. Two sessions with the same configuration share one configuration.
- A **generated stream** is the produced playback artifact for one configuration.
- The room holds as many streams as there are distinct configurations **found among its
  participants** — not one per session, not a single global one. Streams are created as
  configurations appear, not eagerly for every possible combination.
- Participants with the same configuration receive the **same** stream: one generation, reused.
  Configuration keys are normalized so cosmetic differences (surrounding whitespace, language
  tag casing) do not multiply streams.

## Concurrency cap

- The number of distinct configurations held at once is **capped** by a server-owned limit, so
  paid generation and stored streams stay bounded no matter how many people join or how many
  variations they invent.
- The cap sits alongside the other resource controls — the provider model allowlist, the
  generation concurrency gate, and bounded session duration. This build does not track spend
  (`docs/DECISIONS.md`), so the cap is the bound, not an accounting of one.
- The limit and its enforcement live on the server. The browser never decides how many streams
  may be generated.

## When the cap is reached — attach, don't create

- A participant whose configuration is not already active, once the cap is full, does **not**
  trigger a new generation.
- Instead, the screen shows the **active configurations** in the room, and the participant
  **attaches to one** — adopting that configuration and its stream.
- This turns the cap into a visible, shared choice rather than a silent failure or an unbounded
  number of streams. It must never silently degrade to a mock, nor generate past the cap.

## Open questions (unspecified)

- The exact cap value, and whether a full cap is per-room, per-host, or global.
- Eviction or replacement policy when a configuration goes unused.
- Precise normalization/canonicalisation of the configuration key. The client-side key above is
  what this build does, not a ruling: the server owns the real one.
- Whether attaching rewrites the participant's session settings, or only selects a stream for
  playback.
- How this composes with script versioning and the editable-copy flow.

## Relationship to sessions

This extends `docs/specs/script-screen-actions.md` section 3: a session is a participant's seat
in the shared room, carrying per-participant overrides; those overrides **select a
configuration**, and each active configuration maps to one generated stream. Overrides still
never fork the script or split the room.

## Implementation status

Split, because the two playback paths are in different places.

**The live director implements the core of this spec.**

- Streams are keyed by configuration: `<jamId>:<configurationKey>`, held by the session ledger
  (`apps/server/directorSessions.ts`), not one stream per participant.
- `POST /api/jams/:id/director/session` takes an optional `configuration`. A configuration that
  already has a stream returns **200 with `attached: true` and the same `sessionId`** instead of
  refusing; a different configuration opens its own stream, still bounded by concurrency and
  session duration. Two sessions with the same configuration therefore receive the same stream.
- Configuration keys are normalized in one place (`configurationKey`, `src/core/portionPlayback.ts`
  — language tag lowercased, ambientation trimmed and its whitespace collapsed) so cosmetic
  differences cannot multiply provider streams.
- Everyone on a configuration is *delivered* the same stream, not merely told they share one:
  one HLS playlist and one set of fMP4 segments per configuration, fetched over plain HTTP
  (RV-19, `docs/DECISIONS.md`). Segment addresses are per session, so the shared stream is shared
  in fact and not only in accounting.
- Viewers on a shared stream are counted, so it outlives any one of them leaving and is settled
  when the last one does.

**Not implemented, and still open.**

- The **visible** half of the cap. `maxConcurrentSessions` bounds how many streams may run at
  once and refuses `too_many_sessions` beyond it; what the spec asks for is that a participant
  whose configuration is not active then sees the room's **active configurations and attaches to
  one**. There is no active-configuration listing and no such choice. A full cap today is a typed
  refusal, not a shared decision.
- Eviction or replacement policy when a configuration goes unused.
- Whether attaching rewrites the participant's session settings or only selects a stream.
- How this composes with script versioning and the editable-copy flow.
- The **stored-portion** playback path is unchanged: the player normalizes its configuration into
  a key and asks for its clip under it, but the server serves one generated stream per jam, and
  the key is deliberately not sent as a query parameter. `MAX_SESSIONS_PER_JAM = 32`
  (`apps/server/sessions.ts:12`) caps how many sessions a jam holds and does **not** cap
  configurations — do not mistake one for the other.

**Nothing on the provider path is probed.** No Director session has been opened with a valid key,
so "one provider stream per configuration" is how the code is built, not a measured claim about
how fal behaves. See the register in `docs/specs/intended-vs-implemented.md`.
