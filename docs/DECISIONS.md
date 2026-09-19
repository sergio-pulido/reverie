# Decisions

## 2026-09-20 — Probe receipt: what MiniMax H3 actually returns, and what the room is built on

Two live generations through `minimax/h3-max/text-to-video` with a real loop shot from a
shipped scenario, on 2026-09-20, via `scripts/probe-escape-segment.mts`:

| asked | measured duration | bytes | accepted | completed | playable file |
| --- | --- | --- | --- | --- | --- |
| 15s | **15.104s** | 9,795,075 | 523ms | 22.9s | 25.3s |
| 5s | **5.184s** | 3,792,092 | 488ms | 6.4s | 8.7s |

Both came back as `video/mp4` from `v3b.fal.media`. Two things follow, and the escape room is
built on them rather than on the published schema.

**The model overshoots, by a tenth of a second or two, and not proportionally.** So a clip's
length is read from the file (`src/core/mediaDuration.ts`, the `moov`/`mvhd` header) rather than
assumed from the request, and it is the measured number that the panel shows and that the cut
back to the loop is timed against. A room that trusted the request would drift a little further
out of true on every beat.

**A fifteen-second beat takes about twenty-five seconds to become playable — longer than the
beat itself.** The idle loop is therefore not a nicety; it is the only thing between the room and
a spinner. A location's loop is generated at 5 seconds, which is the model's floor, the cheapest
and, measured here, the fastest to first frame; a beat is 15. A beat that arrives late is simply
a longer loop, and one that never arrives leaves the loop running.

At the configured list rate of $0.08 per generated second that is $0.40 a loop and $1.20 a beat,
so a clean ten-step run of a scenario costs about $14 of the $20 ceiling this project ships with.
That is why the ceiling ending a session is a designed ending rather than a failure. **The rate
is a configured estimate, not an invoice this repository has seen**: it is the figure the
director already used, chosen because list price never understates the bill.

Also verified live, in a browser against the hosted Supabase project, on 2026-09-20: a room
opened, a proposal in a participant's own words resolved and was filmed, a second proposal was
discarded, the beat cut in over the loop and handed the screen back when it ended, and a refusal
was reported in the author's words without spending anything. Not verified: two browsers in one
room, and any of this on Vercel.

## 2026-09-20 — The rules decide what happened; the model only tells it

An escape room's whole value is that it is coherent — that the key fits the drawer for everyone,
on every replay, in the same way. So the question "what happened" is answered by a pure module
(`src/core/escape/rules.ts`) with no network, no React, no clock and no randomness, reading an
authored scenario, and by nothing else. The model is handed the resolved outcome afterwards and
writes the prose and the shot. It is never asked a question about the world, so there is nothing
here for it to get wrong about the world.

That boundary is enforced, not hoped for. An outcome that does not advance returns the very state
it was given, **by identity**, so "an impossible action changes nothing" is checkable rather than
intended. An advancing one appends exactly one action id to a log, and the tests search each
scenario exhaustively over the transitions the rules actually produce, replay every reachable
goal log to prove it reproduces that same world, and prove that dropping any single step of a
shortest solution fails to reach the goal.

**Interpretation is a matcher, not a model.** Turning "jam the crank with the file" into an
action is also a question about this world, so it is answered by the same offline, testable code
(`src/core/escape/intent.ts`). The cost is real and is stated where it lives: a phrasing nobody
anticipated does not match, and the room is told so rather than handed something it did not ask
for. Widening that is an author writing more aliases.

**Every refusal is the author's sentence.** A condition carries the words to say when it does not
hold, so a room is told "the porch is still filling; the pressure behind the door will not let
the dogs move" rather than a template. A generic "you cannot do that" is what makes a room feel
arbitrary, and the format has nowhere to put one.

**Things carry `seen` as well as `known`.** A door two rooms away is not hidden, but nobody has
been there: it must not appear in the progress panel, and naming it must read as meaningless
rather than as "it is not here", which would confirm the building has one. This was found by a
test asserting what the panel lists at the start, and it changed the format.

## 2026-09-20 — Only an outcome that changed the world is filmed

A beat costs $1.20 and a clean run of a scenario is ten or eleven of them against a $20 ceiling.
A refusal — "the lock still holds", "the bolt will not move by hand" — is the most cinematic
thing in an escape room and is also the cheapest thing to get wrong about: the scenario authors a
shot for what happens, not for what does not. So refusals become beats in the record, are shown
to the room with the sentence their author wrote, and are not generated. The loop keeps the
screen and the panel says "not filmed".

The alternative was letting the model invent a shot for a failure. That is inside the boundary —
the rules had already decided it failed — but it would spend a fifth of the budget on the door
that did not open, and the room would run out before reaching the one that does.

## 2026-09-20 — One spend account for the process, and the queue half of the fal adapter

`FAL_ASSET_BUDGET_USD` is documented as a ceiling on this process. A second feature holding its
own copy of that number would have meant two features each believing they could spend all of it,
and the documented ceiling would quietly have become twice what it says. Money now lives in one
`SpendAccount` (`apps/server/spendLedger.ts`); the director ledger keeps its reservation
behaviour unchanged and debits that account instead of a private total.

The escape room needs a clip it can **play again** — a location's loop is generated once and
reused for the rest of the session — and a realtime Director session cannot give you one: it
produces frames and no file, which is exactly why RV-16 deleted the per-portion queue pipeline
and said the director was the only video path. That decision stands for the **film**: a Movie Jam
is still one continuous directed stream. It does not fit a room that has to cut between a
reusable loop and a rendered action, so the fal adapter regains its queue half
(`apps/server/providers/falSegments.ts`) for the escape room only. Same provider, same rules: a
typed spec per model carrying the duration band and request body it actually wants, a
server-owned allowlist that `FAL_MODEL` selects from, an unknown value refused rather than
quietly replaced, and no path anywhere that produces something which only looks generated.

## 2026-09-20 — The escape-room routes check who is asking; the rest of this Express host does not

The script, session and director routes on the local Node server carry no authorization — a
known, recorded gap. The escape-room routes do not repeat it: they move a world a whole room can
see and they spend from a budget, so identity is Supabase Auth's answer to the presented access
token and the role is the caller's own `jam_members` row read under Row Level Security with that
same token. This server holds no service-role key for it and can see no more than the participant
it is acting for. Opening a room and closing a vote are host-only; proposing and voting need an
active member; an `authorId` in a request body is rejected outright rather than overruled.

A room is polled by everyone in it every three seconds, and two Supabase calls per participant
per poll is not a thing to ship. The answer is cached for twenty seconds against a SHA-256 digest
of the token — the digest, so a long-lived structure never holds a credential. The cost is
stated where it lives: an admission or a removal takes up to twenty seconds to be felt.

This leaves the host inconsistent, and deliberately so. Bringing the other routes up to this is
worth doing and is not this slice; what is not worth doing is adding a fourth unauthenticated
surface because the first three are.

## 2026-09-20 — The account menu shows the real anonymous session, not a fabricated identity

The top bar now ends in an avatar with a menu behind it. The obvious way to build that surface is
to invent what it needs: a placeholder name ("Guest", "You"), a stock photo, a seeded email. Every
one of those would be a lie that the app then has to keep, and the lie is load-bearing in the worst
place — the account menu is exactly where a viewer looks to answer "who does this app think I am?"

The app already has a real answer. Every visitor is signed in anonymously through Supabase Auth the
first time a screen reads anything (`src/lib/session.ts`), and that user id is what row-level
security checks on every jam, membership, message and proposal. So the menu surfaces **that** user
and nothing else:

- The **colour** of the circle is *derived* from the Supabase user id (`src/shell/avatar.ts`), not
  stored. That is what makes it stable across visits and devices without a profile table, and it
  is why a sign-out visibly changes it: it is a new identity, and it should not look like the old
  one.
- The **initials** come from the display name the viewer gave a room (`jam_members.display_name`),
  because that is the only name the app keeps for them. With no name the circle shows a neutral
  mark and the menu says "Signed in" — true, and short of inventing one. No email and no photo is
  shown, because the app holds neither.
- The avatar **never signs anyone in** to find out who they are. It watches the session and waits
  for the sign-in the screens themselves cause, so a surface that only *shows* the viewer cannot
  create one.
- **Log out is a real sign-out**, not a local reset: Supabase ends the session, the identity module
  forgets the id it confirmed this page load, and the next visit mints a new anonymous user with a
  different id, a different colour and no rooms. Anything weaker would leave the menu offering an
  action that does not do what it says.

**Account is present, focusable and does nothing.** It is in the menu because the menu's shape is
part of this slice and a later one owns the screen behind it; it opens nothing rather than
pretending to. Its absence would have been the other kind of lie — a menu that looks finished.

The cost is accepted and stated: an anonymous identity is per browser profile, so the same person
on two devices is two viewers with two colours, and signing out discards the rooms that identity
hosted or joined. Both follow from anonymous auth, which this repository chose earlier; neither is
made better by drawing a fictional account over it.

## 2026-09-20 — Every integration goes through a PR; nobody pushes to `main` directly (RV-20)

`AGENTS.md` and `docs/CONTRIBUTING.md` described a two-tier delivery model: a "primary agent"
pushing small verified commits straight to `main`, and a "collaborating developer" going through
PRs. That split no longer holds — the fleet working this repository grew past the point where a
direct push to a shared branch is safe to reason about, and it was flagged as a live contradiction
(one contributor building against the documented direct-push rule while another had just been told
the opposite). The rule is now uniform: rebase onto the latest `main`, push the branch, open a PR,
merge the PR. Nobody, including the session that used to be "primary", pushes to `main` directly.
`AGENTS.md`, `docs/CONTRIBUTING.md` and `README.md` are updated to say so; entries dated before this
one that describe or assume a direct push to `main` are historical record, not current practice.

## 2026-09-19 — The story outline is a centralized artifact, and every way to modify it is an adapter

A jam's script is the right artifact to generate and to play, and the wrong one to **steer**: no
participant can be asked to read four minutes of screenplay to change where the story is going.
The **outline** — one brief phrase (a **beat**) per portion, ordered and coherent — is the
readable projection that makes the film glanceable.

The load-bearing reason it is a *named, centralized* artifact is different, and is the product
goal: there are to be **several ways to modify the story** — up and down votes on parts of the
future, chat, polls, a direct rewrite, and mechanisms not yet imagined. Without a central target,
each of those would have to know how to edit a screenplay: validate the portion schema, respect
the playback lock window, hold the runtime inside the jam format, preserve the flat portion
indices that key generation jobs, and serialize against the others. That is the same dangerous
logic written four times, with four chances to corrupt a script the room has already paid for.

So every mechanism is an **input adapter** that produces one typed intent against one beat, and
everything downstream happens once behind a single boundary. Two intents exist because votes
demand it: `set` (this beat becomes this phrase) and `reroll` (not this — the model chooses, and
is told what was rejected). A down-vote carries no replacement text, and collapsing `reroll` into
`set` would force voting mechanisms to fabricate prose they were never given. Adding a fifth
mechanism should mean adding an adapter and touching none of the machinery below.

The layer is called the outline, not "history", because `scriptHistory.ts` / `JamScriptHistory`
already means the append-only revision log; this repository has already paid once for that kind
of collision, when `Jam` had to be split into `JamRoom`. See `docs/specs/story-outline.md`.

## 2026-09-19 — A beat edit re-derives the rest of the story, in one call, without touching timing

Editing a beat re-derives **every beat after it** and rewrites their portions. The room asked for
an outline that stays coherent, so coherence is enforced rather than hoped for: changing "she
finds the key" to "she loses the key" must not leave later beats assuming she has it. The
accepted cost is explicit — a later beat another participant contributed can be rewritten by
someone else's earlier edit — and the alternative, a self-contradicting outline, defeats the
artifact's purpose.

Three bounds make that affordable and safe. **One completion rewrites the whole tail**, never one
call per portion: cheaper (one paid call per edit rather than up to forty-six), but chosen mainly
because a model that sees the entire remainder at once writes a coherent tail where a chain of
local rewrites reproduces the incoherence being prevented. **Durations are never rewritten**, so
the runtime stays inside the jam format by construction and needs none of the fitting retries
generation requires. **Structure is never rewritten**: the reply is a flat list covering the tail
exactly, re-attached to existing scenes by position, because flat portion indices key the
generation jobs and renumbering them would silently re-key every clip already bought.

Edits are **serialized** per jam — admitted to a queue and processed one at a time, each cascade
computed against the previous result — because two parallel cascades would each re-derive the
same tail from a different story and the second would erase the first. With many mechanisms
feeding one artifact, simultaneous edits are the normal case.

The lock window applies unchanged, and the check is smaller than it looks: the window is a prefix
and a cascade only runs forward, so only the **edited** beat needs checking. The real hazard is a
race — playback advances during the provider call — so a cascade is computed optimistically
outside the critical section and committed atomically inside it, refused with `portion_locked` if
the boundary moved meanwhile. A cascade in a fast-playing room can therefore be paid for and
discarded, which is preferred over a half-rewritten story or a room frozen for the length of a
provider call.

## 2026-09-19 — Viewers watch the live stream by RTP relay, not by waiting for a recording (RV-16)

A director session is watched **as it is generated**. The browser peers with THIS SERVER, which
already holds the fal connection, and the server forwards a copy of the inbound track. Nothing
peers with fal, so every frame still arrives here first and stays auditable and recordable — the
"proxy everything through the server" rule is kept, and the viewer stops having to wait for a
recording that only appeared at stop.

**Relaying is not muxing, and that distinction is the whole design.** The 99% CPU that blocked
the event loop came from muxing WebM, not from receiving RTP. Forwarding depacketizes nothing,
muxes nothing and re-encodes nothing: the packet that arrives is the packet that leaves.

Measured on a real session at 480p, one viewer attached, 2749 RTP packets relayed over 30s:

| | muxing to disk | relaying to a viewer |
| --- | --- | --- |
| Server CPU | 99% | 3.5–5.8% |
| `GET /api/health` | timed out | 200 in 4–13ms |
| `POST .../end` | timed out | 204 |

So the stop path survives the media path, which is the invariant that failed before. Video and
audio both forward; the first packet arrived 4.8s after attach, which is fal's generation
warm-up rather than relay latency.

**This corrects the earlier recommendation of HLS for live viewing.** That advice assumed the
choice was between cheap HTTP segments and expensive per-viewer connections. The real cost driver
turned out to be muxing — which HLS *requires* and a relay *avoids* — so for getting video in
front of a viewer, relaying is both cheaper and lower latency. HLS remains the right answer for
scale and CDN reach, and RV-19 is building it off-thread; the two are complementary, and a relay
is what makes the feature work today.

One fal session fans out to every viewer attached to it, so a shared configuration still costs
one stream rather than one per person. A viewer whose peer dies cannot take down the session or
the other viewers: a failed `writeRtp` is swallowed per-viewer.

**The measurement above is one viewer, and per-viewer cost is exactly what a relay is supposed to
be questioned on.** One viewer at 3.5–5.8% does not establish what ten cost, and "several
consumers watching one stream" is the requirement. A probe with three or four attached viewers
costs the same billed minute and is the one still owed; until it is run, the relay is proven
cheap for one viewer and *assumed* to scale.

**Viewers are counted, because a session bills whether or not anyone is watching.** A viewer that
navigates away never calls the teardown route, so the peer's connection state is the only honest
signal that it is gone. When a session's last viewer leaves, the session stops rather than
billing on to the 90-second idle reclaim. A session nobody has joined *yet* is left alone: having
had no audience is not the same as having lost one. Viewer peers are tracked per session, so
ending one session does not tear down another's audience.

## 2026-09-19 — Capturing the director's media on the server thread blocks the server (RV-16)

Measured, not predicted. With a real session running at 480p, the Node process sat at **99% CPU**
and the event loop stopped: `/api/health` timed out, and so did
`POST /api/jams/:id/director/session/:sessionId/end` — **the route that stops the paid session**.
The server had to be killed, which drops the peer without telling fal to stop, and fal's
`max_session_seconds` is 900.

Depacketizing RTP and muxing WebM on the same thread that serves HTTP does not work. Recording is
therefore **opt-in and off by default** (`REVERIE_DIRECTOR_RECORD`), and `DirectorStream` discards
the track unless it is set. The control path — opening a session, sending direction, recording the
audit trail, enforcing the beat lock — does not touch media and is unaffected.

This makes the honest split visible: **direction and audit are proven; capture is not.** Moving
capture off-thread (a worker, or a separate process) is RV-18's problem, and RV-19's delivery work
inherits the same constraint. Neither should assume the main thread can carry media.

The cost lesson is separate and worth stating on its own: a server that cannot answer is a server
that cannot stop spending. Any future media work needs the stop path to survive the media path.

## 2026-09-19 — The portion-by-portion pipeline is removed; the director is the only video path (RV-16)

Reverie generated a film as a queue of per-portion clips: lock portion N, submit it to a
text-to-video model, download the result, store it, play it, advance. That whole path is
**deleted**. There is one way to make video now, and it is the live director.

Removed: the portion player and its hook (`JamPlayer`, `usePortionPlayback`), the viewer rules
(`src/core/portionPlayback.ts`), the typed client (`src/lib/portionPlayback.ts`), the shared
playback clock (`PlaybackBar`, `usePlaybackClock`, `src/core/playbackClock.ts`, `src/lib/playback.ts`),
the server coordinator and its routes (`apps/server/playback.ts`), per-portion clip storage
(`apps/server/media.ts`, `apps/server/supabaseMedia.ts`), and the queue model adapter with its
allowlist (`apps/server/providers/fal.ts`, `falModels.ts`) — whose only consumer was that
pipeline. `FAL_MODEL` is gone with it: there is no queue model to select.

`JamStore.getPlayback`/`updatePlayback` are removed too. They were the persistence seam for the
portion cursor and, per the RV-14 handover, nothing ever wired them; with the pipeline gone they
had no possible consumer.

**What survived, and where it went.** `configurationKey` / `DEFAULT_CONFIGURATION` moved to
`src/core/configuration.ts` — they key director streams, which is now their only job. The
Supabase Storage config moved to `apps/server/objectStorage.ts`, since director recordings use
the same bucket and credential. `flattenPortions` had one remaining caller and was inlined.

**The script-edit lock now has a driver again.** `PlaybackGuard` existed but defaulted to
"everything editable" and was never wired, so `portion_locked` could never fire. It is now driven
by the director's beat window through `DirectorStreamRegistry`: a jam's strictest open stream
sets `minEditablePortionIndex`. A beat edit *is* a script edit, so refusing direction on a closed
beat while letting a `PATCH` rewrite the same portion would have left two different answers to
one question.

**Two things are deliberately left behind rather than deleted.** The `jam_playback` migrations
(`20260919190000`, `20260919225000`, `20260919230000`) stay: applied migrations are history, and
rewriting them would diverge every database that has run them. The table is now unused. And
`docs/reviews/review-2026-09-19-fal-playback-pipeline.md` stays as the record of a review that
happened, about code that no longer exists.

**What this costs.** Nothing in this build stores a finished film any more. A director recording
is one session's stream, kept under `director/<jamId>/<sessionId>.webm`, and the durable
reproduction of a jam is RV-18's work. Until then, stopping a stream is the only way to keep it,
and a server without a service-role key keeps it only in memory.

## 2026-09-19 — Probe receipt: the director handshake works, and it speaks SSE (RV-16)

First live run of `minimax/h3-max/director` with a valid key, via
`scripts/probe-director.mts`, on 2026-09-19. Two sessions were opened and stopped
immediately; each bills fal's 60-second minimum.

Result: **the handshake completes and the control channel opens.** A 2095-character
offer with three media sections was answered in ~2.5s with a 3313-character answer,
also three media sections; the remote description applied, the data channel reached
`open`, `stop` was sent and the peer closed cleanly. Our server, as the WebRTC peer,
can hold a director session.

**`/start-session` answers `text/event-stream`, not JSON.** The answer arrives as the
first `data:` frame carrying `{"sdp": ...}`. The adapter had parsed the body as JSON
and reported "the director stream returned an unexpected shape" on every real
session — the endpoint's own OpenAPI declares a JSON response, so the mistake was
reading the contract rather than the wire. It now reads the event stream
incrementally and stops at the answer, because the stream may stay open for the
session and waiting for it to end would hang the handshake it completes. The JSON
branch is kept, since the published contract still says JSON.

`POST /info` also answered and confirms every constant hard-coded from the published
schema: `min_chunk_duration` 5, `max_chunk_duration` 15, `fps` 24, resolutions
480p/768p/1080p, aspect ratios 16:9/9:16/1:1. It adds two facts worth recording:
`max_session_seconds` is **900**, and `one_session_per_machine` is **true**.

**Still not probed:** no video has been received or watched. The handshake and the
control channel are proven; the media track is not.

## 2026-09-19 — MiniMax H3 Max is the video model, and its limits are the product's limits (RV-16)

Reverie generates video on **`minimax/h3-max/text-to-video`**. It is entry `[0]` of the
server-owned allowlist, which makes it both the default and what an unconfigured or
misconfigured server falls back to. `FAL_MODEL` still selects a different entry, and a value
that is not on the list is **refused** rather than quietly replaced — serving a model the
operator did not ask for is exactly the kind of unverified provider claim `AGENTS.md` forbids.

The allowlist stopped being a list of slugs. A model differs from its neighbours in the duration
band it accepts and the request body it wants, so `apps/server/providers/falModels.ts` holds
typed specs and the transport adapter asks the spec how to build a request. The same file records
that a queued request is addressed by its **application** (`minimax/h3-max/requests/<id>`) and not
by its full slug; the previous code polled the slug, which works only for models without a
sub-path and would have 404'd on this one.

**The model's duration band is now the product's portion band: whole seconds in `[5, 15]`.**
H3 Max publishes it as `duration`; the Director model publishes the same numbers as
`min_chunk_duration`/`max_chunk_duration`. A portion outside that band cannot be rendered by
anything this build can call, so it is refused at the script boundary instead of at spend time:
the format schema enforces it, the transport schema enforces it for imported scripts, and the
slack that lets a beat breathe may no longer widen past it. `TOTAL_MAX_SECONDS` is derived
(`MAX_PORTIONS × 15s = 720s`) so the advertised ceiling stays reachable. The default jam is
**20 seconds of 5-second portions**, four portions in total.

A 4-second portion was asked for and is not possible: 5 seconds is the vendor floor on every
H3 Max route. That is a vendor limit, not a preference, and nothing in this build rounds it away.

## 2026-09-19 — The server is the WebRTC peer, so every frame and every direction is on the record (RV-16)

`minimax/h3-max/director` is **not a queue model**. A session is a WebRTC peer connection: the
caller POSTs an SDP offer to `/start-session`, fal answers, and video then arrives as a media
track while direction travels over a JSON control channel (`configure`, `prompt`, `ping`, `stop`
out; `configured`, `chunk`, `prompt_applied`, `prompt_rejected`, `stream_exhausted`, `error`
back). There is no result URL.

**This server is the peer.** An earlier revision of this branch made the browser the peer and had
the server broker only the handshake, on the grounds that a browser renders a media track for
free. That was reversed: if the browser holds the connection, prompts go from the browser
straight to fal and there is no record of what the room asked for or what came back. Full control
and a complete audit trail are the point of the integration, so the server takes the connection
and pays the costs that come with it.

What that buys: every direction is **originated** here (`POST .../director/session/:id/direct`),
recorded with its prompt version, its author and the proposal it came from, and matched against
fal's `prompt_applied` / `prompt_rejected` verdict. The media track is recorded to WebM and
stored. A client has no route to the provider at all.

What it costs, stated plainly:
- **It cannot run in a serverless function.** A peer connection is long-lived, so the live
  director belongs to the container process, not to Vercel. `AGENTS.md` already forbids a
  long-lived socket server on Vercel; this is the same constraint arriving from the provider side.
- **A WebRTC stack is now a server dependency** (`werift`, pure TypeScript, no native bindings).
  `AGENTS.md` requires a measured need for new infrastructure; the audit requirement is it.
- **The browser no longer watches live.** It watches the stored recording, because forwarding the
  track to a second peer connection is a separate piece of work. The screen says so rather than
  implying liveness it does not have.

`werift` sits behind one interface (`DirectorPeer` in `apps/server/directorStream.ts`) so nothing
else in the server knows it exists, and so route tests can drive a session without opening real
sockets — a real peer also keeps the Node event loop alive and hangs the test runner.

**The audit log is deliberately stream-specific.** It records the prompt version, whether fal
applied or refused it, and which chunk it took effect on. It does not duplicate author, body,
decision or timestamps for the *proposal* that produced a direction; that record belongs to
`jam_proposals`, and a second copy would be a second, divergent account of the same event.

**Spend is unchanged and still the sharp edge.** fal bills each session a **60-second minimum of
wall-clock runtime**, so an idle open session costs as much as a working one. Opening reserves the
worst case, closing settles against the billed minimum, a session whose client stops checking in
is reclaimed without a refund, and a handshake fal *refused* is released in full — nothing ran, so
nothing is billed. The default rate is fal's list price rather than the promotional one, because
the safe direction is to over-estimate. Director stays behind its own `REVERIE_DIRECTOR_ENABLED`
flag.

**Still open, and not decided here:** whether an accepted proposal becomes live direction on an
open stream or a script edit gated by the portion-lock window. `docs/specs/transactional-scene-contract.md`
assumes the second; this integration currently implements the first as a minimal typed seam
(`DirectionRequest`) that carries `authorId` and `proposalId` without assuming where they came
from. The seam is one interface wide so it is cheap to move.

**Not probed.** No Director session has been opened with a valid key, and no generated video has
been seen by anyone. The route shape was confirmed unauthenticated — `/start-session` and `/info`
answer 401, `/health` and the bare application 404 — and every constant comes from the model's
published `/info` and AsyncAPI documents.

## 2026-09-19 — Generated streams are keyed by configuration, and a cap makes the room attach

Per-participant overrides select a configuration (today `language` + `ambientation`), and Reverie
generates **one stream per distinct configuration present in the room**, not one per participant:
two sessions with the same configuration receive the same stream. To keep paid generation and
storage from scaling with headcount, the server caps how many distinct configurations are held at
once. When the cap is full, a participant whose configuration is not active is shown the active
configurations and **attaches to one** instead of triggering a new generation. The cap is a
budget control in the same family as the provider model allowlist and the concurrency gate; it
must never silently fall back to a mock or generate outside the budget. This is intended, not
implemented: the cap value, eviction policy, configuration-key normalization, and whether
attaching rewrites session settings remain unspecified. See
`docs/specs/configuration-keyed-streams.md`.

## 2026-09-19 — A session is a seat in the collaborative room, with per-participant overrides

A jam has one collaborative room and one authoritative script; a `jam_sessions` record is a
participant's seat **in that same room**, not a separate playback space. The session carries
only per-participant overrides (`language`, `ambientation`) layered on the common behaviour, so
everyone still collaborates on the same shared activity. This refines "A jam session is one
user's playback seat" below: the variation is still stored and never forked into the script, but
the seat is understood to sit *inside* the shared room rather than beside it. Implementation gap:
the playback session (owner-token `JamSession`) and room membership (Supabase `jam_members`) are
currently separate records, and creating a session does not admit the participant. Unifying the
two is a design task, not shipped behaviour.

## 2026-09-19 — A draft that misses the runtime is corrected on the next attempt

The scriptwriter no longer sends the same prompt twice and then reports a fit failure. When a draft is outside the rescalable window, its actual total seconds, portion count, and whether it ran long or short are fed back into the next attempt together with the feasible portion band for the jam's target, so the retry is a directed correction. The same applies to a reply that fails the draft shape: the exact JSON shape is restated. Attempts stay bounded at four paid completions because each one costs money and the concurrency gate is the only other spend control; only after that cap does the fit miss become the typed, retryable `generation_failed` that a room can retry. The 0.8×–1.25× rescale window is unchanged — a draft too far off is still never silently stretched.

## 2026-09-19 — A jam registers its room first, and import is a first-class creation source

Creating a jam now registers the room before the script exists, and the pre-minted room id is passed to `POST /api/jams` as `jamId`, so one jam owns exactly one script and its revision history instead of a second, unrelated server id. `/jams` lists the rooms an identity can read (host or any member) and offers "start a new jam"; without Supabase it is an explicitly non-shareable browser-local registry, never presented as shared. Creation has two sources: generate from a prompt (Nebius, behind the existing gate) or import an existing script. Import makes no provider call, stores the pasted markdown verbatim as revision 1, and derives a word-boundary, format-bounded timed projection for playback; text that cannot fill or fit the runtime is refused with `invalid_script_import` rather than padded or shredded into mid-word fragments. The earlier "from an existing movie" prompt path stays supported by the API but is no longer a create-screen option, matching the product decision that a room brings its own script.

## 2026-09-19 — A live token is minted from membership, never requested

The browser asks for a live token with a jam id and its Supabase access token, and nothing
else; an extra `role` field is rejected rather than ignored. The function resolves identity
through Supabase Auth, reads the caller's own `jam_members` row with that same token — so it
is bound by the same RLS as the browser and needs no service-role key — and maps the result
to a Vonage role. A participant cannot hold a moderator token by asking for one, and cannot
hold any token while waiting or after removal. The token lasts ten minutes because rejoining
is cheap and a long-lived credential in a browser is not.

## 2026-09-19 — Consent is a row, and withdrawing it stops the track

A live contribution is permitted only while a `jam_live_consents` row for that owner and that
track kind is unwithdrawn and unexpired. The row records the declared creative purpose and a
server-issued `live:<uuid>` asset reference, so anything downstream cites the reference rather
than the raw feed. A database trigger issues that reference and clamps the lifetime, because a
reference the browser chose would not be server-issued and an expiry the browser chose would
not be a limit. Withdrawal is a `security definer` function that can stamp only the caller's
own row: there is no update or delete policy, so a consent record cannot be rewritten into
something its owner did not agree to. Expiry and withdrawal are the same answer to every
consumer, which is why nothing downstream has to know which one happened.

## 2026-09-19 — Live media records nothing by default

Sessions are created with `archiveMode=manual` and the slice contains no archive, broadcast,
RTMP, caption or transformation call at all. Recording, export and creative transformation are
separate permissions with their own consent fields and budgets; none of them may be reachable
as a side effect of a participant turning on a camera. fal.ai is not wired to a live feed here.

## 2026-09-19 — The Vonage credentials in this repository cannot open a video session

Two bounded probes on 2026-09-19 settled which credential shape exists. `POST
https://api.opentok.com/session/create` with an HS256 project JWT returned 403, and `GET
https://api.nexmo.com/v2/applications` with the same key and secret returned 200 listing zero
applications: these are valid Vonage *account* credentials, the configured
`VONAGE_APPLICATION_ID` is not reachable from that account, and no private key is supplied.
The adapter supports both documented shapes — an application id with an RS256 private key
against `video.api.vonage.com`, and a numeric legacy project key with an HS256 secret against
`api.opentok.com` — and accepts neither an account key nor a half-configured pair. Until a
video-capable application is supplied, `/api/live/token` answers `live_not_configured` and the
studio says live media is off. A working stage is not claimed on the strength of code that
compiles.

## 2026-09-19 — Script timing is a per-jam format with the 4-minute defaults

The total runtime and portion length band are per-jam parameters (`format`: total 10–900 seconds, portions 4–60 seconds, at most 48 portions) instead of global constants; omitting them keeps the established 4-minute, 10–20 second behaviour. The low floor exists for tiny test jams, and the scriptwriter's completion token budget scales with the expected portion count instead of paying a flat worst case. Hard bounds (±2 seconds) and the total tolerance (~6% of runtime) are derived from the chosen format, so the writer prompt, draft rescaling, and validation stay a single consistent system at any length. Stored scripts validate against a format-agnostic structural schema; strict timing is enforced at generation time against the jam's own format.

## 2026-09-19 — A jam session is one user's playback seat, not a copy of the script

Per-user variation (language, ambientation) lives in a `jam_sessions` record attached to the jam, never in a forked script: the room keeps one authoritative script and each session stores the parameters that will skin its owner's playback. In the local server, ownership is a bearer token issued once at session creation (Supabase RLS with `auth.users` ownership is the persistent equivalent, one session per user per jam). Sessions record playback parameters only; per-session generated media is a later, budgeted provider step.

## 2026-09-19 — Generated jam scripts are 4 minutes of 10–20 second scene portions

A jam starts from scratch (a small prompt) or from an existing movie (inspiration only, never a retelling). The script targets 240 seconds total, told in scene portions of 10–20 seconds (hard bounds 8–22 for coherence); a scene may hold several portions. Zod validates the model draft, and drafts within 190–300 seconds are deterministically rescaled and settled onto exactly 240 seconds — anything further off is a typed, retryable failure, never silently accepted. The script is stored as structured data (the authority) and rendered to markdown on request.

## 2026-09-19 — Nebius script generation runs behind a server-owned allowlist

`POST /api/jams` calls Nebius chat completions in JSON mode through the typed server adapter. The server owns the model allowlist (default `Qwen/Qwen3-235B-A22B-Instruct-2507`); `NEBIUS_MODEL` may only select an allowlisted model. Generation is enabled only when `REVERIE_LIVE_ENABLED=true` and a key is present — otherwise the endpoint returns a typed `generation_disabled` error instead of a mock. Probe receipt (2026-09-19): `GET /v1/models` 200; JSON-mode completion on the default model 200 in 0.85s, 39 tokens.

## 2026-09-19 — Jam persistence sits behind a JamStore interface

`createJamsRouter(store)` takes a `JamStore` (`createJam`, `getJam`) instead of owning data. The bounded in-memory store is the local development implementation; the Supabase-backed store (RV-03) replaces it without route changes, mirroring the Vercel/Supabase target architecture.

## 2026-09-19 — Use Vercel and Supabase for the public prototype

The public prototype deploys the Vite frontend and privileged Node functions to Vercel, while Supabase provides Postgres, anonymous Auth, Row Level Security, Realtime, and later Storage. This gives the demo persistent room URLs and multi-browser collaboration without operating a custom WebSocket server on a serverless platform.

## 2026-09-19 — Retain a local same-origin development server

Superseded for deployment by the Vercel/Supabase decision above. Express remains the local Vite/static-preview host; persistent room state belongs in Supabase, and collaboration uses Supabase Realtime.

## 2026-09-19 — Keep sponsor technologies behind adapters

Nebius, SLNG, fal.ai, Titan, and any confirmed HackBarna sponsor capability are server-side integrations behind typed adapters. The product contracts do not depend on one model/vendor, and no provider is represented as available before a live probe confirms it.

## 2026-09-19 — Server owns collaborative story state

The server is authoritative for membership, queue ordering, votes, story versions, accepted scenes, and budgets. Clients render snapshots/events and can show pending feedback, but cannot commit a scene independently.

## 2026-09-19 — Use Titan catalogue records as real cinema, not synthetic content

The Discover experience renders Titan-provided real films and series faithfully. Catalogue metadata and generated Movie Jam artifacts have separate schemas, identifiers, and labels so the product never presents an invented/generated work as a real title or rewrites existing films as jokes.

## 2026-09-19 — Treat media as declared creative references

Images, uploaded clips, and live camera are inputs to a shared creative turn, not opaque prompt attachments. Each has an owner, consent state, declared purpose, lifetime, and server-issued asset reference. Live media uses Vonage for room transport and fal.ai only for explicitly permitted creative transformation.

## 2026-09-19 — Script history is append-only full snapshots

The script is versioned as an append-only sequence of full snapshots behind the `JamStore` boundary. Undo restores an earlier revision as a new revision recording `restoredFromRevision`, so redo is just another restore and history is never rewritten; identical-content saves are ignored so autosave cannot flood the history. Full snapshots (≤500 revisions per jam) were chosen over diffs because a movie-jam script is small and restore must be trivial. In Supabase this is `jam_scripts` (artifact) plus `jam_script_revisions` (history) hanging off the room row in `jams`, with no update/delete policies on revisions. Amended same day: revisions snapshot the structured script, not markdown — see the next decision.

## 2026-09-19 — Structured script is the editing source of truth

Video playback needs portion-level locking (played portions immutable, the generation buffer pinned at a revision), which opaque markdown edits cannot support. Revisions therefore snapshot the structured `JamScript` and markdown became a deterministic per-revision render (it was never canonical — `renderScriptMarkdown` already varies per session). Edits are portion-scoped (`PATCH .../script/portions/:portionIndex`, flat zero-based index, structural edits forbidden in v1) and validate duration against the jam format's hard portion bounds only — the total-runtime tolerance is not re-enforced on live edits. The store stays persistence-only: edit and revert take a `minEditablePortionIndex` parameter wired by the router from the playback guard inside the same per-jam critical section (`withJamLock`), reverts that would change a locked portion are rejected outright (no partial reverts, so pinned text is immutable by construction), and playback state persists through `getPlayback`/`updatePlayback` under compare-and-swap while its semantics live in the playback module. Full contract: docs/API_CONTRACTS.md "Portion playback, locking, and video generation" (agreed with RV-06).

## 2026-09-19 — Start with one same-origin local development server

The first runnable baseline serves the Vite client through the Node/Express process at `127.0.0.1:4317`. This keeps browser-to-server contracts and provider boundaries easy to iterate on locally. It is a local development baseline, not the public deployment configuration.

## 2026-09-19 — Align deployment and collaboration foundation

Vercel serves the Vite SPA and `/api` Node functions. API paths are excluded from the SPA rewrite; health does not assert provider/database readiness. Supabase owns identity and persistent state. No extra database, WebSocket service or provider integration is introduced.

The primary agent commits and pushes completed verified slices directly to `main`, including documentation. The collaborator uses isolated PR branches and auto-merge after checks. Fetch before publication, stage owned files explicitly, and never force-push shared history.

## 2026-09-19 — Ship Discover as a configuration-driven adapter with an explicit unconfigured state

*Superseded by "The catalogue is a curated TMDB snapshot in Postgres; there is no Titan API" below.*

A credential named `TITAN_API_KEY` exists, but no Titan catalogue endpoint, request shape or response schema is published or supplied, and the Titan SDK publishes no content API. Rather than guess a base URL, substitute a different provider under Titan's name, or seed placeholder films, the catalogue adapter takes its endpoint from `TITAN_CATALOGUE_URL` and reports `catalogue_not_configured` until an authorized contract is supplied. The expected upstream contract is written down in `docs/specs/discover-titan-catalogue.md`, so adopting a real catalogue changes one adapter file and nothing else. An empty Discover screen that says why is honest; an invented catalogue is not.

## 2026-09-19 — Validate every catalogue record individually and drop what fails

A single malformed upstream record must not blank the whole page, and a partially trusted record must not be rendered as if complete. The adapter validates each record on its own, drops records that fail, and strips any non-`https` artwork or availability URL rather than rejecting the title around it. The browser re-validates the response it receives, so an unexpected shape becomes an explicit error state instead of a half-rendered title.

## 2026-09-19 — The invite code, not the room URL, is the entitlement

A jam carries a server-generated 8-character code from an alphabet with no I, O or U so it
can be read aloud in a room. A room URL can be screenshotted, indexed or forwarded; an
entitlement should be something the host hands out deliberately. Admission exchanges the
code and a display name for a membership row through a constrained `security definer`
function, and the browser has no write policy on `jam_members` at all.

## 2026-09-19 — Public jams admit on arrival, invite-only jams wait

A public jam activates a guest as soon as they present the code, because asking a host to
admit an audience one by one is the wrong default for a live demo. An invite-only jam keeps
the waiting lobby from `docs/STATE_MACHINE.md`. Removal is host-only in both cases and a
removed participant cannot re-enter with the same code.

## 2026-09-19 — Membership checks run through security definer helpers

A policy on `jams` that reads `jam_members`, while a policy on `jam_members` reads `jams`,
recurses. `is_jam_host`, `is_jam_member` and `is_active_jam_member` read with RLS bypassed
and are the single place membership is decided, for table policies and for the private
Realtime channel alike.

## 2026-09-19 — Rows are authority, Postgres Changes are notification, Broadcast is neither

Durable collaborative state is rows under RLS. Postgres Changes tell a subscriber that such
a row exists and are filtered by the same policies. Presence answers only "who is connected
right now". Broadcast carries no story state and grants nothing, so knowing a channel name
is never access.

## 2026-09-19 — Reconnect reloads a snapshot instead of replaying events

There is no persisted event log, so a client that misses events cannot be caught up by
replay without inventing one. Every successful subscribe reloads the authorized snapshot
and folds it over local rows, deduplicated by id and ordered by `(created_at, id)`. This is
correct with no extra infrastructure and stays correct when a replay log is added later.

## 2026-09-19 — Chat and proposals are append-only until a versioned scene contract exists

`jam_messages` and `jam_proposals` have insert and select policies and no update or delete
policy. Changing a proposal status is a scene transition, which `docs/API_CONTRACTS.md`
requires to carry `expectedStateVersion`, an idempotent `requestId` and a serialized commit.
Until that transactional contract is implemented, no client can fake one, and no generation
is wired to a proposal.

## 2026-09-19 — A configured Supabase failure is an error, never local state

The local preview exists only when Supabase is unconfigured, and says so on the screen. When
Supabase is configured and a call fails, the room shows a typed error and a retry. Silently
degrading into local React state would present a private draft as a shared room.

## 2026-09-19 — Only a message the schema authored reaches a participant

Every `raise exception` in the Reverie schema marks its message. `toJamError` forwards only
a marked message and replaces anything else with fixed safe text per SQLSTATE. Without that
rule a native Postgres error — an RLS violation or a unique-constraint failure — would
display a table, column or constraint name to whoever triggered it.

## 2026-09-19 — Who is waiting is host-only information

An active member reads the active roster; only the host reads the waiting rows. Enforcing
this in the `jam_members` select policy rather than in the component that renders the lobby
means a participant reading the table directly sees the same thing the UI shows them.

## 2026-09-19 — The invite is a column privilege, not only a policy

A member has to be able to read the room they are in. They must not be able to read the
room's invite code, or an admitted participant could forward the entitlement to anyone. RLS
cannot express that: it answers *which rows*, not *which columns of a row*. So the
table-level `select` and `update` grants on `public.jams` are dropped and re-issued per
column, excluding `invite_code`, `invite_expires_at` and `invite_revoked_at`.

The same grant closes a second hole. The host update policy would otherwise let a host write
`invite_code` directly — including a short, guessable, or previously revoked one. With the
column ungranted, the only writer is `rotate_jam_invite`, which runs as owner and always
draws from `generate_invite_code()`.

## 2026-09-19 — Rotation is revocation with continuity

`revoke_jam_invite` stamps `invite_revoked_at` and the room stops admitting anyone.
`rotate_jam_invite` mints a fresh code instead, which kills every outstanding link and QR in
the same instant while leaving the room open. Because the entitlement is a column on the
room rather than a row per guest, there is nothing left behind to expire separately, and
neither function touches anyone already in the room — removing a member is
`set_jam_member_status`, which is a different decision with a different audit meaning.

A refused invite reports exactly what an unknown code reports. If "this invite expired" and
"no such invite" read differently, a prober learns that a private room exists at that code.

## 2026-09-19 — Failed invite lookups are throttled, not only made improbable

Eight characters of a 31-symbol alphabet is roughly 39 bits, which is not guessable from a
browser. That is an argument about cost, not about permission, so `jam_admission_attempts`
counts failed lookups per authenticated user over a rolling 10-minute window and refuses
after ten. The table has RLS enabled and no policies at all, and neither helper is granted
to `authenticated`, so nobody can read it or drive another user's count up into a lockout.

Its limit is worth writing down rather than discovering later. The counter is keyed on
`auth.uid()`, and this product signs people in anonymously, so a determined attacker mints a
new identity and starts a new window. The throttle ends casual scripted probing from one
session; the entropy of the code is still the real barrier, and Supabase Auth's own limits
on anonymous sign-in are the backstop that has to be configured before a public audience.
Claiming the throttle alone makes enumeration impossible would be false.

## 2026-09-19 — A waiting participant polls, because it cannot subscribe

Realtime channel authorization requires *active* membership, so a participant in the lobby
holds no channel and cannot be pushed their own admission. The previous lobby told them the
page would update and then waited for a manual retry. Rather than widen Realtime
authorization to waiting members — which would hand a not-yet-admitted session a live view
of the room's channel — the lobby polls the single row it is already authorized to read,
its own `jam_members` row, every five seconds. Polling ends at `active`, where Postgres
Changes take over, and at `removed`, which will not change by waiting.

## 2026-09-19 — The local Supabase gateway must reproduce hosted preflight behaviour

The local stack exists to exercise the same client contracts as hosted Supabase, so its nginx
gateway echoes the browser's `Access-Control-Request-Headers` (and `Origin`, with credentials)
instead of a fixed allow-list. Supabase JS adds `Prefer`, `Accept-Profile` and
`Content-Profile` to PostgREST writes, and a fixed allow-list silently omits them, making the
browser block a write that hosted Supabase accepts. Reflecting the requested headers is safe
here because the gateway is bound to `127.0.0.1` only: the permissive surface never leaves the
developer machine. For the same reason the local anon JWT and its signing secret are public
and committed — they authorize only an ephemeral local database, and committing them keeps
`docker compose up` reproducible without weakening the rule that real provider secrets stay in
ignored `.env.local`.

## 2026-09-19 — A stored session is not trusted until the auth server confirms it

Supabase's `getSession` is a storage read: it returns whatever session the browser persisted,
including a user row that the project no longer has (a database reset deletes `auth.users`,
while the browser keeps its token). Trusting that identity made every room insert fail on the
`jams.host_id` foreign key, and the generic fallback hid the cause behind "The Jam room could
not be created." Identity is now confirmed once per page load with `auth.getUser()`; a 4xx
from the auth server means the identity is gone and a fresh anonymous sign-in replaces it,
while a network failure is surfaced rather than silently swapping the participant's identity.
The unmapped `23503`, `42P01`/`PGRST205` and `42883`/`PGRST202` codes now map to an
actionable message (reload to sign in again; apply the migrations) instead of a retryable
outage, because the two failures need different fixes.

## 2026-09-19 — The catalogue is a curated TMDB snapshot in Postgres; there is no Titan API

The Titan OS challenge supplies no catalogue API. Its brief names the Kaggle TMDB dataset as the
tool and judges on a TV-ready UI, real data and cost efficiency. Reverie therefore stops waiting
for an upstream that will not arrive. The catalogue is `public.catalogue_titles`, 27,839 films
curated from the dataset and held in the Supabase project the app already uses. The long tail
of the 1.5M rows is left out: it costs storage and index time and would never be recommended.

- **Reads run as the viewer.** `search_catalogue_titles` is `security invoker`, and the table's
  only policy is select for `authenticated`. Discover presents the viewer's anonymous session
  token, so the server holds no privileged key and the catalogue cannot be written through the API.
- **Rank lives in SQL.** PostgREST can filter on `document` but cannot order by `ts_rank`, so
  ranked search and its match count are one function returning one page. Title words are indexed
  with the `simple` configuration and plot text with `english`, so a query is matched both ways.
- **Cost is bounded by the page.** The function returns only the eight columns Discover maps, at
  most 48 rows, in one round trip. There is no `select *` and no table-wide fetch.
- **Availability is empty, not guessed.** The dataset says nothing about where a film streams, so
  every title has `availability: []`. The UI renders no "where to watch" block and no copy that
  implies one. The response says `source: "tmdb"`, not `"titan"`: labelling TMDB data as a
  Titan feed would misstate where the data comes from.
- **Attribution travels with the data.** Every title and every page carries the TMDB attribution
  that TMDB's terms require wherever its data or images appear.
- **Separation is unchanged.** Catalogue rows keep their TMDB ids behind the `cat:` namespace and
  their own table and schema. They are never merged with generated Movie Jam artifacts.

## 2026-09-19 — The room's shared position is derived, not stored

A synchronized player needs one thing before it needs a video element: a single position the
whole room agrees on. Storing a counter and incrementing it would drift the moment two writers
raced or a tab slept. Instead the database stores only an anchor — `started_at` while playing
plus the `paused_elapsed_ms` accumulated before it — and every reader derives the position as
`paused_elapsed_ms + (now() - started_at)`. Pausing freezes the derivation into
`paused_elapsed_ms` and clears the anchor; a check constraint keeps the two consistent.

The payload includes the server's own `serverNow`. A browser cannot trust its wall clock (it
may be minutes off) but it can trust the *difference* between two of its own monotonic
readings, so it anchors to the server's `elapsedMs` and advances with `performance.now()`.
That is why two viewers show the same counter without any clock synchronization protocol.
Polling every 2.5s is deliberately an interim transport isolated to one named constant; the
documented contract is `portion.locked`/`media.*` events over Realtime, and this slice must
not be built on as if polling were the contract. The clock is room-wide, not per user session:
the existing `jam_sessions` remain language/ambientation skins over the one shared script.

## 2026-09-19 — Discover refinement is filtered in SQL and ranked by the engine

- **Hard limits run in the database.** Every constraint the preference state holds becomes a
  filter on `search_catalogue_titles`, so the shortlist is the best 48 of the whole catalogue
  rather than 48 fetched rows with the misfits thrown away. The engine still re-checks every row
  it receives with `isEligible`, so a filter the SQL cannot express (a language refusal) is
  enforced in the browser instead of silently ignored.
- **A genre is both a dimension and a tag.** `genre.horror` carries "I want horror"; the tag
  `horror` is what `excludeTag` refuses, the only way to say "nothing scary". Refusing a genre
  also states it as unwanted, and wanting it lifts the refusal.
- **Wanted genres shape the shortlist, not only the order.** They restrict it to titles carrying
  at least one of them, ordered by how many, which is what makes "something scary" narrow the
  grid rather than reshuffle it.
- **The deterministic scorer crosses the same boundary a model will.** Its ranking goes through
  `acceptRanking`, so slice 5 can swap the ranker without changing what may reach the screen.
- **Chips are statements, not toggles on a hidden filter.** Each carries its sentence and cites
  quotes from it; withdrawing one is a turn whose transcript quotes what is withdrawn. A session
  holds twelve turns, after which the viewer is told to start over.

## 2026-09-19 — One jam_playback table, reconciled by a stacked migration

Two independent slices each created `public.jam_playback`: the portion-playback work
(`20260919190000_structured_script_revisions.sql`) with `current_portion_index`, and the shared
clock (`20260919230000_jam_playback_clock.sql`) with `started_at`/`paused_elapsed_ms`. They were
merged without knowing about each other, and the collision is not merely cosmetic: `190000` sorts
first, so on a **fresh** database it creates the table, the clock migration's `create table if not
exists` then silently no-ops, and its `jam_playback_json` function fails to compile because
`p_row.started_at` does not exist. On an **existing** database the reverse is true — the clock
table is present and the cursor column is missing. A migration that only worked for one history
would have left the other broken, and a fresh deploy is exactly the path CI and a new contributor
take.

Rather than edit either migration — databases have already applied them, and editing an applied
migration means the file no longer describes the database — a stacked migration
(`20260919225000_reconcile_jam_playback.sql`) sits between them and converges both histories on one
table carrying both column sets. It is idempotent and backfills before enforcing `NOT NULL`, so no
existing row can block it. `status` becomes the union `idle|priming|playing|paused|finished`, and
the anchor invariant is restated for the union as `(status = 'playing') = (started_at is not null)`
— priming and finished carry no anchor, which is correct because only a playing clock needs one.
The two representations stay deliberately distinct: the cursor is a `-1`-sentinel integer in
Postgres and `null` in memory, mapped at the store boundary so playback semantics never see `-1`.

Verified by applying the whole migration set in sorted order to a clean Postgres (the clock
functions compile and the table ends with all seven columns) and by applying it to the existing
local stack (which converges to the same shape). `pnpm verify:realtime` remains 34/34, including
the clock RPCs now running against the combined table.

## 2026-09-19 — Discover talks through the engine; the model never sees the catalogue

Discover's conversation makes two model calls per turn, and neither can put a film on screen that
the database did not return. The first (**interpret**) sees the viewer's message and a few lines
summarising the preference state, never catalogue data. It returns a `Decision`
(`src/conversation/decision.ts`): genre evidence as `genre.<slug>` with a quote and
explicit/inferred, a runtime limit and an era as three fixed slots, one acknowledgement and at most
one question. The decision becomes an ordinary engine turn and must pass `applyTurn`, which
refuses a quote that is not a literal substring of the message. That rule was not relaxed: when
the model first failed it, the prompt was fixed (emit only what the new message changes, with three
worked examples) and the retry now repeats the exact refusal. The second call (**rank**) sees only
the eligible shortlist and may only reorder it; its ranking must pass `acceptFullRanking`, which
refuses any id not supplied or ruled out, on the server and again in the browser.

The translation mirrors the chips so a sentence and a chip mean the same thing: an outright refusal
also excludes the genre, and wanting a refused genre lifts the refusal. Three rules are
deterministic rather than left to the model, and each is written down in `decisionToTurn`: an
inference never replaces what the viewer said outright (it is left out, and the engine would refuse
it anyway); asking for a genre outright retires the genres earlier guessed from a mood, so "a
comedy" after "something light" narrows comedy/family/romance to comedy; and the question is dropped
when the turn states anything outright, because a clear request must be answered, not questioned.

When the model ranks, its utility replaces the scorer's; nothing is blended. The scorer's 10%
position term stays for the deterministic fallback only, because an arbitrary term in the model's
order would make it unexplainable. The model reads every candidate but scores only its best twelve.
Asking it to score all 48 made the reply long enough that one of the first live runs timed out at 20
seconds. Titles it did not score follow, unmarked, in shortlist order. The top three carry a
one-line reason, shown in the spotlight and in each pick's accessible name.

Honesty rules for the UI: the grid is labelled "Ranked by the assistant" only when the model's
ranking was made for exactly this shortlist and state and was accepted in the browser. While it is
in flight the label reads "Ranking with the assistant…" and nothing is marked a top pick. When it
fails, the label reads "Ranked by genre match" and gives the reason. A shortlist is ranked only once
it has been loaded for the current filters, so the previous shortlist is never paid for again under
the new state. The assistant ranks only after the viewer has actually talked to it; chips alone use
the scorer.

Cost bounds: a token ceiling and a per-attempt timeout inside an overall deadline per call, at most
one retry (never after a provider timeout), the engine's 12-turn session cap enforced before any
call, per-instance rate limits and a concurrency cap of 6, a signed-in viewer verified by Supabase
Auth, and an abort when the client disconnects. Temperature is 0.2.

## 2026-09-19 — The film replaces the counter, and its clips outlive the process (RV-14)

The studio showed an elapsed-time counter — the room's shared position, host-driven, backed by
Supabase RPCs — and no way to watch the video the generation pipeline had been producing since
RV-06. The counter is a clock, not a film: extending it would have made a number look like
playback. So the reproducer was built fresh against the portion routes, and it takes the
counter's place in the studio. `PlaybackBar`, `usePlaybackClock`, `src/lib/playback.ts` and the
host-only clock RPCs are untouched but no screen mounts them; whether a room-wide position
returns beside the film, or goes, is a product decision nobody has made yet, and deleting a
working feature to answer it would have been the wrong way to ask.

**Play and stop, and no seek.** Not a simplification for its own sake: the cursor only moves
forward, the next portion is generated while the current one plays, and a clip that does not
exist yet cannot be scrubbed to. A progress bar would promise a timeline the server cannot
serve. Stop is local — it stops watching, and never rewinds the room.

**Advance when the clip ends, not when the next one is ready.** The snapshot can report the next
portion ready while the current one is still playing; advancing then would cut a portion short.
The viewer-side rules live in `src/core/portionPlayback.ts` as a pure function of the server's
snapshot (`nextPlayerAction`), so the screen holds no playback rules of its own and the rules are
testable without a DOM.

**The player asks by configuration, and says it shares one stream.** `configurationKey` normalizes
language-tag casing and whitespace in one place, and the clip address takes the key, so
per-configuration streams (`docs/specs/configuration-keyed-streams.md`) land without moving the
player. The key is deliberately **not** sent as a query parameter yet: the server serves one
stream per jam, and a URL implying a personal stream while everyone watches the same one would be
a claim the build cannot keep. The panel says so in words instead.

**Clips persist to a private Supabase Storage bucket.** The in-memory store lost every clip on
restart, which made paid generation buy the same portion twice. Clips now go to `jam-portions`
(migration `20260919233000`) when the server holds `SUPABASE_SERVICE_ROLE_KEY`, behind the same
`PortionMediaStore` boundary. Consequences taken deliberately:

- **The server holds a service-role key; the Vercel functions still do not.** `api/_lib/supabase-rest.ts`
  acts as the caller under RLS, and that stays true. Uploading generated bytes has no caller to
  act as — generation is a server-driven job — so the privileged path is confined to the local
  Express host, and the bucket has no `storage.objects` policies, so nothing else can reach it.
- **Participants still receive our own bytes.** The route is unchanged; no signed storage URL is
  handed out, so a clip cannot outlive the room's authorization checks.
- **A store that is not durable says so.** Without the key the bounded in-memory store is used and
  reports `durable: false`. A build never implies clips survived a restart that did not.
- **Presence is one listing per jam, not one request per portion.** Every playback poll asks about
  every portion; probing each one would multiply storage traffic by the portion count. The listing
  is cached for 5s, so another process's upload can take that long to appear.
- **A stored clip is never generated again.** `enqueue` now checks the media store before taking a
  provider slot. Without that, durable clips plus an in-memory job map would re-buy portion 0 on
  every restart — the exact spend leak durability was meant to close.

Open, and not silently fixed here: the cursor itself is still in memory. `JamStore.getPlayback`/
`updatePlayback` landed with RV-07 but nothing wires `PlaybackCoordinator` to them, so a restarted
server reads `idle` while its clips remain (it replays from portion 0 and regenerates nothing).
Rewiring that is a change to a freshly merged storage contract and belongs to whoever owns it.
Also unenforced: `start`/`advance` are host-only in the contract, and the player honours that, but
the Express routes carry no authorization — the UI boundary is not a security control.

Verified: `pnpm typecheck`, `pnpm test` (363/363 including the new core, storage and
already-stored-clip tests), `pnpm build`. Against the running local host with providers off, a
jam created from an imported script answered `idle` with four portions, `start` returned the
typed `generation_disabled`, the video route `404`, and advance `invalid_transition`. The screens
themselves were not opened in a browser this session: the shared Chrome profile was locked by
another session, so the UI states in UJ-02 section C are unrun.


## 2026-09-19 — One top bar, a layered Back, and a home that pays for what it shows

**Back is layered, and leaving goes to the parent.** Back from anywhere on a page scrolls to the
top and focuses the top bar; only Back on the bar leaves the screen. This is the published TV
convention for apps with top navigation, and it is what makes the bar reachable again from far
down a page when it has scrolled away. Leaving goes to the screen's parent (the three destinations
are siblings under the home; a jam's screens sit under Movie Jam), not simply to the previous
history entry: history is stepped back only when the entry behind is the parent, and replaced
otherwise, so tab-hopping between destinations never turns Back into a replay of the session. On
the home, Back on the bar is not taken: it belongs to the platform, which may exit the app.

**A film page opens with focus on the bar.** Its only action, "Not this one", changes the
viewer's preferences, so it must not receive a second press of OK. Landing on the bar's current
item keeps the page's old one-press Back, makes OK on that item close the page, and leaves Down to
enter it. The item names where the film was opened from, and choosing it closes the page through
the same path as Back, so history is never pushed on top of the film.

**A film opened from the home is a layer over the home**, as a film opened from the grid is a
layer over the grid. The home stays mounted and inert underneath, so it keeps its shelves, scroll
and focus, and the card that opened the film gets focus back when it closes, with nothing read
again.

**The home reads two shelves, then only what the viewer approaches.** `search_catalogue_titles`
counts every match on every call, so the home never fires every shelf on load. The hero and the
spotlight still come from those two reads rather than from requests of their own. Shelves already
read are kept for five minutes and shared between visits; a read in flight is joined. The
anonymous sign-in behind those reads became single-flight at the same time, because two eager
reads on a first visit could otherwise create two identities.

**Focus is marked until a pointer is used.** Browsers decide `:focus-visible` from pointer and
keyboard heuristics; a remote may give them neither, which left programmatic focus (the landing
item, the bar after Back) unmarked. The root records `data-input="pointer"` after a pointer is
used, and every focused control is marked until then.

**OK is handled by the app on the home and the bar**, as the Discover grid already does: the
browser's own Enter activation is prevented and the item is chosen once. Held repeats of OK and of
Back are swallowed, so holding a key cannot fall through to whatever the next screen focuses.

**Kept on purpose:** "Leave the room" in the studio. It ends the participant's presence (and with
it any live camera, microphone or screen tracks), which people in a live room look for; it is a
room action, not a way back. The explanation of a Jam (the illustration and the three steps) moved
to the create screen, where someone is about to start one.

**History entries carry a key and their opener's key.** Replacing an entry (which leaving does)
leaves any forward entries in place with a record that no longer describes what lies behind them.
Replaced keys are remembered for the tab session, and an entry whose opener was replaced is closed
by replacement rather than by stepping back into a screen it was never opened from.

**A shelf's height is fixed by construction, not measured.** Every card is two title lines and one
meta line tall, every card is one card wide, and a poster image fills its 2:3 box without sizing
it. The loading placeholder, a loaded shelf and a failed one then share one height computed from
those sizes, and the hero reserves its own tallest content the same way, so the page never moves
as reads arrive.

**Component tests run in jsdom.** The suite had no DOM, so focus hand-offs were checked only by
hand. The catalogue read is provided through a React context, which the app leaves at
`/api/catalogue` and tests replace with their own titles, so App-level tests exercise real posters
through the real code. `jsdom` is a dev dependency with no effect on the build; tests render
real screens, drive them with key events and fail on any React or jsdom error.

## 2026-09-19 — Discover voice: SLNG behind our server, final transcripts only, streaming with an upload underneath

Voice produces text for the conversation field and nothing else. Only a final transcript can
reach the field, and only the viewer sends it, so the engine's rule that every quote is a literal
substring of the sent message still holds, and a misheard sentence costs a correction rather than
one of the session's twelve turns. Partials are shown and never sent.

SLNG is called only from the server: `POST /api/voice/transcribe` (HTTP, one recording) and a
WebSocket relay at `/api/voice/stream` (live partials). The relay runs on the long-lived Node server
only. It is not a Vercel function, and the rule against a custom long-lived WebSocket server on
Vercel stands; there, the browser's socket fails and the recording is uploaded. The browser records
Opus for the upload and streams PCM at the same time, because SLNG's streaming route accepts only
linear16 and a failed stream must never lose what the viewer said.

SLNG's streaming route ignores every control message in its reference, so the end of an utterance
is found by appending silence and waiting until a result has heard past the stop point. Model
(`slng/deepgram/nova:3-en`) and region (`us-east`, or `us-west`) are server allowlists. Over HTTP,
the model is named explicitly (`nova-3-general`), because the upstream default is rejected whenever
an option is sent. Probe receipts and measurements are in `docs/PROJECT_STATE.md`.

## 2026-09-19 — Subtitle and audio-description availability is metadata in a companion table

Every catalogue film may carry two availability facts: which subtitle languages exist, and
whether it is known to have an audio-description track. Decisions taken:

- **A companion table, not new catalogue columns.** `catalogue_titles` is licensed reference data
  that is never rewritten. `catalogue_title_accessibility` is keyed by `title_id`, filled by an
  offline backfill, read-only through the API, and joined into `get_catalogue_title` only.
- **Three states, never collapsed.** `subtitle_languages` null = never checked, `'{}'` = checked,
  none found. `has_audio_description` null = unknown. Check constraints keep each answer whole
  (languages + count + time + source, or AD value + source + time). No row = never checked.
- **Subtitles from OpenSubtitles `/features?imdb_id=`, one request per film.** Its
  `subtitles_counts` gives the per-language counts, so The Matrix costs one request, not the 17
  pages `/subtitles` would. Search is not quota-limited; the client can build no URL except
  `/features`, so it can never spend a download or fetch subtitle text. Requests are paced 400 ms
  apart against the published 5 req/s per IP and 40 per 10 s on `/features`.
- **Audio description from the Audio Description Project directory, yes-only.** There is no API
  or export; the directory is a public HTML table with an IMDb link per row. A listed film is a
  sourced yes. An unlisted film stays unknown: the list is curated and US-centred, so absence is
  not a no. The backfill never writes `false`.
- **The page shows found facts only.** "Subtitles: 14 languages" and "Audio description:
  Available". Not checked, checked-none, and a sourced no all render nothing: a community index
  lacking a film is weak evidence that no subtitles exist. The contract still carries all three
  states for any later consumer.
- **The backfill holds no write credential.** It reads the catalogue as an anonymous viewer,
  appends answers to JSONL ledgers under `.backfill/` (resumable), and emits one SQL file of
  upserts that the database owner applies. It lives in `apps/backfill/`, and a test fails if
  anything under `api/`, `src/` or `apps/server/` imports it.
- **Not decided here:** fetching, storing or showing subtitle text, or giving it to a model.


## 2026-09-19 — The public landing is static HTML built from real catalogue films

The landing at `/` shows real posters from `public.catalogue_titles`, and a visitor to it has no
session. The catalogue is readable only by signed-in viewers, and that stays true: the page does
not read the catalogue at all. The build does, once, as an ordinary viewer. It signs in
anonymously with the public anon key, exactly as a browser opening Discover does, and reads through
`fetchCatalogue`, the adapter behind `/api/catalogue`, under the same RLS. No service key, no new
database function, no policy change, and no public endpoint that would read the catalogue for
anyone who asks. The cost is one anonymous user per build and posters that change only on a
rebuild. A runtime endpoint was rejected: it would need its own sign-in per cold start and would
make the page wait for a request before showing its films.

The selection filters only by genre, in Discover's own vocabulary: the most popular titles without
horror or thriller for the shelf, and drama or family without the tense genres for the "gentle"
picks. The catalogue function exposes no quality signal, and its popularity order surfaces softcore
titles in several decades, so a genre filter is the smallest honest rule; no film is chosen or
refused by name.

Because the films are fixed at build time the whole page is too, so the build renders it to static
HTML with no script, and the app's shell moves to `app.html`. Measured on a throttled phone profile,
a client-rendered landing painted first at 1.7–2.5 s against 0.75 s for the static page. The route
still exists in the app: `main.tsx` renders the same component at `/` in development and if the app
ever reaches it.

Fonts are self-hosted latin subsets of only the faces the page uses. With the same fonts loaded
from Google, the same layout painted about 190 ms later on that profile (a render-blocking
stylesheet from a second origin, then files from a third). Preloading them was measured too and rejected: it removed a
few pixels of swap shift but delayed the first paint by about 250 ms.


## 2026-09-19 — Search is a conversation whose answers are snapshots

Finding something to watch moved from the Discover grid to `/search`, where the conversation is
the page and each answer's films sit under the reply that produced them. `/discover` now leads to
`/search`; a film's page keeps its address, `/discover/:id`, so no link breaks.

**A turn's films are a snapshot.** Once a result set is attached to an assistant line it is never
replaced or re-ranked, whatever the state becomes afterwards: a scrollback that rewrites itself is
worse than one that is honestly stale, and "how the search narrowed" is only visible if each step
keeps what it showed. Each turn's films are read and ranked for the state its own reply left,
by a preparer that outlives later changes: a filter changed or another message sent meanwhile
never alters what that turn shows, because a ranking is valid for one state only. The transcript
is bounded by turns (20), never by lines, so a turn leaves whole with its posters.

**Filters are a separate surface.** Genre, era and running time live in a panel with its own live
results, and changing them writes nothing to the conversation and rewrites no turn. They narrow
the same engine state, so the next turn composes with them. The panel orders by the scorer, so a
filter never costs a model call.

**Speech is shown, never sent.** Partials fill a pending line, merged by overlap, with chips and
a poster preview derived from them by a word list; only a final transcript reaches the field, and
only the viewer sends it. The engine's grounding rule applies to the sent text as before. Filler
(including a speech service's rendering of a trailing "or" as "four") fires nothing.

## 2026-09-19 — A catalogue film is found here, never played here

The catalogue is a curated TMDB snapshot for discovery. It is not a licence to show films, and
the data says nothing about where a film can be watched. So nothing in Reverie plays a catalogue
film or implies that it can: a film's preview offers its own page and "Start a Jam from this",
which opens the Movie Jam form seeded with a title and premise *inspired by* the film. That Jam
makes an original film; the seed names the catalogue film as its inspiration and never as its
content. Availability stays empty and unrendered, and the TMDB attribution stays wherever films
are shown, the preview included.

## 2026-09-19 — The conversation keeps the path its film pages already use

A film's page has always lived at `/discover/:id`. Giving the screen above it a different
address meant a parent and a child with unrelated names, and a redirect to hide the seam.

The conversation is served at `/discover`, and `/discover/:id` sits beneath it. There is no
moved path and nothing redirects: one screen, one address, and a film page whose URL says
which screen it belongs to. The top bar shows it as Discover, with the search icon beside it,
so the label, the route and the screen's own name all agree.
