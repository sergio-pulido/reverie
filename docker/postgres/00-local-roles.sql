\set pgpass `echo "$POSTGRES_PASSWORD"`

create role anon nologin noinherit;
create role dashboard_user nologin;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator noinherit login password :'pgpass';
grant anon, authenticated, service_role to authenticator;

create role supabase_auth_admin noinherit login password :'pgpass';
alter role supabase_admin with superuser createdb createrole replication bypassrls login password :'pgpass';
create schema _realtime authorization supabase_admin;
create schema if not exists realtime authorization supabase_admin;

grant create on database postgres to supabase_auth_admin;
grant create on database postgres to supabase_admin;
create schema auth authorization supabase_auth_admin;
grant usage, create on schema public to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';
alter role authenticator set statement_timeout = '8s';
