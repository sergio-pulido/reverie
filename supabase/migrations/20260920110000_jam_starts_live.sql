-- A jam is live the moment it exists.
--
-- `draft` was a state nothing ever left: no code path has ever written a
-- different value, so every room in the registry read DRAFT for its whole
-- life — including rooms with a generated script that were playing. The
-- room's real state is the lifecycle the server owns (live, playing,
-- stopped, `src/core/jamLifecycle.ts`), and the registry now reads that.
--
-- So the column stops asserting a state the product does not have: the
-- default becomes `live`, every existing `draft` row is moved to `live`, and
-- `draft` leaves the check constraint so it cannot come back. What remains
-- are the states something can actually put a room in.
alter table public.jams alter column status set default 'live';

update public.jams set status = 'live' where status = 'draft';

alter table public.jams drop constraint if exists jams_status_check;
alter table public.jams
  add constraint jams_status_check
  check (status in ('lobby', 'live', 'paused', 'completed', 'closed'));
