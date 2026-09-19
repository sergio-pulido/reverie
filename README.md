# Reverie — Movie Jam

> Real cinema to discover together, plus a live studio where a room becomes the director's room for a new story.

Reverie is an open-source HackBarna project built around the real movie catalogue provided through Titan. People can browse and discover actual films and series, then join a **Movie Jam** to collaboratively direct a new living story: propose what happens next, shape characters and worlds, vote on the strongest direction, and watch the film evolve together.

The aim is to make film discovery and cinematic creation feel as social and immediate as choosing songs for a shared playlist. A Jam prompt can be as simple as _“a tiny dragon visits a pink unicorn world”_ or as detailed as a full character bible, visual language, plot turn, soundtrack cue, and camera direction.

## Real catalogue, real recommendations

Reverie will show the real films and series made available through Titan's catalogue integration. Their titles, artwork, metadata, availability, and editorial identity remain intact. The product does not create parody replacements, invented robot remakes, or misleading synthetic listings for existing cinema.

The catalogue powers a conversational, TV-first **Discover** experience: viewers can ask for what they feel like watching, refine the answer naturally, and browse genuine titles. Movie Jam is a separate, clearly labelled creative mode for directing a new story with other people.

## The experience

1. **Discover something real** — viewers use natural conversation to find films and series in the Titan catalogue.
2. **Create or join a Movie Jam** — hosts can create a public room, a private room, or share an invite link / QR code with an audience.
3. **Direct together** — participants write, speak, upload a reference, or share a live camera moment for the story, characters, locations, visual style, mood, dialogue, and scene changes.
4. **Build a coherent film** — Reverie turns the room's ideas into editable creative material: story beats, screenplay, character sheets, world bible, shot list, prompts, sound direction, and scene assets.
5. **Vote and transition** — ideas are queued and voted on so the generation system receives one clear creative turn at a time instead of conflicting instructions.
6. **Watch it take shape** — the active direction updates the live visual and the next scene. Every scene remains editable, and any earlier moment can fork into a new version of the story.
7. **Keep the result** — a completed Jam becomes a shareable short film or episodic story, with its creative history and branches preserved.

## What makes it different

- **Many directors, one coherent story.** A room can be playful and chaotic without producing an incoherent film.
- **Natural level of detail.** Children can ask for a magical pig; filmmakers can set lens language, pacing, character arcs, and production constraints.
- **A living production package.** Inputs do not disappear into a single generation. They continuously update editable script and asset documents.
- **Real-time, audience-ready.** It is designed for friends, families, classrooms, festivals, and a HackBarna demo with audience members joining through a QR code.
- **Branchable cinema.** Fork from any past scene and explore alternate endings, tones, or universes.
- **Respect for real films.** Genuine catalogue titles stay genuine; collaborative generation is distinct and clearly labelled.

## Direct in any medium

A Movie Jam should accept ideas in the medium that makes them easiest to express. Each contribution becomes an attributed, editable **creative turn** in the same shared story timeline.

| Contribution | What a participant can add | How it can shape the movie |
| --- | --- | --- |
| Text | A plot twist, character detail, line of dialogue, camera instruction, or full scene brief | Story beats, screenplay, dialogue, shot list, and generation direction |
| Voice | A spoken idea, performance, sound cue, or fast instruction | Live transcription, tone and dialogue references, and the next creative turn |
| Image | A drawing, moodboard, character reference, costume, location, or colour palette | Character/world bible, visual palette, prop and composition direction |
| Video clip | A movement reference, performance, texture, location, or camera-language example | Blocking, pacing, motion, scene energy, and visual-transition direction |
| Live camera | A host or participant appears in the Jam, shows an object, performs a moment, or directs the scene in real time | A time-bounded live reference that can inform the current scene and be transformed into the shared visual language |

The participant always states the purpose of an image or video — for example, “use the colour palette,” “use this movement,” or “make this character feel like this.” The system stores that intent alongside the asset rather than treating an upload as an opaque prompt.

### Live co-direction with Vonage + fal.ai

Vonage will make Movie Jam a real collaborative studio rather than a text chat with a video result. Hosts and remote participants can join a WebRTC room, contribute a live camera or screen, receive captions, and see the evolving film together. Vonage signaling carries room interaction such as chat, proposal, and control events; its broadcast and archive capabilities can power a public Watch page, optional RTMP output, and a Jam replay.

fal.ai then becomes the creative media layer: it can transform a permitted camera feed or uploaded media into the Jam's visual world, while the screenplay and production package keep the result coherent. The Vonage starter shown at HackBarna demonstrates this exact category of integration: Vonage Video API broadcast, archiving, and signaling alongside a WebRTC camera feed passed to fal for live video editing. [Vonage Video API × fal starter](https://github.com/Vonage-Community/demo-video-javascript-fal-starter)

Live and uploaded media are opt-in contributions. The product will show who is live, what is being used as a reference, and when a contribution expires. Raw camera/audio should remain transient unless the room deliberately enables recording or export.

## Sponsor-first technical direction

Reverie will be built to showcase the strongest relevant HackBarna 2027 sponsor technologies, while keeping each provider behind a replaceable adapter.

Potential capabilities include:

| Need | Possible sponsor integration |
| --- | --- |
| Real catalogue, title metadata, and TV discovery context | Titan OS catalogue integration |
| Real-time conversational direction, transcription, and script reasoning | Titan and other event-provided AI models |
| Live participant video, broadcast, recording, captions, and room signaling | Vonage Video API |
| Image, video, and visual asset generation | fal.ai |
| Live rooms, events, presence, and voting | Event-supported real-time / cloud infrastructure |
| Media storage, rendering, and exports | Event-supported cloud and media tools |

The exact provider stack will follow the official HackBarna 2027 sponsor list and available APIs. No provider is assumed to be enabled until it has been confirmed for the event.

## Technology stack

Reverie uses the same deliberately small, real-time architecture validated in the rehearsal project. It is a single TypeScript application for the first public build: a React TV/web client, one Node server, and provider adapters that keep sponsor integrations replaceable.

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Client | React, TypeScript, Vite | TV-first discovery catalogue, Jam hub, host and participant rooms, responsive audience UI, accessible focus states |
| Real-time | WebSocket (`ws`) | Room presence, proposal queue, chat, votes, scene state and reconnect snapshots |
| Server | Node.js, Express, TypeScript | Session authorization, orchestration, rate/budget limits, provider credentials and safe errors |
| Validation | Zod | Validate browser commands, provider output and state transitions at every boundary |
| Creative reasoning | Nebius Token Factory adapter | Convert user turns into a structured story, script and production-direction bundle |
| Speech | SLNG adapter | Real-time speech-to-text, partial/final transcripts and optional voice responses |
| Generative media | fal.ai adapter | Generate and direct stills, video, scene updates and other synthetic film assets |
| QR invites | `qrcode.react` | Invite an audience into a specific Jam through a shareable room link |
| Core domain | Provider-free TypeScript modules | Versioned story state, queue/vote rules, validation, deterministic ordering and forks |

Keys always remain server-side in a local `.env.local` file. Browser clients never choose arbitrary model IDs, provider URLs or budget limits. The initial deployment target is one instance with in-memory rooms; persistence and multi-instance infrastructure come only when the public product needs them.

Technical design documents:

- [Architecture](docs/ARCHITECTURE.md)
- [Technology stack and provider strategy](docs/TECHNOLOGY_STACK.md)
- [Internal API contracts](docs/API_CONTRACTS.md)
- [State machines](docs/STATE_MACHINE.md)
- [Contributor instructions](AGENTS.md)

## Core product principles

- **The audience remains in control.** AI is the production partner, not the sole author.
- **One clear turn at a time.** Queue, voting, and scene boundaries protect story continuity and model quality.
- **Fast feedback over long waits.** Text, story state, and visual direction should update immediately; expensive generation can continue progressively.
- **Every important decision is editable.** Scripts, character definitions, prompts, scenes, and forks are first-class artifacts.
- **Safe public collaboration.** Rooms need host controls, invite permissions, moderation, and appropriate rate limits.

## Initial demo

The HackBarna demo will start with a host-led story, then reveal a QR code so audience members can join. The host admits participants, who submit and vote on twists. The winning direction becomes the next scene while the audience watches the movie take shape in real time.

## Status

This repository is being restarted as the public HackBarna 2027 build. The first milestone is a credible multi-user Jam: shared room state, participant identity, proposal queue and voting, editable story artifacts, and a visible generation pipeline.

## Contributing

This is an early public project. Product, design, film, AI, real-time systems, and creative-tool contributors are all welcome. The initial architecture and contribution workflow will be added as the build begins.
