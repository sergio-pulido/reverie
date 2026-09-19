# Reverie — Movie Jam

> A live, collaborative studio where a room of people becomes the director's room for an original AI film.

Reverie is an open-source HackBarna 2027 project. It turns a group prompt session into a living movie: people join a **Jam**, propose what should happen next, shape characters and worlds, vote on the strongest direction, and watch the film evolve together.

The aim is to make cinematic creation feel as social and immediate as choosing songs for a shared playlist. A prompt can be as simple as _“a tiny dragon visits a pink unicorn world”_ or as detailed as a full character bible, visual language, plot turn, soundtrack cue, and camera direction.

## The experience

1. **Create or join a Movie Jam** — hosts can create a public room, a private room, or share an invite link / QR code with an audience.
2. **Direct together** — participants write or speak ideas for the story, characters, locations, visual style, mood, dialogue, and scene changes.
3. **Build a coherent film** — Reverie turns the room's ideas into editable creative material: story beats, screenplay, character sheets, world bible, shot list, prompts, sound direction, and scene assets.
4. **Vote and transition** — ideas are queued and voted on so the generation system receives one clear creative turn at a time instead of conflicting instructions.
5. **Watch it take shape** — the active direction updates the live visual and the next scene. Every scene remains editable, and any earlier moment can fork into a new version of the story.
6. **Keep the result** — a completed Jam becomes a shareable short film or episodic story, with its creative history and branches preserved.

## What makes it different

- **Many directors, one coherent story.** A room can be playful and chaotic without producing an incoherent film.
- **Natural level of detail.** Children can ask for a magical pig; filmmakers can set lens language, pacing, character arcs, and production constraints.
- **A living production package.** Inputs do not disappear into a single generation. They continuously update editable script and asset documents.
- **Real-time, audience-ready.** It is designed for friends, families, classrooms, festivals, and a HackBarna demo with audience members joining through a QR code.
- **Branchable cinema.** Fork from any past scene and explore alternate endings, tones, or universes.

## Sponsor-first technical direction

Reverie will be built to showcase the strongest relevant HackBarna 2027 sponsor technologies, while keeping each provider behind a replaceable adapter.

Potential capabilities include:

| Need | Possible sponsor integration |
| --- | --- |
| Real-time conversational direction, transcription, and script reasoning | Titan and other event-provided AI models |
| Image, video, and visual asset generation | fal.ai |
| Live rooms, events, presence, and voting | Event-supported real-time / cloud infrastructure |
| Media storage, rendering, and exports | Event-supported cloud and media tools |

The exact provider stack will follow the official HackBarna 2027 sponsor list and available APIs. No provider is assumed to be enabled until it has been confirmed for the event.

## Technology stack

Reverie uses the same deliberately small, real-time architecture validated in the rehearsal project. It is a single TypeScript application for the first public build: a React TV/web client, one Node server, and provider adapters that keep sponsor integrations replaceable.

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Client | React, TypeScript, Vite | Jam hub, host and participant rooms, responsive audience UI, accessible focus states |
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
