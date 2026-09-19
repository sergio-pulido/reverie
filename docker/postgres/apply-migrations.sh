#!/usr/bin/env bash
set -euo pipefail

export PGPASSWORD="$POSTGRES_PASSWORD"

# `storage.buckets` is waited on alongside the others because the bucket
# migrations guard on it and skip when it is missing. Storage is healthy before
# this container starts (docker/compose.yaml), so this only guards the gap
# between the service reporting healthy and its own migrations landing.
until psql -Atqc "select to_regclass('auth.users') is not null and to_regclass('realtime.messages') is not null and to_regclass('storage.buckets') is not null" | grep -qx t; do
  sleep 1
done

psql -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists reverie_local;
create table if not exists reverie_local.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
SQL

for migration in /migrations/*.sql; do
  version="$(basename "$migration" .sql)"
  if [[ "$(psql -Atqc "select count(*) from reverie_local.schema_migrations where version = '$version'")" == "0" ]]; then
    echo "Applying $version"
    psql -v ON_ERROR_STOP=1 --single-transaction --file "$migration"
    psql -v ON_ERROR_STOP=1 -c "insert into reverie_local.schema_migrations(version) values ('$version')"
  fi
done

# Grant only the operations for which the migrations define authenticated RLS policies.
# Anonymous sign-ins receive the authenticated role after Auth issues their JWT.
psql -v ON_ERROR_STOP=1 <<'SQL'
grant usage on schema public to authenticated;
-- `jams` select/update are granted per column by 20260919200000_jam_invite_lifecycle.sql so
-- the invite columns stay unreadable. A table-level grant here would silently re-expose them,
-- so only insert is granted at table level.
grant insert on public.jams to authenticated;
grant select on public.jam_members to authenticated;
grant select, insert, update, delete on public.jam_sessions to authenticated;
grant select, insert on public.jam_scripts, public.jam_script_revisions to authenticated;
grant select, insert on public.jam_messages, public.jam_proposals to authenticated;
grant select on public.jam_live_sessions to authenticated;
grant select, insert on public.jam_live_consents to authenticated;
SQL

# Storage creates its own schema on boot but grants nothing to the API roles, so
# `service_role` cannot even see storage.buckets -- an unqualified lookup reports
# "relation does not exist" rather than a permission error, which is a confusing
# way to find out. Only service_role is granted: the buckets are private, the
# server holds the only key, and no browser identity ever reads them directly.
psql -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema absent; skipping storage grants.';
    return;
  end if;
  grant usage on schema storage to service_role;
  grant all on all tables in schema storage to service_role;
  grant all on all sequences in schema storage to service_role;
  alter default privileges in schema storage grant all on tables to service_role;
  alter default privileges in schema storage grant all on sequences to service_role;
end
$$;
SQL

# PostgREST starts before application migrations so Auth and Realtime can become healthy.
# Tell the running process to refresh its schema cache after every migration pass.
psql -v ON_ERROR_STOP=1 -c "notify pgrst, 'reload schema'"
