-- Supabase installs pgcrypto functions in the `extensions` schema. The earlier
-- security-definer function deliberately has a public-only search path, so qualify it.
-- Apply after 20260919211000_live_session_reservation.sql.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.generate_invite_code()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTVWXYZ23456789';
  bytes bytea;
  code text;
  i int;
begin
  loop
    bytes := extensions.gen_random_bytes(8);
    code := '';
    for i in 0..7 loop
      code := code || substr(alphabet, 1 + (get_byte(bytes, i) % 31), 1);
    end loop;
    exit when not exists (select 1 from public.jams where jams.invite_code = code);
  end loop;
  return code;
end;
$$;

revoke all on function public.generate_invite_code() from public;
grant execute on function public.generate_invite_code() to authenticated;
