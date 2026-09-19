# Decisions

## 2026-09-19 — Start with a single-process real-time architecture

The first public build uses a React/Vite client and one TypeScript Node/Express server with `ws` WebSockets and in-memory rooms. This makes the live demo small, inspectable, and easy to run. Restarts reset rooms visibly; distributed persistence is deferred until it is required.

## 2026-09-19 — Keep sponsor technologies behind adapters

Nebius, SLNG, fal.ai, Titan, and any confirmed HackBarna sponsor capability are server-side integrations behind typed adapters. The product contracts do not depend on one model/vendor, and no provider is represented as available before a live probe confirms it.

## 2026-09-19 — Server owns collaborative story state

The server is authoritative for membership, queue ordering, votes, story versions, accepted scenes, and budgets. Clients render snapshots/events and can show pending feedback, but cannot commit a scene independently.
