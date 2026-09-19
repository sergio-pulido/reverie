# Technology stack and provider strategy

Status: public build target. Package versions, models, cost, account access, and HackBarna 2027 sponsor availability must be verified before implementation claims live support.

## Baseline stack

| Area | Choice | Why it belongs in Reverie |
| --- | --- | --- |
| Language | TypeScript | Shared types across the Jam client, server, room state and provider adapters |
| Client | React + Vite | Fast iteration for host, participant, mobile join and display views |
| Server | Node.js + Express | A small same-origin server for sessions, APIs, static app delivery and provider isolation |
| Real-time | `ws` WebSocket server | Low-latency room events, presence, chat, proposals, votes and scene snapshots |
| Schemas | Zod | Validate every browser command and external AI response |
| QR | `qrcode.react` | Audience invite flow for live presentations |
| Tests/tooling | Node test runner, TSX, TypeScript | Lightweight unit, integration and server smoke checks |

## Provider adapters

All provider code lives behind server-side adapters. The client receives our typed events rather than provider responses or credentials.

| Provider | Intended capability | Required proof before enabling |
| --- | --- | --- |
| Nebius Token Factory | Structured creative reasoning: extract turns, update story state, generate screenplay/material, rank or clarify options | Accessible model, valid structured response, deadline/cost receipt, safe failure path |
| SLNG | Real-time speech-to-text and optional text-to-speech | Exact model, locale, codec, partial/final behavior, authorization and close semantics |
| fal.ai | Image/video generation and live scene direction | Verified model path, server proxy/auth flow, update lifecycle, latency, cancellation and billing receipt |
| Titan | Event/product context and any confirmed event capability | Official HackBarna documentation, mentor confirmation and a tested integration path; no Titan API is assumed |

## Environment configuration

The public repository documents only variable names. Actual values belong in ignored `.env.local` files.

```bash
FAL_KEY=
NEBIUS_API_KEY=
SLNG_API_KEY=
NEBIUS_MODEL=
SLNG_STT_MODEL=
FAL_ASSET_BUDGET_USD=
REVERIE_LIVE_ENABLED=
```

`REVERIE_LIVE_ENABLED` remains off until each selected adapter has a dated, recorded probe. The server must enforce model allowlists, request size limits, session duration, concurrency and spend ceilings.

## Delivery posture

Start with a single Node instance and in-memory rooms for the HackBarna demo. A restart visibly resets active rooms. Add persistence, distributed presence, jobs, media storage, or a database only after the product needs them and the related failure/recovery behavior is specified.
