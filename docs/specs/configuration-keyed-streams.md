# Configuration-keyed generated streams

**Status: intended, not implemented.** This records a product and cost-control design that the
current code does not yet contain. No per-configuration generation, cap or attach flow exists.

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

## Budget cap

- The number of distinct configurations held at once is **capped** by a server-owned limit, so
  paid generation and stored streams stay bounded no matter how many people join or how many
  variations they invent.
- The cap sits alongside the existing spend controls — the provider model allowlist, the
  generation concurrency gate, and per-jam media/spend caps. It is a budget control first, a
  product limit second.
- The limit and its enforcement live on the server. The browser never decides how many streams
  may be generated.

## When the cap is reached — attach, don't create

- A participant whose configuration is not already active, once the cap is full, does **not**
  trigger a new generation.
- Instead, the screen shows the **active configurations** in the room, and the participant
  **attaches to one** — adopting that configuration and its stream.
- This turns the cap into a visible, shared choice rather than a silent failure or an unbounded
  bill. It must never silently degrade to a mock, nor generate outside the budget.

## Open questions (unspecified)

- The exact cap value, and whether a full cap is per-room, per-host, or global.
- Eviction or replacement policy when a configuration goes unused.
- Precise normalization/canonicalisation of the configuration key.
- Whether attaching rewrites the participant's session settings, or only selects a stream for
  playback.
- How this composes with script versioning and the editable-copy flow.

## Relationship to sessions

This extends `docs/specs/script-screen-actions.md` section 3: a session is a participant's seat
in the shared room, carrying per-participant overrides; those overrides **select a
configuration**, and each active configuration maps to one generated stream. Overrides still
never fork the script or split the room.

## Implementation status

**Nothing in this spec is implemented.** There is no configuration key, stream registry, cache,
per-configuration generation, cap, active-configuration listing, or attach endpoint/UI. See the
register in `docs/specs/intended-vs-implemented.md`. The existing `MAX_SESSIONS_PER_JAM = 32`
(`apps/server/sessions.ts:12`) caps how many sessions a jam holds and does **not** cap
configurations — do not mistake one for the other.

