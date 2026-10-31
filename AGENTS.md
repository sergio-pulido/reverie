# Reverie contributor instructions

Reverie is the public HackBarna 2026 Movie Jam project. Read `README.md`, `docs/PROJECT_STATE.md`, `docs/ARCHITECTURE.md`, and the task brief before changing code.

## Product boundary

- Build a shared, real-time creative room where a host and participants direct an original AI movie together.
- Preserve a coherent story through a server-owned queue, voting, scene boundaries, versioned creative artifacts, and forks.
- Keep the public repository self-contained. Everything here is written for this repository. Do not import private code or assets from elsewhere, and do not commit credentials, account information, or unverified provider claims.

## Architecture rules

- Keep `core` independent of React, browser APIs, provider SDKs, and UI concerns.
- Isolate Nebius, SLNG, fal.ai, and future sponsor integrations behind typed provider adapters.
- The server owns rooms, authorization, budgets, queue ordering, votes, scene transitions, and provider calls. Browser state is a projection, never the authority.
- Validate all commands and external output with Zod. Treat participant input and model output as data, never executable instructions or HTML.
- Deploy React/Vite and privileged Node functions on Vercel. Supabase owns Postgres, anonymous Auth, RLS and Realtime. Express is local development/static-preview tooling only.
- Use Supabase Realtime for collaboration; never deploy a custom long-lived WebSocket server on Vercel. Do not add other infrastructure without a measured requirement.

## Security and cost controls

- Keep all secrets in ignored `.env.local`; never log, commit, print, or expose them to the client.
- Use same-origin checks, short-lived session authorization, bounded payloads, per-room rate limits, and server-owned provider/model allowlists.
- Raw audio is transient. Log safe identifiers, duration, state version, and typed errors instead of transcript or provider payload dumps.
- Paid generation needs explicit concurrency and spend limits. Never silently fall back from a failed live provider to a mock or claim that an untested provider works.

## Worktrees and local environment

- Feature and fix work happens in its own worktree on a `codex/rv-NN-description` branch, one
  worktree per branch, outside this checkout.
- A fresh worktree has **no `.env.local`**: the file is ignored, so it exists only in the primary
  checkout. Symlink it rather than copying, so there is one file to rotate and no second copy of a
  secret on disk: `ln -s <primary checkout>/.env.local <worktree>/.env.local`. `.env.compose` is
  tracked and already present in every worktree; it needs no link.
- `node_modules` is absent for the same reason. Symlink it from the primary checkout or run
  `pnpm install` in the worktree; a symlink is not matched by the ignored `node_modules/` pattern,
  so stage files explicitly and never `git add -A` there.
- Before running the local Docker stack or a dev server from a worktree, give it a port of its own
  (`PORT=…`) so it does not collide with a server already running from the primary checkout.

## Delivery standard

- Make focused changes with tests that exercise the affected behavior.
- Update `docs/PROJECT_STATE.md` and `docs/DECISIONS.md` when architecture or product behavior changes materially.
- Those two files grow at opposite ends, which is the trap: `docs/DECISIONS.md` grows at the **head** (newest entry first), while `docs/PROJECT_STATE.md` dated entries are inserted **before the standing `## Next milestones` section** at the end. Do not infer one from the other. Every entry carries the same date, so position in history is the only reliable ordering — `git log -1 -S"<entry title>" origin/main -- docs/DECISIONS.md` tells you which commit introduced an entry, and `git merge-base --is-ancestor <older> <newer>` orders any two.
- `docs/INCONSISTENCIES.md` tracks gaps between the documentation and the actual implementation (a doc describing something the code doesn't do yet, or code behavior the docs don't reflect). It lets the docs describe intended behavior ahead of the code without silently going stale: when you notice or fix a gap, record or close its entry there instead of quietly reconciling docs and code out of band.
- Report commands actually run, results, known gaps, and any provider probe receipts.
- Every contributor, human or agent, integrates the same way: rebase onto the latest `main`, push the branch, open a PR, and merge the PR. Nobody pushes directly to `main`. Use `codex/rv-NN-description` branches and `[RV-NN]` commit references where applicable. Disable signing with `git -c commit.gpgsign=false commit`.
- Fetch before publishing, stage only owned files, and reconcile incoming changes without force pushes. Never stage another developer’s work implicitly. See `docs/CONTRIBUTING.md`.
- Preserve unrelated user changes. Do not use destructive Git commands or amend history unless explicitly asked.
