# Multimodal creative turns

**Status: intended, not implemented.** The README states that text, voice, image, video clip and
opt-in live camera are all first-class creative contributions. One of those is real: live
camera, microphone and screen are implemented as **transport and consent**
(`docs/specs/jam-live-media-vonage.md`). None of them is implemented as a **creative turn** —
nothing a participant shows or says can currently become part of the story. This document
specifies that missing half.

## Problem

Two different things are being conflated by the word "multimodal", and only one exists.

- **Being present with media** — publishing a camera, microphone or screen track to the room's
  live stage, with a declared purpose, a consent row and an expiry. Implemented, opt-in per
  participant and per track, recorded in `jam_live_consents`.
- **Contributing media to the movie** — an image, a clip, a spoken line or a framed camera shot
  that the room can accept as direction for the next scene. Not implemented in any form. There
  is no upload path, no reference store, no transcription, and no way to attach anything but
  text to a proposal (`jam_proposals.body` is `text`, 1–280 characters).

So today a participant can hold up a reference photo to their webcam and describe it out loud,
and neither the photo nor the words can reach the story. Only somebody re-typing it as a text
proposal can.

## The unifying rule

**A reference is never a story input on its own. It becomes one only by being attached to a
proposal, and that proposal is accepted through the versioned transactional scene contract.**

This is the whole design. Every modality — a pasted image, an uploaded clip, a transcribed
sentence, a captured camera frame — converges on the same object the room already understands:
a queued proposal that the room votes on and the host or the vote rule accepts
(`docs/specs/transactional-scene-contract.md`).

The payoff is that multimodality adds no new authority path. It does not add a second way to
change the story, a second thing that can be accepted, or a second place where spend is
committed. A reference that is never attached to an accepted proposal costs storage and nothing
else.

## Reference lifecycle

`docs/STATE_MACHINE.md` already names the lifecycle:
`selected → consented → uploading | live → normalized → available → expired | removed`.

The rules that make it safe are the ones live media already proved, applied to stored media:

- **The server issues the reference.** A descriptor carries its owner, source kind, declared
  purpose, lifetime, consent state and a **server-issued `asset_ref`**. It never accepts a
  browser-supplied provider URL — the same refusal `jam_live_consents` enforces with a trigger
  that overwrites whatever the client sent.
- **Purpose is declared before the media exists, not after.** There is no implicit contribution,
  exactly as there is no implicit publish.
- **Consent is a row, not client state,** and withdrawal stops the use rather than just the
  record: the reference leaves the room's available set through Postgres Changes and every
  client drops it.
- **Lifetime is clamped server-side.** Live consents are clamped into `(now, now + 2h]`; stored
  references need their own bound, which is an open question below but must exist.
- **Validation before availability.** Type, size and duration are checked by the server before a
  reference becomes `available`; `normalized` is where that happens, and it is not optional.

## Per modality

**Image and video clip (upload).** The missing pipeline. `reference.upload.request` returns a
short-lived, server-authorized destination; the bytes go to a **private bucket with no
`storage.objects` policies**, reachable only by the server — the arrangement already used for
generated clips (`jam-portions`, `apps/server/supabaseMedia.ts`). `reference.upload.complete`
moves the descriptor to `normalized`, and participants receive our own bytes through our own
route, never a storage or provider URL. Per-jam count and total-size caps are required, and they
are storage caps, not spend caps.

**Give references their own bucket.** The adjacent director-archive work learned this the
expensive way: sharing one bucket across two media kinds meant uploads were rejected because the
bucket's allowed mime types belonged to the other kind, and the failure was swallowed, so an
archive would have been lost without a sound. References have their own mime and size
constraints, different again from generated clips and from archived segments, so they get a
bucket rather than a prefix inside someone else's. And a store that swallows an upload error is
worse than one that fails loudly: it loses the contribution silently.

**Voice.** The speech-to-text half of this **already exists and should be reused, not rebuilt.**
`apps/server/providers/slng.ts` is a typed SLNG adapter with a server-owned model allowlist
(`slng/deepgram/nova:3-en`), and it is reachable two ways: `POST /api/voice/transcribe` (one
recording in, one final transcript out, 20/minute, 4 concurrent, 15 s timeout, 1,000,000-byte
cap) and a WebSocket relay at `/api/voice/stream` for live partials on the long-lived Node
server. Audio is held in memory for the call and never written or logged. It is probed and
documented in `docs/API_CONTRACTS.md` and `docs/DECISIONS.md`.

What does not exist is **voice in the jam room**. That adapter is scoped to Discover: it
transcribes a viewer's search request, and the transcript lands in a conversation field. Making
voice a creative turn needs the jam-scoped commands `audio.start` / `audio.stop`, the
`transcript.partial` / `transcript.final` events, room-scoped authorization instead of
Discover's, and the attachment path below — not a new provider.

**Raw audio stays transient** — the standing rule in `AGENTS.md`, and what the adapter already
does. The durable artifact is the final transcript, treated as participant text: data, validated,
never executable, never HTML. A transcript becomes a proposal only by the speaker attaching it;
speech is not a command channel, and nothing in the room acts on words merely because they were
said.

**Live camera as a reference.** A participant already on the stage may **capture a frame** as a
stored reference. That capture is a distinct act with its own consent — being live is permission
to be seen now, not permission to be kept. `docs/specs/jam-live-media-vonage.md` already draws
this line for archiving and export, and a captured frame sits on the same line: it is retention,
and it needs its own consent field, not an inference from the publish consent.

**Text.** Already implemented and unchanged; it is the modality the others are being made equal
to, not a special case.

## Transformation and budget

Feeding a reference to fal.ai — to restyle it, to condition a generated portion on it — is a
**paid provider call** and carries every control the portion pipeline already carries: the typed
adapter (`apps/server/providers/fal.ts`), `REVERIE_LIVE_ENABLED` plus the credential, the
server-owned model allowlist, bounded concurrency, and per-jam clip-count and spend caps. It is
never enabled as a side effect of uploading a reference or of joining the stage.

A transformation that fails leaves the accepted creative direction intact and marks media
delayed or failed, per the scene contract. It never silently falls back to a mock and never
claims an unprobed provider works.

## Provenance

Every generated artifact already carries a generated-artifact identifier and must never
impersonate a catalogue title. A reference adds a second provenance question: a portion
conditioned on a participant's photo is derived from a person's contribution, and the room
should be able to say which. The descriptor's owner and `asset_ref` are the trace; whether that
trace is visible to the room, to the host only, or only in the record, is unspecified.

## Contracts (planned, none implemented)

The command and event vocabulary is already reserved in `docs/API_CONTRACTS.md`:
`reference.upload.request`, `reference.upload.complete`, `reference.intent.set`,
`liveMedia.join`, `liveMedia.leave`, `liveMedia.consent.set`, `broadcast.start`,
`broadcast.stop`, `archive.request`, `audio.start`, `audio.stop`; events `reference.ready`,
`transcript.partial`, `transcript.final`, `liveMedia.state`.

This spec adds one requirement to that list: **proposals must be able to carry references.**
`jam_proposals` holds a 1–280 character text body and nothing else, so attaching a reference
needs either a column or a join table, plus an insert policy that permits an active member to
attach only a reference they own and whose consent is effective.

## Open questions (unspecified)

- The storage lifetime of an uploaded reference, and whether it outlives the jam.
- Per-jam and per-participant caps on reference count and total bytes.
- Whether a reference attached to an **accepted** proposal becomes immutable and exempt from
  withdrawal — the room bought something derived from it — or whether withdrawal always wins.
  This is a consent question with a cost consequence and it is not answerable here.
- Whether captured camera frames are a separate consent `kind` or a new field on the existing
  row.
- Which speech-to-text provider, and whether transcription is per-utterance on demand or
  continuous while a microphone consent stands. Continuous transcription of a two-hour stage is
  a spend question, not a feature question.
- Whether a reference may be attached to a proposal by anyone other than its owner.
- How a reference interacts with the portion lock window: a reference attached to a proposal
  accepted for an already-locked portion is refused with `portion_locked` like any other change,
  but whether the reference survives for reuse is unstated.

## Implementation status

**The creative-turn half of this spec is entirely unimplemented.** There is no upload route,
reference descriptor, reference store, transcription path, capture action, or reference-carrying
proposal. `jam_proposals` accepts text only.

**Implemented and not to be re-specified:** live camera, microphone and screen transport through
Vonage; `POST /api/live/token` with membership-derived roles; the `jam_live_consents` register
with server-stamped `asset_ref`, clamped expiry and `withdraw_live_consent`; Realtime delivery of
consent changes; and the SLNG speech-to-text adapter described above. See
`docs/specs/jam-live-media-vonage.md` and the register in
`docs/specs/intended-vs-implemented.md`.

**Two directions share the word "broadcast" and must not be conflated.** Everything above is
*participant media travelling inward* — a person's camera, microphone or screen reaching the
room. The exclusions in `docs/specs/jam-live-media-vonage.md` (recording, archiving, broadcast,
RTMP, export, fal.ai transformation of a participant's feed) are about that inbound direction,
they remain correct, and this document does not bring any of them into scope.

*Generated output travelling outward* — the director stream reaching many viewers — is a
different feature with a different transport, and work is in flight on branches that have not
merged. Read nothing here as a claim that Reverie cannot deliver a generated stream to multiple
viewers. As those branches stand:

- **Live viewing is implemented and has been exercised against the provider**, by relaying the
  stream's packets to viewers. Forwarding to viewers and capturing for storage are separate
  decisions with different costs, so live viewing does not depend on capture being on.
- **Durable per-segment archiving and HLS delivery are implemented, off by default behind their
  own flags, and have never been run against the provider.**

**Disabled and unprobed are two different facts and both belong in any summary of this.** They are
not degrees of the same thing: a reader told only that something is disabled concludes that
flipping the flag makes it work, and nobody has yet seen a frame come out of these paths. Per
`AGENTS.md`, a provider path is not claimed to work without a dated receipt, so "off by default
and never run against the provider" is the honest short form — not "disabled", and not "unprobed".

Precise status is the owning sessions' to publish, including refreshing the implementation status
of `docs/specs/configuration-keyed-streams.md`, which their work makes stale. This document states
only the direction and the boundary, because anything finer grained would be describing branches
it does not own and would go stale as they move.
