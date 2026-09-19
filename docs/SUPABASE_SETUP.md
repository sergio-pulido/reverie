# Supabase setup for Movie Jam

Reverie uses Supabase as the authoritative store for Jam rooms and, in later milestones, membership, proposals, votes, presence, chat, and media-reference metadata. Vercel hosts the Vite frontend and server-side functions that need private provider credentials.

## 1. Create the project

1. Create a Supabase project for Reverie.
2. Enable **Anonymous Sign-Ins** in Auth. This gives each browser a real `auth.uid()` without asking a HackBarna audience member to create an account.
3. Run `supabase/migrations/20260919140000_initial_jams.sql` in the SQL Editor or apply it through the Supabase CLI.
4. In Database → Publications, ensure the future realtime tables are added to `supabase_realtime` only when their client subscriptions are implemented.

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
