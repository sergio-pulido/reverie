# Supabase setup for Movie Jam

Reverie uses Supabase as the authoritative store for Jam rooms and, in later milestones, membership, proposals, votes, presence, chat, and media-reference metadata. Vercel hosts the Vite frontend and server-side functions that need private provider credentials.

## 1. Create the project

1. Create a Supabase project for Reverie.
2. Enable **Anonymous Sign-Ins** in Auth. This gives each browser a real `auth.uid()` without asking a HackBarna audience member to create an account.
3. Run `supabase/migrations/20260919140000_initial_jams.sql` in the SQL Editor or apply it through the Supabase CLI.
4. Keep later migrations ordered and versioned in `supabase/migrations`. Apply the initial migration once; it is not an idempotent reset script.
5. In Database → Publications, add future realtime tables to `supabase_realtime` only when subscriptions and RLS tests exist.

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

The initial migration supports server-authoritative Jam records and host membership. Anonymous authenticated users can create rooms, and hosts can read/update their own room. Private-room admission, proposals, votes, chat, Presence, Storage, and Realtime subscriptions are intentionally subsequent milestones; do not weaken RLS just to make a demo appear to work.

## Verification and security boundary

Create a room in one browser and reload its persistent URL. Inspect `jams` and the active host row in `jam_members` in the dashboard. In a second browser/session, the same private room must not be readable. The current migration does not grant member admission or room discovery, even for rooms labelled public.

Anonymous Auth users receive the `authenticated` database role; the public API key alone is not a signed-in identity. RLS must enforce room membership on every collaborative table. Future join/admit RPCs must constrain who can change membership and prevent self-promotion, removed-member re-entry and private-room enumeration.

Postgres Changes subscriptions need table publication and RLS. Broadcast/Presence need separate Realtime authorization with private channels; knowing a channel name must never grant access. Reconnects must reload authorized durable state, and membership revocation must prevent subsequent reads/writes. Neither subscriptions nor these future admission policies are implemented yet.

Anonymous sessions persist in one browser profile. Do not promise cross-device host recovery. Before a public audience launch, configure Auth abuse protection and appropriate limits. No remote project or migration has been verified by this repository setup alone.

See [Vercel setup](VERCEL_SETUP.md). Official references: [anonymous sign-ins](https://supabase.com/docs/guides/auth/auth-anonymous), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization).
