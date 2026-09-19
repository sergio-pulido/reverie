# RV-05 — Invite entitlement, display names, waiting lobby and host admission

## Problem

A Jam room can be created and reloaded by its host, but nobody else can enter it.
There is no invite entitlement, no display name, no lobby and no way for a host to
admit or remove a participant. The join screen is a placeholder.

## Scope

- Every Jam carries a server-generated `invite_code`. Knowing a slug is not an entitlement;
  the code is.
- A participant submits an invite code (or an invite URL containing it) plus a display name
  and becomes a `jam_members` row through a constrained `security definer` RPC.
- Invite-only rooms place a new participant in `waiting`. Public rooms activate immediately.
- The host sees the lobby and can admit (`waiting → active`) or remove (`→ removed`) a
  participant through a second host-only RPC.
- A `removed` participant cannot re-enter with the same invite code.
- Members can read the room record and the active roster of rooms they belong to; nobody can
  enumerate rooms they do not belong to, and only the host can see who is queued for
  admission.

## Non-goals

Chat, proposals, votes, presence, Realtime subscriptions, scene transitions, Titan and
Vonage remain later milestones. This slice adds no provider call, no paid generation and
no long-lived WebSocket server.

## Contracts

### `public.request_jam_admission(p_invite_code text, p_display_name text)`

`security definer`, `authenticated` only. Returns `(jam_id uuid, slug text, title text, member_status text)`.

| Condition | Result |
| --- | --- |
| No `auth.uid()` | error `28000` |
| Display name not 1–32 characters after trimming | error `22023` |
| Invite code does not resolve | error `P0002` (`invite not found`) |
| Room `completed`/`closed` | error `22023` |
| Caller already `removed` | error `42501` |
| Caller already `waiting`/`active` | display name refreshed, status preserved (idempotent) |
| New caller, `invite_only` room | inserted as `waiting` |
| New caller, `public` room | inserted as `active` |

A caller who previously `left` re-enters under the same rule as a new caller.
The function never promotes anyone to `host`.

### `public.set_jam_member_status(p_jam_id uuid, p_member_id uuid, p_status text)`

`security definer`, host-only. `p_status` is `active` or `removed`. The host's own row cannot
be changed, so a room can never lose its host. Returns the updated member row.

### Read policies

`jams` and `jam_members` selects use `public.is_jam_host` / `public.is_jam_member` /
`public.is_active_jam_member` `security definer` helpers so a membership check does not
recurse through the other table's own policies. A waiting participant reads only their own
row, an active member reads only the active roster, and the host reads every row. No client-side insert/update/delete policy is added to `jam_members`; all
membership mutation goes through the two RPCs above.

## Client

- `src/core/invite.ts` is provider-free and browser-free: invite-code and display-name
  normalization plus Zod schemas for the RPC payloads. It is unit tested.
- `src/lib/membership.ts` holds the Supabase calls.
- `src/screens/JoinRoom.tsx` performs a real admission request and reports the resulting
  lobby state. `src/screens/JamLobby.tsx` renders the host admission panel.
- Without Supabase configuration the join screen states plainly that joining is unavailable
  rather than simulating a successful join.

## Acceptance

- `pnpm typecheck`, `pnpm build` and `pnpm test` pass.
- Unit tests cover invite-code extraction from raw codes and invite URLs, rejection of bad
  codes and display names, and RPC payload validation.
- `supabase/tests/lobby_rls.sql` states the RLS and RPC expectations as executable SQL
  assertions for a Supabase project. It is not run by this repository and no hosted database
  has been migrated by this change.

## Known gaps

No remote Supabase project has been migrated or probed. The lobby does not yet update in
Realtime; the host panel reloads on demand. Rate limiting of admission attempts and Auth
abuse protection are configured in the Supabase dashboard, not here.
