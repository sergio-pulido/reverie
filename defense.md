# How this code is defended

*Written for the Quality Clouds challenge at HackBarna 2026. Repository: `sergio-pulido/reverie`.*

"Defend" here means one thing: for any line in this repository we can say what it does, show
the test that proves it, point at the decision that put it there, and name the failure mode we
accepted when we wrote it. What we cannot defend is listed at the end, not hidden.

## 1. The shape of it

- React 19 + TypeScript front end (Vite), an Express host for local development, Vercel
  functions for the privileged handlers, Supabase (Postgres, anonymous Auth, Row Level
  Security, Realtime) as the shared authority.
- 316 commits, 110 test files, 24 database migrations, 11 of them enabling RLS on the tables
  they create, and Zod schemas at 38 boundaries.
- Everything a contributor — human or agent — must obey is in `AGENTS.md`. It is short and it
  is enforced by review, not by hope.

## 2. Boundaries that make the code arguable

**`core` knows nothing.** `src/core/` has no React, no browser API, no provider SDK and no
clock. The rules of an escape room, the intent matcher, the outline logic and the spend ledger
are pure functions over typed data. A pure function is the cheapest thing in the world to
defend: give it an input, read the output, no setup.

**The server is the authority; the browser is a projection.** Rooms, membership, budgets, queue
order, votes and every provider call live on the server or in Postgres under RLS. The browser
never holds a provider key and never decides anything the database could contradict.

**Providers sit behind typed adapters.** Nebius, fal.ai, Vonage and Supabase are each reached
through one adapter with a Zod schema on the response. A model's output is data, never
instructions and never HTML. If a provider changes its shape, the failure is a typed error at
the adapter, not a corrupted room.

**Zod at every boundary.** Commands from the browser, rows from the database, responses from
providers. Nothing untyped crosses a module edge.

## 3. Tests, and what kind

- `pnpm test` runs every file in `tests/` under Node's own test runner: 554 unit tests at the
  last recorded run (`docs/PROJECT_STATE.md`, 2026-09-19). DOM behaviour runs in jsdom; no
  browser is needed.
- **The escape-room rules are searched, not sampled.** `tests/escapeRules.test.ts` walks each
  authored scenario exhaustively over the transitions the rules actually produce, replays every
  reachable goal log to prove it reproduces the same world, and proves that dropping any single
  step of a shortest solution fails to reach the goal. An impossible action returns the very
  state it was given, by identity, so "nothing changed" is checkable rather than intended.
- **The model is never asked about the world.** The rules resolve an outcome first; the model is
  handed the result and writes prose and a shot. There is nothing for it to get wrong about the
  world, so there is nothing to test it for there.
- **Live is live, mock is mock.** `pnpm verify:realtime` (RLS, invites, lobby, admission,
  reconnect, removal — 27/27 against the hosted project, 34/34 against the local Docker stack),
  `verify:shortlist`, `verify:conversation`, `probe:vonage` and `probe:beat-video` run against
  real services and print receipts. A rule in `AGENTS.md` forbids claiming live success from a
  mock, and `docs/PROJECT_STATE.md` records each probe with its date and what actually came back.

## 4. Security and money

- Secrets live only in ignored `.env.local`; the browser is configured with exactly two public
  values. There is no service-role key on the server for the room routes: the server acts with
  the participant's own token and can see no more than they can.
- Access rules — who may join, be admitted, be removed, read a room — are RLS policies in
  Postgres, verified by the realtime suite. The UI repeats them for convenience, not for safety.
- Paid generation stays off until `REVERIE_LIVE_ENABLED=true`, runs against a server-owned model
  allowlist (two MiniMax models on fal.ai), and bills against one spend ceiling computed from
  generated seconds at fal's published rates. The ceiling is a hard stop, not a warning.
- Camera and microphone are opt-in behind a consent register that records owner, purpose and
  expiry; withdrawing consent stops the track and nothing is recorded, exported or transformed.
- The escape-room routes cache authorization for twenty seconds keyed by a SHA-256 digest of the
  token, so no long-lived structure ever holds a credential. The cost — an admission takes up to
  twenty seconds to be felt — is written where the cache is.

## 5. Traceability

- `docs/DECISIONS.md`: every material choice, newest first, with the alternative it rejected and
  the cost it accepted.
- `docs/PROJECT_STATE.md`: the dated record of what exists and what has been verified, including
  probe receipts.
- `docs/specs/`: nineteen specs, including `intended-vs-implemented.md`, which exists precisely
  so nobody has to guess which is which.
- `docs/CONTRIBUTING.md`: branch, PR, fetch-before-push, no force pushes, stage only owned
  files, never commit environment files.

## 6. What we cannot defend yet

- **No CI.** Typecheck, build and tests run locally and are reported in commits; nothing blocks
  a merge automatically. This is the first thing to add.
- **The local Express host is inconsistently authorized.** The escape-room routes check who is
  asking; the script, session and director routes do not. Recorded in `DECISIONS.md`
  (2026-09-20) as a known gap, deliberately not widened.
- **Unverified surfaces:** a Vercel deployment, a two-browser Vonage stage, the realtime director
  model's media track, and two browsers in one escape room.
- **Hosted migrations were applied by hand.** No tracking table records them.
- **No linter.** TypeScript strict mode and review are the only style gate.

## 7. Check it yourself

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Then read `docs/PROJECT_STATE.md` and compare it with what you just saw. If they disagree, the
document is wrong and we want to know.
