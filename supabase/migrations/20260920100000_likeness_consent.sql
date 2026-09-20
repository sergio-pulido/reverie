-- Reverie Movie Jam: agreeing to appear in the film.
-- Apply after 20260919210000_jam_live_media.sql.
--
-- A participant can choose to be a character in the film the room is generating. That is a
-- separate decision from joining the jam and a separate decision from turning on a camera,
-- so it is a separate grant -- but it is the same kind of fact as the grants already here,
-- so it extends this register instead of starting another one.
--
-- What this migration adds is permission and a reference, never a pixel. The approved frame
-- itself is held by the server under the reference issued below; the database stores no
-- image, and no browser is ever handed the reference of a frame it does not own.

-- 1. `likeness` joins the kinds ----------------------------------------------

alter table public.jam_live_consents
  drop constraint if exists jam_live_consents_kind_check;

alter table public.jam_live_consents
  add constraint jam_live_consents_kind_check
  check (kind in ('camera', 'microphone', 'screen', 'likeness'));

-- 2. The reference says which kind of thing it addresses ----------------------
-- A likeness reference is issued with its own prefix so that a route serving a frame and a
-- route publishing a track can never be handed each other's reference by mistake. Both are
-- still issued here and only here: whatever the browser sent is overwritten.

create or replace function public.stamp_live_consent()
returns trigger
language plpgsql
as $$
begin
  new.asset_ref := case when new.kind = 'likeness' then 'likeness:' else 'live:' end
    || gen_random_uuid();
  new.granted_at := now();
  new.withdrawn_at := null;
  if new.expires_at is null or new.expires_at <= now() or new.expires_at > now() + interval '2 hours' then
    new.expires_at := now() + interval '30 minutes';
  end if;
  return new;
end;
$$;

-- 3. One standing likeness grant per participant per jam ----------------------
-- Two effective grants would mean two references for one face, and withdrawing one would
-- leave the other standing -- a withdrawal that does not withdraw. A participant who wants a
-- different frame withdraws the grant they have and gives a new one, which is a deliberate
-- act with a fresh purpose and a fresh expiry, exactly as the register intends.

create unique index if not exists jam_live_consents_one_standing_likeness
  on public.jam_live_consents (jam_id, owner_id)
  where kind = 'likeness' and withdrawn_at is null;

-- The insert policy is unchanged and still says `owner_id = auth.uid()`, so a participant
-- cannot grant on another's behalf here either. Withdrawal stays `withdraw_live_consent`,
-- which can only stamp the caller's own row, and there is still no update or delete policy.
--
-- Nothing else is granted as a side effect of this migration. Recording a live track,
-- exporting it, or using anybody's face who is not in this room remain absent, not merely
-- switched off.
