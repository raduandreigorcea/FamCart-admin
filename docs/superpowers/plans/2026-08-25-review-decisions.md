# Review Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin approve or reject catalog-importer review candidates from the admin dashboard, with the verdict stored in the catalog project and honoured by the next `score` run.

**Architecture:** A new `005_review.sql` in the catalog project adds an admin list, a decisions table keyed on barcode, a `signals` column on the outcomes table, and five guarded `security definer` RPCs. The importer stops reading verdicts from `data/decisions.jsonl` and fetches them from that table instead, demoting the file to a one-way mirror that keeps offline scoring possible. The dashboard gains a `/review` route driven by two list RPCs.

**Tech Stack:** Postgres 15 + pgTAP (catalog project), Node 22 + tsx + Vitest (catalog-importer), Vue 3 + vue-router + Vitest + happy-dom (admin).

**Spec:** `admin/docs/superpowers/specs/2026-08-25-review-decisions-design.md`

## Global Constraints

- **Two repos.** Tasks 1-4 land in the `catalog-importer` submodule (`D:\famcart\catalog-importer`). Tasks 5-7 land in the `admin` submodule (`D:\famcart\admin`). Commit in the submodule you changed.
- **No service-role key in the admin bundle, ever.** The dashboard holds only `VITE_CATALOG_SUPABASE_ANON_KEY`. Every cross-cutting read or write is an RPC.
- **New migration file, never an edit to 001-004.** Those are restatements already recorded as applied; a change inside one is invisible to `db push`.
- **Constraints restated below the table**, never left inside `create table if not exists` — that block is skipped when the table already exists and the constraint would reach new databases only.
- **`extensions.gin_trgm_ops`, schema-qualified.** `001_foundation.sql` installs `pg_trgm` `with schema extensions`.
- **Always reset before testing:** `npx supabase db reset --workdir supabase-catalog` then `npx supabase test db --workdir supabase-catalog`. `db start` restores a backup and skips migrations.
- **Error code for "not an admin" is `42501`**, matching `admin_guard()` in the app database, because `describeError()` already renders that through its `forbidden` branch.
- **No em dashes in any comment, copy, or commit message.**
- **Commit messages: no Claude attribution, no Co-Authored-By.**

---

### Task 1: The schema and its guard

**Files:**
- Create: `supabase-catalog/supabase/migrations/005_review.sql`
- Modify: `supabase-catalog/supabase/tests/catalog.test.sql` (plan count, new tests at end)

**Interfaces:**
- Consumes: `public.requesting_user_id()` from `001_foundation.sql`; `public.catalog_import_outcomes` from `004_import_runs.sql`.
- Produces: tables `public.catalog_admins`, `public.catalog_review_decisions`; column `catalog_import_outcomes.signals jsonb`; functions `public.catalog_is_admin() returns boolean`, `public.catalog_admin_guard() returns void`, `public.record_review_decision(text, text, text) returns void`, `public.clear_review_decision(text) returns void`, `public.list_review_candidates(uuid, text, text, integer, integer) returns table(...)`, `public.list_review_decisions(text, text, integer, integer) returns table(...)`, `public.approve_review_above(integer, uuid, text, text) returns integer`.

- [ ] **Step 1: Write the migration**

Create `supabase-catalog/supabase/migrations/005_review.sql`:

```sql
-- Recording a verdict on the review band, from something other than a text editor.
--
-- The importer's gate is hybrid: the clearly-good load themselves, the clearly-bad
-- are dropped with a reason, and the ambiguous middle waits for a human. Last run
-- that middle was 12,255 records, and the only way to rule on one was appending a
-- line of JSON to catalog-importer/data/decisions.jsonl by hand.
--
-- The candidates are already here: score publishes every record it did not write
-- to catalog_import_outcomes, stage='review' among them, derived from
-- scored.jsonl rather than the 500-row terminal sample. What was missing is a
-- place to put the answer, and something to stop anyone with the app on their
-- phone from putting it there.
--
-- A NEW FILE rather than an edit to 003 or 004: those are restatements of the
-- schema as it is and are already recorded as applied, so a change inside one is
-- invisible to `supabase db push`.

-- ─── who may decide ──────────────────────────────────────────────────────────
--
-- This project has never had a notion of an admin. admin_users and admin_guard()
-- live in the APP databases; here every signed-in FamCart account is simply
-- `authenticated`, which is why product_catalog is readable by anyone holding the
-- app. That is right for reads of public Open Food Facts data and wrong for a
-- write that decides what the whole catalog contains.
--
-- So: a second list, in this project, kept in step with admin_users by hand. The
-- alternative is a Clerk JWT claim readable by both projects with no second list,
-- which is cleaner and is deliberately deferred -- it would become a fourth thing
-- configured in a dashboard and nowhere in this repo, and forgetting it for a new
-- admin fails silently with no code to grep. Revisit when there is more than one
-- admin.
create table if not exists public.catalog_admins (
  user_id    text        primary key,
  note       text,
  granted_at timestamptz not null default now()
);

comment on table public.catalog_admins is
  'Clerk user ids allowed to record review verdicts here. Seeded by '
  'catalog-importer with its service-role key: npm run admins:add <user-id>.';

-- Unreachable from a client role, and not merely unwritable. Who may approve is
-- not something an ordinary signed-in account should be able to enumerate, so
-- there is no read policy either -- catalog_is_admin() reaches it as SECURITY
-- DEFINER and is the only path in.
alter table public.catalog_admins enable row level security;
revoke all on public.catalog_admins from anon, authenticated;
grant select, insert, delete on public.catalog_admins to service_role;

-- ─── the gate ────────────────────────────────────────────────────────────────

create or replace function public.catalog_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.catalog_admins
    where user_id = public.requesting_user_id()
  );
$$;

-- Granted to authenticated so the dashboard can ask before it renders. The gate
-- that matters is the guard below, called inside every write; this one only
-- decides whether a screen is worth drawing.
revoke all on function public.catalog_is_admin() from public, anon;
grant execute on function public.catalog_is_admin() to authenticated;

create or replace function public.catalog_admin_guard()
returns void
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.catalog_is_admin() then
    -- 42501 deliberately, matching admin_guard() in the app database: the
    -- dashboard's describeError() already renders that code through its
    -- forbidden branch, so one code means one sentence everywhere.
    raise exception 'admin only' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.catalog_admin_guard() from public, anon, authenticated;

-- ─── the verdicts ────────────────────────────────────────────────────────────
--
-- Keyed on barcode ALONE, exactly as data/decisions.jsonl was, and for the reason
-- its own comment gives: the normalizer changes -- a better casing rule, a new
-- brand alias -- and every name changes with it. A verdict keyed on a name would
-- silently evaporate on the next run and the reviewer would be asked the same
-- question again. The barcode is the only thing about a product that does not
-- move.
--
-- Upsert rather than append, so changing your mind rewrites the row. That loses
-- the history the JSONL file got for free from git, which is an accepted trade
-- while there is one reviewer. If it stops being one, this becomes an
-- append-only table plus a latest-wins view and only the RPCs below change.
create table if not exists public.catalog_review_decisions (
  barcode    text        primary key,
  verdict    text        not null,
  -- Null for verdicts imported from the file, which never recorded who.
  decided_by text,
  decided_at timestamptz not null default now(),
  note       text
);

alter table public.catalog_review_decisions
  drop constraint if exists catalog_review_decisions_verdict_check;
alter table public.catalog_review_decisions
  add constraint catalog_review_decisions_verdict_check
  check (verdict in ('approve', 'reject'));

comment on table public.catalog_review_decisions is
  'One row per product a human has ruled on. Read by catalog-importer at the '
  'start of every score run, before the gate.';

alter table public.catalog_review_decisions enable row level security;
revoke all on public.catalog_review_decisions from anon, authenticated;
grant select, insert, update, delete on public.catalog_review_decisions to service_role;

-- ─── the signals a verdict turns on ──────────────────────────────────────────
--
-- Without this the screen is WORSE than the terminal it replaces.
-- writeReviewQueue() puts lang, scans and markets in front of the reviewer, and
-- those are what the judgement actually rests on: a Polish name, never scanned,
-- sold only in France is a different question from a Romanian name scanned four
-- hundred times. None of the three survive into this table today.
--
-- jsonb rather than three columns, on the same reasoning reason_tallies is
-- jsonb: the vocabulary belongs to the gate, which should stay free to change it
-- without a migration.
--
-- Rows written before this column existed keep '{}' and there is no backfill:
-- the values come from that run's scored.jsonl, which retention has aged out.
-- The screen renders an absent signal as a dash rather than a zero, which is the
-- difference between "never scanned" and "we did not record it".
alter table public.catalog_import_outcomes
  add column if not exists signals jsonb not null default '{}'::jsonb;

-- ─── reading the band ────────────────────────────────────────────────────────
--
-- Server-side rather than a PostgREST select like the outcomes browser uses, for
-- two reasons that are not style:
--
--   * Pending is an ANTI-JOIN. Subtracting decided barcodes in the browser makes
--     the total count wrong and therefore every page after the first.
--   * The same barcode recurs across runs. Without distinct on (barcode) you are
--     asked about the same product every month, which is the exact failure the
--     barcode keying exists to prevent.
--
-- Ordered highest score first: the interesting question is what we nearly kept.
-- id breaks ties so paging is stable -- without it two rows of equal score can
-- swap between pages and one is never seen.
create or replace function public.list_review_candidates(
  p_run    uuid    default null,
  p_reason text    default null,
  p_query  text    default null,
  p_limit  integer default 25,
  p_offset integer default 0
)
returns table (
  barcode     text,
  name        text,
  maker       text,
  score       integer,
  reason      text,
  flags       text[],
  signals     jsonb,
  run_id      uuid,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.catalog_admin_guard();

  return query
  with newest as (
    select distinct on (o.barcode)
      o.barcode, o.name, o.maker, o.score, o.reason, o.flags, o.signals,
      o.run_id, o.id
    from public.catalog_import_outcomes o
    join public.catalog_import_runs r on r.id = o.run_id
    where o.stage = 'review'
      and (p_run is null or o.run_id = p_run)
      and (p_reason is null or o.reason = p_reason)
      and (p_query is null or o.name ilike '%' || p_query || '%')
    -- Newest run wins for a barcode seen in several. nulls last so a run with no
    -- scored_at never outranks one that has it.
    order by o.barcode, r.scored_at desc nulls last, o.id desc
  ),
  pending as (
    select n.*
    from newest n
    where not exists (
      select 1 from public.catalog_review_decisions d where d.barcode = n.barcode
    )
  )
  select
    p.barcode, p.name, p.maker, p.score, p.reason, p.flags, p.signals, p.run_id,
    count(*) over () as total_count
  from pending p
  order by p.score desc nulls last, p.id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
end;
$$;

revoke all on function public.list_review_candidates(uuid, text, text, integer, integer)
  from public, anon;
grant execute on function public.list_review_candidates(uuid, text, text, integer, integer)
  to authenticated;

-- The Decided tab. Joined back to the most recent outcome row per barcode so a
-- decided product still shows its name and score rather than a bare number.
-- Left join, because a decision can outlive the outcome rows that prompted it:
-- retention keeps five runs per source and a verdict is kept forever.
create or replace function public.list_review_decisions(
  p_verdict text    default null,
  p_query   text    default null,
  p_limit   integer default 25,
  p_offset  integer default 0
)
returns table (
  barcode     text,
  verdict     text,
  decided_by  text,
  decided_at  timestamptz,
  note        text,
  name        text,
  maker       text,
  score       integer,
  reason      text,
  flags       text[],
  signals     jsonb,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.catalog_admin_guard();

  return query
  with newest as (
    select distinct on (o.barcode)
      o.barcode, o.name, o.maker, o.score, o.reason, o.flags, o.signals, o.id
    from public.catalog_import_outcomes o
    join public.catalog_import_runs r on r.id = o.run_id
    where o.stage = 'review'
    order by o.barcode, r.scored_at desc nulls last, o.id desc
  ),
  decided as (
    select
      d.barcode, d.verdict, d.decided_by, d.decided_at, d.note,
      n.name, n.maker, n.score, n.reason, n.flags,
      coalesce(n.signals, '{}'::jsonb) as signals
    from public.catalog_review_decisions d
    left join newest n on n.barcode = d.barcode
    where (p_verdict is null or d.verdict = p_verdict)
      and (p_query is null or coalesce(n.name, d.barcode) ilike '%' || p_query || '%')
  )
  select
    x.barcode, x.verdict, x.decided_by, x.decided_at, x.note,
    x.name, x.maker, x.score, x.reason, x.flags, x.signals,
    count(*) over () as total_count
  from decided x
  order by x.decided_at desc, x.barcode asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
end;
$$;

revoke all on function public.list_review_decisions(text, text, integer, integer)
  from public, anon;
grant execute on function public.list_review_decisions(text, text, integer, integer)
  to authenticated;

-- ─── recording one ───────────────────────────────────────────────────────────

create or replace function public.record_review_decision(
  p_barcode text,
  p_verdict text,
  p_note    text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
begin
  perform public.catalog_admin_guard();

  if p_verdict not in ('approve', 'reject') then
    raise exception 'verdict must be approve or reject' using errcode = '22023';
  end if;

  if coalesce(trim(p_barcode), '') = '' then
    raise exception 'barcode is required' using errcode = '22023';
  end if;

  insert into public.catalog_review_decisions (barcode, verdict, decided_by, note)
  values (trim(p_barcode), p_verdict, public.requesting_user_id(), p_note)
  on conflict (barcode) do update
    set verdict    = excluded.verdict,
        decided_by = excluded.decided_by,
        decided_at = now(),
        note       = excluded.note;
end;
$$;

revoke all on function public.record_review_decision(text, text, text) from public, anon;
grant execute on function public.record_review_decision(text, text, text) to authenticated;

-- Undo. Returning the product to the pending band is what makes the screen's
-- lack of a per-decision confirmation dialog defensible: unlike a deletion, a
-- verdict costs one click to take back.
create or replace function public.clear_review_decision(p_barcode text)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
begin
  perform public.catalog_admin_guard();
  delete from public.catalog_review_decisions where barcode = trim(p_barcode);
end;
$$;

revoke all on function public.clear_review_decision(text) from public, anon;
grant execute on function public.clear_review_decision(text) to authenticated;

-- ─── clearing the band in bulk ───────────────────────────────────────────────
--
-- Not optional. The review band was 12,255 records and a screen that can only
-- clear it one click at a time is a screen nobody opens; the CLI's
-- `review --approve-above` exists for the same reason.
--
-- It takes THE SAME filter parameters as list_review_candidates and applies them
-- identically. A bulk action whose filters drift from the list it sits under is
-- a bulk action that approves rows you never saw.
create or replace function public.approve_review_above(
  p_min_score integer,
  p_run       uuid default null,
  p_reason    text default null,
  p_query     text default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_count integer;
begin
  perform public.catalog_admin_guard();

  with newest as (
    select distinct on (o.barcode)
      o.barcode, o.score, o.id
    from public.catalog_import_outcomes o
    join public.catalog_import_runs r on r.id = o.run_id
    where o.stage = 'review'
      and (p_run is null or o.run_id = p_run)
      and (p_reason is null or o.reason = p_reason)
      and (p_query is null or o.name ilike '%' || p_query || '%')
    order by o.barcode, r.scored_at desc nulls last, o.id desc
  ),
  pending as (
    select n.barcode
    from newest n
    where n.score >= p_min_score
      and not exists (
        select 1 from public.catalog_review_decisions d where d.barcode = n.barcode
      )
  ),
  written as (
    insert into public.catalog_review_decisions (barcode, verdict, decided_by, note)
    select p.barcode, 'approve', public.requesting_user_id(),
           'bulk: score >= ' || p_min_score
    from pending p
    -- Nothing in `pending` can conflict, since it excludes anything decided.
    -- The clause is here so a concurrent single approval cannot abort the batch.
    on conflict (barcode) do nothing
    returning 1
  )
  select count(*) into v_count from written;

  return v_count;
end;
$$;

revoke all on function public.approve_review_above(integer, uuid, text, text) from public, anon;
grant execute on function public.approve_review_above(integer, uuid, text, text) to authenticated;
```

- [ ] **Step 2: Add the pgTAP tests**

In `supabase-catalog/supabase/tests/catalog.test.sql`, bump the plan count (currently `select plan(65);`) by the number of new assertions, and append this block before the final `rollback;`:

```sql
-- ── 7. Review decisions ──────────────────────────────────────────────────────
-- The catalog project has no admin_users; catalog_admins is its own list and
-- catalog_admin_guard() is the only thing standing between a signed-in phone and
-- the contents of the catalog.

insert into public.catalog_import_runs (id, source, source_version, scored_at)
values
  ('11111111-1111-1111-1111-111111111111', 'openfoodfacts', 'off-2026-01-01', '2026-01-01'),
  ('22222222-2222-2222-2222-222222222222', 'openfoodfacts', 'off-2026-02-01', '2026-02-01');

insert into public.catalog_import_outcomes (run_id, barcode, name, maker, score, stage, reason, flags, signals)
values
  ('11111111-1111-1111-1111-111111111111', '5941000000001', 'Ciocolata Veche', 'Kandia', 55, 'review', 'middle-band', '{}', '{"scans": 12}'),
  ('22222222-2222-2222-2222-222222222222', '5941000000001', 'Ciocolata Noua',  'Kandia', 58, 'review', 'middle-band', '{}', '{"scans": 30}'),
  ('22222222-2222-2222-2222-222222222222', '5941000000002', 'Apa Minerala',    'Borsec', 44, 'review', 'outside-home-market', '{}', '{}'),
  ('22222222-2222-2222-2222-222222222222', '5941000000003', 'Ceva Aruncat',    null,     10, 'dropped', 'below-review-threshold', '{}', '{}');

insert into public.catalog_admins (user_id, note) values ('user_admin', 'test');

-- As a non-admin authenticated user.
set local role authenticated;
set local request.jwt.claims = '{"sub": "user_nobody"}';

select is(public.catalog_is_admin(), false, 'a signed-in non-admin is not a catalog admin');

select throws_ok(
  $$ select public.record_review_decision('5941000000001', 'approve') $$,
  '42501',
  'admin only',
  'a non-admin cannot record a verdict'
);

select throws_ok(
  $$ select * from public.list_review_candidates() $$,
  '42501',
  'admin only',
  'a non-admin cannot list the review band'
);

select throws_ok(
  $$ select public.approve_review_above(50) $$,
  '42501',
  'admin only',
  'a non-admin cannot bulk approve'
);

select is(
  has_table_privilege('authenticated', 'public.catalog_admins', 'SELECT'),
  false,
  'catalog_admins is not selectable by authenticated'
);

select is(
  has_table_privilege('authenticated', 'public.catalog_review_decisions', 'SELECT'),
  false,
  'catalog_review_decisions is not selectable by authenticated'
);

-- As the admin.
set local request.jwt.claims = '{"sub": "user_admin"}';

select is(public.catalog_is_admin(), true, 'the seeded admin is a catalog admin');

select is(
  (select count(*)::int from public.list_review_candidates()),
  2,
  'the pending band has one row per barcode, not one per run'
);

select is(
  (select name from public.list_review_candidates() where barcode = '5941000000001'),
  'Ciocolata Noua',
  'the newest run wins for a barcode seen in several'
);

select is(
  (select total_count from public.list_review_candidates(null, null, null, 1, 0)),
  2::bigint,
  'total_count counts the whole band, not the page'
);

select is(
  (select count(*)::int from public.list_review_candidates(null, 'outside-home-market')),
  1,
  'the reason filter narrows the band'
);

-- Every assertion below reads through the RPCs rather than off the tables.
-- Not incidental: `role authenticated` is still set, and catalog_review_decisions
-- is revoked from it, so a direct select would fail with permission denied and
-- the test would be asserting the grant rather than the behaviour. Reading the
-- way the dashboard reads is also the more useful test.

select lives_ok(
  $$ select public.record_review_decision('5941000000001', 'approve', 'looks fine') $$,
  'an admin can record a verdict'
);

select is(
  (select verdict from public.list_review_decisions(null, null, 100, 0)
   where barcode = '5941000000001'),
  'approve',
  'the verdict landed'
);

select is(
  (select decided_by from public.list_review_decisions(null, null, 100, 0)
   where barcode = '5941000000001'),
  'user_admin',
  'the verdict is stamped with who made it'
);

select is(
  (select count(*)::int from public.list_review_candidates()),
  1,
  'a decided barcode leaves the pending band'
);

select lives_ok(
  $$ select public.record_review_decision('5941000000001', 'reject') $$,
  'a second verdict for the same barcode is allowed'
);

select is(
  (select count(*)::int from public.list_review_decisions(null, null, 100, 0)
   where barcode = '5941000000001'),
  1,
  'changing your mind replaces rather than duplicates'
);

select is(
  (select verdict from public.list_review_decisions(null, null, 100, 0)
   where barcode = '5941000000001'),
  'reject',
  'the replacement is the verdict that stands'
);

select is(
  (select count(*)::int from public.list_review_decisions()),
  1,
  'the decided list shows the verdict'
);

select is(
  (select name from public.list_review_decisions()),
  'Ciocolata Noua',
  'a decided product keeps its name from the newest outcome row'
);

select lives_ok(
  $$ select public.clear_review_decision('5941000000001') $$,
  'a verdict can be cleared'
);

select is(
  (select count(*)::int from public.list_review_candidates()),
  2,
  'clearing a verdict returns the product to the pending band'
);

select throws_ok(
  $$ select public.record_review_decision('5941000000002', 'maybe') $$,
  '22023',
  'verdict must be approve or reject',
  'an unknown verdict is refused'
);

select is(
  public.approve_review_above(50),
  1,
  'bulk approve writes only the rows at or above the score'
);

select is(
  (select verdict from public.list_review_decisions(null, null, 100, 0)
   where barcode = '5941000000001'),
  'approve',
  'bulk approve took the barcode scoring 58'
);

select is(
  (select count(*)::int from public.list_review_decisions(null, null, 100, 0)
   where barcode = '5941000000002'),
  0,
  'bulk approve left the barcode scoring 44 alone'
);

select is(
  public.approve_review_above(0),
  1,
  'bulk approve skips what is already decided'
);

reset role;
```

New assertion count: 24. Change `select plan(65);` to `select plan(89);`.

- [ ] **Step 3: Reset and run the suite, expecting failures first**

Run from `D:\famcart\catalog-importer`:

```bash
npx supabase db reset --workdir supabase-catalog
npx supabase test db --workdir supabase-catalog
```

If step 1 were skipped this would fail with `function public.list_review_candidates() does not exist`. With it in place, expect 89 passing.

- [ ] **Step 4: Commit**

```bash
git add supabase-catalog/supabase/migrations/005_review.sql supabase-catalog/supabase/tests/catalog.test.sql
git commit -m "Record review verdicts in the catalog project, behind its own admin list"
```

---

### Task 2: Carry the decision signals into the outcomes table

**Files:**
- Modify: `src/publish/outcomes.ts`
- Modify: `src/publish/publish.ts` (the insert column list, if it names columns)
- Test: `test/outcomes.test.ts`

**Interfaces:**
- Consumes: `catalog_import_outcomes.signals` from Task 1.
- Produces: `OutcomeRow` in `src/publish/outcomes.ts` gains `signals: Record<string, unknown>`.

- [ ] **Step 1: Write the failing test**

Append to `test/outcomes.test.ts`:

```ts
describe('buildOutcomes signals', () => {
  const scoredReview = {
    product: {
      barcode: '5941000000001',
      name: 'Ciocolata',
      maker: 'Kandia',
      nameLang: 'ro',
      markets: ['en:romania', 'en:france', 'xx:nowhere'],
      signals: { uniqueScans: 42 },
    },
    score: { total: 55, flags: [] },
    verdict: 'review',
    reason: 'middle-band',
  } as never

  it('carries lang, scans and markets for a review row', () => {
    const [row] = buildOutcomes([scoredReview], [])
    expect(row.signals).toEqual({
      lang: 'ro',
      scans: 42,
      markets: ['en:romania', 'en:france'],
    })
  })

  it('leaves signals empty for a dropped row, which nobody rules on', () => {
    const dropped = { ...scoredReview, verdict: 'drop', reason: 'below-review-threshold' } as never
    const [row] = buildOutcomes([dropped], [])
    expect(row.signals).toEqual({})
  })

  it('leaves signals empty for a pre-scoring reject', () => {
    const [row] = buildOutcomes([], [{ barcode: '123', reason: 'no-name' }])
    expect(row.signals).toEqual({})
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/outcomes.test.ts`
Expected: FAIL, `expected undefined to equal { lang: 'ro', ... }`.

- [ ] **Step 3: Implement**

In `src/publish/outcomes.ts`, add `signals` to the interface:

```ts
export interface OutcomeRow {
  barcode: string
  name: string | null
  maker: string | null
  score: number | null
  stage: OutcomeStage
  reason: string
  flags: string[]
  /**
   * What a reviewer decides on, and only for the rows a reviewer is asked
   * about. writeReviewQueue() puts lang, scans and markets in front of the
   * terminal reviewer and none of them survived into this table, which made the
   * dashboard's review screen strictly worse than the queue it replaces.
   *
   * Empty for 'rejected' and 'dropped': nobody is asked to rule on those, and
   * filling it would double the size of the biggest population here for a
   * question no screen asks.
   */
  signals: Record<string, unknown>
}
```

Add the empty object to the rejected mapping, and fill it for review rows in the scored loop:

```ts
  for (const entry of scored) {
    const stage = DISCARDED[entry.verdict]
    // 'auto' has no stage: it landed, and product_catalog already has it.
    if (!stage) continue
    rows.push({
      barcode: entry.product.barcode,
      name: entry.product.name,
      maker: entry.product.maker,
      score: entry.score.total,
      stage,
      reason: entry.reason,
      flags: entry.score.flags,
      signals: stage === 'review' ? reviewSignals(entry) : {},
    })
  }
```

And the helper, above `buildOutcomes`:

```ts
// The same three the terminal queue shows, and capped at four markets for the
// same reason writeReviewQueue caps them: a product sold in thirty countries
// tells the reviewer nothing more than one sold in four.
function reviewSignals(entry: ScoredProduct): Record<string, unknown> {
  return {
    lang: entry.product.nameLang,
    scans: entry.product.signals.uniqueScans,
    markets: entry.product.markets.filter((m) => m.startsWith('en:')).slice(0, 4),
  }
}
```

- [ ] **Step 4: Run the whole importer suite**

Run: `npx vitest run`
Expected: PASS. If `src/publish/publish.ts` names columns explicitly in its insert, add `signals` there too and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/publish/outcomes.ts src/publish/publish.ts test/outcomes.test.ts
git commit -m "Publish the signals a review verdict actually turns on"
```

---

### Task 3: Read verdicts from the database, keep the file as a mirror

**Files:**
- Modify: `src/score/decisions.ts`
- Modify: `src/cli.ts` (the `score` function, and `--offline` in the flag list)
- Test: `test/decisions.test.ts` (create)

**Interfaces:**
- Consumes: `catalog_review_decisions` and `record_review_decision` from Task 1; `createServiceClient()` from `src/load/supabase.ts`.
- Produces: `fetchDecisions(db: SupabaseClient): Promise<DecisionIndex>`, `writeDecisionMirror(path: string, index: DecisionIndex): void`, `readDecisionMirror(path: string): { index: DecisionIndex; writtenAt: string | null }` in `src/score/decisions.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/decisions.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fetchDecisions,
  loadDecisions,
  readDecisionMirror,
  writeDecisionMirror,
} from '../src/score/decisions.ts'
import type { DecisionIndex } from '../src/types.ts'

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'decisions-')), name)
}

/** A stand-in for the supabase-js client, returning one page then an empty one. */
function fakeDb(pages: unknown[][], error: unknown = null) {
  let call = 0
  return {
    from() {
      return {
        select() {
          return {
            order() {
              return {
                range: async () => ({ data: pages[call++] ?? [], error }),
              }
            },
          }
        },
      }
    },
  } as never
}

describe('fetchDecisions', () => {
  it('indexes every page by barcode', async () => {
    const db = fakeDb([
      [{ barcode: '111', verdict: 'approve', decided_at: '2026-01-01', decided_by: 'user_a', note: null }],
      [{ barcode: '222', verdict: 'reject', decided_at: '2026-01-02', decided_by: null, note: 'junk' }],
    ])
    const index = await fetchDecisions(db)

    expect(index.size).toBe(2)
    expect(index.get('111')?.verdict).toBe('approve')
    expect(index.get('222')?.verdict).toBe('reject')
  })

  // The whole point of fail-loud: an empty index is indistinguishable from
  // "nobody has decided anything", and every approval would silently fall back
  // to whatever the gate says.
  it('throws rather than returning an empty index when the read fails', async () => {
    const db = fakeDb([[]], { message: 'network down' })
    await expect(fetchDecisions(db)).rejects.toThrow(/network down/)
  })
})

describe('the mirror', () => {
  it('round-trips through the file', () => {
    const path = tmpFile('decisions.jsonl')
    const index: DecisionIndex = new Map([
      ['111', { barcode: '111', verdict: 'approve', decidedAt: '2026-01-01' }],
    ])
    writeDecisionMirror(path, index)

    const back = readDecisionMirror(path)
    expect(back.index.get('111')?.verdict).toBe('approve')
    expect(back.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
  })

  it('writes a header saying it is generated', () => {
    const path = tmpFile('decisions.jsonl')
    writeDecisionMirror(path, new Map())
    expect(readFileSync(path, 'utf8')).toMatch(/generated/i)
  })

  it('still parses a hand-written file with no header', () => {
    const path = tmpFile('decisions.jsonl')
    writeFileSync(path, '{"barcode":"999","verdict":"approve","decidedAt":"2026-01-01"}\n')
    expect(loadDecisions(path).get('999')?.verdict).toBe('approve')
    expect(readDecisionMirror(path).writtenAt).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/decisions.test.ts`
Expected: FAIL, `fetchDecisions is not a function`.

- [ ] **Step 3: Implement in `src/score/decisions.ts`**

Update the file header comment to say the table is now the source of truth and the file is a mirror, then add:

```ts
const MIRROR_HEADER =
  '// GENERATED. The source of truth is catalog_review_decisions in the catalog\n' +
  '// project; this file is rewritten by every `npm run score`. Editing it does\n' +
  '// nothing, because the next fetch overwrites it. Use the admin dashboard, or\n' +
  '// `npm run review -- --approve-above <score> --apply`.\n'

const PAGE = 1000

/**
 * Every verdict a human has ever recorded, from the catalog project.
 *
 * The WHOLE table, paged, not just the barcodes in this run: filtering by the
 * run's barcodes would mean a filter built from hundreds of thousands of values,
 * and this table is small -- it holds one row per product somebody has actually
 * ruled on, which is bounded by how much reviewing has been done rather than by
 * the size of the dump.
 *
 * Throws rather than returning what it managed to read. applyGate() checks a
 * recorded verdict BEFORE any scoring, so a half-read index is not a smaller
 * answer, it is a wrong one: every missing approval falls back to whatever the
 * gate says and every missing reject quietly stops applying.
 */
export async function fetchDecisions(db: SupabaseClient): Promise<DecisionIndex> {
  const index: DecisionIndex = new Map()

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('catalog_review_decisions')
      .select('barcode,verdict,decided_by,decided_at,note')
      .order('barcode', { ascending: true })
      .range(offset, offset + PAGE - 1)

    if (error) {
      throw new Error(
        `could not read recorded verdicts: ${(error as { message?: string }).message ?? String(error)}`,
      )
    }

    const rows = (data ?? []) as {
      barcode: string
      verdict: 'approve' | 'reject'
      decided_by: string | null
      decided_at: string
      note: string | null
    }[]

    for (const row of rows) {
      index.set(row.barcode, {
        barcode: row.barcode,
        verdict: row.verdict,
        decidedAt: row.decided_at,
        ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
        ...(row.note ? { reason: row.note } : {}),
      })
    }

    if (rows.length < PAGE) break
  }

  return index
}

/** Rewrite the local mirror. One way, always: the table is the source. */
export function writeDecisionMirror(path: string, index: DecisionIndex): void {
  mkdirSync(dirname(path), { recursive: true })
  const body = [...index.values()].map((d) => JSON.stringify(d)).join('\n')
  writeFileSync(
    path,
    `${MIRROR_HEADER}// written ${new Date().toISOString()}\n${body}${body ? '\n' : ''}`,
    'utf8',
  )
}

/**
 * The mirror, plus when it was written, so `score --offline` can say how stale
 * the verdicts it is about to apply are. A null timestamp means a file that
 * predates the mirror, or one somebody wrote by hand.
 */
export function readDecisionMirror(path: string): {
  index: DecisionIndex
  writtenAt: string | null
} {
  const index = loadDecisions(path)
  if (!existsSync(path)) return { index, writtenAt: null }

  const stamp = readFileSync(path, 'utf8').match(/^\/\/ written (.+)$/m)
  return { index, writtenAt: stamp ? stamp[1] : null }
}
```

Add `import type { SupabaseClient } from '@supabase/supabase-js'` at the top. `loadDecisions` already skips `//` lines, so the header parses harmlessly.

- [ ] **Step 4: Wire it into `score` in `src/cli.ts`**

Replace `const decisions = loadDecisions(paths.decisions)` with:

```ts
  // Fail-loud, unlike the publish at the end of this function.
  //
  // applyGate() checks a recorded verdict before any scoring, which is what
  // makes review work across runs: a reject survives the score going up, a new
  // dump, and a normalizer change that renames the product entirely. An index
  // that came back empty because the network was down does not fail anything --
  // it silently un-decides every product somebody ruled on. So scoring stops
  // instead, and --offline is how you say you accept the older set.
  let decisions: DecisionIndex
  if (hasFlag('--offline')) {
    const mirror = readDecisionMirror(paths.decisions)
    decisions = mirror.index
    console.warn(
      `! Offline: applying ${mirror.index.size.toLocaleString()} verdicts from the local mirror` +
        (mirror.writtenAt ? `, written ${mirror.writtenAt}.` : ', of unknown age.') +
        '\n  Anything decided since is not being applied.',
    )
  } else {
    decisions = await fetchDecisions(createServiceClient())
    writeDecisionMirror(paths.decisions, decisions)
    console.log(`${decisions.size.toLocaleString()} recorded verdicts applied.`)
  }
```

Add `fetchDecisions`, `readDecisionMirror`, `writeDecisionMirror` to the existing `./score/decisions.ts` import, and `DecisionIndex` to the `./types.ts` type import.

- [ ] **Step 5: Run the suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add src/score/decisions.ts src/cli.ts test/decisions.test.ts
git commit -m "Read verdicts from the catalog project, and refuse to score without them"
```

---

### Task 4: The three CLI commands that fill the table

**Files:**
- Modify: `src/cli.ts` (`review`, plus `decisionsImport` and `adminsAdd`, and the `COMMANDS` map)
- Modify: `package.json` (three scripts)
- Modify: `README.md` (the Running it section)
- Test: `test/decisions.test.ts` (extend)

**Interfaces:**
- Consumes: `fetchDecisions`, `loadDecisions` from Task 3; `record_review_decision` from Task 1.
- Produces: `toDecisionRows(index: DecisionIndex): { barcode: string; verdict: string; decided_at: string; note: string | null }[]` exported from `src/score/decisions.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/decisions.test.ts`:

```ts
describe('toDecisionRows', () => {
  it('maps the index to the table s column names', () => {
    const index: DecisionIndex = new Map([
      ['111', { barcode: '111', verdict: 'approve', decidedAt: '2026-01-01', reason: 'fine' }],
    ])
    expect(toDecisionRows(index)).toEqual([
      { barcode: '111', verdict: 'approve', decided_at: '2026-01-01', note: 'fine' },
    ])
  })

  // The file never recorded who, so decided_by is left off the row entirely
  // rather than sent as null: the column defaults to null and an import should
  // not claim the importer made the decision.
  it('omits decided_by, which the file never held', () => {
    const index: DecisionIndex = new Map([
      ['111', { barcode: '111', verdict: 'reject', decidedAt: '2026-01-01' }],
    ])
    expect(toDecisionRows(index)[0]).not.toHaveProperty('decided_by')
    expect(toDecisionRows(index)[0].note).toBeNull()
  })
})
```

Add `toDecisionRows` to the import at the top of the file.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/decisions.test.ts`
Expected: FAIL, `toDecisionRows is not a function`.

- [ ] **Step 3: Implement `toDecisionRows` in `src/score/decisions.ts`**

```ts
/** The index as rows for catalog_review_decisions. Used by `decisions:import`. */
export function toDecisionRows(index: DecisionIndex): {
  barcode: string
  verdict: string
  decided_at: string
  note: string | null
}[] {
  return [...index.values()].map((d) => ({
    barcode: d.barcode,
    verdict: d.verdict,
    decided_at: d.decidedAt,
    note: d.reason ?? null,
  }))
}
```

- [ ] **Step 4: Add the three commands to `src/cli.ts`**

```ts
// A one-shot backfill of the verdicts recorded before the table existed.
//
// Idempotent: upsert on the primary key, so running it twice is harmless and
// running it after somebody has revised a verdict in the dashboard would
// overwrite that revision with the file's older answer. Which is why it prints
// what it is about to do and takes --apply.
async function decisionsImport() {
  const index = loadDecisions(paths.decisions)
  if (!index.size) {
    console.log(`No verdicts in ${paths.decisions}.`)
    return
  }

  const rows = toDecisionRows(index)
  console.log(`Target:  ${new URL(loadCredentials().url).host}`)
  console.log(`Rows:    ${rows.length.toLocaleString()} from ${paths.decisions}`)

  if (!hasFlag('--apply')) {
    console.log('\nThis was a dry run. To write them: npm run decisions:import -- --apply')
    return
  }

  const db = createServiceClient()
  const { error } = await db
    .from('catalog_review_decisions')
    .upsert(rows, { onConflict: 'barcode' })
  if (error) throw new Error(error.message)

  console.log(`\nImported ${rows.length.toLocaleString()} verdicts.`)
}

// Who may decide, in the catalog project.
//
// This list is separate from the app database's admin_users and is kept in step
// by hand. See the header of 005_review.sql for why that is the accepted shape
// for now.
async function adminsAdd() {
  const userId = argv[1]
  if (!userId || userId.startsWith('--')) {
    throw new Error('usage: npm run admins:add -- <clerk-user-id> [note]')
  }

  const db = createServiceClient()
  const { error } = await db
    .from('catalog_admins')
    .upsert({ user_id: userId, note: argv[2] ?? null }, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)

  console.log(`${userId} may now record review verdicts on ${new URL(loadCredentials().url).host}.`)
}
```

Then change the tail of `review()` so `--apply` writes instead of printing. Replace the `if (Number.isFinite(threshold))` block with:

```ts
  const threshold = Number(argv[argv.indexOf('--approve-above') + 1])
  if (!Number.isFinite(threshold)) {
    console.log(
      `\n${queue.length} queued. Re-run with --approve-above <score> to approve a slice of it.`,
    )
    return
  }

  const today = new Date().toISOString().slice(0, 10)
  const approvals: Decision[] = queue
    .filter((row) => row.score >= threshold)
    .map((row) => ({ barcode: row.barcode, verdict: 'approve', decidedAt: today }))

  if (!hasFlag('--apply')) {
    console.log(
      `\n${approvals.length} products score ${threshold} or above. ` +
        'To approve them: npm run review -- --approve-above ' +
        `${threshold} --apply`,
    )
    return
  }

  // Straight to the table. It used to print a block for you to paste into
  // data/decisions.jsonl, and that file is now a generated mirror the next score
  // run overwrites -- pasting into it would look like it worked and then
  // silently vanish.
  const db = createServiceClient()
  const { error } = await db
    .from('catalog_review_decisions')
    .upsert(toDecisionRows(new Map(approvals.map((a) => [a.barcode, a]))), {
      onConflict: 'barcode',
    })
  if (error) throw new Error(error.message)

  console.log(`\nApproved ${approvals.length.toLocaleString()} products.`)
```

Make `review` `async`, and register all three in `COMMANDS`:

```ts
  review,
  'decisions:import': decisionsImport,
  'admins:add': adminsAdd,
```

Add `loadDecisions` and `toDecisionRows` to the decisions import.

- [ ] **Step 5: Add the scripts to `package.json`**

```json
    "review": "tsx src/cli.ts review",
    "decisions:import": "tsx src/cli.ts decisions:import",
    "admins:add": "tsx src/cli.ts admins:add",
```

- [ ] **Step 6: Update the README**

In the Running it block, change the `review` line and add the setup step:

```
npm run admins:add -- user_xxx    # once: who may decide, in the catalog project
npm run decisions:import -- --apply  # once: move data/decisions.jsonl into the table
...
npm run review             # print the queue
npm run review -- --approve-above 55 --apply   # or decide in the admin dashboard
```

And under "The database this writes", add a line: verdicts now live in
`catalog_review_decisions`, and `data/decisions.jsonl` is a generated mirror that
`score` rewrites; editing it does nothing.

- [ ] **Step 7: Run everything**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS both.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/score/decisions.ts package.json README.md test/decisions.test.ts
git commit -m "Add the commands that seed the admin list and fill the verdict table"
```

---

### Task 5: The dashboard data module

**Files:**
- Create: `src/lib/data/review.ts`
- Test: `test/review.test.ts` (create)

**Interfaces:**
- Consumes: the five RPCs from Task 1; `getCatalogSupabase()` from `src/lib/supabase.ts`; `CatalogNotConfigured` from `src/lib/data/products.ts`; `queryError` from `src/lib/data/errors.ts`; `Page`, `PageParams` from `src/lib/data/types.ts`.
- Produces: `ReviewCandidate`, `ReviewDecision`, `ReviewFilters` types; `fetchReviewCandidates`, `fetchReviewDecisions`, `recordDecision`, `clearDecision`, `approveAbove`, `isCatalogAdmin`, `reviewSignal`.

- [ ] **Step 1: Write the failing test**

Create `test/review.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { reviewSignal, reviewRpcArgs } from '../src/lib/data/review'

describe('reviewRpcArgs', () => {
  // A filter that was not set must be absent, not null-valued: the RPCs treat
  // null as "no filter", so this is about not sending '' for an empty search box.
  it('sends null for an empty filter rather than an empty string', () => {
    expect(reviewRpcArgs({ runId: null, reason: null, query: '  ' }, { limit: 25, offset: 0 })).toEqual({
      p_run: null,
      p_reason: null,
      p_query: null,
      p_limit: 25,
      p_offset: 0,
    })
  })

  it('passes the filters it was given', () => {
    expect(
      reviewRpcArgs(
        { runId: 'r1', reason: 'middle-band', query: 'ciocolata' },
        { limit: 50, offset: 100 },
      ),
    ).toEqual({
      p_run: 'r1',
      p_reason: 'middle-band',
      p_query: 'ciocolata',
      p_limit: 50,
      p_offset: 100,
    })
  })
})

describe('reviewSignal', () => {
  // The distinction the spec insists on: a row written before the signals
  // column existed is not a product that was never scanned.
  it('returns null for a signal that was never recorded', () => {
    expect(reviewSignal({}, 'scans')).toBeNull()
  })

  it('returns a recorded zero as zero, not as absent', () => {
    expect(reviewSignal({ scans: 0 }, 'scans')).toBe(0)
  })

  it('returns a recorded value', () => {
    expect(reviewSignal({ lang: 'ro' }, 'lang')).toBe('ro')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/review.test.ts`
Expected: FAIL, cannot resolve `../src/lib/data/review`.

- [ ] **Step 3: Implement `src/lib/data/review.ts`**

```ts
import { getCatalogSupabase } from '../supabase'
import { queryError } from './errors'
import { CatalogNotConfigured } from './products'
import type { Page, PageParams } from './types'

// Deciding the review band.
//
// The importer's gate parks everything ambiguous in a review band -- 12,255
// records last run -- and until now the only way to rule on one was appending a
// line of JSON to a file on the operator's machine. These are the five calls
// that make it a screen instead.
//
// Every one of them is an RPC rather than a table select, unlike outcomes.ts
// next door, and that is not a style choice. Reads need an anti-join (pending
// means "in the band and not yet decided") whose count the pager depends on, and
// a distinct-on so a barcode seen in four runs is one question rather than four.
// Writes need a guard, because this project's `authenticated` role is every
// FamCart account with the app installed.

export interface ReviewCandidate {
  barcode: string
  name: string | null
  maker: string | null
  score: number | null
  reason: string
  flags: string[]
  signals: Record<string, unknown>
  run_id: string
}

export interface ReviewDecision {
  barcode: string
  verdict: 'approve' | 'reject'
  decided_by: string | null
  decided_at: string
  note: string | null
  name: string | null
  maker: string | null
  score: number | null
  reason: string | null
  flags: string[] | null
  signals: Record<string, unknown>
}

export interface ReviewFilters {
  runId?: string | null
  reason?: string | null
  query?: string | null
}

/** The verdict a row currently carries, or null while it is still pending. */
export type Verdict = 'approve' | 'reject'

const nullIfBlank = (value: string | null | undefined): string | null => {
  const text = value?.trim()
  return text ? text : null
}

/**
 * Filters as the RPCs want them.
 *
 * Separated from issuing the call so the argument shape can be asserted without
 * a network, the same reason buildOutcomeQuery is its own function.
 *
 * An absent filter is null, never ''. The RPCs read null as "no filter" and ''
 * as a search for the empty string, which every name matches -- a filter that is
 * wrong in the direction of silently doing nothing.
 */
export function reviewRpcArgs(filters: ReviewFilters, params: PageParams) {
  return {
    p_run: nullIfBlank(filters.runId),
    p_reason: nullIfBlank(filters.reason),
    p_query: nullIfBlank(filters.query),
    p_limit: params.limit ?? 25,
    p_offset: params.offset ?? 0,
  }
}

/**
 * One signal, distinguishing "not recorded" from "recorded as nothing".
 *
 * Outcome rows written before 005_review.sql have an empty signals object and
 * cannot be backfilled: the values came from that run's scored.jsonl, which
 * retention has aged out. So an absent signal renders as a dash and a recorded
 * zero renders as zero, because "never scanned" and "we did not write it down"
 * are opposite facts and the reviewer is deciding on exactly this.
 */
export function reviewSignal(
  signals: Record<string, unknown>,
  key: 'lang' | 'scans' | 'markets',
): unknown | null {
  if (!signals || !(key in signals)) return null
  const value = signals[key]
  return value === undefined || value === null ? null : value
}

function client() {
  const db = getCatalogSupabase()
  if (!db) throw new CatalogNotConfigured()
  return db
}

/** True when the signed-in account is in this project's catalog_admins. */
export async function isCatalogAdmin(signal: AbortSignal): Promise<boolean> {
  const { data, error } = await client().rpc('catalog_is_admin').abortSignal(signal)
  if (error) queryError('catalog_is_admin', error)
  return data === true
}

export async function fetchReviewCandidates(
  filters: ReviewFilters,
  params: PageParams,
  signal: AbortSignal,
): Promise<Page<ReviewCandidate>> {
  const { data, error } = await client()
    .rpc('list_review_candidates', reviewRpcArgs(filters, params))
    .abortSignal(signal)

  if (error) queryError('list_review_candidates', error)

  const rows = (data ?? []) as (ReviewCandidate & { total_count: number })[]
  return {
    rows: rows.map(({ total_count: _drop, ...row }) => row),
    // count(*) over () is per row, so an empty page carries no count. An empty
    // page IS zero rows for these filters, which is the honest total.
    total: rows.length ? Number(rows[0].total_count) : 0,
    offset: params.offset ?? 0,
  }
}

export async function fetchReviewDecisions(
  filters: { verdict?: Verdict | null; query?: string | null },
  params: PageParams,
  signal: AbortSignal,
): Promise<Page<ReviewDecision>> {
  const { data, error } = await client()
    .rpc('list_review_decisions', {
      p_verdict: nullIfBlank(filters.verdict),
      p_query: nullIfBlank(filters.query),
      p_limit: params.limit ?? 25,
      p_offset: params.offset ?? 0,
    })
    .abortSignal(signal)

  if (error) queryError('list_review_decisions', error)

  const rows = (data ?? []) as (ReviewDecision & { total_count: number })[]
  return {
    rows: rows.map(({ total_count: _drop, ...row }) => row),
    total: rows.length ? Number(rows[0].total_count) : 0,
    offset: params.offset ?? 0,
  }
}

export async function recordDecision(
  barcode: string,
  verdict: Verdict,
  note?: string,
): Promise<void> {
  const { error } = await client().rpc('record_review_decision', {
    p_barcode: barcode,
    p_verdict: verdict,
    p_note: note ?? null,
  })
  if (error) queryError('record_review_decision', error)
}

export async function clearDecision(barcode: string): Promise<void> {
  const { error } = await client().rpc('clear_review_decision', { p_barcode: barcode })
  if (error) queryError('clear_review_decision', error)
}

/** Returns how many verdicts were written. */
export async function approveAbove(
  minScore: number,
  filters: ReviewFilters,
): Promise<number> {
  const { data, error } = await client().rpc('approve_review_above', {
    p_min_score: minScore,
    p_run: nullIfBlank(filters.runId),
    p_reason: nullIfBlank(filters.reason),
    p_query: nullIfBlank(filters.query),
  })
  if (error) queryError('approve_review_above', error)
  return Number(data ?? 0)
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/review.test.ts && npm run typecheck`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/lib/data/review.ts test/review.test.ts
git commit -m "Read and write review verdicts from the dashboard"
```

---

### Task 6: The review screen

**Files:**
- Create: `src/views/ReviewView.vue`
- Modify: `src/router/index.ts` (a route between pipeline and search)
- Modify: `src/components/SideNav.vue` (a nav entry)
- Modify: `src/components/CommandPalette.vue` (if it enumerates routes)
- Test: `test/reviewView.test.ts` (create)

**Interfaces:**
- Consumes: everything Task 5 produced; `useQuery`, `describeError` from `src/lib/useQuery.ts`; `useTableState`; `DataTable`, `PageHeader`, `PanelCard`, `SegmentedControl`, `SideDrawer`, `StateBlock`, `StatusPill`, `TablePager`, `ConfirmDialog`, `FilterBar`.
- Produces: route name `review` at path `/review`.

- [ ] **Step 1: Write the failing test**

Create `test/reviewView.test.ts`, following the mount-and-fake pattern in `test/trashView.test.ts` (read it first and mirror its mocking of `../src/lib/supabase`):

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const rpc = vi.fn()
vi.mock('../src/lib/supabase', () => ({
  getCatalogSupabase: () => ({ rpc }),
  getAppSupabase: () => ({ rpc }),
  activeProject: { value: 'development' },
  appTarget: { value: { key: 'development', label: 'famcart-dev', ref: 'abc' } },
}))

import ReviewView from '../src/views/ReviewView.vue'

const candidate = {
  barcode: '5941000000001',
  name: 'Ciocolata',
  maker: 'Kandia',
  score: 58,
  reason: 'middle-band',
  flags: [],
  signals: { lang: 'ro', scans: 42, markets: ['en:romania'] },
  run_id: '22222222-2222-2222-2222-222222222222',
  total_count: 1,
}

function answer(name: string, data: unknown) {
  return { abortSignal: () => Promise.resolve({ data, error: null }) }
}

beforeEach(() => {
  rpc.mockReset()
  rpc.mockImplementation((name: string) => {
    if (name === 'catalog_is_admin') return answer(name, true)
    if (name === 'list_review_candidates') return answer(name, [candidate])
    if (name === 'list_review_decisions') return answer(name, [])
    return { abortSignal: () => Promise.resolve({ data: null, error: null }) }
  })
})

describe('ReviewView', () => {
  it('lists the pending band', async () => {
    const wrapper = mount(ReviewView, { global: { stubs: { RouterLink: true, Teleport: true } } })
    await flushPromises()
    expect(wrapper.text()).toContain('Ciocolata')
    expect(wrapper.text()).toContain('58')
  })

  it('says approving does nothing until the next run', async () => {
    const wrapper = mount(ReviewView, { global: { stubs: { RouterLink: true, Teleport: true } } })
    await flushPromises()
    expect(wrapper.text()).toMatch(/next score and load run/i)
  })

  it('records a verdict and refetches', async () => {
    const wrapper = mount(ReviewView, { global: { stubs: { RouterLink: true, Teleport: true } } })
    await flushPromises()

    await wrapper.find('[data-test="approve"]').trigger('click')
    await flushPromises()

    expect(rpc).toHaveBeenCalledWith('record_review_decision', {
      p_barcode: '5941000000001',
      p_verdict: 'approve',
      p_note: null,
    })
  })

  it('renders the forbidden branch when the database refuses', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'catalog_is_admin') return answer(name, false)
      return {
        abortSignal: () =>
          Promise.resolve({ data: null, error: { code: '42501', message: 'admin only' } }),
      }
    })
    const wrapper = mount(ReviewView, { global: { stubs: { RouterLink: true, Teleport: true } } })
    await flushPromises()
    expect(wrapper.text()).toMatch(/not an admin|admin only|permission/i)
  })

  // A signal that was never recorded is not a zero. Rows written before
  // 005_review.sql have an empty signals object.
  it('renders an unrecorded signal as a dash', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'catalog_is_admin') return answer(name, true)
      if (name === 'list_review_candidates')
        return answer(name, [{ ...candidate, signals: {} }])
      return answer(name, [])
    })
    const wrapper = mount(ReviewView, { global: { stubs: { RouterLink: true, Teleport: true } } })
    await flushPromises()
    expect(wrapper.find('[data-test="scans"]').text()).toBe('—')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/reviewView.test.ts`
Expected: FAIL, cannot resolve `../src/views/ReviewView.vue`.

- [ ] **Step 3: Build the view**

Read `src/views/TrashView.vue` first: it is the smallest view with a write action and a confirm dialog, and this one should look like it. Then build `ReviewView.vue` with:

- `PageHeader` titled "Review", description: "The importer parks everything it is unsure about here. A verdict is recorded against the barcode, so it survives a new dump and a renamed product."
- The **banner**, a `PanelCard` above the table, rendering exactly: `Approved products enter the catalog on the next score and load run. {n} verdicts are waiting for one.` where `n` comes from the Decided tab's total. Not a toast: it must be visible while deciding.
- `SegmentedControl` bound to `tab`, values `pending` / `decided`.
- `FilterBar` with a free-text search bound to `query`, plus reason and run selects populated from the candidate rows already on screen.
- `DataTable` with columns: name (with maker beneath), score, reason, flags, lang, scans, markets, actions. The scans cell carries `data-test="scans"` and renders `—` when `reviewSignal(row.signals, 'scans')` is null.
- Per-row Approve (`data-test="approve"`) and Reject (`data-test="reject"`) buttons calling `recordDecision` then `refetch`. No confirm dialog: a verdict is an upsert and Undo is one click, unlike the deletions TrashView guards.
- On the Decided tab, an Undo button per row calling `clearDecision`.
- Keyboard: `j` / `k` move a `focusedIndex`, `a` and `r` decide the focused row. Bound with a `keydown` listener on the table container, not on `window`, so typing in the search box does not approve anything.
- `SideDrawer` on row click showing every field including the raw `signals`.
- Bulk approve: a number input plus a button, behind `ConfirmDialog` whose body names the count and the active filters, calling `approveAbove(minScore, filters)`.
- `StateBlock` for the three failure states: catalog not configured, forbidden (via `describeError(...).forbidden`), and an empty band.

- [ ] **Step 4: Add the route**

In `src/router/index.ts`, between `pipeline` and `search`:

```ts
  {
    path: '/review',
    name: 'review',
    component: () => import('../views/ReviewView.vue'),
    meta: { crumb: 'Review' },
  },
```

- [ ] **Step 5: Add the nav entry**

In `src/components/SideNav.vue`, after the Pipeline entry, matching the shape of the entries around it. Reuse an existing icon from `src/assets/` (`check.svg` is present) rather than adding one, since icons are synced from `lucide-static` by `npm run icons:sync` and an unsynced file fails `icons:check`.

- [ ] **Step 6: Run everything**

Run: `npx vitest run && npm run typecheck && npm run lint && npm run icons:check`
Expected: PASS all four.

- [ ] **Step 7: Commit**

```bash
git add src/views/ReviewView.vue src/router/index.ts src/components/SideNav.vue src/components/CommandPalette.vue test/reviewView.test.ts
git commit -m "Add the Review screen, where the importer's queue gets its verdicts"
```

---

### Task 7: Point the pipeline page at it, and correct the README

**Files:**
- Modify: `src/views/PipelineView.vue` (the run drawer, and the trigger panel copy)
- Modify: `src/lib/data/pipeline.ts` (`triggerCapability` comment)
- Modify: `README.md` (the "read-only with two exceptions" claim)

**Interfaces:**
- Consumes: route `review` from Task 6.

- [ ] **Step 1: Link the run drawer to the band**

In `PipelineView.vue`, beside the existing link to `/products?scope=outcomes&run=…`, add one to `/review?run=…` labelled "Decide this run's review band". `ReviewView` already reads `route.query.run` into its run filter, the same way `ProductsView` reads `scope`.

- [ ] **Step 2: Correct the trigger panel's copy**

The panel still tells you to run `npm run review` and paste a block. Change `runInstead` in `triggerCapability()` to drop the paste step, and its comment to say that verdicts are now recorded in the dashboard while starting a run is still a terminal job:

```ts
    runInstead: [
      'cd catalog-importer',
      'npm run acquire:delta      # fold in what changed upstream',
      'npm run normalize && npm run score',
      'npm run load               # dry run, then read out/load-diff.md',
      'npm run load:apply',
    ],
```

and add above it, in the block comment, a line: verdicts are no longer part of this list, because the Review screen records them and `score` reads them from the database.

- [ ] **Step 3: Correct the README**

`admin/README.md` says the tool is "read-only with two exceptions: granting and revoking admin access". That has been false since the deletion and ban work landed, and this task adds four more writes. Replace that sentence with a list: grant and revoke admin, delete and restore a household, ban and unban an account, and record, clear or bulk-approve a review verdict.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/PipelineView.vue src/lib/data/pipeline.ts README.md
git commit -m "Point the pipeline page at the review screen, and correct the read-only claim"
```

---

### Task 8: Bump the submodule pointers

**Files:**
- Modify: `D:\famcart` superproject (`catalog-importer` and `admin` gitlinks)

- [ ] **Step 1: Commit both pointers from the superproject**

```bash
cd /d/famcart
git add catalog-importer admin
git commit -m "Bump catalog-importer and admin: review verdicts move into the catalog project"
```

Note the superproject already has unrelated staged changes (`ci.yml`, `.gitignore`, `src/supabase.ts`, the deleted `supabase-catalog/`). Add only the two gitlinks.

- [ ] **Step 2: Verify CI would pass**

Run from `D:\famcart`:

```bash
npx supabase db reset --workdir catalog-importer/supabase-catalog
npx supabase test db --workdir catalog-importer/supabase-catalog
```

Expected: 89 passing. This is the job `.github/workflows/ci.yml` runs as `catalog-tests`, through the submodule.
