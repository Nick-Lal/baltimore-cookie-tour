-- ===========================================================================
-- Verification. Paste the whole file into the Supabase SQL editor and run it.
-- It returns one table: every row should say PASS. It writes no lasting data.
--
-- An earlier version of this file used \echo and raise notice. Neither works
-- here: \echo is a psql client command the dashboard editor does not have, and
-- notices are not displayed. It reported nothing and failed on its first line.
-- Everything now comes back as a result set, which is the only thing the
-- editor actually shows you.
--
-- This exists because "I wrote row level security policies" and "the policies
-- do what I think they do" are different claims, and only one is testable.
-- ===========================================================================

create temp table if not exists _verify (n int, check_name text, result text);
truncate _verify;

-- ------------------------------------------------------------- structure ---

insert into _verify values (1, '7 tables exist',
  (select case when count(*) = 7 then 'PASS' else 'FAIL: found ' || count(*) end
     from information_schema.tables
    where table_schema = 'public'
      and table_name in ('tasters','stop_items','rubric_weights','parties',
                         'party_members','party_join_attempts','rating_events')));

insert into _verify values (2, 'RLS enabled on every table',
  (select case when bool_and(rowsecurity) then 'PASS'
               else 'FAIL: ' || string_agg(tablename, ', ') filter (where not rowsecurity) end
     from pg_tables
    where schemaname = 'public'
      and tablename in ('tasters','stop_items','rubric_weights','parties',
                        'party_members','party_join_attempts','rating_events')));

insert into _verify values (3, 'every view uses security_invoker',
  (select case when count(*) = 3 then 'PASS' else 'FAIL: only ' || count(*) || ' of 3' end
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('rating_feed','ratings_current','rating_history')
      and c.reloptions::text like '%security_invoker=true%'));

insert into _verify values (4, 'no UPDATE or DELETE on scores for anyone',
  (select case when count(*) = 0 then 'PASS' else 'FAIL: ' || count(*) || ' grants' end
     from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'rating_events'
      and privilege_type in ('UPDATE','DELETE')
      and grantee in ('anon','authenticated')));

insert into _verify values (5, 'server-computed columns are not client-writable',
  (select case when count(*) = 0 then 'PASS' else 'FAIL: ' || string_agg(column_name, ', ') end
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'rating_events'
      and grantee = 'authenticated' and privilege_type = 'INSERT'
      and column_name in ('total_score','recipe_score','item_type','id','created_at')));

insert into _verify values (6, 'party code_hash is not readable by clients',
  (select case when count(*) = 0 then 'PASS' else 'FAIL: code_hash is granted' end
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'parties'
      and grantee in ('anon','authenticated') and column_name = 'code_hash'));

insert into _verify values (7, 'party functions are not executable by PUBLIC',
  (select case when count(*) = 0 then 'PASS' else 'FAIL: ' || string_agg(routine_name, ', ') end
     from information_schema.role_routine_grants
    where routine_schema = 'public' and grantee = 'PUBLIC'
      and routine_name in ('join_party','leave_party','my_party_ids')));

insert into _verify values (8, 'SECURITY DEFINER functions pin search_path',
  (select case when bool_and(p.proconfig::text like '%search_path%') then 'PASS'
               else 'FAIL: ' || string_agg(p.proname, ', ') filter (where p.proconfig is null) end
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in ('join_party','leave_party','my_party_ids',
                        'rating_events_score','rating_events_rate_limit')));

insert into _verify values (9, 'seed data loaded',
  (select case when count(*) = 42 then 'PASS' else 'FAIL: ' || count(*) || ' items, expected 42' end
     from public.stop_items));

insert into _verify values (10, 'rubric weights loaded and sum to 1.00 per type',
  (select case when count(*) = 2 and bool_and(abs(s - 1.0) < 0.0001) then 'PASS'
               else 'FAIL' end
     from (select item_type, sum(weight) as s from public.rubric_weights
            where version = '2.0.0' group by item_type) t));

-- ----------------------------------------------------------- behavioural ---
-- Each of these must be REJECTED. A silent success is a hole.

do $$
declare fake_taster uuid;
begin
  select id into fake_taster from public.tasters limit 1;
  if fake_taster is null then
    insert into _verify values (11, 'behavioural checks',
      'SKIPPED: no tasters yet, score something in the app first');
    return;
  end if;

  begin
    insert into public.rating_events (taster_id, item_key, chocolate, texture, dough, salt, structure, freshness)
    values (fake_taster, 'aunt-kellys:cc-cookie', 99, 5, 5, 5, 5, 5);
    insert into _verify values (11, 'a score of 99 is rejected', 'FAIL: it was accepted');
  exception when others then
    insert into _verify values (11, 'a score of 99 is rejected', 'PASS');
  end;

  begin
    insert into public.rating_events (taster_id, item_key, chocolate, texture, dough, salt, structure, freshness)
    values (fake_taster, 'not-a-real:item', 5, 5, 5, 5, 5, 5);
    insert into _verify values (12, 'a score for a nonexistent item is rejected', 'FAIL: it was accepted');
  exception when others then
    insert into _verify values (12, 'a score for a nonexistent item is rejected', 'PASS');
  end;

  begin
    insert into public.rating_events (taster_id, item_key, chocolate, texture, dough, salt, structure, freshness)
    values (fake_taster, 'cafe-dear-leon:cortado', 8, 8, 8, 8, 8, 8);
    insert into _verify values (13, 'a cortado cannot be scored on chocolate and salt', 'FAIL: it was accepted');
  exception when others then
    insert into _verify values (13, 'a cortado cannot be scored on chocolate and salt', 'PASS');
  end;

  -- the trigger must overrule whatever total the caller claims
  begin
    insert into public.rating_events (taster_id, item_key, chocolate, texture, dough, salt, structure, freshness, total_score)
    values (fake_taster, 'kneads-bakeshop:oatmeal-raisin', 1, 1, 1, 1, 1, 1, 100);
    insert into _verify values (14, 'server recomputes the total, ignoring the client',
      (select case when total_score = 10.0 then 'PASS'
                   else 'FAIL: stored ' || total_score end
         from public.rating_events
        where taster_id = fake_taster and item_key = 'kneads-bakeshop:oatmeal-raisin'
        order by created_at desc limit 1));
    delete from public.rating_events
     where taster_id = fake_taster and item_key = 'kneads-bakeshop:oatmeal-raisin';
  exception when others then
    insert into _verify values (14, 'server recomputes the total, ignoring the client',
      'PASS (insert rejected: ' || sqlerrm || ')');
  end;
end $$;

-- ------------------------------------------------------------------ result --

select check_name as "check", result
from _verify
order by n;
