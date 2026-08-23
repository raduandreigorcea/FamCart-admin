-- Optional development data for famcart-dev.
--
-- WHY THIS EXISTS
--
-- famcart-dev is nearly empty: a couple of profiles, a couple of households, one
-- list item, no purchase history and no audit events. That is fine for the app
-- and useless for this dashboard, where most panels, charts, sort controls and
-- pagers cannot be exercised at all against three rows. Running this fills it
-- with a plausible ninety days so every screen has something to show.
--
-- It does NOT change what the dashboard is. Every panel still runs the same
-- query against the same real database; this only puts rows in it. Nothing in
-- the app reads from here, and nothing here ships.
--
-- ─── THE GUARD ───────────────────────────────────────────────────────────────
--
-- This will REFUSE to run unless you opt in for the session first. Paste both
-- statements, in this order, into the SQL editor of the project you mean:
--
--   set app.seed_ok = 'famcart-dev';
--   -- then this whole file
--
-- The guard exists because production and development have identical schemas and
-- the SQL editor does not say loudly which project it is attached to. Running
-- this against `famcart` would invent eight households of people who do not
-- exist, inside real data, with no clean way to tell them apart afterwards.
--
-- ─── UNDOING IT ──────────────────────────────────────────────────────────────
--
-- Every row this creates is marked: profiles get a user_id starting `seed_`, and
-- households get names starting `Seed `. To remove all of it:
--
--   delete from public.households where name like 'Seed %';
--   delete from public.profiles where user_id like 'seed\_%';
--
-- Deleting a household cascades its members, list and history away with it, so
-- those two statements are the whole cleanup.

do $$
begin
  if current_setting('app.seed_ok', true) is distinct from 'famcart-dev' then
    raise exception
      'Refusing to seed. Run `set app.seed_ok = ''famcart-dev'';` first, and be sure this is not production.';
  end if;
end $$;

begin;

-- ─── people ──────────────────────────────────────────────────────────────────
-- Ten accounts. The user_id shape mirrors Clerk's so the dashboard's own
-- validation and truncation behave the way they will with real ids.
insert into public.profiles (user_id, display_name, updated_at)
select
  'seed_user_' || lpad(n::text, 3, '0'),
  name,
  now() - (random() * interval '80 days')
from (values
  (1,  'Ana Popescu'),
  (2,  'Mihai Ionescu'),
  (3,  'Elena Dumitru'),
  (4,  'Andrei Stan'),
  (5,  'Ioana Marin'),
  (6,  'Cristian Radu'),
  (7,  'Maria Nistor'),
  (8,  'Vlad Georgescu'),
  (9,  'Diana Preda'),
  (10, 'Sorin Barbu')
) as t(n, name)
on conflict (user_id) do nothing;

-- ─── households ──────────────────────────────────────────────────────────────
-- Five, of deliberately different sizes and activity levels, so the
-- distribution charts have a shape rather than a single bar. One is left empty
-- on purpose: a household nobody has shopped in is a real state and the
-- dashboard should be seen rendering it.
--
-- The invite code alphabet omits I, O, 0 and 1, matching
-- households_invite_code_format_check.
insert into public.households (id, name, invite_code, created_by, emoji, max_items_per_member, created_at)
select
  ('5eed0000-0000-4000-8000-00000000000' || n::text)::uuid,
  name,
  code,
  'seed_user_' || lpad(owner::text, 3, '0'),
  emoji,
  50,
  now() - (days || ' days')::interval
from (values
  (1, 'Seed Popescu',   'SEEDAAA2', 1, '🏠', 88),
  (2, 'Seed Ionescu',   'SEEDBBB3', 2, '🌻', 74),
  (3, 'Seed Dumitru',   'SEEDCCC4', 3, '🐝', 55),
  (4, 'Seed Stan',      'SEEDDDD5', 4, '⛰', 30),
  (5, 'Seed Marin',     'SEEDEEE6', 5, '🧺', 9)
) as t(n, name, code, owner, emoji, days)
on conflict (id) do nothing;

-- ─── rosters ─────────────────────────────────────────────────────────────────
-- Sizes 4, 3, 2, 2 and 1. The owner is always a moderator, matching what
-- create_household() does.
insert into public.household_members (household_id, user_id, role, joined_at)
select
  ('5eed0000-0000-4000-8000-00000000000' || hh::text)::uuid,
  'seed_user_' || lpad(member::text, 3, '0'),
  role,
  now() - (days || ' days')::interval
from (values
  (1, 1, 'moderator', 88), (1, 6, 'member', 70), (1, 7, 'member', 44), (1, 10, 'member', 12),
  (2, 2, 'moderator', 74), (2, 8, 'member', 60), (2, 9, 'member', 21),
  (3, 3, 'moderator', 55), (3, 10, 'member', 33),
  (4, 4, 'moderator', 30), (4, 9, 'member', 18),
  (5, 5, 'moderator', 9)
) as t(hh, member, role, days)
on conflict (household_id, user_id) do nothing;

-- ─── the active lists ────────────────────────────────────────────────────────
-- Unchecked items only. Checked ones are not seeded because buy_items() is what
-- moves rows off a list, and the history below is seeded directly instead.
--
-- The unique index is on (household_id, lower(name), lower(maker)) where not
-- checked, so no household gets the same product twice.
insert into public.shopping_list_items (household_id, name, maker, quantity, added_by, created_at)
select
  ('5eed0000-0000-4000-8000-00000000000' || hh::text)::uuid,
  name,
  maker,
  qty,
  'seed_user_' || lpad(who::text, 3, '0'),
  now() - (hours || ' hours')::interval
from (values
  (1, 'Lapte 1.5%',        'Zuzu',      2, 1,  4),
  (1, 'Paine integrala',   null,        1, 6,  9),
  (1, 'Oua marimea M',     null,       10, 7, 20),
  (1, 'Cafea macinata',    'Jacobs',    1, 1, 31),
  (1, 'Detergent vase',    'Fairy',     1, 10, 50),
  (2, 'Apa plata 2L',      'Dorna',     6, 2,  2),
  (2, 'Rosii cherry',      null,        1, 8, 26),
  (2, 'Iaurt grecesc',     'Olympus',   4, 9, 47),
  (3, 'Faina 1kg',         null,        2, 3, 15),
  (3, 'Ulei floarea soar', 'Untdelemn', 1, 10, 62),
  (4, 'Banane',            null,        1, 4,  6),
  (4, 'Hartie igienica',   'Zewa',      1, 9, 38)
) as t(hh, name, maker, qty, who, hours);

-- ─── history ─────────────────────────────────────────────────────────────────
-- Ninety days of shopping, so the 24h / 7d / 30d / 90d ranges all have
-- something to draw and the daily and weekly buckets differ.
--
-- Written directly rather than through buy_items() because that function reads
-- the caller's session to decide which households it may touch, and there is no
-- session here. purchase_history has no insert policy at all, which is exactly
-- why this has to be run as the owner and cannot be done from the app.
--
-- Each checkout gets its own checkout_id, and the buyer's name is frozen into
-- the row, which is what the real function does: history is an archive.
with checkouts as (
  select
    gen_random_uuid()                              as checkout_id,
    ('5eed0000-0000-4000-8000-00000000000'
      || (1 + (n % 4))::text)::uuid                as household_id,
    1 + (n % 10)                                   as buyer,
    now() - ((n * 0.72)::numeric || ' days')::interval as at,
    n
  from generate_series(1, 120) as n
),
basket as (
  select
    c.checkout_id,
    c.household_id,
    c.buyer,
    c.at,
    p.name,
    p.maker,
    1 + ((c.n + p.idx) % 3) as quantity
  from checkouts c
  cross join lateral (
    select * from (values
      (1, 'Lapte 1.5%',      'Zuzu'),
      (2, 'Paine integrala', null),
      (3, 'Oua marimea M',   null),
      (4, 'Apa plata 2L',    'Dorna'),
      (5, 'Cafea macinata',  'Jacobs'),
      (6, 'Banane',          null),
      (7, 'Iaurt grecesc',   'Olympus'),
      (8, 'Rosii cherry',    null),
      (9, 'Unt 200g',        'President'),
      (10, 'Orez basmati',   null)
    ) as v(idx, name, maker)
    -- Between two and five distinct products per shop, varying with the
    -- checkout, so the "items per checkout" numbers are not all identical.
    where v.idx <= 2 + (c.n % 4)
  ) p
)
insert into public.purchase_history (
  checkout_id, household_id, name, maker, quantity,
  added_by, added_by_name, purchased_by, purchased_at
)
select
  b.checkout_id,
  b.household_id,
  b.name,
  b.maker,
  b.quantity,
  'seed_user_' || lpad(b.buyer::text, 3, '0'),
  pr.display_name,
  'seed_user_' || lpad(b.buyer::text, 3, '0'),
  b.at
from basket b
join public.profiles pr on pr.user_id = 'seed_user_' || lpad(b.buyer::text, 3, '0');

-- ─── contributed products ────────────────────────────────────────────────────
-- The catalog's misses, which is what the Search Analytics page reads as
-- zero-result searches. One of them is contributed by three distinct households,
-- so the promotion band on that page has an example of a gap that has closed.
insert into public.product_catalog
  (name, maker, search_text, household_id, contributed_by, source, add_count, created_at)
select
  name,
  maker,
  public.product_search_text(name, maker),
  ('5eed0000-0000-4000-8000-00000000000' || hh::text)::uuid,
  'seed_user_' || lpad(who::text, 3, '0'),
  'community',
  adds,
  now() - (days || ' days')::interval
from (values
  ('Covrigi cu susan',   null,          1, 1, 4, 30),
  ('Covrigi cu susan',   null,          2, 2, 3, 24),
  ('Covrigi cu susan',   null,          3, 3, 2, 11),
  ('Zacusca de casa',    null,          1, 6, 5, 40),
  ('Zacusca de casa',    null,          2, 8, 1, 17),
  ('Telemea de oaie',    'Bradet',      1, 7, 2, 22),
  ('Must de struguri',   null,          4, 4, 1, 9),
  ('Cozonac cu nuca',    'Boromir',     3, 10, 3, 6)
) as t(name, maker, hh, who, adds, days)
on conflict on constraint product_catalog_name_maker_household_unique do nothing;

-- ─── audit events ────────────────────────────────────────────────────────────
-- A handful, of mixed severity, so the digest and the severity colouring on the
-- Health page have something to sort. Written directly for the same reason the
-- history is: log_security_event() stamps the caller, and there is no caller.
insert into public.security_events (kind, actor, household_id, detail, created_at)
select
  kind,
  case when who is null then null else 'seed_user_' || lpad(who::text, 3, '0') end,
  case when hh is null then null else ('5eed0000-0000-4000-8000-00000000000' || hh::text)::uuid end,
  detail::jsonb,
  now() - (hours || ' hours')::interval
from (values
  ('invite_code_failed',      6::int,    null::int, '{"attempts": 3}',            4),
  ('invite_code_failed',      6,         null,      '{"attempts": 4}',            4),
  ('invite_code_failed',      null,      null,      '{"attempts": 1}',           26),
  ('invite_join_succeeded',   10,        1,         '{"role": "member"}',       288),
  ('invite_join_succeeded',   9,         2,         '{"role": "member"}',       504),
  ('item_insert_rate_limited', 7,        1,         '{"limit": 120}',            51),
  ('profile_write_rate_limited', 8,      null,      '{"limit": 20}',             73),
  ('member_removed',          2,         2,         '{"target": "seed_user_009"}', 120),
  ('member_role_changed',     1,         1,         '{"to": "moderator"}',      160)
) as t(kind, who, hh, detail, hours);

commit;

-- What landed.
select
  (select count(*) from public.profiles where user_id like 'seed\_%')        as profiles,
  (select count(*) from public.households where name like 'Seed %')          as households,
  (select count(*) from public.shopping_list_items si
     join public.households h on h.id = si.household_id
     where h.name like 'Seed %')                                             as list_items,
  (select count(*) from public.purchase_history ph
     join public.households h on h.id = ph.household_id
     where h.name like 'Seed %')                                             as purchases;
