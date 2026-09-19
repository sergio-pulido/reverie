# Vercel deployment

## Project configuration

Import this public repository into Vercel with root directory `.` and production branch `main`. Select Node.js 22.x. `vercel.json` selects Vite, `pnpm install --frozen-lockfile`, `pnpm build`, and output directory `dist`. The package manager version is pinned in `package.json`.

`api/health.ts` deploys as a Node function. SPA rewrites exclude `/api` so direct Jam links load the client and unknown API routes do not return HTML. Express is for local development/build preview, not the Vercel entrypoint. Future privileged endpoints belong under `api/`.

## Environment

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for Production and Preview. They are public values embedded at build time; redeploy after changing them. Prefer a separate Supabase project for previews to avoid modifying production rooms.

Follow [Supabase setup](SUPABASE_SETUP.md) before testing persistent rooms. Anonymous identity belongs to the browser profile and origin: localhost, preview and production do not share host sessions. Clearing browser data may lose host access until account recovery is implemented.

Provider keys, Vonage signing credentials and spend limits from `.env.example` belong only in server environment variables, never `VITE_`. No service-role key is needed for current room creation. Add elevated credentials only if a future reviewed server operation requires them; privileged handlers must validate identity and membership themselves. Keep `REVERIE_LIVE_ENABLED=false` until documented probes and limits exist.

## Verification

Locally:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm start
```

In another terminal:

```bash
node scripts/smoke.mjs
```

After deployment, run `SMOKE_BASE_URL=https://YOUR-DEPLOYMENT node scripts/smoke.mjs` against the assigned HTTPS domain. Check `/api/missing` returns 404, open `/jams/new` directly, create a room, reload its URL in the same browser, and verify the record in Supabase. A second browser must not read an invite-only room under the current host-only policies. Admission is a future milestone; do not weaken policies to bypass that restriction.

A healthy endpoint proves only the function is reachable. It does not prove Supabase, Realtime, Titan or providers work. Deployment/account configuration and the live database migration have not been performed by this foundation change.

References: [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite), [rewrites](https://vercel.com/docs/routing/rewrites).
