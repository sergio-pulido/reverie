# Technology stack and provider strategy

Status: public build target. Package versions, models, cost, account access, and HackBarna 2027 sponsor availability must be verified before implementation claims live support.

## Baseline stack

| Area | Choice | Why it belongs in Reverie |
| --- | --- | --- |
| Language | TypeScript | Shared types across the Jam client, server, room state and provider adapters |
| Client | React + Vite | Fast iteration for host, participant, mobile join and display views |
| Server | Node.js + Express | A small same-origin server for sessions, APIs, static app delivery and provider isolation |
| Real-time | `ws` WebSocket server | Low-latency room events, presence, chat, proposals, votes and scene snapshots |
| Live media | Vonage Video API | WebRTC participant video, broadcast/watch view, optional archive, captions and room signaling |
| Schemas | Zod | Validate every browser command and external AI response |
| QR | `qrcode.react` | Audience invite flow for live presentations |
| Catalogue | Titan catalogue adapter | Server-side access to real title metadata and availability for TV-first discovery |
| Tests/tooling | Node test runner, TSX, TypeScript | Lightweight unit, integration and server smoke checks |

## Provider adapters

All provider code lives behind server-side adapters. The client receives our typed events rather than provider responses or credentials.

| Provider | Intended capability | Required proof before enabling |
| --- | --- | --- |
| Nebius Token Factory | Structured creative reasoning: extract turns, update story state, generate screenplay/material, rank or clarify options | Accessible model, valid structured response, deadline/cost receipt, safe failure path |
| SLNG | Real-time speech-to-text and optional text-to-speech | Exact model, locale, codec, partial/final behavior, authorization and close semantics |
| Vonage Video API | Live participant camera/screen inputs, broadcast, archive, captions and signaling | Verified session/token lifecycle, browser permissions, broadcast/recording consent, reconnect and teardown |
| fal.ai | Image/video generation and live scene direction | Verified model path, server proxy/auth flow, update lifecycle, latency, cancellation and billing receipt |
| Titan | Real-title catalogue and TV-first discovery context | Confirmed catalogue contract, allowed fields/assets, attribution requirements and a tested integration path |

## Environment configuration

The public repository documents only variable names. Actual values belong in ignored `.env.local` files.

```bash
FAL_KEY=
NEBIUS_API_KEY=
SLNG_API_KEY=
NEBIUS_MODEL=
SLNG_STT_MODEL=
VONAGE_API_KEY=
VONAGE_API_SECRET=
VONAGE_APPLICATION_ID=
VONAGE_PRIVATE_KEY=
FAL_ASSET_BUDGET_USD=
REVERIE_LIVE_ENABLED=
```

`REVERIE_LIVE_ENABLED` remains off until each selected adapter has a dated, recorded probe. The server must enforce model allowlists, request size limits, session duration, concurrency and spend ceilings.

Vonage credentials and session tokens are server-only. The browser receives a short-lived room/session token and never receives the API secret or application private key.

Titan catalogue data is treated as licensed source material: real title names, posters, metadata, and availability are rendered faithfully and attributed according to the integration terms. It must not be remixed into invented catalogue entries or used to imply a generated work is an existing film.

## Delivery posture

Start with a single Node instance and in-memory rooms for the HackBarna demo. A restart visibly resets active rooms. Add persistence, distributed presence, jobs, media storage, or a database only after the product needs them and the related failure/recovery behavior is specified.
