# UJ-03 — Session configuration cap

Covers: the per-participant playback override model where sessions that share a configuration
share one generated stream, the server-owned cap on distinct configurations, and the
"attach, don't create" behaviour once the cap is full. Three participants across three
isolated contexts exercise it.
Runtime: ~12 minutes (once implemented).
Environment: A or B, with a jam that has a script (from [UJ-02](02-reproduce-the-video.md)).

> ## Status: BLOCKED — intended, not implemented
>
> The configuration cap and the attach flow are **specification only** today:
> `docs/specs/configuration-keyed-streams.md` opens with "Status: intended, not implemented",
> and no cap, configuration list or attach route exists in the code. The only current limit is
> `MAX_SESSIONS_PER_JAM = 32` sessions in `apps/server/sessions.ts`, which is not a
> configuration cap.
>
> Run steps 1–2 as written; step 3 is expected to be `BLOCKED` and must record the **absence**
> of the cap rather than a pass. The expected behaviour is written out so this runbook can be
> run unchanged once the feature lands. Do not claim the cap works until a dated run passes
> step 3.

## Goal

Prove the cost driver is the number of **distinct configurations** in the room, not the number
of people: a room holds at most **two** configurations at once, streams are shared between
participants with the same configuration, and a third participant with a new configuration
attaches to an existing one instead of triggering another paid generation.

## The one mental model

- A **session** is a participant's seat in the shared collaborative room, carrying per-seat
  overrides (`language`, `ambientation`). It never forks the story or splits the room
  (`docs/specs/script-screen-actions.md`).
- A **configuration** is the normalized tuple of those overrides. Two sessions with the same
  configuration are one configuration.
- A **generated stream** exists per active configuration. Participants with the same
  configuration receive the same stream: one generation, reused.
- The **cap** (two, for this run) is server-owned. The browser never decides how many streams
  may exist. When the cap is full, a participant **attaches** to an existing configuration.

## Preconditions

- A jam with a script and a reachable `/api/jams/<jamId>/sessions` route.
- Three isolated browser contexts: `reverie-a` (host/creator), `reverie-b`, `reverie-c`.
- The cap is configured to `2` for this run. The exact value and where it is set are open in
  the spec; record the value you were told to expect, and treat "2" as the test value.
- **Reachability caveat (current gap).** The "Your session" form lives only on the script
  screen, which exists in the page session that created the jam. Until sessions are unified
  with room membership (`docs/specs/script-screen-actions.md`, "Current gap"), participants B
  and C drive the session API with `evaluate_script` from the app origin. Use the same body the
  form sends:

  ```js
  async () => await fetch("/api/jams/<jamId>/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "<name>", settings: { language: "<tag>", ambientation: "<text>" } }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  ```

  **Treat every `ownerToken` in a response as a secret: never screenshot, paste or report it.**

## Steps

### 1. A creates the room and the first configuration

- Do: in `reverie-a`, register the room and generate its script exactly as in
  [UJ-02](02-reproduce-the-video.md) section A (or use the fixture). In the `YOUR SESSION`
  panel, name `Host A`, language `English`, ambientation empty; click `Start my session`.
- Expect:
  - `POST /api/jams/<jamId>/sessions` returns `201` with a session and a one-time
    `ownerToken`.
  - The panel becomes `YOUR SESSION · Host A`; configuration 1 is **(en, "")**.
  - `My script view` annotates the header with `language en, ambientation as written`.
- Evidence: `uj-03-config-a.png`; the session payload minus the token.

### 2. B creates a second, different configuration

- Do: in `reverie-b`, create a session with language `Español` and ambientation
  `sunlit watercolor`.
- Expect:
  - The request returns `201`; configuration 2 is **(es, "sunlit watercolor")**, distinct from
    configuration 1.
  - The room now holds **two** active configurations — the cap — both listed among the room's
    participants.
  - B's `My script view` reads `language es, ambientation “sunlit watercolor”`.
- Evidence: `uj-03-config-b.png`; the session payload minus the token.

### 3. C cannot create a third configuration and attaches to B's

This is the cap behaviour. **Expected once implemented:**

- Do: in `reverie-c`, attempt a session with a third distinct configuration, for example
  language `Français`, ambientation `arctic night`.
- Expect:
  - The server refuses to create a third configuration at the cap with a typed, non-retryable
    error (for example a `configuration_cap_reached` code; record the actual code). It must
    **not** fail silently and must **not** generate outside the budget.
  - The screen lists the room's active configurations — **(en, "")** and
    **(es, "sunlit watercolor")** — and offers an attach control rather than a create form.
- Do: C attaches to the second configuration, B's **(es, "sunlit watercolor")**.
- Expect:
  - C's playback view shows `language es, ambientation “sunlit watercolor”` — the same
    configuration as B — and C receives the **same** stream B receives.
  - No third generated stream is created and no third generation is enqueued: the distinct
    configuration count stays at `2`.
  - Attaching does not remove B or change A's configuration.
- Evidence: the refusal body, the configuration list screenshot `uj-03-cap-attach.png`, and
  C's annotated script view.

**Expected today (record this instead):** `POST /api/jams/<jamId>/sessions` succeeds and creates
a third session; there is no configuration list, no attach control and no cap. Mark step 3
`BLOCKED` — "feature not implemented (docs/specs/configuration-keyed-streams.md)" — and attach
the successful third-session payload (minus the token) as proof of the gap. Do not mark it
`PASS`.

### 4. Same configuration is shared, not multiplied

- Expected once implemented: a fourth participant (or C before the cap, if you reorder) who
  chooses `es` + `sunlit watercolor` does **not** create a new configuration. Two sessions with
  the same tuple share one configuration and one stream.
- Expected today: this is `BLOCKED` too; record it.
- Evidence: the session payload and the configuration count.

### 5. Normalization

- Expected once implemented: cosmetic differences — surrounding whitespace, language-tag
  casing (`ES` vs `es`) — normalize to the same configuration and do not multiply streams. The
  exact canonicalisation is an open question in the spec; record what the build actually does.
- Expected today: `BLOCKED`.
- Evidence: two session payloads and the resulting configuration count.

### 6. Budget stays bounded

- Do: over the whole run, count distinct configurations and generated streams.
- Expect: distinct configurations **≤ 2**; generated streams **= distinct configurations**;
  no stream is generated for an attached (non-created) configuration beyond the one it shares.
  Never let the room silently degrade to a mock or generate outside the cap.
- Evidence: a one-line count in the report.

## Pass criteria

- A room holds at most the configured number of distinct configurations (2 here).
- Participants sharing a configuration share one stream; one generation, reused.
- A participant whose configuration would exceed the cap is shown the active configurations and
  attaches to one; no extra stream is generated and no silent failure occurs.
- The count of streams equals the count of distinct configurations.

## Failure signals

- A third distinct configuration is created and a third stream is generated.
- The cap is enforced only in the browser (for example by hiding the form) while the API still
  creates the configuration.
- Attaching silently degrades to a mock, or generates anyway.
- The cap error is retryable, untyped, or leaks a provider/internal detail.
- Two sessions with the same normalized configuration produce two streams.

## Teardown

- Record the three contexts, each configuration, and the distinct-configuration/stream counts.
- Note that `ownerToken` values are never recorded.

## Not covered

- Per-configuration translated/re-ambiented rendering itself (a later, budgeted provider step).
- Eviction or replacement of an unused configuration (open in the spec).
- Whether attaching rewrites the session settings or only selects a stream (open in the spec).
- Live media / Vonage.
