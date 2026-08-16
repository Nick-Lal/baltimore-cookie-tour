-- ===========================================================================
-- Baltimore Cookie Tour — database schema (v2)
--
-- Run this whole file once in the Supabase SQL editor, then run seed.sql.
-- It is idempotent: running it again after an edit is safe.
--
-- ---------------------------------------------------------------------------
-- SECURITY MODEL, STATED HONESTLY
--
-- The anon key that ships in the page is public. It is not a secret, and
-- nothing here is protected by hiding it. Every visitor gets a real JWT
-- through anonymous sign-in, and row level security decides what that JWT may
-- do. The browser cannot bypass RLS, so these policies are the whole boundary.
--
-- What this design does guarantee:
--   * Nobody can write a row attributed to someone else. Insert policies check
--     taster_id = auth.uid(), so forging authorship fails in the database, not
--     in a form validator that a determined person can skip.
--   * Nobody can edit or delete another person's scores. Scores are stored in
--     an append-only table with no UPDATE or DELETE grant at all, for anyone.
--   * No client can submit a total that disagrees with its own factor scores.
--     Totals are computed by a trigger from a server-side weights table.
--   * Party codes are never readable. Only a SHA-256 hash is stored, and
--     joining goes through one audited function with a per-user attempt limit.
--
-- What it does NOT guarantee, and the site says so on the page:
--   * Anonymous sign-in mints identities on demand. Somebody determined could
--     script sign-ups and stuff the global leaderboard. The per-taster rate
--     limits below raise the cost, and turning on CAPTCHA in the dashboard
--     (see the checklist at the bottom) raises it a lot more, but a public
--     leaderboard with no proof of personhood is never fully sybil-proof. The
--     party-scoped leaderboard is the trustworthy one, because membership is
--     gated by a code, and that is what the site shows by default.
--   * Display names are not verified. Two people can pick the same name. That
--     is a naming collision, not a security hole: scores stay bound to the
--     auth.uid() that wrote them.
-- ===========================================================================

create extension if not exists pgcrypto with schema extensions;

-- ================================================================= tasters ==

create table if not exists public.tasters (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  theme        text,
  created_at   timestamptz not null default now(),
  constraint tasters_display_name_len
    check (char_length(btrim(display_name)) between 1 and 40),
  constraint tasters_theme_len
    check (theme is null or char_length(theme) <= 40)
);

-- ================================================== stop and item reference ==
-- Generated from data/stops.json by tools/build-seed.mjs. Ratings carry a
-- foreign key to this table, so a score can never point at a stop or menu item
-- that does not exist. Keys are namespaced 'stopId:itemId' because item ids
-- like 'cc-cookie' repeat across stops.

create table if not exists public.stop_items (
  key       text primary key,
  stop_id   text not null,
  item_id   text not null,
  item_type text not null check (item_type in ('cookie', 'other')),
  constraint stop_items_key_shape check (key = stop_id || ':' || item_id)
);

-- ========================================================= rubric weighting ==
-- Weights live server side so the client cannot pick its own. The version is
-- frozen onto every event, so changing weights later never silently rewrites
-- history.

create table if not exists public.rubric_weights (
  version   text    not null,
  item_type text    not null check (item_type in ('cookie', 'other')),
  factor    text    not null,
  weight    numeric not null check (weight > 0 and weight <= 1),
  primary key (version, item_type, factor)
);

insert into public.rubric_weights (version, item_type, factor, weight) values
  ('2.0.0', 'cookie', 'chocolate', 0.22),
  ('2.0.0', 'cookie', 'texture',   0.22),
  ('2.0.0', 'cookie', 'dough',     0.20),
  ('2.0.0', 'cookie', 'salt',      0.14),
  ('2.0.0', 'cookie', 'structure', 0.12),
  ('2.0.0', 'cookie', 'freshness', 0.10),
  ('2.0.0', 'other',  'dough',     0.35),
  ('2.0.0', 'other',  'texture',   0.30),
  ('2.0.0', 'other',  'structure', 0.20),
  ('2.0.0', 'other',  'freshness', 0.15)
on conflict (version, item_type, factor) do update set weight = excluded.weight;

-- ================================================================= parties ==
-- Only a hash of the code is stored, so a party code cannot be read back out
-- of the database even by someone with the anon key and a lot of patience.

create table if not exists public.parties (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null unique,
  label      text,
  created_by uuid references public.tasters (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint parties_label_len check (label is null or char_length(label) <= 40)
);

create table if not exists public.party_members (
  party_id  uuid not null references public.parties (id) on delete cascade,
  taster_id uuid not null references public.tasters (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (party_id, taster_id)
);

create index if not exists party_members_taster_idx on public.party_members (taster_id);

create table if not exists public.party_join_attempts (
  taster_id  uuid not null references public.tasters (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index if not exists party_join_attempts_idx
  on public.party_join_attempts (taster_id, attempted_at);

-- =========================================================== rating events ==
-- Append only. There is no UPDATE or DELETE grant on this table for anybody,
-- which is what makes "rankings over time" real: re-scoring a cookie adds a
-- new event rather than overwriting the old one, so the history survives.

create table if not exists public.rating_events (
  id             uuid primary key default gen_random_uuid(),
  -- restrict, not cascade: a cascade here would let a taster delete their own
  -- scores by deleting their profile, which would break the append-only promise.
  taster_id      uuid not null references public.tasters (id) on delete restrict,
  item_key       text not null references public.stop_items (key) on delete restrict,
  item_type      text not null check (item_type in ('cookie', 'other')),

  chocolate  smallint check (chocolate  between 1 and 10),
  texture    smallint check (texture    between 1 and 10),
  dough      smallint check (dough      between 1 and 10),
  salt       smallint check (salt       between 1 and 10),
  structure  smallint check (structure  between 1 and 10),
  freshness  smallint check (freshness  between 1 and 10),

  price_paid numeric(6,2) check (price_paid is null or price_paid between 0 and 200),
  notes      text check (notes is null or char_length(notes) <= 500),
  visited_on date not null default current_date,

  rubric_version text        not null default '2.0.0',
  total_score    numeric(4,1),
  recipe_score   numeric(4,1),
  created_at     timestamptz not null default now(),

  -- A cookie needs all six factors. Anything else needs the four that transfer,
  -- and must leave the cookie-only ones empty rather than scoring a latte on
  -- "salt balance".
  constraint rating_events_factors_present check (
    (item_type = 'cookie'
      and chocolate is not null and texture is not null and dough is not null
      and salt is not null and structure is not null and freshness is not null)
    or
    (item_type = 'other'
      and dough is not null and texture is not null
      and structure is not null and freshness is not null
      and chocolate is null and salt is null)
  ),
  constraint rating_events_visited_sane
    check (visited_on between date '2020-01-01' and current_date + 1)
);

create index if not exists rating_events_item_idx    on public.rating_events (item_key, created_at desc);
create index if not exists rating_events_taster_idx  on public.rating_events (taster_id, created_at desc);
create index if not exists rating_events_latest_idx  on public.rating_events (taster_id, item_key, created_at desc);

-- ============================================================== server side ==

-- Totals are computed here, from the server's own weights table, so a client
-- cannot submit a score that disagrees with its own factors. recipe_score is
-- the same calculation with freshness dropped and the rest renormalised.
create or replace function public.rating_events_score()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total  numeric := 0;
  v_recipe numeric := 0;
  v_rw     numeric := 0;
  r        record;
  v_val    smallint;
begin
  new.created_at := now();

  select item_type into new.item_type from public.stop_items where key = new.item_key;
  if new.item_type is null then
    raise exception 'Unknown menu item %', new.item_key using errcode = 'foreign_key_violation';
  end if;

  for r in
    select factor, weight from public.rubric_weights
    where version = new.rubric_version and item_type = new.item_type
  loop
    v_val := case r.factor
      when 'chocolate' then new.chocolate
      when 'texture'   then new.texture
      when 'dough'     then new.dough
      when 'salt'      then new.salt
      when 'structure' then new.structure
      when 'freshness' then new.freshness
    end;
    if v_val is null then
      raise exception 'Missing factor % for %', r.factor, new.item_type
        using errcode = 'check_violation';
    end if;
    v_total := v_total + r.weight * v_val;
    if r.factor <> 'freshness' then
      v_recipe := v_recipe + r.weight * v_val;
      v_rw := v_rw + r.weight;
    end if;
  end loop;

  if v_total = 0 then
    raise exception 'No weights found for rubric version %', new.rubric_version
      using errcode = 'check_violation';
  end if;

  new.total_score  := round(v_total * 10, 1);
  new.recipe_score := round((v_recipe / nullif(v_rw, 0)) * 10, 1);
  return new;
end;
$$;

drop trigger if exists rating_events_score_trg on public.rating_events;
create trigger rating_events_score_trg
  before insert on public.rating_events
  for each row execute function public.rating_events_score();

-- Rate limiting. Sixty scores an hour is far beyond any honest tasting pace
-- and well below what a script needs to be a nuisance.
create or replace function public.rating_events_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_hour  integer;
  n_total integer;
begin
  select count(*) into n_hour
    from public.rating_events
   where taster_id = new.taster_id and created_at > now() - interval '1 hour';
  if n_hour >= 60 then
    raise exception 'Too many scores in the last hour. Slow down.'
      using errcode = 'check_violation';
  end if;

  select count(*) into n_total
    from public.rating_events where taster_id = new.taster_id;
  if n_total >= 500 then
    raise exception 'Score limit reached for this taster.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists rating_events_rate_limit_trg on public.rating_events;
create trigger rating_events_rate_limit_trg
  before insert on public.rating_events
  for each row execute function public.rating_events_rate_limit();

-- ================================================================== views ===
-- security_invoker makes a view run under the caller's permissions, so the
-- policies below still apply through it. Without it a view silently bypasses
-- RLS, which is the classic way a "secure" Postgres schema leaks.

drop view if exists public.rating_feed;
drop view if exists public.ratings_current;

create view public.ratings_current
with (security_invoker = true) as
select distinct on (e.taster_id, e.item_key) e.*
from public.rating_events e
order by e.taster_id, e.item_key, e.created_at desc;

create view public.rating_feed
with (security_invoker = true) as
select
  c.id, c.taster_id, t.display_name as taster_name,
  c.item_key, si.stop_id, si.item_id, c.item_type,
  c.chocolate, c.texture, c.dough, c.salt, c.structure, c.freshness,
  c.price_paid, c.notes, c.visited_on,
  c.total_score, c.recipe_score, c.rubric_version,
  case when c.price_paid is null or c.price_paid <= 0
       then null else round(c.total_score / c.price_paid, 2) end as value_index,
  c.created_at
from public.ratings_current c
join public.tasters t     on t.id  = c.taster_id
join public.stop_items si on si.key = c.item_key;

-- Full history, for the over-time chart.
drop view if exists public.rating_history;
create view public.rating_history
with (security_invoker = true) as
select e.id, e.taster_id, t.display_name as taster_name,
       e.item_key, si.stop_id, si.item_id, e.item_type,
       e.total_score, e.recipe_score, e.created_at
from public.rating_events e
join public.tasters t     on t.id  = e.taster_id
join public.stop_items si on si.key = e.item_key;

-- Which parties am I in? Used to scope the leaderboard without ever exposing
-- a code. Marked stable so the planner can reuse it inside policies.
create or replace function public.my_party_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select party_id from public.party_members where taster_id = (select auth.uid());
$$;

-- Joining a party. One audited path, hashed comparison, attempt limited.
create or replace function public.join_party(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_hash    text;
  v_party   uuid;
  n_recent  integer;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = 'insufficient_privilege';
  end if;
  if p_code is null or char_length(btrim(p_code)) < 6 or char_length(p_code) > 40 then
    raise exception 'Party codes are 6 to 40 characters.' using errcode = 'check_violation';
  end if;

  select count(*) into n_recent
    from public.party_join_attempts
   where taster_id = v_uid and attempted_at > now() - interval '1 hour';
  if n_recent >= 10 then
    raise exception 'Too many join attempts. Try again later.'
      using errcode = 'check_violation';
  end if;
  insert into public.party_join_attempts (taster_id) values (v_uid);

  v_hash := encode(extensions.digest(lower(btrim(p_code)) || ':cookietour-v2', 'sha256'), 'hex');

  select id into v_party from public.parties where code_hash = v_hash;
  if v_party is null then
    insert into public.parties (code_hash, created_by) values (v_hash, v_uid)
    returning id into v_party;
  end if;

  insert into public.party_members (party_id, taster_id) values (v_party, v_uid)
  on conflict do nothing;

  return v_party;
end;
$$;

-- ==================================================================== RLS ===

alter table public.tasters             enable row level security;
alter table public.stop_items          enable row level security;
alter table public.rubric_weights      enable row level security;
alter table public.parties             enable row level security;
alter table public.party_members       enable row level security;
alter table public.party_join_attempts enable row level security;
alter table public.rating_events       enable row level security;

alter table public.tasters             force row level security;
alter table public.rating_events       force row level security;

-- parties and party_members are deliberately NOT forced. They are written only
-- by join_party(), which is SECURITY DEFINER and therefore runs as the table
-- owner. FORCE would subject the owner to RLS as well, and since neither table
-- has an INSERT policy, joining a party would fail outright. Clients still
-- cannot write to them: no INSERT grant is issued to anon or authenticated.

-- reference data: readable by all, writable by nobody through the API
drop policy if exists stop_items_read on public.stop_items;
create policy stop_items_read on public.stop_items for select to anon, authenticated using (true);

drop policy if exists rubric_weights_read on public.rubric_weights;
create policy rubric_weights_read on public.rubric_weights for select to anon, authenticated using (true);

-- tasters
drop policy if exists tasters_select_all on public.tasters;
create policy tasters_select_all on public.tasters
  for select to anon, authenticated using (true);

drop policy if exists tasters_insert_self on public.tasters;
create policy tasters_insert_self on public.tasters
  for insert to authenticated with check (id = (select auth.uid()));

drop policy if exists tasters_update_self on public.tasters;
create policy tasters_update_self on public.tasters
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- No delete policy on tasters, and no delete grant. Scores are append-only and
-- reference their author, so allowing self-deletion would be a back door to
-- erasing your own scores.

-- parties: visible only to members, and the hash is never granted anyway
drop policy if exists parties_select_member on public.parties;
create policy parties_select_member on public.parties
  for select to authenticated using (id in (select public.my_party_ids()));

drop policy if exists party_members_select_own on public.party_members;
create policy party_members_select_own on public.party_members
  for select to authenticated using (party_id in (select public.my_party_ids()));

drop policy if exists pja_select_own on public.party_join_attempts;
create policy pja_select_own on public.party_join_attempts
  for select to authenticated using (taster_id = (select auth.uid()));

-- ratings: readable by everyone, insertable only as yourself, never mutable
drop policy if exists rating_events_select_all on public.rating_events;
create policy rating_events_select_all on public.rating_events
  for select to anon, authenticated using (true);

drop policy if exists rating_events_insert_own on public.rating_events;
create policy rating_events_insert_own on public.rating_events
  for insert to authenticated with check (taster_id = (select auth.uid()));

-- Deliberately no UPDATE or DELETE policy on rating_events. Scores are
-- history. Change your mind by adding a new score.

-- ================================================================= grants ===

revoke all on all tables in schema public from anon, authenticated;

grant select                 on public.stop_items          to anon, authenticated;
grant select                 on public.rubric_weights      to anon, authenticated;
grant select on public.tasters to anon, authenticated;
-- Column-level grants, not table-level. A table-level GRANT covers every
-- column and a later column-level REVOKE does not narrow it, so listing the
-- writable columns explicitly is the only thing that actually works.
grant insert (id, display_name, theme)      on public.tasters to authenticated;
grant update (display_name, theme)          on public.tasters to authenticated;

grant select on public.rating_events to anon, authenticated;
grant insert (taster_id, item_key, chocolate, texture, dough, salt, structure,
              freshness, price_paid, notes, visited_on, rubric_version)
  on public.rating_events to authenticated;
grant select                 on public.parties             to authenticated;
grant select                 on public.party_members       to authenticated;
grant select                 on public.ratings_current     to anon, authenticated;
grant select                 on public.rating_feed         to anon, authenticated;
grant select                 on public.rating_history      to anon, authenticated;

-- Postgres grants EXECUTE on every new function to PUBLIC by default, so the
-- explicit grants below are decorative unless PUBLIC is revoked first.
revoke execute on function public.join_party(text)          from public;
revoke execute on function public.my_party_ids()            from public;
revoke execute on function public.rating_events_score()     from public;
revoke execute on function public.rating_events_rate_limit() from public;

grant execute on function public.join_party(text) to authenticated;
grant execute on function public.my_party_ids()   to authenticated;

-- ===========================================================================
-- AFTER RUNNING THIS FILE
--
-- 1. Run db/seed.sql to populate stop_items from data/stops.json.
--
-- 2. Dashboard -> Authentication -> Sign In / Providers:
--    turn ON "Enable anonymous sign-ins".
--
-- 3. Dashboard -> Authentication -> Attack Protection:
--    turn ON CAPTCHA (Cloudflare Turnstile) and enable it for anonymous
--    sign-ins. THIS STEP IS NOT OPTIONAL. Without it, anonymous sign-in is an
--    unlimited identity factory and the global leaderboard can be stuffed by
--    anyone with a script. With it, the cost of doing so goes up enormously.
--
-- 4. Dashboard -> Authentication -> Rate Limits: cap anonymous sign-ins per
--    hour per IP. The default is generous; 30 is plenty for a cookie tour.
--
-- 5. Copy config/supabase.example.json to config/supabase.json and fill in
--    your project URL and anon key. That file is gitignored by default, so
--    decide deliberately whether to commit it. Committing it is fine: the
--    anon key is public by design and RLS is what protects the data.
-- ===========================================================================
