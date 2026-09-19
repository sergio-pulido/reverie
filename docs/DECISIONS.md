# Decisions

## 2026-09-19 — Use Vercel and Supabase for the public prototype

The public prototype deploys the Vite frontend and privileged Node functions to Vercel, while Supabase provides Postgres, anonymous Auth, Row Level Security, Realtime, and later Storage. This gives the demo persistent room URLs and multi-browser collaboration without operating a custom WebSocket server on a serverless platform.

## 2026-09-19 — Retain a local same-origin development server

The first public build uses a React/Vite client and one TypeScript Node/Express server with `ws` WebSockets and in-memory rooms. This makes the live demo small, inspectable, and easy to run. Restarts reset rooms visibly; distributed persistence is deferred until it is required.

## 2026-09-19 — Keep sponsor technologies behind adapters

Nebius, SLNG, fal.ai, Titan, and any confirmed HackBarna sponsor capability are server-side integrations behind typed adapters. The product contracts do not depend on one model/vendor, and no provider is represented as available before a live probe confirms it.

## 2026-09-19 — Server owns collaborative story state

The server is authoritative for membership, queue ordering, votes, story versions, accepted scenes, and budgets. Clients render snapshots/events and can show pending feedback, but cannot commit a scene independently.

## 2026-09-19 — Use Titan catalogue records as real cinema, not synthetic content

The Discover experience renders Titan-provided real films and series faithfully. Catalogue metadata and generated Movie Jam artifacts have separate schemas, identifiers, and labels so the product never presents an invented/generated work as a real title or rewrites existing films as jokes.

## 2026-09-19 — Treat media as declared creative references

Images, uploaded clips, and live camera are inputs to a shared creative turn, not opaque prompt attachments. Each has an owner, consent state, declared purpose, lifetime, and server-issued asset reference. Live media uses Vonage for room transport and fal.ai only for explicitly permitted creative transformation.

## 2026-09-19 — Start with one same-origin local development server

The first runnable baseline serves the Vite client through the Node/Express process at `127.0.0.1:4317`. This keeps browser-to-server contracts and provider boundaries easy to iterate on locally. It is a local development baseline, not the public deployment configuration.
