# Reverie contributor instructions

Reverie is the public HackBarna 2027 Movie Jam project. Read `README.md`, `docs/PROJECT_STATE.md`, `docs/ARCHITECTURE.md`, and the task brief before changing code.

## Product boundary

- Build a shared, real-time creative room where a host and participants direct an original AI movie together.
- Preserve a coherent story through a server-owned queue, voting, scene boundaries, versioned creative artifacts, and forks.
- Keep the public repository independent. Do not copy private rehearsal code, private assets, credentials, account information, or unverified provider claims.

## Architecture rules

- Keep `core` independent of React, browser APIs, provider SDKs, and UI concerns.
- Isolate Nebius, SLNG, fal.ai, and future sponsor integrations behind typed provider adapters.
- The server owns rooms, authorization, budgets, queue ordering, votes, scene transitions, and provider calls. Browser state is a projection, never the authority.
- Validate all commands and external output with Zod. Treat participant input and model output as data, never executable instructions or HTML.
- Prefer one Node process and documented limits for the initial demo. Do not add databases, queues, vector stores, or extra services without a measured requirement.

## Security and cost controls

- Keep all secrets in ignored `.env.local`; never log, commit, print, or expose them to the client.
- Use same-origin checks, short-lived session authorization, bounded payloads, per-room rate limits, and server-owned provider/model allowlists.
- Raw audio is transient. Log safe identifiers, duration, state version, and typed errors instead of transcript or provider payload dumps.
- Paid generation needs explicit concurrency and spend limits. Never silently fall back from a failed live provider to a mock or claim that an untested provider works.

## Delivery standard

- Make focused changes with tests that exercise the affected behavior.
- Update `docs/PROJECT_STATE.md` and `docs/DECISIONS.md` when architecture or product behavior changes materially.
- Report commands actually run, results, known gaps, and any provider probe receipts.
- Use `codex/rv-NN-description` branches and `[RV-NN]` commit references for implementation work.
- Preserve unrelated user changes. Do not use destructive Git commands or amend history unless explicitly asked.
