# Admin Deletion and Bans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin soft-delete a household (hiding everything inside it, reversibly) and ban a person from the app, from the dashboard.

**Architecture:** One `deleted_at` column on `households` and one `banned_at` on `profiles`. Eight RLS policy sites that each inline "which households is this person in" collapse onto a single `active_household_ids()` helper that filters deleted households out — so one definition governs visibility and no policy can be forgotten. Bans work by making the app's boot-time profile upsert refuse to revive a banned row.

**Tech Stack:** Postgres 17 / Supabase, pgTAP for schema tests, Vue 3.5 + TypeScript for the dashboard, Vitest + @vue/test-utils.

**Spec:** `docs/superpowers/plans/../specs/2026-08-24-admin-deletion-design.md` (in this repo, `admin/docs/superpowers/specs/`)

## Global Constraints

- **Two repos.** Schema work is in `D:\famcart` (the `famcart` repo). Dashboard work is in `D:\famcart\admin`. Every task says which.
- **`famcart-dev` ONLY.** Do not run any migration against the `famcart` production project. Production is a separate, later, explicitly-approved step.
- **Restatement rule.** New columns and constraints go **below** the `create table if not exists` block as `alter table ... add column if not exists` / `drop constraint if exists` + `add constraint`. Anything declared inside that block reaches new databases only. See `D:\famcart\CLAUDE.md`.
- **Always `db reset` before `supabase test db`.** `db start` restores from a local backup and skips migrations, so the suite would test a stale schema.
- **`select plan(N)` at `supabase/tests/rls.test.sql:60` is a hard count.** Bump it by exactly the number of assertions you add, or the suite fails with a plan mismatch that does not name the cause.
- **Every admin RPC opens with `perform public.admin_guard();`** — matching the twenty already in `008_admin.sql`.
- **`security definer` functions must set `search_path = public`.**
- Dashboard: strict TypeScript, no `any`. `npm run typecheck && npx eslint . && npx vitest run` must all pass before any commit.

---

### Task 1: The two columns

**Files:**
- Modify: `D:\famcart\supabase\migrations\003_households_and_members.sql` (append to the households and profiles sections, below their `create table` blocks)
- Test: `D:\famcart\supabase\tests\rls.test.sql`

**Interfaces:**
- Consumes: nothing
- Produces: `public.households.deleted_at timestamptz null`, `public.profiles.banned_at timestamptz null`

- [ ] **Step 1: Write the failing test**

Add to `supabase/tests/rls.test.sql`, just before `select finish();`:

```sql
-- 13. Soft-delete and ban columns exist and default to null.
select has_column('public', 'households', 'deleted_at', 'households.deleted_at exists');
select has_column('public', 'profiles', 'banned_at', 'profiles.banned_at exists');
select col_is_null('public', 'households', 'deleted_at', 'households.deleted_at is nullable');
```

- [ ] **Step 2: Bump the plan count**

At `supabase/tests/rls.test.sql:60`, change `select plan(113);` to `select plan(116);` (three assertions added).

- [ ] **Step 3: Run the suite to verify it fails**

```bash
cd D:/famcart
npx supabase db reset
npx supabase test db
```

Expected: FAIL — `has_column` reports `households.deleted_at` does not exist.

- [ ] **Step 4: Add the columns**

In `003_households_and_members.sql`, below the `create table if not exists public.households (...)` block and its existing `alter table` restatements:

```sql
-- Soft delete. Null means live.
--
-- Below the create-table block deliberately: a column declared inside
-- `create table if not exists` is skipped when the table already exists, so it
-- would reach new databases only and never production. See CLAUDE.md.
alter table public.households
  add column if not exists deleted_at timestamptz;

comment on column public.households.deleted_at is
  'When an admin soft-deleted this household. Null means live. Everything inside a deleted household is hidden through active_household_ids(); nothing is destroyed and admin_restore_household() reverses it.';

-- Partial: the only query wanting the non-null side is the dashboard Trash view,
-- and a full index on a column that is null for every live row earns nothing.
create index if not exists households_deleted_at
  on public.households (deleted_at) where deleted_at is not null;
```

And below the `create table if not exists public.profiles (...)` block:

```sql
-- A ban, not a delete.
--
-- Deleting a profile row does not stick: the app upserts display_name and
-- image_url on every boot (see the note above join_household_with_code), so the
-- row returns the next time the person opens FamCart. The Clerk account is a
-- separate system this database cannot touch. So the row stays and the upsert
-- refuses to revive it -- see the banned_at guard in ensure_profile below.
alter table public.profiles
  add column if not exists banned_at timestamptz;

comment on column public.profiles.banned_at is
  'When an admin barred this account from the app. Null means allowed. The profile upserts raise when it is set, so the person can still sign into Clerk but FamCart turns them away.';
```

- [ ] **Step 5: Run the suite to verify it passes**

```bash
cd D:/famcart && npx supabase db reset && npx supabase test db
```

Expected: PASS, 116 assertions.

- [ ] **Step 6: Commit**

```bash
cd D:/famcart
git add supabase/migrations/003_households_and_members.sql supabase/tests/rls.test.sql
git commit -m "Add households.deleted_at and profiles.banned_at"
```

---

### Task 2: The `active_household_ids()` helper

**Files:**
- Modify: `D:\famcart\supabase\migrations\003_households_and_members.sql` (new function, after `shares_household_with`)
- Test: `D:\famcart\supabase\tests\rls.test.sql`

**Interfaces:**
- Consumes: `households.deleted_at` from Task 1
- Produces: `public.active_household_ids() returns setof uuid` — every policy in Task 3 calls this

- [ ] **Step 1: Write the failing test**

Add before `select finish();`:

```sql
-- 14. active_household_ids() excludes deleted households.
set local request.jwt.claims = '{"sub":"user_a"}';

select is(
  (select count(*)::int from public.active_household_ids()),
  1,
  'user_a is in exactly one live household'
);

update public.households set deleted_at = now()
  where id = '00000000-0000-0000-0000-0000000000a1';

select is(
  (select count(*)::int from public.active_household_ids()),
  0,
  'a deleted household drops out of active_household_ids()'
);

update public.households set deleted_at = null
  where id = '00000000-0000-0000-0000-0000000000a1';

select is(
  (select count(*)::int from public.active_household_ids()),
  1,
  'restoring brings it back'
);
```

Note: `00000000-0000-0000-0000-0000000000a1` is user_a's household in the existing fixtures — confirm the id by reading the fixture block near the top of `rls.test.sql` before running, and substitute the real one if it differs.

- [ ] **Step 2: Bump the plan count**

`select plan(116);` → `select plan(119);`

- [ ] **Step 3: Run to verify it fails**

```bash
cd D:/famcart && npx supabase db reset && npx supabase test db
```

Expected: FAIL — function `public.active_household_ids()` does not exist.

- [ ] **Step 4: Write the helper**

In `003_households_and_members.sql`, after `shares_household_with`:

```sql
-- Which households the caller is actually in, live ones only.
--
-- ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
--
-- Eight policy sites across 003-006 each inlined the same subquery -- "the
-- household_ids this user is a member of" -- and one of them wrote it with an
-- alias, so a grep for the exact text found seven. Eight copies of one rule is
-- how the rule drifts.
--
-- It matters more now than it did: soft delete needs every one of those sites
-- to also exclude deleted households, and the failure mode of missing one is
-- silent. The app would keep showing rows from a household an admin believes
-- they removed, with no error anywhere. One definition, called from eight
-- places, cannot be half-applied.
--
-- security definer because it reads households and household_members from
-- inside a policy, where the caller's own RLS would otherwise apply and
-- recurse. search_path is pinned for the usual reason.
create or replace function public.active_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select hm.household_id
  from public.household_members hm
  join public.households h on h.id = hm.household_id
  where hm.user_id = requesting_user_id()
    and h.deleted_at is null
$$;

revoke all on function public.active_household_ids() from public, anon;
grant execute on function public.active_household_ids() to authenticated;
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd D:/famcart && npx supabase db reset && npx supabase test db
```

Expected: PASS, 119 assertions.

- [ ] **Step 6: Commit**

```bash
cd D:/famcart
git add supabase/migrations/003_households_and_members.sql supabase/tests/rls.test.sql
git commit -m "Add active_household_ids(), one definition for eight policy sites"
```

---

### Task 3: Convert the policies

**Files:**
- Modify: `D:\famcart\supabase\migrations\003_households_and_members.sql:242-260` (both households SELECT policies)
- Modify: `D:\famcart\supabase\migrations\004_shopping_list.sql:79-127` (five policies)
- Modify: `D:\famcart\supabase\migrations\005_purchase_history.sql:50-58` (one policy)
- Modify: `D:\famcart\supabase\migrations\006_product_catalog.sql:213-222` (one policy, aliased)
- Test: `D:\famcart\supabase\tests\rls.test.sql`

**Interfaces:**
- Consumes: `public.active_household_ids()` from Task 2
- Produces: deleted households hide their contents from the app

**DO NOT convert these** — they match the same text but are not policies, and converting them changes unrelated behaviour:
- `003:164`, `003:187`, `003:208` — inside `is_household_owner_or_moderator` and `shares_household_with`
- `003:465`, `003:477` — inside the household-count-cap trigger. A deleted household arguably should not count toward a user's cap, but that is a product decision, not a mechanical rewrite. Leave it.

- [ ] **Step 1: Write the failing test**

Add before `select finish();`:

```sql
-- 15. A deleted household hides everything inside it.
set local request.jwt.claims = '{"sub":"user_a"}';

update public.households set deleted_at = now()
  where id = '00000000-0000-0000-0000-0000000000a1';

select is(
  (select count(*)::int from public.households
   where id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'a member cannot see their deleted household'
);

select is(
  (select count(*)::int from public.shopping_list_items
   where household_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'a member cannot see items in a deleted household'
);

select is(
  (select count(*)::int from public.purchase_history
   where household_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'a member cannot see purchase history in a deleted household'
);

select is(
  (select count(*)::int from public.product_catalog
   where household_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'a member cannot see household-scoped products in a deleted household'
);

-- The rows still exist. This is a soft delete, and the whole point is that
-- restore brings them back rather than a backup having to.
select is(
  (select count(*)::int from public.shopping_list_items
   where household_id = '00000000-0000-0000-0000-0000000000a1'
   and true /* bypasses nothing; run as the table owner below */),
  0,
  'rows are hidden from the member, not yet proven present -- see next assertion'
);

reset request.jwt.claims;
select isnt(
  (select count(*)::int from public.shopping_list_items
   where household_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'the items are physically still there: soft delete, not hard'
);

set local request.jwt.claims = '{"sub":"user_a"}';
update public.households set deleted_at = null
  where id = '00000000-0000-0000-0000-0000000000a1';

select is(
  (select count(*)::int from public.households
   where id = '00000000-0000-0000-0000-0000000000a1'),
  1,
  'restoring makes the household visible again'
);
```

- [ ] **Step 2: Bump the plan count**

`select plan(119);` → `select plan(126);` (seven assertions added).

- [ ] **Step 3: Run to verify it fails**

```bash
cd D:/famcart && npx supabase db reset && npx supabase test db
```

Expected: FAIL — the member still sees the deleted household and its items.

- [ ] **Step 4: Convert the two households policies**

Both, because SELECT policies are OR'd: adding the check to only the members policy leaves the creator still seeing their deleted household through the second one.

In `003_households_and_members.sql`, replace:

```sql
create policy "household members can read their household"
  on public.households for select
  using (
    id in (
      select household_id from public.household_members
      where user_id = requesting_user_id()
    )
  );
```

with:

```sql
create policy "household members can read their household"
  on public.households for select
  using (id in (select public.active_household_ids()));
```

and replace:

```sql
create policy "household owners can read own households"
  on public.households for select
  using (created_by = requesting_user_id());
```

with:

```sql
-- The deleted_at check is NOT redundant with the members policy above. SELECT
-- policies are OR'd, so without it the creator of a deleted household still
-- reads it through this branch and an admin's deletion looks like it did
-- nothing -- for exactly one person, the one most likely to complain.
create policy "household owners can read own households"
  on public.households for select
  using (created_by = requesting_user_id() and deleted_at is null);
```

- [ ] **Step 5: Convert the five shopping_list_items policies**

In `004_shopping_list.sql`, in each of the five policies at lines ~79-127, replace every occurrence of:

```sql
    household_id in (
      select household_id from public.household_members
      where user_id = requesting_user_id()
    )
```

with:

```sql
    household_id in (select public.active_household_ids())
```

Leave the rest of each policy (the `added_by = requesting_user_id()` conjunct in the insert policy, etc.) exactly as it is.

- [ ] **Step 6: Convert purchase_history and product_catalog**

In `005_purchase_history.sql:50-58`, the same substitution.

In `006_product_catalog.sql:213-222`, note the alias. Replace:

```sql
    household_id is null
    or household_id in (
      select fm.household_id from public.household_members fm
      where fm.user_id = requesting_user_id()
    )
```

with:

```sql
    -- Global rows belong to nobody, so no household's deletion hides them.
    household_id is null
    or household_id in (select public.active_household_ids())
```

- [ ] **Step 7: Run to verify it passes**

```bash
cd D:/famcart && npx supabase db reset && npx supabase test db
```

Expected: PASS, 126 assertions. If any pre-existing assertion now fails, a policy was over-converted — check the DO-NOT-convert list at the top of this task.

- [ ] **Step 8: Commit**

```bash
cd D:/famcart
git add supabase/migrations/ supabase/tests/rls.test.sql
git commit -m "Route eight policy sites through active_household_ids()"
```

---

### Task 4: The ban guard

**Files:**
- Modify: `D:\famcart\supabase\migrations\003_households_and_members.sql:711` and `:831` (the two profile upserts)
- Test: `D:\famcart\supabase\tests\rls.test.sql`

**Interfaces:**
- Consumes: `profiles.banned_at` from Task 1
- Produces: banned accounts cannot revive their profile row

- [ ] **Step 1: Write the failing test**

```sql
-- 16. A banned account cannot revive its profile.
update public.profiles set banned_at = now() where user_id = 'user_a';

set local request.jwt.claims = '{"sub":"user_a"}';

select throws_ok(
  $$ select public.create_household_with_owner('Banned Attempt', null) $$,
  'P0001',
  null,
  'a banned account cannot create a household (the profile upsert refuses)'
);

reset request.jwt.claims;
select is(
  (select banned_at is not null from public.profiles where user_id = 'user_a'),
  true,
  'the ban survives the attempt'
);

update public.profiles set banned_at = null where user_id = 'user_a';
```

Confirm `create_household_with_owner`'s exact name and arity by reading `003_households_and_members.sql` near line 711 before running; substitute if it differs.

- [ ] **Step 2: Bump the plan count**

`select plan(126);` → `select plan(128);`

- [ ] **Step 3: Run to verify it fails**

```bash
cd D:/famcart && npx supabase db reset && npx supabase test db
```

Expected: FAIL — no exception raised; the household is created.

- [ ] **Step 4: Add the guard**

Immediately before the `insert into public.profiles` at both `003:711` and `003:831`, add:

```sql
  -- A banned account is turned away here rather than at the door, because this
  -- IS the door: the app upserts a profile on every boot, so refusing the
  -- upsert is what makes a ban stick. Raising rather than silently skipping,
  -- for the same reason admin_guard() raises -- a refusal and a no-op look
  -- identical from the client and only one of them is worth reporting.
  if exists (
    select 1 from public.profiles
    where user_id = v_user and banned_at is not null
  ) then
    raise exception 'This account has been suspended.'
      using errcode = 'P0001';
  end if;
```

Use whichever local variable each function already holds the caller's id in — read the surrounding lines; `003:689` uses `v_user`, `003:782` uses `v_user`. Do not introduce a new one.

- [ ] **Step 5: Run to verify it passes**

```bash
cd D:/famcart && npx supabase db reset && npx supabase test db
```

Expected: PASS, 128 assertions.

- [ ] **Step 6: Commit**

```bash
cd D:/famcart
git add supabase/migrations/003_households_and_members.sql supabase/tests/rls.test.sql
git commit -m "Make a ban stick by refusing the profile upsert"
```

---

### Task 5: The admin RPCs

**Files:**
- Modify: `D:\famcart\supabase\migrations\008_admin.sql` (append after `admin_revoke`, and add drops to the drop block at the top)
- Test: `D:\famcart\supabase\tests\admin.test.sql`

**Interfaces:**
- Consumes: `households.deleted_at`, `profiles.banned_at`, `public.admin_guard()`, `public.log_security_event(p_kind text, p_household_id uuid default null, p_detail jsonb default '{}'::jsonb)`
- Produces:
  - `admin_delete_household(p_id uuid) returns void`
  - `admin_restore_household(p_id uuid) returns void`
  - `admin_ban_user(p_user_id text, p_reason text) returns void`
  - `admin_unban_user(p_user_id text) returns void`
  - `admin_deleted_households() returns table (id uuid, name text, emoji text, deleted_at timestamptz, members integer, items_total integer)`

- [ ] **Step 1: Write the failing test**

Add to `supabase/tests/admin.test.sql` before its `select finish();`, and bump that file's own `select plan(N)` by 5:

```sql
-- Deletion RPCs refuse a non-admin and audit what they do.
set local request.jwt.claims = '{"sub":"not_an_admin"}';

select throws_ok(
  $$ select public.admin_delete_household('00000000-0000-0000-0000-0000000000a1') $$,
  '42501',
  null,
  'admin_delete_household refuses a non-admin'
);

select throws_ok(
  $$ select public.admin_ban_user('user_a', 'spam') $$,
  '42501',
  null,
  'admin_ban_user refuses a non-admin'
);

set local request.jwt.claims = '{"sub":"admin_user"}';

select lives_ok(
  $$ select public.admin_delete_household('00000000-0000-0000-0000-0000000000a1') $$,
  'an admin may delete a household'
);

select is(
  (select deleted_at is not null from public.households
   where id = '00000000-0000-0000-0000-0000000000a1'),
  true,
  'the household is marked deleted'
);

select isnt(
  (select count(*)::int from public.security_events
   where kind = 'admin_household_deleted'),
  0,
  'the deletion left an audit row'
);
```

`admin_user` must be a seeded admin in that file's fixtures — read the top of `admin.test.sql` and use whatever id it already seeds into `admin_users`.

- [ ] **Step 2: Run to verify it fails**

```bash
cd D:/famcart && npx supabase db reset && npx supabase test db
```

Expected: FAIL — `admin_delete_household` does not exist.

- [ ] **Step 3: Add the drops**

In the drop block at the top of `008_admin.sql` (around line 94-106), add:

```sql
drop function if exists public.admin_delete_household(uuid);
drop function if exists public.admin_restore_household(uuid);
drop function if exists public.admin_ban_user(text, text);
drop function if exists public.admin_unban_user(text);
drop function if exists public.admin_deleted_households();
```

- [ ] **Step 4: Write the functions**

Append to `008_admin.sql`:

```sql
-- ─── deletion and bans ───────────────────────────────────────────────────────
--
-- The only destructive-looking things this dashboard can do, and neither
-- actually destroys anything. A household is flagged and everything inside it
-- disappears through active_household_ids(); a person is flagged and the app
-- stops letting them in. Both reverse with one write.
--
-- Auditing matters more here than anywhere else in this file, and soft delete
-- is what makes it work: the security_events row describing a deletion still
-- points at a household that exists.

create or replace function public.admin_delete_household(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  update public.households
  set deleted_at = now()
  where id = p_id and deleted_at is null;

  if not found then
    return;  -- already deleted, or no such household. Idempotent on purpose.
  end if;

  perform public.log_security_event(
    'admin_household_deleted',
    p_id,
    jsonb_build_object('actor', requesting_user_id())
  );
end;
$$;

create or replace function public.admin_restore_household(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  update public.households
  set deleted_at = null
  where id = p_id and deleted_at is not null;

  if not found then
    return;
  end if;

  perform public.log_security_event(
    'admin_household_restored',
    p_id,
    jsonb_build_object('actor', requesting_user_id())
  );
end;
$$;

-- Deliberately does NOT touch household_members.
--
-- Ownership is household_members.role, not a column on households, so deleting
-- a banned person's memberships deletes the household's admin -- ban the
-- founder of a one-person household and nobody can administer it. The upsert
-- guard already stops the person at the door, so the membership is inert.
-- Removing someone from a household is a separate, explicit action.
create or replace function public.admin_ban_user(p_user_id text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  update public.profiles
  set banned_at = now()
  where user_id = p_user_id and banned_at is null;

  if not found then
    return;
  end if;

  perform public.log_security_event(
    'admin_user_banned',
    null,
    jsonb_build_object('actor', requesting_user_id(), 'target', p_user_id, 'reason', p_reason)
  );
end;
$$;

create or replace function public.admin_unban_user(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  update public.profiles
  set banned_at = null
  where user_id = p_user_id and banned_at is not null;

  if not found then
    return;
  end if;

  perform public.log_security_event(
    'admin_user_unbanned',
    null,
    jsonb_build_object('actor', requesting_user_id(), 'target', p_user_id)
  );
end;
$$;

create or replace function public.admin_deleted_households()
returns table (
  id uuid,
  name text,
  emoji text,
  deleted_at timestamptz,
  members integer,
  items_total integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_guard();

  return query
  select h.id, h.name, h.emoji, h.deleted_at,
         (select count(*)::integer from public.household_members m where m.household_id = h.id),
         (select count(*)::integer from public.shopping_list_items i where i.household_id = h.id)
  from public.households h
  where h.deleted_at is not null
  order by h.deleted_at desc;
end;
$$;

revoke all on function public.admin_delete_household(uuid) from public, anon;
revoke all on function public.admin_restore_household(uuid) from public, anon;
revoke all on function public.admin_ban_user(text, text) from public, anon;
revoke all on function public.admin_unban_user(text) from public, anon;
revoke all on function public.admin_deleted_households() from public, anon;
grant execute on function public.admin_delete_household(uuid) to authenticated;
grant execute on function public.admin_restore_household(uuid) to authenticated;
grant execute on function public.admin_ban_user(text, text) to authenticated;
grant execute on function public.admin_unban_user(text) to authenticated;
grant execute on function public.admin_deleted_households() to authenticated;
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd D:/famcart && npx supabase db reset && npx supabase test db
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd D:/famcart
git add supabase/migrations/008_admin.sql supabase/tests/admin.test.sql
git commit -m "Add the five deletion and ban RPCs, each audited"
```

---

### Task 6: Ship the schema to famcart-dev

**Files:** none — this is a deployment step.

**Interfaces:**
- Consumes: Tasks 1-5
- Produces: `famcart-dev` carrying the new schema, so the dashboard tasks have something to talk to

- [ ] **Step 1: Confirm which project is linked**

```bash
cd D:/famcart
cat supabase/.temp/project-ref
```

Expected: the `famcart-dev` ref. **If it prints the production ref, STOP** and re-link to dev before going further. Do not run the next steps against production.

- [ ] **Step 2: Mark the edited migrations reverted**

`003`, `006` and `008` are restatements already recorded as applied, so a plain push reports "up to date" and applies nothing.

```bash
npx supabase migration repair --status reverted 003 006 008 --linked
```

- [ ] **Step 3: Dry run and read the scope**

```bash
npx supabase db push --dry-run --include-all --linked
```

Confirm it lists 003, 006 and 008 and nothing unexpected.

- [ ] **Step 4: Push**

```bash
npx supabase db push --include-all --linked
```

If it fails, restore history with `npx supabase migration repair --status applied 003 006 008 --linked` and fix before retrying. Every file is written to be re-runnable.

- [ ] **Step 5: Verify against the live dev project**

Confirm `households.deleted_at`, `profiles.banned_at`, `active_household_ids()` and the five `admin_*` functions all exist.

- [ ] **Step 6: Commit** (nothing to commit — deployment only; note the result in the task checklist)

---

### Task 7: Dashboard data layer

**Files:**
- Modify: `D:\famcart\admin\src\lib\data\households.ts`
- Modify: `D:\famcart\admin\src\lib\data\users.ts`
- Create: `D:\famcart\admin\test\adminActions.test.ts`

**Interfaces:**
- Consumes: the five RPCs from Task 5
- Produces:
  - `deleteHousehold(id: string, signal: AbortSignal): Promise<void>`
  - `restoreHousehold(id: string, signal: AbortSignal): Promise<void>`
  - `fetchDeletedHouseholds(signal: AbortSignal): Promise<DeletedHouseholdRow[]>`
  - `banUser(userId: string, reason: string, signal: AbortSignal): Promise<void>`
  - `unbanUser(userId: string, signal: AbortSignal): Promise<void>`
  - `interface DeletedHouseholdRow { id: string; name: string; emoji: string | null; deleted_at: string; members: number; items_total: number }`

- [ ] **Step 1: Write the failing test**

Create `test/adminActions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
vi.mock('../src/lib/supabase', () => ({
  getAppSupabase: () => ({ rpc }),
  getCatalogSupabase: () => null,
}))

const { deleteHousehold, restoreHousehold } = await import('../src/lib/data/households')
const { banUser } = await import('../src/lib/data/users')

function ok() {
  return { abortSignal: () => Promise.resolve({ data: null, error: null }) }
}

describe('admin write actions', () => {
  it('calls admin_delete_household with the id', async () => {
    rpc.mockReturnValue(ok())
    await deleteHousehold('h-1', new AbortController().signal)
    expect(rpc).toHaveBeenCalledWith('admin_delete_household', { p_id: 'h-1' })
  })

  it('calls admin_restore_household with the id', async () => {
    rpc.mockReturnValue(ok())
    await restoreHousehold('h-1', new AbortController().signal)
    expect(rpc).toHaveBeenCalledWith('admin_restore_household', { p_id: 'h-1' })
  })

  it('passes the reason through to admin_ban_user', async () => {
    // The reason is the whole audit value of a ban; dropping it silently would
    // leave a security_events row that says nothing.
    rpc.mockReturnValue(ok())
    await banUser('user_2abc', 'spam', new AbortController().signal)
    expect(rpc).toHaveBeenCalledWith('admin_ban_user', {
      p_user_id: 'user_2abc',
      p_reason: 'spam',
    })
  })

  it('names the failing RPC when the database refuses', async () => {
    rpc.mockReturnValue({
      abortSignal: () =>
        Promise.resolve({ data: null, error: { message: 'not an admin', code: '42501' } }),
    })
    await expect(deleteHousehold('h-1', new AbortController().signal)).rejects.toMatchObject({
      message: expect.stringContaining('admin_delete_household'),
      code: '42501',
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd D:/famcart/admin && npx vitest run test/adminActions.test.ts
```

Expected: FAIL — `deleteHousehold` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/data/households.ts`:

```ts
export interface DeletedHouseholdRow {
  id: string
  name: string
  emoji: string | null
  deleted_at: string
  members: number
  items_total: number
}

export async function deleteHousehold(id: string, signal: AbortSignal): Promise<void> {
  const { error } = await getAppSupabase()
    .rpc('admin_delete_household', { p_id: id })
    .abortSignal(signal)
  if (error) queryError('admin_delete_household', error)
}

export async function restoreHousehold(id: string, signal: AbortSignal): Promise<void> {
  const { error } = await getAppSupabase()
    .rpc('admin_restore_household', { p_id: id })
    .abortSignal(signal)
  if (error) queryError('admin_restore_household', error)
}

export async function fetchDeletedHouseholds(signal: AbortSignal): Promise<DeletedHouseholdRow[]> {
  const { data, error } = await getAppSupabase()
    .rpc('admin_deleted_households')
    .abortSignal(signal)
  if (error) queryError('admin_deleted_households', error)
  return (data ?? []) as DeletedHouseholdRow[]
}
```

Append to `src/lib/data/users.ts`:

```ts
export async function banUser(
  userId: string,
  reason: string,
  signal: AbortSignal,
): Promise<void> {
  const { error } = await getAppSupabase()
    .rpc('admin_ban_user', { p_user_id: userId, p_reason: reason })
    .abortSignal(signal)
  if (error) queryError('admin_ban_user', error)
}

export async function unbanUser(userId: string, signal: AbortSignal): Promise<void> {
  const { error } = await getAppSupabase()
    .rpc('admin_unban_user', { p_user_id: userId })
    .abortSignal(signal)
  if (error) queryError('admin_unban_user', error)
}
```

Both files already import `queryError` from `./errors` and `getAppSupabase` from `../supabase`. If either import is missing, add it.

- [ ] **Step 4: Run to verify it passes**

```bash
cd D:/famcart/admin && npx vitest run test/adminActions.test.ts && npm run typecheck && npx eslint .
```

Expected: 4 passed, typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
cd D:/famcart/admin
git add src/lib/data/households.ts src/lib/data/users.ts test/adminActions.test.ts
git commit -m "Add the delete, restore and ban calls to the data layer"
```

---

### Task 8: Trash view

**Files:**
- Create: `D:\famcart\admin\src\views\TrashView.vue`
- Modify: `D:\famcart\admin\src\router\index.ts` (new route)
- Modify: `D:\famcart\admin\src\components\SideNav.vue` (nav entry under OPERATE)
- Modify: `D:\famcart\admin\scripts\sync-icons.mjs:46-84` (the `ICONS` manifest)
- Create: `D:\famcart\admin\test\trashView.test.ts`

**There is no trash icon.** `src/assets/` holds thirty icons and none is a bin.
Do NOT reuse `x` — it means "close" everywhere else in this tool, and a nav entry
wearing the close glyph reads as a dismiss control. Add `'trash-2'` to the `ICONS`
array in `scripts/sync-icons.mjs` with a trailing comment naming its use, matching
the entries around it, then run `npm run icons:sync`. `npm run icons:check` runs in
CI and fails if the manifest and `src/assets/` disagree.

**Interfaces:**
- Consumes: `fetchDeletedHouseholds`, `restoreHousehold`, `DeletedHouseholdRow` from Task 7
- Produces: `/trash` route named `trash`

- [ ] **Step 1: Write the failing test**

Create `test/trashView.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'

const fetchDeletedHouseholds = vi.fn()
const restoreHousehold = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/lib/data/households', () => ({ fetchDeletedHouseholds, restoreHousehold }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const TrashView = (await import('../src/views/TrashView.vue')).default as unknown as Component

const stubs = { PageHeader: true, PanelCard: true, DataTable: true, StateBlock: true, ConfirmDialog: true, SegmentedControl: true, AppIcon: true }

describe('TrashView', () => {
  it('does not claim the trash is empty while it is still loading', async () => {
    // The same rule TablePager follows: not knowing yet and knowing there is
    // nothing are different answers.
    fetchDeletedHouseholds.mockReturnValue(new Promise(() => {}))
    const wrapper = mount(TrashView, { global: { stubs } })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('Nothing deleted')
    wrapper.unmount()
  })

  it('lists what has been deleted once it knows', async () => {
    fetchDeletedHouseholds.mockResolvedValue([
      { id: 'h-1', name: 'The Smiths', emoji: null, deleted_at: '2026-08-24T10:00:00Z', members: 3, items_total: 12 },
    ])
    const wrapper = mount(TrashView, { global: { stubs } })
    await new Promise((r) => setTimeout(r, 0))
    await wrapper.vm.$nextTick()
    expect(fetchDeletedHouseholds).toHaveBeenCalled()
    wrapper.unmount()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd D:/famcart/admin && npx vitest run test/trashView.test.ts
```

Expected: FAIL — cannot resolve `../src/views/TrashView.vue`.

- [ ] **Step 3: Write the view's script**

Create `src/views/TrashView.vue`. The `<script setup lang="ts">` block, in full:

```ts
import { computed, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import StateBlock from '../components/StateBlock.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import { useQuery, useQueryGroup, describeError } from '../lib/useQuery'
import { useDensity, type Density } from '../lib/useDensity'
import {
  fetchDeletedHouseholds,
  restoreHousehold,
  type DeletedHouseholdRow,
} from '../lib/data/households'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

// What an admin deleted, and the only way back.
//
// This view is why soft delete was worth the policy rewrite. Without it a
// deletion is indistinguishable from a hard one, and "reversible" is a claim
// nobody can check.

const { dense, density, setDensity, segments: densitySegments } = useDensity()

const deleted = useQuery((signal) => fetchDeletedHouseholds(signal))
const page = useQueryGroup([deleted])

const rows = computed(() => deleted.data.value ?? [])

// Not `rows.length === 0`: that is also true before the first response, and an
// empty trash and an unanswered query are different answers. Same rule as
// TablePager.
const knownEmpty = computed(() => deleted.data.value !== null && rows.value.length === 0)

const error = computed(() =>
  deleted.error.value ? describeError(deleted.error.value).detail : '',
)

const columns: Column<DeletedHouseholdRow>[] = [
  { key: 'name', label: 'Household', width: '30%' },
  { key: 'deleted_at', label: 'Deleted', width: '20%' },
  { key: 'members', label: 'Members', numeric: true, width: '12%' },
  { key: 'items_total', label: 'Items', numeric: true, width: '12%' },
  { key: 'actions', label: '', width: '16%', align: 'right' },
]

const pending = ref<DeletedHouseholdRow | null>(null)
const busy = ref(false)
const actionError = ref('')

async function confirmRestore() {
  const target = pending.value
  if (!target || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    await restoreHousehold(target.id, new AbortController().signal)
    pending.value = null
    await deleted.refetch()
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = false
  }
}
```

- [ ] **Step 3b: Write the view's template and styles**

```vue
<template>
  <div class="page">
    <PageHeader
      title="Trash"
      description="Households an admin deleted. Nothing here has been destroyed — restoring one brings it back, along with every item and purchase inside it."
      :fetched-at="page.fetchedAt.value"
      :busy="page.busy.value"
      @refresh="page.refresh"
    >
      <template #tools>
        <SegmentedControl
          :model-value="density"
          :segments="densitySegments"
          label="Rows"
          @update:model-value="setDensity($event as Density)"
        />
      </template>
    </PageHeader>

    <PanelCard flush>
      <StateBlock
        v-if="knownEmpty"
        state="empty"
        title="Nothing deleted"
        message="When an admin deletes a household it waits here until it is restored."
      />
      <DataTable
        v-else
        :columns="columns"
        :rows="rows"
        row-key="id"
        :dense="dense"
        :loading="deleted.loading.value"
        :error="error"
      >
        <template #cell-name="{ row }">
          {{ row.emoji ? `${row.emoji} ` : '' }}{{ row.name }}
        </template>
        <template #cell-deleted_at="{ row }">
          <span :title="formatDateTime(String(row.deleted_at))">
            {{ formatRelative(String(row.deleted_at)) }}
          </span>
        </template>
        <template #cell-members="{ row }">{{ formatCount(Number(row.members)) }}</template>
        <template #cell-items_total="{ row }">{{ formatCount(Number(row.items_total)) }}</template>
        <template #cell-actions="{ row }">
          <button type="button" class="restore" @click="pending = row">Restore</button>
        </template>
      </DataTable>
    </PanelCard>

    <ConfirmDialog
      :open="pending !== null"
      :title="`Restore ${pending?.name ?? ''}?`"
      message="Its members get it back, along with every item and purchase inside it."
      confirm-label="Restore"
      :busy="busy"
      :error="actionError"
      @confirm="confirmRestore"
      @cancel="pending = null"
    />
  </div>
</template>

<style scoped>
.restore {
  background: none;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-primary);
  cursor: pointer;
}

.restore:hover {
  background: var(--bg-hover);
}
</style>
```

- [ ] **Step 4: Add the route**

In `src/router/index.ts`, before the catch-all:

```ts
  {
    path: '/trash',
    name: 'trash',
    component: () => import('../views/TrashView.vue'),
    meta: { crumb: 'Trash' },
  },
```

- [ ] **Step 5: Add the nav entry**

In `SideNav.vue`, add to the OPERATE group, after Access:

```ts
      { to: '/trash', label: 'Trash', icon: 'trash-2' },
```

- [ ] **Step 6: Run to verify it passes**

```bash
cd D:/famcart/admin && npx vitest run && npm run typecheck && npx eslint . && npm run build
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
cd D:/famcart/admin
git add src/views/TrashView.vue src/router/index.ts src/components/SideNav.vue test/trashView.test.ts
git commit -m "Add the Trash view, where a deletion can be undone"
```

---

### Task 9: Delete and ban controls on the detail views

**Files:**
- Modify: `D:\famcart\admin\src\views\HouseholdDetailView.vue`
- Modify: `D:\famcart\admin\src\views\UserDetailView.vue`
- Modify: `D:\famcart\admin\test\adminActions.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 7 and 8

- [ ] **Step 1: Add the household delete control**

In `HouseholdDetailView.vue`, add to `<script setup>`:

```ts
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { deleteHousehold } from '../lib/data/households'

const confirmingDelete = ref(false)
const deleting = ref(false)
const deleteError = ref('')

async function confirmDelete() {
  if (deleting.value) return
  deleting.value = true
  deleteError.value = ''
  try {
    await deleteHousehold(householdId.value, new AbortController().signal)
    confirmingDelete.value = false
    // Leaving is not politeness: the household is no longer readable, so
    // staying here would render this page's own error state a moment later.
    void router.push('/households')
  } catch (caught) {
    deleteError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    deleting.value = false
  }
}
```

`ref` is already imported in this file; `router` already exists. Add to the `PageHeader` tools slot:

```vue
        <button type="button" class="danger" @click="confirmingDelete = true">Delete</button>
```

and before `</div>` at the end of the template:

```vue
    <ConfirmDialog
      :open="confirmingDelete"
      :title="`Delete ${household?.name ?? 'this household'}?`"
      message="Its members lose access to it and everything inside it. Nothing is destroyed — it moves to Trash and can be restored."
      confirm-label="Delete"
      tone="danger"
      :busy="deleting"
      :error="deleteError"
      @confirm="confirmDelete"
      @cancel="confirmingDelete = false"
    />
```

with:

```css
.danger {
  background: none;
  border: var(--border-width-thin) solid var(--danger-border);
  border-radius: var(--radius-md);
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  color: var(--danger-text);
  cursor: pointer;
}

.danger:hover {
  background: var(--danger-bg);
}
```

- [ ] **Step 2: Add the ban control**

In `UserDetailView.vue`, add to `<script setup>`:

```ts
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { banUser, unbanUser } from '../lib/data/users'

const confirmingBan = ref(false)
const banReason = ref('')
const banBusy = ref(false)
const banError = ref('')

const banned = computed(() => Boolean(profile.value?.banned_at))

async function confirmBan() {
  if (banBusy.value) return
  banBusy.value = true
  banError.value = ''
  try {
    if (banned.value) {
      await unbanUser(userId.value, new AbortController().signal)
    } else {
      await banUser(userId.value, banReason.value.trim(), new AbortController().signal)
    }
    confirmingBan.value = false
    banReason.value = ''
    await detail.refetch()
  } catch (caught) {
    banError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    banBusy.value = false
  }
}
```

This requires `banned_at` on the profile payload — add it to the `UserDetail['profile']` interface in `src/lib/data/types.ts` as `banned_at: string | null`, and to the select list in `admin_user_detail` in `008_admin.sql`. **If `admin_user_detail` is changed, Task 6's push must be re-run** before this works against dev.

Template, in the `PageHeader` tools slot:

```vue
        <button type="button" class="danger" @click="confirmingBan = true">
          {{ banned ? 'Unban' : 'Ban' }}
        </button>
```

and before the closing `</div>`:

```vue
    <ConfirmDialog
      :open="confirmingBan"
      :title="banned ? `Unban ${profile?.display_name ?? ''}?` : `Ban ${profile?.display_name ?? ''}?`"
      :message="banned
        ? 'They can use FamCart again. Their existing memberships were never removed, so they return to the households they were in.'
        : 'FamCart refuses them at sign-in. Their memberships are left alone and nothing is deleted.'"
      :confirm-label="banned ? 'Unban' : 'Ban'"
      tone="danger"
      :busy="banBusy"
      :error="banError"
      @confirm="confirmBan"
      @cancel="confirmingBan = false"
    >
      <!-- The reason is the whole audit value of a ban: without it the
           security_events row records that something happened and not why. -->
      <input
        v-if="!banned"
        v-model="banReason"
        class="reason"
        type="text"
        placeholder="Why? This is recorded in the audit trail."
      />
    </ConfirmDialog>
```

`ConfirmDialog` already renders a default `<slot />` between its message and its actions, so no change to that component is needed. Style `.reason` to match `.grant__input` in `AccessView.vue`.

- [ ] **Step 3: Verify**

```bash
cd D:/famcart/admin && npx vitest run && npm run typecheck && npx eslint . && npm run build
```

- [ ] **Step 4: Commit**

```bash
cd D:/famcart/admin
git add src/views/HouseholdDetailView.vue src/views/UserDetailView.vue test/adminActions.test.ts
git commit -m "Add delete and ban controls to the detail views"
```

---

### Task 10: End-to-end check against famcart-dev

**Files:** none — verification only.

- [ ] **Step 1: Confirm the switcher is on development**

Open the dashboard. The topbar badge must read the dev project, not `famcart`.

- [ ] **Step 2: Delete a household and watch it vanish**

Delete a test household. Confirm it disappears from `/households`, appears in `/trash`, and that opening FamCart itself as a member of that household no longer shows it or its items.

- [ ] **Step 3: Restore it and watch it come back**

Restore from `/trash`. Confirm it returns to `/households` and that its items reappear in the app.

- [ ] **Step 4: Ban and unban**

Ban a test account. Confirm opening FamCart as that account is refused rather than silently working. Unban and confirm access returns.

- [ ] **Step 5: Check the audit trail**

On `/health`, confirm `admin_household_deleted`, `admin_household_restored`, `admin_user_banned` and `admin_user_unbanned` rows appear in the security events table.

- [ ] **Step 6: Report**

Summarise what was verified. **Production deployment is NOT part of this plan** — it is a separate step requiring explicit approval, using the same `migration repair` / `db push --include-all` sequence against the `famcart` project.
