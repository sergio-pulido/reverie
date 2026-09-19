# Vercel + Supabase foundation

## Scope and acceptance

- Vite builds static assets for Vercel; direct `/jams/new`, `/jams/:slug`, and `/join` navigation serves the app.
- `/api/health` is a Node function on Vercel and a matching local Express route. Unknown API paths return 404, never the SPA.
- Supabase owns persisted room records, anonymous identity and RLS. No custom WebSocket server is deployed.
- Public configuration and private provider keys have separate documented scopes. Missing configuration enables only an explicitly labelled local preview.
- README, contributor instructions, architecture, contracts, state and setup guides agree on implemented versus planned capabilities.
- Verify install, typecheck, build, health and local production deep links. Hosted deployment and live database verification require configured projects and are reported separately.

## Exclusions

Admission, proposals, chat, presence, voting, Titan and Vonage remain subsequent feature work. No remote database is migrated and no paid provider is enabled by this change.
