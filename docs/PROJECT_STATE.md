# Project state

## 2026-09-19 — Public repository initialized

- The public HackBarna 2027 Movie Jam vision is documented in the root README.
- The target stack, provider boundaries, application contracts and state machines are defined as implementation guides.
- No application code, provider connection, model access, generated media, or live multi-user capability has been claimed or implemented in this repository yet.

## 2026-09-19 — Executable foundation and first screen

- The repository now has a React/Vite client and a same-origin TypeScript Node/Express server.
- `pnpm dev` starts the local experience at `http://127.0.0.1:4317`; `GET /api/health` confirms the server is running.
- The initial Movie Jam landing screen presents the host and invite entry points. Those controls intentionally communicate their next implementation step; no room, provider, or live collaboration behavior exists yet.
- Package installation, type checking, production build, and local health route have been verified.

## Next milestone

Implement an independently testable local Jam room: server-owned room state, name/admission flow, shared WebSocket presence and chat, proposal queue, vote state, and a host-controlled scene transition. Provider adapters remain disabled until their individual probes pass.
