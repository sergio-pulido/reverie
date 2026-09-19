# Technology stack and provider strategy

Status: public build target. Package versions, models, cost, account access, and HackBarna 2026 sponsor availability must be verified before implementation claims live support.

## Baseline stack

| Area | Choice | Why it belongs in Reverie |
| --- | --- | --- |
| Language | TypeScript | Shared types across the Jam client, server, room state and provider adapters |
| Client | React + Vite | Fast iteration for host, participant, mobile join and display views |
| Server | Node.js + Express | Local same-origin development and production-build preview; not the deployed room authority |
| Deploy and privileged APIs | Vercel | Vite deployment, deep-link routing, and Node functions for provider credentials and token signing |
| Authoritative collaboration data | Supabase + `@supabase/supabase-js` | Postgres, anonymous Auth, Row Level Security, Realtime, and later Storage |
| Real-time | Supabase Realtime | RLS-protected Postgres Changes for durable chat and proposals; Presence and Broadcast deferred |
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
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
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

Vonage credentials are server-only. Session tokens are minted server-side. The browser receives a short-lived room/session token and never receives the API secret or application private key.

Titan catalogue data is treated as licensed source material: real title names, posters, metadata, and availability are rendered faithfully and attributed according to the integration terms. It must not be remixed into invented catalogue entries or used to imply a generated work is an existing film.

## Delivery posture

Use Vercel for the deployed frontend and server-side functions, and Supabase for persistent rooms. Do not run a custom long-lived WebSocket server on Vercel: use Supabase Realtime for presence, broadcast, and database-change subscriptions. Keep provider secrets and privileged actions in Vercel functions; keep the browser restricted to public Supabase configuration and RLS-protected calls.

## Implemented versus planned

React/Vite, local Express, Supabase client room creation, the host-only migration and Vercel health handler exist. Realtime subscriptions, provider adapters, media, admission, catalogue data and live deployment verification do not yet exist. See [Vercel setup](VERCEL_SETUP.md), [Supabase setup](SUPABASE_SETUP.md) and [contracts](API_CONTRACTS.md).

Official references: [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite), [Supabase Realtime authorization](https://supabase.com/docs/guides/realtime/authorization), [anonymous sign-ins](https://supabase.com/docs/guides/auth/auth-anonymous).
