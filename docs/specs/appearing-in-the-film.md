# Spec — appearing in the film

Status: implemented. The consent model is the feature; the generation is what it permits.

## What this is

A participant in a jam can choose to be a character in the film the room is making. One
frame from their own camera becomes the character reference, and beats are generated with
`minimax/h3-max/reference-to-video` so the person on screen is them.

A jam where nobody has agreed generates exactly as it did before this existed. The feature is
additive and never blocks a film from being made.

## The five rules

Everything below follows from these. Where the code and this document disagree, the code in
`src/core/likeness.ts` is what actually runs, and one of the two is a bug.

1. **Appearing is its own grant.** Joining a jam is not it. Turning on a camera is not it.
   It has its own purpose, its own lifetime, and its own row.
2. **A frame is captured on the person's own action, shown back to them, and approved before
   use.** Nothing is captured silently and no frame is used that its owner has not seen.
3. **Withdrawal is immediate and forward-looking.** It stops the likeness being used by any
   beat generated from then on. Beats already generated already exist, and the interface says
   so rather than implying they can be recalled.
4. **The approved frame is a server-issued reference with an expiry.** It is never sent to
   another participant's browser and never addressable by anyone holding a link.
5. **Only a consenting participant's own frame may be used.** Never a face from the
   catalogue, never an uploaded photograph of someone who is not in the room, never a frame
   of a participant who declined.

## The register, extended

`jam_live_consents` already recorded owner, purpose, asset reference, lifetime and
withdrawal for the live stage. Appearing in the film is the same kind of fact, so it is a
fourth **consent kind** in that register rather than a second register
(`20260920100000_likeness_consent.sql`).

| | camera / microphone / screen | likeness |
| --- | --- | --- |
| What it permits | publishing that track to the live stage | seeding a generated beat |
| Reference prefix | `live:` | `likeness:` |
| Bytes behind it | none; nothing is recorded | one approved frame, held by the server |
| How many at once | one per kind | one standing grant per participant per jam |

`likeness` is deliberately **not** a track kind. `permittedKinds` filters to track kinds
explicitly, so agreeing to appear can never start a camera and turning on a camera can never
be read as agreeing to appear. That is a tested invariant, not an accident of ordering.

The trigger still issues the reference and still clamps the lifetime into `(now, now + 2h]`,
so neither is the browser's to choose. The insert policy still pins `owner_id = auth.uid()`.
There is still no update or delete policy: a grant is made by an insert and retired only by
`withdraw_live_consent`, which can stamp nobody's row but the caller's own.

**One standing grant per participant per jam**, enforced by a partial unique index. Two would
mean two references for one face, and withdrawing one would leave the other standing — a
withdrawal that does not withdraw. Wanting a different frame means withdrawing and granting
again, which is a fresh purpose and a fresh expiry.

## The frame

Captured in the browser from a camera the person turned on by pressing, drawn to a canvas on
a second press, shown back, and sent only on a third press that says what it is for. The
camera closes as soon as the picture is taken.

It is JPEG or PNG, square, between 256×256 and 1024×1024, at most 512 KB. The lower bound is
the provider's, measured: a smaller reference is refused with `image_too_small`. The upper
bound is ours and it is a payload decision — the provider includes 4,096 reference tokens per
request and a 1024×1024 image is 1,024 of them, so three references stay inside the included
allowance.

The bytes live in the private bucket under `likeness/<jamId>/<uuid>`, reached only with the
service-role key this host holds. No signed URL is ever minted. `GET
/api/jams/:id/likeness/:assetRef` serves a frame to its owner and to nobody else; a
participant asking for someone else's frame gets the same refusal as one asking for a
reference that does not exist.

Without a service-role key the frame is held in memory and lost on restart, and the upload
response says `durable: false` rather than implying an archive.

## Generation

Two models on one provider, one key, both on the server's own allowlist
(`apps/server/providers/falBeatVideo.ts`). No request body, environment variable or provider
response can widen it.

| | model | when |
| --- | --- | --- |
| Plain beat | `minimax/h3-max/text-to-video` | nobody has agreed |
| Likeness beat | `minimax/h3-max/reference-to-video` | at least one standing grant |

`POST /api/jams/:id/beats/:index/video` generates one beat. **Whether anyone appears in it is
not in the request body.** The server reads the register fresh, under the caller's own RLS, at
the instant of submission, and `usableLikenesses` answers. There is no cache, so a withdrawal
a second earlier is honoured by construction rather than by an invalidation that might not
run.

The frame travels to the provider inline as a `data:` URI. It is never uploaded to a provider
CDN and no address for a participant's face is ever minted. The provider learns that an image
is "a character in this scene" and nothing else: no display name, no user id, not how many
people are in the room. `prompt_expansion_mode` is `disabled`, so no provider-side rewrite
puts words the room never agreed to in front of a face that was agreed to a stated purpose.

At most three references per beat, in the order the grants were given.

### What is not silently substituted

- A grant whose frame never arrived is `409 frame_missing`. It never becomes a plain beat
  generated without the person who agreed to be in it.
- No provider configured is `503 generation_disabled`. It is never a mock.
- No way to check consent — no Supabase configuration — is `503 likeness_not_configured`.
  A server that cannot verify consent does not act on it.
- A provider failure is a typed code with a sentence this server wrote. No provider body,
  URL or credential is ever forwarded or logged.

## What may be said about a finished beat

`describeBeatLikeness` returns one of three answers, and it is the only source of the words
the room sees:

| | meaning | what the room is told |
| --- | --- | --- |
| `none` | no likeness seeded it | "No one's likeness was used for this beat." |
| `standing` | every grant it used still stands | "Made with the likeness of everyone who agreed, and they still agree." |
| `withdrawn_since` | at least one has ended | "Made before that agreement ended. This beat already exists and still shows them; ending the agreement stops the next beat, not this one." |

A withdrawal never turns a `standing` beat into a `none` beat. That is the mistake the
function exists to prevent, and it is why the answer is three-valued rather than a boolean.
The beat record is written once, when the beat is generated, and never rewritten.

## In the room

`AppearInFilm` shows who has agreed, from the register, with each ended grant still listed and
plainly marked as ended. Each person has one press to withdraw — no menu, no confirmation
step, no second screen. Another participant's reference never reaches this browser's markup;
only their display name and the purpose they declared, both of which the register already
makes readable to the room.

Somebody else agreeing never puts this viewer in the film, and the badge says so.

## Resource bounds

Nothing here tracks what a beat costs: this build carries no budget and no ledger
(`docs/DECISIONS.md`). Concurrency is bounded (`REVERIE_BEAT_MAX_CONCURRENT`, default 2) and
the same beat cannot be generated twice at once. That is the whole of it.

## Not in this slice

Editing or re-generating a beat with a different cast; a likeness carried between rooms; a
voice; any use of a frame outside generating a beat in the room it was given in; any export of
a beat that contains a person. Each needs its own permission and its own consent field, and
none of them is enabled as a side effect of agreeing to appear.
