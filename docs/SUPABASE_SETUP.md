# Supabase setup for Movie Jam

Reverie uses Supabase as the authoritative store for Jam rooms, membership, chat and proposals, and in later milestones for votes and media-reference metadata. Vercel hosts the Vite frontend and server-side functions that need private provider credentials.

## 1. Create the project

1. Create a Supabase project for Reverie.
2. Enable **Anonymous Sign-Ins** in Auth. This gives each browser a real `auth.uid()` without asking a HackBarna audience member to create an account.
3. Run every migration in `supabase/migrations` in filename order through the SQL Editor or
   Supabase CLI: `20260919140000_initial_jams.sql`, `20260919160000_jam_lobby_admission.sql`,
   `20260919170000_script_format_and_sessions.sql`, `20260919180000_jam_scripts.sql`, then
   `20260919190000_jam_collaboration.sql`. The last migration adds `jam_messages`,
   `jam_proposals` and `jam_members` to the `supabase_realtime` publication and creates the
   `realtime.messages` policies that authorize the private `jam:<id>` channel, so no manual
   publication step is needed.
4. Keep later migrations ordered and versioned in `supabase/migrations`. Apply the initial migration once; it is not an idempotent reset script.
5. In Database → Publications, add any further realtime table to `supabase_realtime` only once its subscription and its RLS policies exist.

## 2. Configure local development

Copy `.env.example` to `.env.local` and set only the public browser values below:

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
```

The anonymous/publishable key is safe for the browser because the database is protected by Row Level Security. Never put `SUPABASE_SERVICE_ROLE_KEY`, provider secrets, Vonage secrets, or a private key in a `VITE_` environment variable.

## 3. Configure Vercel

Add the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` values to the Vercel project for Preview and Production. Add private keys only to server-side function variables, without the `VITE_` prefix. Vercel deploys the Vite single-page app; `vercel.json` preserves deep links such as `/jams/<slug>`.

## Current scope

The migrations support server-authoritative Jam records, script/session metadata, invite
entitlement, display names, the waiting lobby, host admission and removal, append-only chat
and proposals, Postgres Changes and a private Presence channel. Membership is mutated only through
`request_jam_admission` and `set_jam_member_status`; the browser has no write policy on
`jam_members`. Votes, scene transitions, forks, Storage and every provider call remain
subsequent milestones. Do not weaken RLS just to make a demo appear to work.

## Verification and security boundary

Run the scripted two-session check against the configured project:

```bash
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_ANON_KEY=sb_publishable_... \
pnpm verify:realtime
```

It opens three independent anonymous sessions and asserts lobby placement, refusal of
self-admission and of direct `jam_members` inserts, host admission, cross-session Realtime
delivery of a message and a proposal, snapshot recovery after a dropped subscription,
host-only visibility of the waiting lobby, outsider denial, removal, and refusal to re-enter
after removal. It leaves one test jam
behind and prints its slug so it can be deleted from the dashboard. This repository has no
Supabase credentials, so the script has never been run here.

By hand: create a room in one browser and reload its persistent URL; open the invite code in
a second browser profile and confirm it waits until the host admits it; send a line from each
side and confirm both appear; reload one side and confirm the conversation is restored from
the snapshot; remove the guest and confirm the room stops updating for them.

Anonymous Auth users receive the `authenticated` database role; the public API key alone is not a signed-in identity. RLS enforces room membership on every collaborative table. The join and admit RPCs constrain who can change membership and refuse self-promotion, removed-member re-entry and private-room enumeration.

Postgres Changes subscriptions need table publication and RLS; Presence needs separate
Realtime authorization with private channels, so knowing a channel name never grants access.
Reconnects reload authorized durable state, and membership revocation stops subsequent reads
and writes. All of this is implemented in the migrations and the client, and none of it has
been verified against a live project from this repository.

Anonymous sessions persist in one browser profile. Do not promise cross-device host recovery. Before a public audience launch, configure Auth abuse protection and appropriate limits. No remote project or migration has been verified by this repository setup alone.

See [Vercel setup](VERCEL_SETUP.md). Official references: [anonymous sign-ins](https://supabase.com/docs/guides/auth/auth-anonymous), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization).
