# Deciding the review queue from the dashboard

**Date:** 2026-08-25
**Status:** design, approved in chat, not yet planned
**Spans:** `catalog-importer` (schema + CLI), `famcart/admin` (UI)

## The problem

The importer's gate is hybrid: the clearly-good load themselves, the clearly-bad
are dropped with a reason, and the ambiguous middle waits for a human. Last run
that middle was 12,255 records.

Ruling on one of them currently means reading a terminal, then pasting a line of
JSON into `catalog-importer/data/decisions.jsonl` by hand:

```
npm run review --approve-above 55
# copy the emitted block, paste it into data/decisions.jsonl
npm run score
```

That is the only way a verdict can be recorded, and it is not a way anybody who
is not already living in this repo is going to use. The dashboard exists so that
live data can be looked at without a terminal; the review band is the one place
where looking is not enough, because the answer is a decision.

## What already exists, and what does not

The candidates are **already in the database**. `score` publishes every record it
did not write to `catalog_import_outcomes`, including `stage = 'review'`, and it
derives them from `scored.jsonl` rather than the 500-row terminal sample, so the
population there is complete. The dashboard already browses them at
`/products?scope=outcomes`.

So this piece does not move any data. It adds:

1. somewhere to record a verdict, with an authorization gate the catalog project
   does not currently have,
2. a path for `score` to read verdicts back out instead of off the disk,
3. a screen to make them on.

## What this is not

This is the first of three pieces. It records verdicts; it does not run
anything. Approving a product changes nothing about the catalog until the next
`score` and `load --apply`, and the screen has to say so out loud (see
"The banner", below).

Out of scope here, each getting its own spec:

- **The worker and live progress.** Starting a run from the dashboard, a
  `catalog_run_requests` queue, a heartbeat, streaming stage counts.
- **The diff and Apply.** Persisting what `load` would change and applying it
  from the screen.
- **Gate tuning.** Editing `data/gate.json` weights and `perMarketCap` from the
  UI, with a preview of what a change would admit.

## Authorization, which the catalog project has none of

`admin_users` and `admin_guard()` live in the app databases. In the catalog
project every signed-in FamCart user is simply `authenticated`, which is why
`product_catalog` is readable by anyone with the app on their phone. That is
correct for reads of public Open Food Facts data and wrong for writes.

Two ways to gate a write here. We are taking the first:

- **A `catalog_admins` table in this project**, with a guard every write RPC
  calls, mirroring `admin_guard()` in `008_admin.sql`. Entirely in this repo,
  covered by the pgTAP suite, and greppable. The cost is a second admin list,
  kept in step with `admin_users` by hand.
- **A Clerk JWT claim**, readable by both projects with no second list. Cleaner,
  and deferred: it would become a fourth thing configured in a dashboard and
  nowhere in this repo, and CLAUDE.md already documents that category as the one
  that bites. Forget it for a new admin and they silently cannot approve
  anything, with no code to grep. Revisit when there is more than one admin.

## Schema

A new `005_review.sql` in
`catalog-importer/supabase-catalog/supabase/migrations/`. New file rather than an
edit to `003` or `004`: those are restatements already recorded as applied on the
remote project, so a change inside one is invisible to `db push`.

### `catalog_admins`

```sql
create table if not exists public.catalog_admins (
  user_id    text        primary key,   -- Clerk user id, as requesting_user_id() returns it
  note       text,
  granted_at timestamptz not null default now()
);
```

RLS on, all privileges revoked from `anon` and `authenticated`, managed by
`service_role` only. The guard below reads it as `security definer`, so it does
not need a grant to `authenticated` and must not have one: the list of who can
approve is not something an ordinary signed-in account should be able to
enumerate.

Seeded by the importer, which already holds the service-role key, through a new
`npm run admins:add <clerk-user-id>`.

### The guard

```sql
create or replace function public.catalog_is_admin() returns boolean
  language sql stable security definer set search_path = public, extensions
as $$
  select exists (
    select 1 from public.catalog_admins where user_id = public.requesting_user_id()
  );
$$;

create or replace function public.catalog_admin_guard() returns void
  language plpgsql stable security definer set search_path = public, extensions
as $$
begin
  if not public.catalog_is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
end;
$$;
```

`42501` deliberately, matching what `admin_guard()` raises in the app database,
because `describeError()` in the dashboard already renders that through its
`forbidden` branch.

`catalog_is_admin()` gets `execute` for `authenticated` so the UI can ask before
rendering; the guard is what actually protects each call.

### `catalog_review_decisions`

```sql
create table if not exists public.catalog_review_decisions (
  barcode    text        primary key,
  verdict    text        not null,
  decided_by text,                       -- Clerk user id; null for file-imported verdicts
  decided_at timestamptz not null default now(),
  note       text
);

alter table public.catalog_review_decisions
  drop constraint if exists catalog_review_decisions_verdict_check;
alter table public.catalog_review_decisions
  add constraint catalog_review_decisions_verdict_check
  check (verdict in ('approve', 'reject'));
```

Restated below the table rather than declared inline, for the reason `004` gives
about its own constraints.

**Primary key on `barcode` alone**, matching the JSONL file's semantics exactly
and for the reason its own comment gives: the normalizer changes, a better casing
rule or a new brand alias, and every name changes with it. The barcode is the
only thing about a product that does not move.

**Upsert, not append.** Changing your mind rewrites the row. This loses the
history the JSONL file got for free from git; accepted for now. If history is
wanted later it is an append-only table plus a latest-wins view, and the RPCs
below are the only thing that would need to change.

RLS on, no direct grants to `authenticated`. Every read and write goes through
the RPCs.

### `catalog_import_outcomes.signals`

```sql
alter table public.catalog_import_outcomes
  add column if not exists signals jsonb not null default '{}'::jsonb;
```

Without this the screen is **worse than the terminal it replaces**.
`writeReviewQueue()` puts `lang`, `scans` and `markets` in front of the reviewer,
and those are the signals a verdict actually turns on: a Polish name, never
scanned, sold only in France is a different judgement from a Romanian name
scanned four hundred times. None of the three survive into the outcomes table
today.

`jsonb` rather than three columns, on the same reasoning `reason_tallies` is
jsonb: the vocabulary belongs to the gate, which should stay free to change it
without a migration.

`buildOutcomes()` in `src/publish/outcomes.ts` fills it for `review` rows:
`{ lang, scans, markets }`. Left empty for `rejected` and `dropped`, which nobody
is asked to rule on.

**Rows written before this column existed keep `{}`, and there is no backfill.**
The signals are not recoverable from the outcome row: they come from
`scored.jsonl` for that run, which retention will have aged out. So the screen
renders an absent signal as a dash rather than a zero, which is the difference
between "never scanned" and "we did not record it" and is exactly the
distinction `types.ts` argues for. Every run scored after this ships carries
them, and retention keeps five runs per source, so the gap closes on its own
within five runs.

## The RPCs

All `security definer`, all calling `catalog_admin_guard()` first, all with
`execute` granted to `authenticated` and revoked from `anon`, following the
grant discipline `003` sets out.

### `list_review_candidates(p_run, p_reason, p_query, p_limit, p_offset)`

Returns the pending band: `stage = 'review'` outcomes minus anything already
decided, with a `total_count` from `count(*) over ()` so the pager is right.

Server-side rather than a PostgREST select like `outcomes.ts` uses, for two
reasons that are not style:

- **Pending is an anti-join.** Subtracting decided barcodes in the browser makes
  the total count wrong, and therefore every page after the first.
- **The same barcode recurs across runs.** `distinct on (barcode)` ordered by run
  recency, or you are asked about the same product every month, which is the
  exact failure the barcode keying exists to prevent.

Ordered highest score first, `id` breaking ties for stable paging, matching what
`buildOutcomeQuery` already does and for the reason stated there: the interesting
question is what you nearly kept.

### `list_review_decisions(p_verdict, p_query, p_limit, p_offset)`

The Decided tab. Joins back to the most recent outcome row per barcode so a
decided product still shows its name, score and reason rather than a bare
barcode.

### `record_review_decision(p_barcode, p_verdict, p_note)`

Upsert, stamping `decided_by = requesting_user_id()` and `decided_at = now()`.

### `clear_review_decision(p_barcode)`

Deletes the row, returning the product to the pending band. This is Undo, and it
is also what makes the no-confirmation choice on the screen defensible.

### `approve_review_above(p_min_score, p_run, p_reason, p_query)`

Bulk approve, returning the number of rows written. The dashboard mirror of
`review --approve-above`, and not optional: the band was 12,255 records and a
screen that can only clear it one click at a time is a screen nobody opens.

It takes **the same filter parameters as `list_review_candidates`** and applies
them identically, so what it approves is exactly what the filtered screen was
showing. A bulk action whose filters drift from the list it sits under is a bulk
action that approves rows you never saw.

## The CLI change

### Fetching is fail-loud

`applyGate()` checks a recorded verdict **before any scoring**, which is what
makes review work across runs: a reject survives the score going up, a new dump,
and a normalizer change that renames the product entirely.

If that index comes back empty because the network was down, nothing currently
fails. Every approval silently falls back to whatever the gate says, and every
reject quietly stops applying. That is the failure the barcode-keying comment
exists to prevent, arriving through a different door.

So `score` fetching decisions is **fail-loud**, unlike publishing at the end of a
run, which stays best-effort for the reason `bestEffort()` documents. Cannot
reach the catalog project, cannot score.

It fetches **the whole table, paged**, not just the barcodes in the current run.
Filtering the fetch by the run's barcodes would mean building a filter from
hundreds of thousands of values, and the table is small: it holds one row per
product a human has ever ruled on, which is bounded by how much reviewing has
actually been done rather than by the size of the dump.

### `data/decisions.jsonl` becomes a one-way mirror

Refusing to run offline would break the promise in `cli.ts` that a forty-minute
scoring run does not depend on the network. So the file stays, demoted:

- every successful fetch rewrites it,
- `score --offline` runs against it and prints its age and verdict count, which
  is a stated assumption rather than a silent one,
- it gains a generated-file header, because it is no longer a place you write.

The consequence to accept: pasting a verdict into a cache the next fetch
overwrites is a trap, so `review --approve-above <n>` gains `--apply` and writes
straight to the table with the service-role key, instead of printing a block to
paste.

### `npm run decisions:import`

One-shot backfill of the verdicts already in `decisions.jsonl`, stamped
`decided_by = null` because the file never recorded who. Idempotent, so running
it twice is harmless. After it, the file is only ever written by the fetch.

### What does not change

`applyGate()` itself, at all. It takes a `DecisionIndex` and has never cared
where one came from, which is why this change is small.

## The dashboard change

### `src/lib/data/review.ts` (new)

The four RPC wrappers plus their row types, following the structural
`FilterBuilder` pattern `outcomes.ts` uses so the call shape stays assertable
without a network.

Catalog not configured throws `CatalogNotConfigured`, matching Products and
Pipeline: the section reports as unconfigured rather than failing, and every
other section is unaffected.

### `src/views/ReviewView.vue` (new), route `/review`

A new route rather than a fourth scope on the Products page. Browsing what did
not land and working through a queue are different activities, and
`ProductsView.vue` is already 606 lines.

- `DataTable`, highest score first, columns carrying the decision signals: name,
  maker, score, reason, flags, and the new `lang` / `scans` / `markets`.
- `SideDrawer` per row for the full record, the pattern the Pipeline run list
  already uses.
- Approve and Reject per row, with `J` / `K` / `A` / `R` shortcuts so a long
  queue is survivable.
- `SegmentedControl` for **Pending** / **Decided**.
- `FilterBar` for run, reason and flag; free-text search on name.
- Bulk approve above a score, behind a `ConfirmDialog` naming the count.

**No confirmation dialog per decision.** A deliberate break from the pattern that
guards delete and ban: confirming four hundred approvals one at a time would make
the screen useless, and unlike a deletion a verdict is an upsert and fully
reversible. The row shows its new state inline with an Undo instead, and the
Decided tab is where a verdict gets revisited.

### The banner

Persistent, above the table:

> Approved products enter the catalog on the next score and load run. 63 verdicts
> are waiting for one.

Without it you approve fifty products and go looking for them in the catalog.
When the worker piece lands, that sentence grows a button.

### Nav

`SideNav` entry under Pipeline. `meta.crumb: 'Review'`, no router guard, matching
every other route: `App.vue` decides what to render and the database decides what
to answer.

## Testing

**pgTAP**, in `catalog-importer/supabase-catalog/supabase/tests/catalog.test.sql`:

- a non-admin calling `record_review_decision` gets `42501`; an admin's verdict
  lands
- a second verdict for the same barcode replaces rather than duplicates
- `clear_review_decision` returns the product to the pending set
- `list_review_candidates` excludes decided barcodes, returns one row per
  barcode across multiple runs, and reports a `total_count` that survives paging
- `approve_review_above` writes exactly the rows the same filters would list
- `catalog_admins` is not selectable by `authenticated`

**Vitest, catalog-importer:**

- fetch, merge and mirror: a fetched index is written to the mirror verbatim
- a failed fetch stops `score` rather than scoring with an empty index
- `--offline` uses the mirror and reports its age
- `decisions:import` is idempotent

**Vitest, admin:**

- query shape for each of the four RPCs, via the recorder
- `CatalogNotConfigured` propagates rather than throwing something opaque
- a component test for `ReviewView` against the fake Supabase client: approve
  moves a row out of Pending, Undo moves it back, forbidden renders the
  `describeError` forbidden branch

## Order of work

The schema and CLI first, because the screen has nothing to call otherwise, and
because a verdict recorded through the CLI is testable end to end before any
Vue exists:

1. `005_review.sql` plus its pgTAP coverage
2. `signals` on the outcomes publisher, so new runs carry it
3. CLI: fetch, mirror, `--offline`, `decisions:import`, `admins:add`,
   `review --apply`
4. `src/lib/data/review.ts`
5. `ReviewView.vue`, route, nav
6. The banner and the bulk action

Steps 1 to 3 are shippable on their own: they move the source of truth off the
disk without any UI at all.
