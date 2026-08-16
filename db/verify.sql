-- ===========================================================================
-- Verification. Run this in the Supabase SQL editor after schema.sql and
-- seed.sql. Every check should print PASS. Nothing here writes data.
--
-- This exists because "I wrote row level security policies" and "the policies
-- do what I think" are different claims, and only one of them is testable.
-- ===========================================================================

\echo '--- structural checks ---'

select case when count(*) = 7 then 'PASS' else 'FAIL: ' || count(*) end
         as "7 tables exist"
from information_schema.tables
where table_schema = 'public'
  and table_name in ('tasters','stop_items','rubric_weights','parties',
                     'party_members','party_join_attempts','rating_events');

select case when bool_and(rowsecurity) then 'PASS' else 'FAIL' end
         as "RLS enabled on every table"
from pg_tables
where schemaname = 'public'
  and tablename in ('tasters','stop_items','rubric_weights','parties',
                    'party_members','party_join_attempts','rating_events');

select case when count(*) = 0 then 'PASS' else 'FAIL: ' || string_agg(viewname, ', ') end
         as "every view uses security_invoker"
from pg_views v
where v.schemaname = 'public'
  and v.viewname in ('rating_feed','ratings_current','rating_history')
  and not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = v.viewname
      and c.reloptions::text like '%security_invoker=true%'
  );

select case when count(*) = 0 then 'PASS' else 'FAIL: ' || count(*) || ' rows' end
         as "nobody can update or delete a score"
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'rating_events'
  and privilege_type in ('UPDATE','DELETE')
  and grantee in ('anon','authenticated');

select case when count(*) = 0 then 'PASS' else 'FAIL: ' || count(*) end
         as "join_party is not executable by PUBLIC"
from information_schema.role_routine_grants
where routine_schema = 'public' and routine_name = 'join_party' and grantee = 'PUBLIC';

select case when count(*) = 42 then 'PASS' else 'FAIL: ' || count(*) || ' items, expected 42' end
         as "seed data loaded"
from public.stop_items;

select case when count(*) = 10 then 'PASS' else 'FAIL: ' || count(*) end
         as "rubric weights loaded"
from public.rubric_weights where version = '2.0.0';

\echo '--- behavioural checks (these should all be rejected) ---'

-- A score with a factor out of range must fail the CHECK constraint.
do $$
begin
  begin
    insert into public.rating_events (taster_id, item_key, chocolate, texture, dough,
                                      salt, structure, freshness)
    values (gen_random_uuid(), 'aunt-kellys:cc-cookie', 99, 5, 5, 5, 5, 5);
    raise notice 'FAIL: an out-of-range score was accepted';
  exception when others then
    raise notice 'PASS: out-of-range score rejected (%)', sqlerrm;
  end;
end $$;

-- A score pointing at a menu item that does not exist must fail the foreign key.
do $$
begin
  begin
    insert into public.rating_events (taster_id, item_key, chocolate, texture, dough,
                                      salt, structure, freshness)
    values (gen_random_uuid(), 'not-a-real:item', 5, 5, 5, 5, 5, 5);
    raise notice 'FAIL: a score for a nonexistent item was accepted';
  exception when others then
    raise notice 'PASS: unknown menu item rejected (%)', sqlerrm;
  end;
end $$;

-- A non-cookie item must not carry the cookie-only factors.
do $$
begin
  begin
    insert into public.rating_events (taster_id, item_key, chocolate, texture, dough,
                                      salt, structure, freshness)
    values (gen_random_uuid(), 'cafe-dear-leon:cortado', 8, 8, 8, 8, 8, 8);
    raise notice 'FAIL: a cortado was scored on chocolate and salt';
  exception when others then
    raise notice 'PASS: cookie-only factors rejected on a non-cookie (%)', sqlerrm;
  end;
end $$;

\echo '--- done. Every line above should say PASS. ---'
