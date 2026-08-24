# Deletion and bans in the admin dashboard

**Date:** 2026-08-24
**Status:** design, awaiting review
**Repos touched:** `famcart` (schema, the bulk) and `famcart/admin` (UI)

## What this is for

The dashboard is read-only apart from `admin_grant` and `admin_revoke`. This adds
the ability to remove a household and everything in it, and to bar a person from
the app, without either operation being unrecoverable.

There is no specific driving case — the request was for general admin capability
— so this is designed for the safest common denominator: nothing is destroyed,
everything is reversible, and every action leaves a record that outlives the
thing it describes.

## Decisions, and why

### Soft delete, not hard delete

Hard delete works today with no schema change at all: `households(id)` cascades
to `household_members`, `shopping_list_items`, `purchase_history` and
household-scoped `product_catalog`. One statement removes a family's entire
history, permanently, from a dialog that could be mis-clicked.

The cascade is exactly what makes it too sharp. A soft delete gives the same
apparent outcome with an undo, and it lets the `security_events` row describing
the deletion still point at rows that exist.

### Households only

`deleted_at` goes on `households` and nowhere else. Individual list items,
purchase rows and catalog products are NOT independently deletable.

The household is the cascade root, so hiding it hides everything inside it —
that is the blast radius that matters. Per-row deletion would cost three more
columns, three more sets of policies and three more restore paths, for
operations an administrator would almost never run. They are additive later if
a real case appears.

### A ban flag for people, not a delete

`profiles` gets `banned_at`, not `deleted_at`, because a soft-deleted profile
does not stay deleted.

`003_households_and_members.sql:589` says it plainly: the app "upserts
display_name and image_url on every boot to keep them fresh", and HomeView does
this on every load. The upsert is `on conflict (user_id) do update`. So a
deleted profile is recreated the next time that person opens FamCart — their
Clerk account is untouched and nothing stops them signing in.

A ban is the honest primitive: the row stays, the upsert refuses to revive it,
and the app turns the person away. It is achievable entirely in Postgres.
Deleting the Clerk account itself would need Clerk's Backend API and a secret
key, which cannot live in this browser bundle — that is a separate project with
its own deployable piece, and it is out of scope here.

### Child visibility derives from the parent

A row inside a household is hidden because its household is deleted, not because
it was stamped. Restoring is then one write, and there is no need to distinguish
"deleted on its own" from "deleted along with its parent" — a distinction that
stamping would force us to record and get right.

## Schema

### The helper, which is also a cleanup

Eight policies across `003`–`006` each inline the same subquery:

```sql
household_id in (
  select household_id from public.household_members
  where user_id = requesting_user_id()
)
```

Eight copies of one rule is how the rule drifts — and one of them, in `006`,
writes it with an alias (`fm.household_id from public.household_members fm`), so
a naive grep finds only seven. That is precisely how a policy gets missed during
the rewrite. They collapse into:

```sql
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
```

Every child policy becomes `household_id in (select public.active_household_ids())`.

This is the whole mechanism. One definition governs what a deleted household
hides, so there is no policy that can be forgotten — which was the main risk in
the alternative design, where eighteen policies each grew their own
`deleted_at is null` clause and missing one would silently leak deleted rows
into the live app.

### Columns

| Table | Column | Notes |
|---|---|---|
| `households` | `deleted_at timestamptz` | Null means live. Indexed partially: `where deleted_at is not null` — the Trash view is the only query that wants the non-null side, and it is tiny. |
| `profiles` | `banned_at timestamptz` | Null means allowed. |

Both are added with `alter table ... add column if not exists` **below** the
`create table if not exists` block, per the restatement rule in `CLAUDE.md` — a
column declared inside that block reaches new databases only.

### Policies

- `households`: its own select/update policies gain `deleted_at is null`, so a
  deleted household disappears for its members too, not just its contents.
- `shopping_list_items`, `purchase_history`, `household_members`: rewritten onto
  `active_household_ids()`.
- `product_catalog`: the aliased eighth copy. Household-scoped rows go through
  the helper; the `household_id is null` branch stays exactly as it is — global
  rows belong to nobody and no household's deletion should hide them.

### The upsert guard

The three profile upserts — `003:711`, `003:831`, and HomeView's boot upsert —
gain a check that raises when `banned_at is not null`. Raising rather than
silently doing nothing, for the same reason `admin_guard()` raises: a refusal
and a no-op look identical from the client, and only one of them is worth
telling the user about.

## RPCs

All in `008_admin.sql`, all opening with `perform public.admin_guard()` like the
twenty already there.

| Function | Does |
|---|---|
| `admin_delete_household(p_id uuid)` | Sets `deleted_at = now()`. No-op if already set. |
| `admin_restore_household(p_id uuid)` | Clears `deleted_at`. |
| `admin_ban_user(p_user_id text, p_reason text)` | Sets `banned_at`. Does not touch memberships — see below. |
| `admin_unban_user(p_user_id text)` | Clears `banned_at`. |
| `admin_deleted_households()` | The Trash view's list. |

Each writes a `security_events` row through the existing `log_security_event()`,
recording actor, target and reason. The audit trail is the reason soft delete
beats hard delete here: the record still points at a row that exists.

**Ban deliberately leaves memberships alone**, and this is a correction to an
earlier draft of this design that had it delete them.

Ownership is not a column on `households` — it is `household_members.role`, one
of `admin` / `moderator` / `member` (`003:136`). Deleting a banned person's
memberships therefore deletes the household's admin, and banning the founder of
a one-person household would leave it with no one who can administer it. The
tidier-looking semantics destroy data and break households.

Leaving the rows costs nothing: the upsert guard already refuses the person at
the door, so the membership is inert. If someone should also be removed from a
household, that is a separate, explicit action — not a side effect of a ban.

## Dashboard

- **HouseholdDetailView** — a Delete action in the header. `ConfirmDialog` is
  reused unchanged: it already names its target and focuses Cancel, so a
  reflexive Enter is the safe outcome.
- **UserDetailView** — Ban / Unban, with the reason captured in the dialog.
- **New: TrashView** at `/trash`, listing deleted households with when and by
  whom, and a Restore action. This is also where you confirm a deletion actually
  did what you expected.
- `SideNav` gains a Trash entry under OPERATE.

No new components. `DataTable`, `ConfirmDialog`, `PageHeader` and `StatusPill`
cover all of it.

## Testing

**pgTAP** (`supabase/tests/rls.test.sql`, `admin.test.sql`) is where the
important tests go, because the risk here is a policy that lets deleted rows
through:

- A member of a deleted household sees none of its items, purchases or products.
- A deleted household's rows are still physically present (soft, not hard).
- Restore makes them visible again.
- A banned user's profile upsert raises rather than reviving the row.
- A banned user holds no memberships.
- `admin_delete_household` refuses for a non-admin with 42501.
- Every RPC writes exactly one `security_events` row.

**Vitest** covers the dashboard: the confirm flow, that Restore calls the right
RPC, and that TrashView renders an empty state rather than asserting "no deleted
households" while still loading — the same rule `TablePager` now follows.

## Deployment

Per `CLAUDE.md`, `006` and `008` are restatements already recorded as applied, so
a plain `db push` will report "up to date" and do nothing:

```bash
npx supabase migration repair --status reverted 003 006 008 --linked
npx supabase db push --dry-run --include-all --linked
npx supabase db push --include-all --linked
```

`famcart-dev` first, verified there, then `famcart`. Note this is the second
production migration this project has needed in a day — the first was the
catalog `markets`/`search_catalog` repair — and the same trap applies: anything
declared inside a `create table if not exists` block will not arrive.

## Explicitly out of scope

- Deleting individual list items, purchase rows or catalog products.
- Deleting Clerk accounts. Needs a secret key and therefore a server-side piece.
- Purging soft-deleted households after N days. Nothing here grows fast enough
  to need it, and a scheduled hard delete would reintroduce exactly the
  irreversibility this design exists to avoid.
- Erasing the denormalised `added_by_name` / `added_by_image_url` snapshots in
  `purchase_history`. They survive a ban by design, so history stays readable.
  If a genuine erasure request arrives, that is a different feature with
  different requirements.

## Risks

**The policy rewrite is the dangerous part.** Seven policies change shape at
once, and a mistake means either the app loses access to live data (loud, caught
immediately) or deleted rows stay visible (quiet, caught by nobody). The pgTAP
assertions above are what make the quiet failure loud, and they should be
written before the policies change.

**`security_definer` on `active_household_ids()`** is required — it reads
`households` and `household_members` from inside a policy — and it is the usual
footgun. `set search_path = public` is not optional.
