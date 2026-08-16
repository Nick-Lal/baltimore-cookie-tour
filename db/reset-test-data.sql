-- ===========================================================================
-- Reset the leaderboard to empty.
--
-- Run this in the Supabase SQL editor, not from the site. It cannot run from
-- the browser by design: rating_events has no DELETE grant for any role the
-- page can reach, which is what makes scores append-only. If this file could
-- be run from the client, that guarantee would not exist.
--
-- WHAT IT KEEPS
--   stop_items and rubric_weights. Those are reference data generated from
--   data/stops.json by tools/build-seed.mjs, not anybody's scores. Expect 42
--   items and 10 weight rows to survive.
--
-- WHAT IT DELETES
--   Every score, every taster, every party. All of it, for everyone. There is
--   no "just mine" version of this file, because on a two-person cookie tour
--   the only reason to run it is to clear the decks before you start.
--
-- ORDER MATTERS
--   rating_events.taster_id is ON DELETE RESTRICT, deliberately: without it a
--   person could delete their own append-only scores just by deleting their
--   taster row, and "append-only" would be a comment rather than a rule. So
--   scores go first, then the party tables, then tasters.
-- ===========================================================================

begin;

select 'before' as stage,
       (select count(*) from public.rating_events) as scores,
       (select count(*) from public.tasters)       as tasters,
       (select count(*) from public.parties)       as parties;

delete from public.rating_events;
delete from public.party_join_attempts;
delete from public.party_members;
delete from public.parties;
delete from public.tasters;

-- Anonymous sign-in mints a row in auth.users per taster, and deleting a
-- taster does not remove it: the cascade runs the other way. Left alone they
-- accumulate as empty accounts nobody can sign back into. Email-linked
-- accounts are spared, because those are real people who expect their scores
-- to survive on another device.
delete from auth.users
 where coalesce(is_anonymous, false) = true
   and (email is null or email = '');

select 'after' as stage,
       (select count(*) from public.rating_events) as scores,
       (select count(*) from public.tasters)       as tasters,
       (select count(*) from public.parties)       as parties,
       (select count(*) from public.stop_items)    as items_kept,
       (select count(*) from public.rubric_weights) as weights_kept;

commit;

-- After this runs, every browser still holds a signed JWT naming an auth user
-- that no longer exists. PostgREST validates the signature, not the account,
-- so those tokens keep working right up until something touches a foreign key
-- to auth.users — which is exactly what saving your name does. signIn() in
-- assets/js/lib/storage.js catches that specific failure and signs in again
-- under a fresh identity, so the visible effect is that people re-enter their
-- name once. Nothing breaks, but do not run this halfway through a tour:
-- scores already written are gone, not re-attributed.
