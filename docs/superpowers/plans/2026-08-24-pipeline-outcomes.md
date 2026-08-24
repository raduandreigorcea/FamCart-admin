# Pipeline Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record what each importer run discarded, so the admin dashboard can show the funnel and let you search the products that never landed.

**Architecture:** Two new tables in the catalog project (`catalog_import_runs`, `catalog_import_outcomes`), written by a new best-effort publish step in `catalog-importer` using the service-role key it already holds, and read by the admin dashboard with the anon key it already holds. A run row is opened by `score` and completed by `load --apply`, keyed on a uuid parked in `out/run.json`.

**Tech Stack:** Postgres 15 / Supabase CLI + pgTAP (catalog project), TypeScript + tsx + vitest (importer), Vue 3 + TypeScript + vitest (admin dashboard).

**Spec:** `docs/superpowers/specs/2026-08-24-pipeline-outcomes-design.md`

## Global Constraints

- **Two repos.** Tasks 1–5 commit in `D:\famcart\catalog-importer`. Tasks 6–10 commit in `D:\famcart\admin`. Never stage across them.
- **No service-role key in the browser, ever.** The dashboard reads with `VITE_CATALOG_SUPABASE_ANON_KEY` only. If a panel seems to need more, the answer is a `security definer` RPC, not a secret.
- **New migration file, never an edit to `003`.** `001`–`003` are restatements that production already records as applied; a change inside one is invisible to `db push`.
- **Always `db reset` before `db test`.** `db start` restores from a backup and skips migrations.
- **`score` must keep working offline.** Publishing is best-effort: it warns and continues, never throws.
- **Import sources are exactly** `openfoodfacts`, `openproductsfacts`, `openbeautyfacts`.
- **Stage vocabulary is exactly** `rejected` | `dropped` | `review`.
- **Retention:** run rows kept forever; outcome rows kept for the 5 most recent runs per source.

---

## Prerequisite: branch both repos

- [ ] **Step 1: Branch**

```bash
cd /d/famcart/admin && git checkout -b feat/pipeline-outcomes
cd /d/famcart/catalog-importer && git checkout -b feat/pipeline-outcomes
```

---

## File Structure

**`catalog-importer/supabase-catalog/supabase/`**
- `migrations/004_import_runs.sql` — both tables, indexes, RLS, grants
- `tests/catalog.test.sql` — extended with the new invariants

**`catalog-importer/src/publish/`** — new module, one responsibility each
- `outcomes.ts` — pure: `ScoredProduct[] + rejects[]` → outcome rows + funnel counts + reason tallies
- `runFile.ts` — pure-ish: mint, read, write `out/run.json`
- `publish.ts` — the only file that talks to Supabase for this feature

**`catalog-importer/src/cli.ts`** — three call sites, no logic

**`admin/src/lib/data/`**
- `pipeline.ts` — modified: runs come from the table; `runLedger()` becomes a pure function over a run row
- `outcomes.ts` — new: paged, filtered read of `catalog_import_outcomes`

**`admin/src/views/`**
- `PipelineView.vue` — tiles, funnel panel, drawer ledger
- `ProductsView.vue` — third scope

---

### Task 1: The schema

**Files:**
- Create: `catalog-importer/supabase-catalog/supabase/migrations/004_import_runs.sql`
- Modify: `catalog-importer/supabase-catalog/supabase/tests/catalog.test.sql` (append a new section at the end)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `public.catalog_import_runs` and `public.catalog_import_outcomes` with the columns named below. Tasks 4 and 6–9 depend on these exact column names.

- [ ] **Step 1: Write the migration**

Create `catalog-importer/supabase-catalog/supabase/migrations/004_import_runs.sql`:

```sql
-- What a run did, and what it threw away.
--
-- import_catalog_products() computes a report and returns it to the CLI, which
-- prints it and forgets it. The database kept the ROWS a run produced and no
-- memory of the run itself, so the dashboard could reconstruct ingestion history
-- from provenance columns but could never say what was rejected -- a rejected
-- record leaves no row to count.
--
-- These two tables are that memory. They are written by catalog-importer with
-- the service-role key it already holds, and read by the admin dashboard with
-- the anon key it already holds.
--
-- A NEW FILE rather than an edit to 003: 001-003 are restatements of the schema
-- as it is, and every one of them is already recorded as applied on the remote
-- project. A change made inside one is invisible to `supabase db push`.

-- ─── the run ─────────────────────────────────────────────────────────────────
--
-- Opened by `npm run score` and completed by `npm run load:apply`. Those are
-- separate invocations that can be days apart, which is why the load-side
-- columns are all nullable and `loaded_at` is the flag for "this run reached the
-- database".
--
-- Keyed on a uuid minted by the CLI, NOT on source_version. A version is derived
-- from the dump date, so two scores of the same dump collide, and the second
-- would silently overwrite the first. A re-run should be a row you can see.
create table if not exists public.catalog_import_runs (
  id                        uuid        primary key,
  source                    text        not null,
  source_version            text,

  scored_at                 timestamptz,
  loaded_at                 timestamptz,

  -- The funnel, exactly as out/report.md renders it. Null when a run was
  -- published from a load with no matching score (an older scored.jsonl).
  records_read              integer,
  records_rejected          integer,
  records_auto              integer,
  records_review            integer,
  records_dropped           integer,
  records_capped            integer,

  -- The jsonb report import_catalog_products() already builds, unpacked.
  inserted                  integer,
  updated_imported          integer,
  updated_provenance_only   integer,
  skipped_invalid           integer,
  skipped_barcode_conflict  integer,
  deduped                   integer,
  collapsed_scoped          integer,
  dry_run                   boolean,

  -- Why records were rejected, and why the gate sent things to review or drop.
  -- jsonb rather than a third table because nothing queries ACROSS runs by
  -- reason -- the dashboard renders one run's breakdown at a time -- and the
  -- reason vocabulary belongs to the gate, which should be free to change it
  -- without a migration.
  reason_tallies            jsonb       not null default '{}'::jsonb,

  -- The contents of out/load-errors.jsonl. A failed chunk is the one thing in
  -- the load half that is not a count.
  load_errors               jsonb       not null default '[]'::jsonb,

  -- Set when retention has deleted this run's outcome rows. Without it the
  -- dashboard cannot tell "no records, because pruned" from "no records,
  -- because none were recorded" -- and those are opposite facts.
  outcomes_pruned           boolean     not null default false,

  created_at                timestamptz not null default now()
);

-- Restated below the table rather than inline, because a constraint declared
-- inside `create table if not exists` is skipped when the table already exists
-- and would reach new databases only.
alter table public.catalog_import_runs
  drop constraint if exists catalog_import_runs_source_check;
alter table public.catalog_import_runs
  add constraint catalog_import_runs_source_check
  check (source in ('openfoodfacts', 'openproductsfacts', 'openbeautyfacts'));

create index if not exists catalog_import_runs_source_scored
  on public.catalog_import_runs (source, scored_at desc nulls last);

-- ─── what did not land ───────────────────────────────────────────────────────
--
-- One row per record the run did not write. NOT the records that did land:
-- those are in product_catalog, queryable today, and mirroring them would
-- double the write for a question already answered.
create table if not exists public.catalog_import_outcomes (
  id       bigint  generated always as identity primary key,
  run_id   uuid    not null references public.catalog_import_runs(id) on delete cascade,
  barcode  text    not null,
  -- Null for pre-scoring rejects. Most of them have no name, which is precisely
  -- why they were rejected.
  name     text,
  maker    text,
  -- Null for pre-scoring rejects, which were never scored.
  score    integer,
  stage    text    not null,
  reason   text    not null,
  flags    text[]  not null default '{}'
);

alter table public.catalog_import_outcomes
  drop constraint if exists catalog_import_outcomes_stage_check;
alter table public.catalog_import_outcomes
  add constraint catalog_import_outcomes_stage_check
  check (stage in ('rejected', 'dropped', 'review'));

create index if not exists catalog_import_outcomes_run_stage
  on public.catalog_import_outcomes (run_id, stage);

create index if not exists catalog_import_outcomes_barcode
  on public.catalog_import_outcomes (barcode);

-- The "why isn't Nutella in the catalog" index. gin_trgm_ops because the search
-- is a substring match on a name the operator half-remembers, which no btree
-- can serve. pg_trgm is already installed by 001_foundation.sql.
create index if not exists catalog_import_outcomes_name_trgm
  on public.catalog_import_outcomes using gin (name gin_trgm_ops);

comment on table public.catalog_import_runs is
  'One row per catalog-importer run. Opened by `npm run score`, completed by '
  '`npm run load:apply`. The database''s only memory of a run as an event.';
comment on table public.catalog_import_outcomes is
  'Records a run did not write: rejected before scoring, dropped by the gate, or '
  'left in the review band. Pruned to the 5 most recent runs per source.';
comment on column public.catalog_import_runs.outcomes_pruned is
  'True once retention has deleted this run''s outcome rows. Distinguishes '
  '"pruned" from "never recorded", which are opposite facts.';

-- ─── access ──────────────────────────────────────────────────────────────────
--
-- Read to authenticated, exactly as product_catalog has it in 003. These rows
-- are barcodes, names and scores derived from public Open Food Facts data;
-- nothing about a household is in them.
--
-- The catalog project has no admin concept -- product_catalog is readable by any
-- signed-in FamCart account. Building one here to protect already-public data
-- would be a larger change that deserves its own decision. Recorded so the
-- choice is visible rather than inherited.
--
-- There are no insert, update or delete policies at all. The importer writes as
-- service_role, which RLS does not apply to.
alter table public.catalog_import_runs     enable row level security;
alter table public.catalog_import_outcomes enable row level security;

drop policy if exists "authenticated users can read import runs" on public.catalog_import_runs;
create policy "authenticated users can read import runs"
  on public.catalog_import_runs for select
  to authenticated
  using (true);

drop policy if exists "authenticated users can read import outcomes" on public.catalog_import_outcomes;
create policy "authenticated users can read import outcomes"
  on public.catalog_import_outcomes for select
  to authenticated
  using (true);

-- Revoke first, then grant. Hosted Supabase hands anon and authenticated
-- INSERT, UPDATE, DELETE and TRUNCATE at provisioning, and TRUNCATE would not
-- even be stopped by a policy since it ignores RLS.
revoke all on public.catalog_import_runs     from anon, authenticated, service_role;
revoke all on public.catalog_import_outcomes from anon, authenticated, service_role;

grant select on public.catalog_import_runs     to authenticated;
grant select on public.catalog_import_outcomes to authenticated;

grant select, insert, update, delete on public.catalog_import_runs     to service_role;
grant select, insert, update, delete on public.catalog_import_outcomes to service_role;
grant usage on sequence public.catalog_import_outcomes_id_seq to service_role;
```

- [ ] **Step 2: Append the pgTAP tests**

Append to `catalog-importer/supabase-catalog/supabase/tests/catalog.test.sql`, immediately before its final `select * from finish();` line (find that line first — do not append after it):

```sql
-- ─── 7. import runs and outcomes ─────────────────────────────────────────────

select has_table('public', 'catalog_import_runs', 'the run ledger exists');
select has_table('public', 'catalog_import_outcomes', 'the outcome table exists');

-- Readable by a signed-in user, writable by none.
set local role authenticated;
select lives_ok(
  $$ select count(*) from public.catalog_import_runs $$,
  'authenticated can read import runs'
);
select lives_ok(
  $$ select count(*) from public.catalog_import_outcomes $$,
  'authenticated can read import outcomes'
);
select throws_ok(
  $$ insert into public.catalog_import_runs (id, source) values (gen_random_uuid(), 'openfoodfacts') $$,
  '42501',
  null,
  'authenticated cannot write a run'
);
select throws_ok(
  $$ delete from public.catalog_import_outcomes $$,
  '42501',
  null,
  'authenticated cannot delete outcomes'
);

set local role anon;
select throws_ok(
  $$ select count(*) from public.catalog_import_runs $$,
  '42501',
  null,
  'anon reaches nothing'
);

reset role;

-- The source check mirrors the one import_catalog_products() enforces.
select throws_ok(
  $$ insert into public.catalog_import_runs (id, source) values (gen_random_uuid(), 'curated') $$,
  '23514',
  null,
  'a run cannot claim a non-import source'
);

-- The cascade: deleting a run takes its outcomes with it.
insert into public.catalog_import_runs (id, source, source_version)
  values ('11111111-1111-1111-1111-111111111111', 'openfoodfacts', 'off-test');
insert into public.catalog_import_outcomes (run_id, barcode, stage, reason)
  values ('11111111-1111-1111-1111-111111111111', '5000000000000', 'dropped', 'no-scans-no-brand');

select is(
  (select count(*)::int from public.catalog_import_outcomes
     where run_id = '11111111-1111-1111-1111-111111111111'),
  1,
  'the outcome landed'
);

delete from public.catalog_import_runs where id = '11111111-1111-1111-1111-111111111111';

select is(
  (select count(*)::int from public.catalog_import_outcomes
     where run_id = '11111111-1111-1111-1111-111111111111'),
  0,
  'deleting a run cascades to its outcomes'
);
```

- [ ] **Step 3: Bump the pgTAP plan count**

`catalog.test.sql` declares its plan near the top with `select plan(N);`. Find that line, count the `select` assertions you just added (10), and raise `N` by 10. A mismatched plan fails the whole suite with "planned N but ran M".

- [ ] **Step 4: Reset and run the suite**

```bash
cd /d/famcart/catalog-importer
npx supabase db reset --workdir supabase-catalog
npx supabase test db  --workdir supabase-catalog
```

Expected: all tests pass, including the 10 new ones. The reset is not optional — `db start` restores from a backup and skips migrations.

- [ ] **Step 5: Commit**

```bash
cd /d/famcart/catalog-importer
git add supabase-catalog/supabase/migrations/004_import_runs.sql supabase-catalog/supabase/tests/catalog.test.sql
git commit -m "Record what a run did and what it threw away"
```

---

### Task 2: Deriving outcomes and the funnel

**Files:**
- Create: `catalog-importer/src/publish/outcomes.ts`
- Test: `catalog-importer/test/outcomes.test.ts`

**Interfaces:**
- Consumes: `ScoredProduct` from `src/types.ts` (fields: `product.barcode`, `product.name`, `product.maker`, `score.total`, `score.flags`, `verdict`, `reason`).
- Produces:
  - `type OutcomeStage = 'rejected' | 'dropped' | 'review'`
  - `interface OutcomeRow { barcode: string; name: string | null; maker: string | null; score: number | null; stage: OutcomeStage; reason: string; flags: string[] }`
  - `interface Funnel { records_read: number; records_rejected: number; records_auto: number; records_review: number; records_dropped: number }`
  - `interface RejectedRecord { barcode?: string; reason: string }`
  - `buildOutcomes(scored: ScoredProduct[], rejected: RejectedRecord[]): OutcomeRow[]`
  - `buildFunnel(scored: ScoredProduct[], rejected: RejectedRecord[]): Funnel`
  - `buildReasonTallies(scored: ScoredProduct[], rejected: RejectedRecord[]): { rejected: Record<string, number>; gate: Record<string, number> }`

- [ ] **Step 1: Write the failing test**

Create `catalog-importer/test/outcomes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildFunnel, buildOutcomes, buildReasonTallies } from '../src/publish/outcomes.ts'
import type { ScoredProduct, StagedProduct } from '../src/types.ts'

// The publisher reads scored.jsonl and rejected.jsonl, never dropped.jsonl or
// review-queue.jsonl. Those two are derived views written for a human at a
// terminal -- the review queue is capped at 500 out of a band of 12,255 -- and
// the sampling that makes the terminal readable must not follow the data into a
// database somebody is going to search.

function staged(over: Partial<StagedProduct> = {}): StagedProduct {
  return {
    barcode: '5000000000000',
    name: 'Ciocolata Lapte 100g',
    maker: 'Milka',
    searchText: 'ciocolata lapte 100g',
    key: 'k',
    dedupKey: 'dk',
    searchAliases: null,
    sourceRef: 'off:5000000000000',
    nameLang: 'ro',
    nameSource: 'product_name_ro',
    quantity: null,
    markets: ['en:romania'],
    signals: {
      uniqueScans: null,
      completeness: 0.5,
      categoriesTags: [],
      hasBrand: true,
      hasQuantity: true,
      rawQuantityPresent: true,
      marketTier: 1,
    },
    warnings: [],
    ...over,
  }
}

function scored(over: Partial<ScoredProduct> = {}): ScoredProduct {
  return {
    product: staged(),
    score: { total: 55, parts: {}, flags: [] },
    verdict: 'review',
    reason: 'middle-band',
    ...over,
  }
}

describe('buildOutcomes', () => {
  it('keeps dropped and review records and discards the ones that landed', () => {
    const rows = buildOutcomes(
      [
        scored({ verdict: 'auto', reason: 'above-auto-threshold' }),
        scored({ verdict: 'drop', reason: 'no-scans-no-brand' }),
        scored({ verdict: 'review', reason: 'middle-band' }),
      ],
      [],
    )

    expect(rows.map((r) => r.stage)).toEqual(['dropped', 'review'])
  })

  it('carries name, maker, score and flags off a scored product', () => {
    const rows = buildOutcomes(
      [
        scored({
          verdict: 'drop',
          reason: 'below-review-threshold',
          score: { total: 31, parts: {}, flags: ['truncated-name'] },
        }),
      ],
      [],
    )

    expect(rows[0]).toEqual({
      barcode: '5000000000000',
      name: 'Ciocolata Lapte 100g',
      maker: 'Milka',
      score: 31,
      stage: 'dropped',
      reason: 'below-review-threshold',
      flags: ['truncated-name'],
    })
  })

  // A pre-scoring reject was never scored and usually has no name -- that is
  // what `no-name`, 12,554 of 12,859 last run, means. Null is the honest value;
  // a zero score would read as "we scored it and it was terrible".
  it('leaves name, maker and score null for a pre-scoring reject', () => {
    const rows = buildOutcomes([], [{ barcode: '0011111125056', reason: 'no-name' }])

    expect(rows[0]).toEqual({
      barcode: '0011111125056',
      name: null,
      maker: null,
      score: null,
      stage: 'rejected',
      reason: 'no-name',
      flags: [],
    })
  })

  it('survives a reject with no barcode at all', () => {
    const rows = buildOutcomes([], [{ reason: 'bad-barcode' }])
    expect(rows[0].barcode).toBe('')
  })
})

describe('buildFunnel', () => {
  it('counts read as everything scored plus everything rejected before scoring', () => {
    const funnel = buildFunnel(
      [
        scored({ verdict: 'auto' }),
        scored({ verdict: 'auto' }),
        scored({ verdict: 'review' }),
        scored({ verdict: 'drop' }),
      ],
      [{ reason: 'no-name' }, { reason: 'bad-barcode' }],
    )

    expect(funnel).toEqual({
      records_read: 6,
      records_rejected: 2,
      records_auto: 2,
      records_review: 1,
      records_dropped: 1,
    })
  })
})

describe('buildReasonTallies', () => {
  it('splits the two breakdowns report.md renders, and prefixes the gate with its verdict', () => {
    const tallies = buildReasonTallies(
      [
        scored({ verdict: 'review', reason: 'middle-band' }),
        scored({ verdict: 'review', reason: 'middle-band' }),
        scored({ verdict: 'drop', reason: 'no-scans-no-brand' }),
        // An auto record has a reason too, and it is not a discard reason.
        scored({ verdict: 'auto', reason: 'above-auto-threshold' }),
      ],
      [{ reason: 'no-name' }, { reason: 'no-name' }, { reason: 'bad-barcode' }],
    )

    expect(tallies).toEqual({
      rejected: { 'no-name': 2, 'bad-barcode': 1 },
      gate: { 'review:middle-band': 2, 'drop:no-scans-no-brand': 1 },
    })
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd /d/famcart/catalog-importer && npx vitest run test/outcomes.test.ts
```

Expected: FAIL — `Cannot find module '../src/publish/outcomes.ts'`.

- [ ] **Step 3: Write the implementation**

Create `catalog-importer/src/publish/outcomes.ts`:

```ts
// Turning a run's files into rows.
//
// Reads scored.jsonl and rejected.jsonl and NOTHING ELSE. dropped.jsonl and
// review-queue.jsonl are derived views written for a human at a terminal: the
// review queue is capped at REVIEW_QUEUE_CAP (500) out of a band that was 12,255
// last run. That sampling is right for a terminal and wrong for a database
// somebody is going to search, so the derivation happens here instead.
import type { ScoredProduct } from '../types.ts'

export type OutcomeStage = 'rejected' | 'dropped' | 'review'

/** One record the run did not write. Mirrors catalog_import_outcomes. */
export interface OutcomeRow {
  barcode: string
  name: string | null
  maker: string | null
  score: number | null
  stage: OutcomeStage
  reason: string
  flags: string[]
}

/** The funnel out/report.md renders, as columns. */
export interface Funnel {
  records_read: number
  records_rejected: number
  records_auto: number
  records_review: number
  records_dropped: number
}

/** A line of rejected.jsonl. The barcode is absent when that was the problem. */
export interface RejectedRecord {
  barcode?: string
  reason: string
}

const DISCARDED: Record<string, OutcomeStage | undefined> = {
  drop: 'dropped',
  review: 'review',
}

export function buildOutcomes(
  scored: ScoredProduct[],
  rejected: RejectedRecord[],
): OutcomeRow[] {
  const rows: OutcomeRow[] = rejected.map((record) => ({
    // '' rather than a skipped row: a record rejected FOR its barcode is still
    // a record that did not land, and dropping it would make the table
    // disagree with the funnel count beside it.
    barcode: record.barcode ?? '',
    name: null,
    maker: null,
    score: null,
    stage: 'rejected',
    reason: record.reason,
    flags: [],
  }))

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
    })
  }

  return rows
}

export function buildFunnel(scored: ScoredProduct[], rejected: RejectedRecord[]): Funnel {
  const byVerdict = { auto: 0, review: 0, drop: 0 }
  for (const entry of scored) byVerdict[entry.verdict] += 1

  return {
    // Matches renderScoreReport's `total`: a rejected record never reached the
    // scorer, so the two populations are disjoint and read is their sum.
    records_read: scored.length + rejected.length,
    records_rejected: rejected.length,
    records_auto: byVerdict.auto,
    records_review: byVerdict.review,
    records_dropped: byVerdict.drop,
  }
}

function tally(items: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1
  return counts
}

export function buildReasonTallies(
  scored: ScoredProduct[],
  rejected: RejectedRecord[],
): { rejected: Record<string, number>; gate: Record<string, number> } {
  return {
    rejected: tally(rejected.map((r) => r.reason)),
    // Prefixed with the verdict, exactly as report.md does it: `middle-band`
    // means something different depending on which side of the gate it fell.
    gate: tally(
      scored
        .filter((entry) => entry.verdict !== 'auto')
        .map((entry) => `${entry.verdict}:${entry.reason}`),
    ),
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /d/famcart/catalog-importer && npx vitest run test/outcomes.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd /d/famcart/catalog-importer
git add src/publish/outcomes.ts test/outcomes.test.ts
git commit -m "Derive a run's discarded records from what it actually scored"
```

---

### Task 3: The run file

**Files:**
- Create: `catalog-importer/src/publish/runFile.ts`
- Test: `catalog-importer/test/runFile.test.ts`
- Modify: `catalog-importer/src/config.ts` (add one path)

**Interfaces:**
- Consumes: `paths` and `outDir` from `src/config.ts`.
- Produces:
  - `interface RunFile { id: string; source: string; sourceVersion: string | null; scoredAt: string; cappedAway: number }`
  - `openRun(source: string, sourceVersion: string | null, cappedAway: number, now?: Date): RunFile`
  - `writeRunFile(path: string, run: RunFile): void`
  - `readRunFile(path: string): RunFile | null`

- [ ] **Step 1: Add the path**

In `catalog-importer/src/config.ts`, inside the `paths` object literal, add after the `loadErrors` line:

```ts
  runFile: join(outDir, 'run.json'),
```

- [ ] **Step 2: Write the failing test**

Create `catalog-importer/test/runFile.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openRun, readRunFile, writeRunFile } from '../src/publish/runFile.ts'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'famcart-run-')), 'run.json')

describe('openRun', () => {
  it('mints a uuid and stamps the moment scoring finished', () => {
    const run = openRun('openfoodfacts', 'off-2026-08-20', 0, new Date('2026-08-24T10:00:00.000Z'))

    expect(run.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(run.source).toBe('openfoodfacts')
    expect(run.sourceVersion).toBe('off-2026-08-20')
    expect(run.scoredAt).toBe('2026-08-24T10:00:00.000Z')
  })

  it('gives every run its own id', () => {
    expect(openRun('openfoodfacts', null, 0).id).not.toBe(openRun('openfoodfacts', null, 0).id)
  })
})

describe('readRunFile', () => {
  it('round-trips what writeRunFile wrote', () => {
    const path = tmp()
    const run = openRun('openbeautyfacts', 'obf-2026-08-24', 1200)
    writeRunFile(path, run)

    expect(readRunFile(path)).toEqual(run)
  })

  // load --apply must work against an older scored.jsonl, and a missing run
  // file is that case rather than an error. The run row it opens instead has
  // null stage counts, which is partial history labelled as partial.
  it('returns null when there is no file', () => {
    expect(readRunFile(join(tmpdir(), 'famcart-does-not-exist', 'run.json'))).toBeNull()
  })

  it('returns null rather than throwing on an unreadable file', () => {
    const path = tmp()
    writeFileSync(path, '{ not json', 'utf8')
    expect(readRunFile(path)).toBeNull()
  })

  it('returns null when the file parses but carries no id', () => {
    const path = tmp()
    writeFileSync(path, JSON.stringify({ source: 'openfoodfacts' }), 'utf8')
    expect(readRunFile(path)).toBeNull()
  })
})
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
cd /d/famcart/catalog-importer && npx vitest run test/runFile.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Create `catalog-importer/src/publish/runFile.ts`:

```ts
// The handoff between `score` and `load --apply`.
//
// A run is two commands that can be days apart -- the current out/ proves it,
// with report.md dated 2026-08-19 and load-plan.json naming off-2026-08-20. So
// `score` mints an id, parks it here, and `load --apply` picks it up and
// completes the same row.
//
// Not keyed on source_version. That is derived from the dump date, so two scores
// of the same dump produce the same string, and the second run would silently
// overwrite the first. A re-run should be a row you can see, not an edit you
// cannot.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

export interface RunFile {
  id: string
  source: string
  sourceVersion: string | null
  scoredAt: string
  /**
   * Rows the per-market cap took away after the gate ran.
   *
   * Lives here rather than being recomputed at publish time because it exists
   * only inside score(): applyMarketCap() returns it, and no file downstream
   * records it. `npm run publish` run standalone would otherwise have to invent
   * the number or leave it out.
   */
  cappedAway: number
}

export function openRun(
  source: string,
  sourceVersion: string | null,
  cappedAway: number,
  now = new Date(),
): RunFile {
  return {
    id: randomUUID(),
    source,
    sourceVersion,
    scoredAt: now.toISOString(),
    cappedAway,
  }
}

export function writeRunFile(path: string, run: RunFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
}

/**
 * The run in progress, or null.
 *
 * Null on every failure, deliberately. Every caller's fallback is "open a run
 * of your own with null stage counts", and that is a better outcome than a
 * `load --apply` refusing to run because a scratch file in out/ was truncated.
 */
export function readRunFile(path: string): RunFile | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunFile>
    if (!parsed.id || !parsed.source) return null
    return {
      id: parsed.id,
      source: parsed.source,
      sourceVersion: parsed.sourceVersion ?? null,
      scoredAt: parsed.scoredAt ?? new Date(0).toISOString(),
      cappedAway: parsed.cappedAway ?? 0,
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
cd /d/famcart/catalog-importer && npx vitest run test/runFile.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
cd /d/famcart/catalog-importer
git add src/config.ts src/publish/runFile.ts test/runFile.test.ts
git commit -m "Carry a run's identity from score through to load"
```

---

### Task 4: The publisher

**Files:**
- Create: `catalog-importer/src/publish/publish.ts`
- Test: `catalog-importer/test/publish.test.ts`

**Interfaces:**
- Consumes: `buildOutcomes`, `buildFunnel`, `buildReasonTallies`, `OutcomeRow` (Task 2); `RunFile` (Task 3); `ImportReport` from `src/types.ts`; `createServiceClient` from `src/load/supabase.ts`.
- Produces:
  - `const OUTCOME_CHUNK = 1000`
  - `const RUNS_KEPT_PER_SOURCE = 5`
  - `interface PublishDeps { db: SupabaseLike }` — a structural subset of `SupabaseClient` so tests need no network
  - `publishScore(deps, run, scored, rejected): Promise<void>`
  - `publishLoad(deps, run, report, errors): Promise<void>`
  - `pruneOutcomes(deps, source): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `catalog-importer/test/publish.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { OUTCOME_CHUNK, publishLoad, publishScore } from '../src/publish/publish.ts'
import type { RunFile } from '../src/publish/runFile.ts'
import type { ImportReport, ScoredProduct, StagedProduct } from '../src/types.ts'

// A fake that records what would have been sent. The publisher is the only file
// in this feature that talks to Supabase, so it is the only one that needs one.
function fakeDb() {
  const calls: { table: string; op: string; rows: unknown }[] = []

  const builder = (table: string) => ({
    upsert(rows: unknown) {
      calls.push({ table, op: 'upsert', rows })
      return Promise.resolve({ error: null })
    },
    insert(rows: unknown) {
      calls.push({ table, op: 'insert', rows })
      return Promise.resolve({ error: null })
    },
    update(rows: unknown) {
      calls.push({ table, op: 'update', rows })
      return { eq: () => Promise.resolve({ error: null }) }
    },
    delete() {
      calls.push({ table, op: 'delete', rows: null })
      return { in: () => Promise.resolve({ error: null }) }
    },
    select() {
      return {
        eq: () => ({
          order: () => ({
            range: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }
    },
  })

  return { db: { from: builder }, calls }
}

function run(over: Partial<RunFile> = {}): RunFile {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    source: 'openfoodfacts',
    sourceVersion: 'off-2026-08-20',
    scoredAt: '2026-08-24T10:00:00.000Z',
    cappedAway: 12,
    ...over,
  }
}

function scored(verdict: ScoredProduct['verdict'], barcode: string): ScoredProduct {
  return {
    product: { barcode, name: 'X', maker: null } as StagedProduct,
    score: { total: 40, parts: {}, flags: [] },
    verdict,
    reason: 'r',
  }
}

const report: ImportReport = {
  inserted: 7683,
  updated_imported: 3012,
  updated_provenance_only: 0,
  skipped_invalid: 0,
  skipped_barcode_conflict: 4,
  deduped: 0,
  collapsed_scoped: 0,
  source: 'openfoodfacts',
  source_version: 'off-2026-08-20',
  dry_run: false,
}

describe('publishScore', () => {
  it('upserts the run with the funnel, then inserts the outcomes', async () => {
    const { db, calls } = fakeDb()
    await publishScore({ db }, run(), [scored('auto', '1'), scored('drop', '2')], [{ reason: 'no-name' }])

    const upsert = calls.find((c) => c.table === 'catalog_import_runs')
    expect(upsert?.op).toBe('upsert')
    expect(upsert?.rows).toMatchObject({
      id: '11111111-1111-1111-1111-111111111111',
      source: 'openfoodfacts',
      records_read: 3,
      records_rejected: 1,
      records_auto: 1,
      records_dropped: 1,
      records_capped: 12,
      outcomes_pruned: false,
    })

    const inserted = calls.filter((c) => c.table === 'catalog_import_outcomes' && c.op === 'insert')
    expect(inserted).toHaveLength(1)
    expect(inserted[0].rows as unknown[]).toHaveLength(2)
  })

  // 32,500 rows in one request is a payload PostgREST will refuse. The number
  // matters less than that there IS one.
  it('chunks the outcome insert', async () => {
    const { db, calls } = fakeDb()
    const many = Array.from({ length: OUTCOME_CHUNK + 5 }, (_, i) => scored('drop', String(i)))
    await publishScore({ db }, run(), many, [])

    const inserted = calls.filter((c) => c.table === 'catalog_import_outcomes' && c.op === 'insert')
    expect(inserted).toHaveLength(2)
    expect(inserted[0].rows as unknown[]).toHaveLength(OUTCOME_CHUNK)
    expect(inserted[1].rows as unknown[]).toHaveLength(5)
  })

  // A republish must be a no-op, not a doubling. Outcomes are deleted for this
  // run before they are re-inserted.
  it('clears this run\u2019s outcomes before inserting', async () => {
    const { db, calls } = fakeDb()
    await publishScore({ db }, run(), [scored('drop', '1')], [])

    const ops = calls.filter((c) => c.table === 'catalog_import_outcomes').map((c) => c.op)
    expect(ops).toEqual(['delete', 'insert'])
  })
})

describe('publishLoad', () => {
  it('completes the run row without touching the funnel columns', async () => {
    const { db, calls } = fakeDb()
    await publishLoad({ db }, run(), report, [{ chunk: 1, message: 'boom' }])

    const update = calls.find((c) => c.table === 'catalog_import_runs')
    expect(update?.op).toBe('update')
    expect(update?.rows).toMatchObject({
      inserted: 7683,
      skipped_barcode_conflict: 4,
      dry_run: false,
      load_errors: [{ chunk: 1, message: 'boom' }],
    })
    expect(update?.rows).not.toHaveProperty('records_read')
  })

  it('stamps loaded_at', async () => {
    const { db, calls } = fakeDb()
    await publishLoad({ db }, run(), report, [])
    const update = calls.find((c) => c.table === 'catalog_import_runs')
    expect(typeof (update?.rows as { loaded_at: string }).loaded_at).toBe('string')
  })
})

describe('failure', () => {
  // score() works offline today and must keep working. A publish that throws
  // would make a network blip cost a 40-minute scoring run.
  it('rejects rather than throwing synchronously, so the caller can swallow it', async () => {
    const db = {
      from: () => ({
        upsert: () => Promise.resolve({ error: { message: 'network down' } }),
      }),
    }
    await expect(publishScore({ db } as never, run(), [], [])).rejects.toThrow('network down')
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd /d/famcart/catalog-importer && npx vitest run test/publish.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `catalog-importer/src/publish/publish.ts`:

```ts
// The only file in this feature that talks to the database.
//
// Everything above it is pure and tested without a network; everything below it
// is the CLI, which calls these three and swallows their failures.
import type { ImportReport } from '../types.ts'
import type { ScoredProduct } from '../types.ts'
import { buildFunnel, buildOutcomes, buildReasonTallies, type RejectedRecord } from './outcomes.ts'
import type { RunFile } from './runFile.ts'

/**
 * A structural subset of SupabaseClient: exactly the calls this file makes.
 *
 * Typed this way so the tests can hand it a recorder instead of a network. The
 * real client satisfies it.
 */
export interface SupabaseLike {
  from(table: string): {
    upsert(rows: unknown): PromiseLike<{ error: { message: string } | null }>
    insert(rows: unknown): PromiseLike<{ error: { message: string } | null }>
    update(values: unknown): {
      eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }>
    }
    delete(): {
      eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }>
      in(column: string, values: unknown[]): PromiseLike<{ error: { message: string } | null }>
    }
    select(columns: string): {
      eq(column: string, value: unknown): {
        order(column: string, options: { ascending: boolean; nullsFirst?: boolean }): {
          range(from: number, to: number): PromiseLike<{ data: { id: string }[] | null; error: { message: string } | null }>
        }
      }
    }
  }
}

export interface PublishDeps {
  db: SupabaseLike
}

/**
 * Rows per insert. A run's outcome set was 32,549 rows last time; PostgREST
 * will refuse that as one payload, and a chunk that fails costs only itself.
 */
export const OUTCOME_CHUNK = 1000

/** Runs whose outcome rows survive, per source. Their run rows are kept forever. */
export const RUNS_KEPT_PER_SOURCE = 5

function fail(context: string, error: { message: string } | null): void {
  if (error) throw new Error(`${context}: ${error.message}`)
}

/**
 * Open (or re-open) the run row and write everything the score step knows.
 *
 * Idempotent: the upsert is keyed on the run id and the outcomes are cleared
 * before they are re-inserted, so `npm run publish` twice is `npm run publish`
 * once.
 */
export async function publishScore(
  deps: PublishDeps,
  run: RunFile,
  scored: ScoredProduct[],
  rejected: RejectedRecord[],
): Promise<void> {
  const funnel = buildFunnel(scored, rejected)

  const { error: runError } = await deps.db.from('catalog_import_runs').upsert({
    id: run.id,
    source: run.source,
    source_version: run.sourceVersion,
    scored_at: run.scoredAt,
    ...funnel,
    records_capped: run.cappedAway,
    reason_tallies: buildReasonTallies(scored, rejected),
    // Re-publishing restores the records, so the pruned flag has to come back
    // down with them.
    outcomes_pruned: false,
  })
  fail('publishing the run', runError)

  const { error: clearError } = await deps.db
    .from('catalog_import_outcomes')
    .delete()
    .eq('run_id', run.id)
  fail('clearing previous outcomes', clearError)

  const rows = buildOutcomes(scored, rejected).map((row) => ({ ...row, run_id: run.id }))

  for (let i = 0; i < rows.length; i += OUTCOME_CHUNK) {
    const { error } = await deps.db
      .from('catalog_import_outcomes')
      .insert(rows.slice(i, i + OUTCOME_CHUNK))
    fail(`inserting outcomes ${i}-${i + OUTCOME_CHUNK}`, error)
  }
}

/**
 * Complete the run row with what the load actually did.
 *
 * Touches none of the funnel columns: a load can happen against a scored.jsonl
 * whose run row was written days ago, and overwriting those with nulls would
 * lose the half of the history that is already correct.
 */
export async function publishLoad(
  deps: PublishDeps,
  run: RunFile,
  report: ImportReport,
  errors: { chunk: number; message: string }[],
): Promise<void> {
  const { error } = await deps.db
    .from('catalog_import_runs')
    .update({
      loaded_at: new Date().toISOString(),
      inserted: report.inserted,
      updated_imported: report.updated_imported,
      updated_provenance_only: report.updated_provenance_only,
      skipped_invalid: report.skipped_invalid,
      skipped_barcode_conflict: report.skipped_barcode_conflict,
      deduped: report.deduped,
      collapsed_scoped: report.collapsed_scoped,
      dry_run: report.dry_run,
      load_errors: errors,
    })
    .eq('id', run.id)
  fail('completing the run', error)
}

/**
 * Delete the outcome rows of every run past the newest RUNS_KEPT_PER_SOURCE.
 *
 * The run rows themselves stay: twenty-odd columns each, a few dozen of them,
 * and the history is the entire point. Only the ~32k-row outcome sets are
 * bounded, which is what keeps the table sized by construction rather than by
 * anyone remembering to prune.
 *
 * Returns how many runs were pruned, for the log line.
 */
export async function pruneOutcomes(deps: PublishDeps, source: string): Promise<number> {
  const { data, error } = await deps.db
    .from('catalog_import_runs')
    .select('id')
    .eq('source', source)
    .order('scored_at', { ascending: false, nullsFirst: false })
    .range(RUNS_KEPT_PER_SOURCE, RUNS_KEPT_PER_SOURCE + 999)
  fail('listing runs to prune', error)

  const stale = (data ?? []).map((row) => row.id)
  if (!stale.length) return 0

  const { error: deleteError } = await deps.db
    .from('catalog_import_outcomes')
    .delete()
    .in('run_id', stale)
  fail('pruning outcomes', deleteError)

  // Flagged rather than inferred. Without this the dashboard cannot tell "no
  // records because pruned" from "no records because none were recorded", and
  // those are opposite facts.
  const { error: flagError } = await deps.db
    .from('catalog_import_runs')
    .update({ outcomes_pruned: true })
    .in('id', stale)
  fail('flagging pruned runs', flagError)

  return stale.length
}
```

Note: `pruneOutcomes` calls `.update(...).in(...)`. Add `in` to the `update` return type in `SupabaseLike` alongside `eq`:

```ts
    update(values: unknown): {
      eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }>
      in(column: string, values: unknown[]): PromiseLike<{ error: { message: string } | null }>
    }
```

- [ ] **Step 4: Run the tests**

```bash
cd /d/famcart/catalog-importer && npx vitest run test/publish.test.ts && npx tsc --noEmit
```

Expected: PASS, 6 tests, and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
cd /d/famcart/catalog-importer
git add src/publish/publish.ts test/publish.test.ts
git commit -m "Write a run and its discards to the catalog project"
```

---

### Task 5: Wire it into the CLI

**Files:**
- Modify: `catalog-importer/src/cli.ts`
- Modify: `catalog-importer/package.json`

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: `npm run publish`; automatic best-effort publishing from `score` and `load --apply`.

- [ ] **Step 1: Add the imports**

In `catalog-importer/src/cli.ts`, after the `import { buildEmojiCoverage, ... }` line, add:

```ts
import { openRun, readRunFile, writeRunFile, type RunFile } from './publish/runFile.ts'
import { publishLoad, publishScore, pruneOutcomes } from './publish/publish.ts'
import type { RejectedRecord } from './publish/outcomes.ts'
```

- [ ] **Step 2: Add the best-effort wrapper**

In `catalog-importer/src/cli.ts`, immediately above `function score() {`, add:

```ts
// Publishing is best-effort, always.
//
// `score` works offline today and must keep working: a scoring run is forty
// minutes of CPU, and losing it to a network blip while writing a report would
// be a bad trade. A failed publish warns and names the retry instead.
//
// The retry is real -- `npm run publish` republishes from whatever is in out/,
// and both halves are idempotent -- so a warning here costs a command, not a
// run.
async function bestEffort(what: string, action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`\n! ${what} was not published: ${message}`)
    console.warn('  The run is intact on disk. Retry with: npm run publish')
  }
}
```

- [ ] **Step 3: Publish from `score`**

`score()` is currently synchronous. Change its signature to `async function score() {`, then replace its final two `console.log` lines:

```ts
  console.log(renderScoreReport(scored, rejected, queued))
  console.log(`Written to ${paths.report}\n\nNext: npm run review, then npm run load`)
```

with:

```ts
  console.log(renderScoreReport(scored, rejected, queued))
  console.log(`Written to ${paths.report}`)

  // Open the run and hand its id to `load --apply` through out/run.json. The
  // file is written before the publish so a failed publish still leaves the two
  // commands talking about the same run.
  const run = openRun(source.id, sourceVersion(), capped.cappedAway)
  writeRunFile(paths.runFile, run)
  await bestEffort('This run', async () => {
    const db = createServiceClient()
    await publishScore({ db }, run, scored, rejected as RejectedRecord[])
    const pruned = await pruneOutcomes({ db }, run.source)
    if (pruned) console.log(`Pruned the discarded records of ${pruned} older run(s).`)
  })

  console.log('\nNext: npm run review, then npm run load')
```

Note: `score()` currently types `rejected` as `readJsonl<{ reason: string }>(paths.rejected)`. Widen it in place so the barcode survives into the outcome rows:

```ts
  const rejected = readJsonl<RejectedRecord>(paths.rejected)
```

- [ ] **Step 4: Publish from `load`**

In `load()`, replace the block that currently reads:

```ts
  if (errors.length) writeJsonl(paths.loadErrors, errors)
```

with:

```ts
  if (errors.length) writeJsonl(paths.loadErrors, errors)

  if (apply) {
    // A run scored days ago, or none at all. Opening one here rather than
    // skipping the publish keeps the load visible; its funnel columns stay null,
    // which is partial history labelled as partial.
    const run: RunFile =
      readRunFile(paths.runFile) ?? openRun(source.id, version, 0)
    await bestEffort('This load', async () => {
      await publishLoad({ db }, run, total, errors)
    })
  }
```

Note: when `readRunFile` returns null, the run row does not exist yet and `publishLoad`'s `update` matches nothing. Guard it — in `publish.ts`, change `publishLoad` to upsert the identity first:

```ts
  const { error: openError } = await deps.db.from('catalog_import_runs').upsert({
    id: run.id,
    source: run.source,
    source_version: run.sourceVersion,
  })
  fail('opening the run', openError)
```

placed as the first statement of `publishLoad`, before the `update`. An upsert of the identity columns alone leaves an existing row's funnel untouched, and creates the row when there was none.

- [ ] **Step 5: Add the `publish` command**

In `catalog-importer/src/cli.ts`, above the `COMMANDS` object, add:

```ts
// Retry a publish that failed, or backfill from files already on disk.
//
// Reads out/ and nothing else, which is what makes it a retry rather than a
// re-run: no scoring, no network to Open Food Facts, no 12 GB download.
async function publish() {
  const scored = readJsonl<ScoredProduct>(paths.scored)
  const rejected = readJsonl<RejectedRecord>(paths.rejected)
  const run = readRunFile(paths.runFile) ?? openRun(source.id, sourceVersion(), 0)

  const db = createServiceClient()
  console.log(`Target:  ${new URL(loadCredentials().url).host}`)
  console.log(`Run:     ${run.id}  (${run.source} ${run.sourceVersion ?? 'no version'})`)

  await publishScore({ db }, run, scored, rejected)
  console.log(`Published ${scored.length.toLocaleString()} scored + ${rejected.length.toLocaleString()} rejected.`)

  // The load half, if this run reached one. load-plan.json is the record of it.
  if (existsSync(paths.loadPlan)) {
    const plan = JSON.parse(readFileSync(paths.loadPlan, 'utf8')) as {
      report: ImportReport
      errors: { chunk: number; message: string }[]
    }
    await publishLoad({ db }, run, plan.report, plan.errors ?? [])
    console.log('Published the load report.')
  }

  const pruned = await pruneOutcomes({ db }, run.source)
  if (pruned) console.log(`Pruned the discarded records of ${pruned} older run(s).`)

  writeRunFile(paths.runFile, run)
}
```

Add `ImportReport` to the type import at the top of `cli.ts`:

```ts
import type { Decision, ImportReport, ScoredProduct, StagedProduct } from './types.ts'
```

Then register it in `COMMANDS`, after `load`:

```ts
  publish,
```

- [ ] **Step 6: Add the npm script**

In `catalog-importer/package.json`, after the `"load:obf:apply"` line:

```json
    "publish": "tsx src/cli.ts publish",
```

- [ ] **Step 7: Typecheck and run the whole suite**

```bash
cd /d/famcart/catalog-importer && npx tsc --noEmit && npx vitest run
```

Expected: clean typecheck, all tests pass.

- [ ] **Step 8: Verify against the local stack end to end**

```bash
cd /d/famcart/catalog-importer
npx supabase db reset --workdir supabase-catalog
npm run publish
```

Expected: it prints the target host, a run id, the counts from the files already in `out/`, and "Published the load report." If `.env.scripts` names the remote catalog project rather than the local stack, stop and point it at the local one first — this writes.

- [ ] **Step 9: Commit**

```bash
cd /d/famcart/catalog-importer
git add src/cli.ts src/publish/publish.ts package.json
git commit -m "Publish a run automatically, and by hand when that fails"
```

---

### Task 6: The dashboard reads the run ledger

**Files:**
- Modify: `admin/src/lib/data/pipeline.ts`
- Test: `admin/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `catalog_import_runs` (Task 1).
- Produces:
  - `interface RunRow` — the raw table row
  - `IngestionRun` gains: `id: string`, `ledger: Metric<RunLedger>`, `funnel: Metric<Funnel>`
  - `interface Funnel { read: number; rejected: number; auto: number; review: number; dropped: number; capped: number }`
  - `runLedger(row: RunRow): Metric<RunLedger>` — pure, replaces `fetchRunLedger`
  - `runFunnel(row: RunRow): Metric<Funnel>` — pure
  - `PipelineSnapshot` gains `funnel: Funnel | null` (the newest completed run's)

- [ ] **Step 1: Write the failing test**

Append to `admin/test/pipeline.test.ts`. The file already imports `describe`, `expect` and `it` from vitest at the top — add only `runFunnel`, `runLedger` and `RunRow` to the existing `../src/lib/data/pipeline` import rather than writing a second import statement:

```ts
// Add to the EXISTING import at the top of the file:
//   import { IMPORT_SOURCES, buildPipelineSnapshot, runFunnel, runLedger, type RunRow } from '../src/lib/data/pipeline'

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    source: 'openfoodfacts',
    source_version: 'off-2026-08-20',
    scored_at: '2026-08-19T12:46:38.327Z',
    loaded_at: '2026-08-20T18:05:00.000Z',
    records_read: 43382,
    records_rejected: 12859,
    records_auto: 10833,
    records_review: 12255,
    records_dropped: 7435,
    records_capped: 0,
    inserted: 7683,
    updated_imported: 3012,
    updated_provenance_only: 0,
    skipped_invalid: 0,
    skipped_barcode_conflict: 4,
    deduped: 0,
    collapsed_scoped: 0,
    dry_run: false,
    reason_tallies: { rejected: { 'no-name': 12554 }, gate: {} },
    load_errors: [],
    outcomes_pruned: false,
    ...over,
  }
}

describe('runLedger', () => {
  it('reads the counts off a completed run', () => {
    const ledger = runLedger(runRow())
    expect(ledger.available).toBe(true)
    if (!ledger.available) return
    expect(ledger.value).toEqual({
      recordsRead: 43382,
      recordsRejected: 12859,
      duplicates: 0,
      barcodeConflicts: 4,
      updated: 3012,
      errors: 0,
    })
  })

  it('counts a failed chunk as an error', () => {
    const ledger = runLedger(runRow({ load_errors: [{ chunk: 1, message: 'boom' }, { chunk: 2, message: 'boom' }] }))
    expect(ledger.available && ledger.value.errors).toBe(2)
  })

  // A run published from a load with no matching score. Half the history is
  // real and half was never recorded, and saying so beats showing zeros.
  it('is unavailable when the funnel was never recorded', () => {
    const ledger = runLedger(runRow({ records_read: null, records_rejected: null }))
    expect(ledger.available).toBe(false)
    if (ledger.available) return
    expect(ledger.reason).toMatch(/no matching score/i)
  })
})

describe('runFunnel', () => {
  it('is unavailable once the records have been pruned', () => {
    const funnel = runFunnel(runRow({ outcomes_pruned: true }))
    expect(funnel.available).toBe(true)
    const ledger = runLedger(runRow({ outcomes_pruned: true }))
    // Pruning removes the RECORDS, never the COUNTS. This is the distinction
    // outcomes_pruned exists to make.
    expect(ledger.available).toBe(true)
  })

  it('carries every stage of the funnel', () => {
    const funnel = runFunnel(runRow({ records_capped: 1200 }))
    expect(funnel.available && funnel.value).toEqual({
      read: 43382,
      rejected: 12859,
      auto: 10833,
      review: 12255,
      dropped: 7435,
      capped: 1200,
    })
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd /d/famcart/admin && npx vitest run test/pipeline.test.ts
```

Expected: FAIL — `runLedger` and `runFunnel` are not exported.

- [ ] **Step 3: Implement**

In `admin/src/lib/data/pipeline.ts`, add the row type and the two pure functions, and delete `fetchRunLedger` along with `LEDGER_REASON` / `LEDGER_FIX`:

```ts
/** A row of the catalog project's catalog_import_runs. */
export interface RunRow {
  id: string
  source: string
  source_version: string | null
  scored_at: string | null
  loaded_at: string | null
  records_read: number | null
  records_rejected: number | null
  records_auto: number | null
  records_review: number | null
  records_dropped: number | null
  records_capped: number | null
  inserted: number | null
  updated_imported: number | null
  updated_provenance_only: number | null
  skipped_invalid: number | null
  skipped_barcode_conflict: number | null
  deduped: number | null
  collapsed_scoped: number | null
  dry_run: boolean | null
  reason_tallies: { rejected?: Record<string, number>; gate?: Record<string, number> }
  load_errors: { chunk: number; message: string }[]
  outcomes_pruned: boolean
}

export interface Funnel {
  read: number
  rejected: number
  auto: number
  review: number
  dropped: number
  capped: number
}

const NO_SCORE_REASON =
  'This run was published from a load with no matching score, so the funnel was never recorded. ' +
  'The load half below is real; the stage counts are not missing, they never existed for this run.'

const NO_SCORE_FIX =
  'Run `npm run publish` in catalog-importer while out/run.json and out/scored.jsonl belong to this run.'

/**
 * What a run discarded.
 *
 * Pure, and reading a row the caller already has, because every one of these
 * numbers is a column on the run — there is nothing left to fetch. This
 * replaces the fetchRunLedger() that always returned Unavailable; the tier it
 * described has moved, and Unavailable now means "this particular run has no
 * score half" rather than "nothing records this".
 */
export function runLedger(row: RunRow): Metric<RunLedger> {
  if (row.records_read === null) return unavailable(NO_SCORE_REASON, NO_SCORE_FIX)

  return available({
    recordsRead: row.records_read,
    recordsRejected: row.records_rejected ?? 0,
    duplicates: row.deduped ?? 0,
    barcodeConflicts: row.skipped_barcode_conflict ?? 0,
    updated: row.updated_imported ?? 0,
    errors: row.load_errors.length,
  })
}

export function runFunnel(row: RunRow): Metric<Funnel> {
  if (row.records_read === null) return unavailable(NO_SCORE_REASON, NO_SCORE_FIX)

  return available({
    read: row.records_read,
    rejected: row.records_rejected ?? 0,
    auto: row.records_auto ?? 0,
    review: row.records_review ?? 0,
    dropped: row.records_dropped ?? 0,
    capped: row.records_capped ?? 0,
  })
}
```

Update the import at the top of the file so `available` comes in too:

```ts
import { available, unavailable, type Metric, type Unavailable } from './types'
```

- [ ] **Step 4: Fetch runs from the table**

Still in `admin/src/lib/data/pipeline.ts`, add:

```ts
export async function fetchRunRows(signal: AbortSignal): Promise<RunRow[]> {
  const client = getCatalogSupabase()
  if (!client) throw new CatalogNotConfigured()

  const { data, error } = await client
    .from('catalog_import_runs')
    .select('*')
    .order('scored_at', { ascending: false, nullsFirst: false })
    .abortSignal(signal)

  if (error) queryError('catalog_import_runs', error)
  return (data ?? []) as RunRow[]
}
```

Import `getCatalogSupabase` from `../supabase`, and `CatalogNotConfigured` plus `queryError` from the same places `products.ts` takes them.

Extend `IngestionRun` with the run row, and rewrite `buildPipelineSnapshot` to take the rows as a second argument:

```ts
export interface IngestionRun {
  id: string
  source: string
  version: string | null
  rowsCreated: number
  firstSeen: string
  lastSeen: string
  withBarcode: number
  withAliases: number
  withMarkets: number
  /** The run row, when the importer published one. Null for runs that predate it. */
  row: RunRow | null
}
```

Replace the body of `buildPipelineSnapshot` with:

```ts
export function buildPipelineSnapshot(
  shape: CatalogShape,
  rows: RunRow[],
  now = Date.now(),
): PipelineSnapshot {
  // Two sources, joined on (source, version), and the join is the whole point.
  //
  // The ledger says which runs happened -- authoritatively, because the importer
  // wrote a row per run. The catalog shape says how complete each run's output
  // was, which only the product rows can answer.
  //
  // So the run LIST no longer depends on paging the whole catalog under
  // SHAPE_ROW_CEILING: a run computed from a prefix could be missing entirely,
  // and now it cannot be. The coverage SHARES still come from the prefix and
  // still carry `truncated` with them.
  const shapeByKey = new Map(
    shape.byVersion
      // The curated seed is not an import run: no source_version, written by
      // hand. Listing it would put an event in the timeline that never happened.
      .filter((v) => v.source !== 'curated')
      .map((v) => [`${v.source}::${v.version ?? ''}`, v]),
  )

  const runs: IngestionRun[] = []
  const claimed = new Set<string>()

  // Published runs first, newest by scored_at, because the ledger is the
  // authority on what happened.
  for (const row of rows) {
    const key = `${row.source}::${row.source_version ?? ''}`
    claimed.add(key)
    const coverage = shapeByKey.get(key)
    runs.push({
      id: row.id,
      source: row.source,
      version: row.source_version,
      // A run that inserted rows but whose rows are not in the shape's prefix
      // reports the ledger's own count rather than zero.
      rowsCreated: coverage?.rows ?? row.inserted ?? 0,
      firstSeen: coverage?.firstSeen ?? row.loaded_at ?? row.scored_at ?? '',
      lastSeen: coverage?.lastSeen ?? row.loaded_at ?? row.scored_at ?? '',
      withBarcode: coverage?.withBarcode ?? 0,
      withAliases: coverage?.withAliases ?? 0,
      withMarkets: coverage?.withMarkets ?? 0,
      row,
    })
  }

  // Then the runs that predate the ledger, reconstructed the old way. They keep
  // working, and their drawer says the counts were never recorded.
  for (const [key, v] of shapeByKey) {
    if (claimed.has(key)) continue
    runs.push({
      id: key,
      source: v.source,
      version: v.version,
      rowsCreated: v.rows,
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
      withBarcode: v.withBarcode,
      withAliases: v.withAliases,
      withMarkets: v.withMarkets,
      row: null,
    })
  }

  runs.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))

  const sources: SourceHealth[] = IMPORT_SOURCES.map((source) => {
    const totals = shape.bySource.find((s) => s.source === source)
    const latest = runs.filter((r) => r.source === source)[0]
    const lastRunAt = latest?.lastSeen || null
    const ageDays = lastRunAt
      ? Math.floor((now - new Date(lastRunAt).getTime()) / 86_400_000)
      : null

    return {
      source,
      rows: totals?.rows ?? 0,
      withBarcode: totals?.withBarcode ?? 0,
      withMarkets: totals?.withMarkets ?? 0,
      latestVersion: latest?.version ?? null,
      lastRunAt,
      ageDays,
      status: statusFor(ageDays),
    }
  })

  const newest = runs[0] ?? null

  return {
    runs,
    sources,
    totalRows: shape.total,
    lastRunAt: newest?.lastSeen ?? null,
    lastRunVersion: newest?.version ?? null,
    byDay: shape.byCreatedDay,
    truncated: shape.truncated,
  }
}
```

And `fetchPipeline`, which now needs both:

```ts
export async function fetchPipeline(signal: AbortSignal, now = Date.now()): Promise<PipelineSnapshot> {
  // Concurrent, and independent: the ledger is a few dozen small rows and the
  // shape is a paged crawl. Waiting for one to start the other doubles the
  // slowest page load on the dashboard for no reason.
  const [shape, rows] = await Promise.all([loadCatalogShape(), fetchRunRows(signal)])
  return buildPipelineSnapshot(shape, rows, now)
}
```

Update the one call site in `PipelineView.vue` from `fetchPipeline()` to `(signal) => fetchPipeline(signal)`.

Existing tests in `pipeline.test.ts` call `buildPipelineSnapshot(shape(...), NOW)`. They must all become `buildPipelineSnapshot(shape(...), [], NOW)` — the empty array is the pre-ledger case those tests already describe, so their assertions stand unchanged.

- [ ] **Step 5: Run the tests**

```bash
cd /d/famcart/admin && npx vitest run test/pipeline.test.ts && npm run typecheck
```

Expected: PASS including the existing tests, clean typecheck.

- [ ] **Step 6: Commit**

```bash
cd /d/famcart/admin
git add src/lib/data/pipeline.ts test/pipeline.test.ts
git commit -m "Read run history from the ledger the importer now writes"
```

---

### Task 7: Reading the discarded records

**Files:**
- Create: `admin/src/lib/data/outcomes.ts`
- Test: `admin/test/outcomes.test.ts`

**Interfaces:**
- Consumes: `catalog_import_outcomes` (Task 1); `Page`, `PageParams` from `./types`; `escapeLike` from `./products`.
- Produces:
  - `type OutcomeStage = 'rejected' | 'dropped' | 'review'`
  - `interface OutcomeRow { id: number; run_id: string; barcode: string; name: string | null; maker: string | null; score: number | null; stage: OutcomeStage; reason: string; flags: string[] }`
  - `const OUTCOME_STAGES: readonly OutcomeStage[]`
  - `fetchOutcomes(filters: { runId?: string | null; stage?: OutcomeStage | null; reason?: string | null }, params: PageParams, signal: AbortSignal): Promise<Page<OutcomeRow>>`

- [ ] **Step 1: Write the failing test**

Create `admin/test/outcomes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildOutcomeQuery, OUTCOME_STAGES } from '../src/lib/data/outcomes'

// A recorder standing in for a PostgREST filter builder, so the query shape is
// verified without a network. Each method returns `this`, exactly as the real
// builder does.
function recorder() {
  const calls: [string, ...unknown[]][] = []
  const builder: Record<string, unknown> = {}
  for (const method of ['eq', 'ilike', 'order', 'range']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args])
      return builder
    }
  }
  return { builder, calls }
}

describe('buildOutcomeQuery', () => {
  it('filters by run and stage when both are given', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, { runId: 'r1', stage: 'dropped', reason: null }, {})

    expect(calls).toContainEqual(['eq', 'run_id', 'r1'])
    expect(calls).toContainEqual(['eq', 'stage', 'dropped'])
  })

  it('omits a filter that was not given rather than matching on null', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, { runId: null, stage: null, reason: null }, {})

    expect(calls.some(([method, column]) => method === 'eq' && column === 'run_id')).toBe(false)
    expect(calls.some(([method, column]) => method === 'eq' && column === 'stage')).toBe(false)
  })

  // The same escaping products.ts does. A name with a % in it is a name, not a
  // wildcard, and `\` is LIKE's default escape character so no ESCAPE clause is
  // needed.
  it('escapes LIKE metacharacters in the search', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, { runId: null, stage: null, reason: null }, { query: '100% Cacao' })

    expect(calls).toContainEqual(['ilike', 'name', '%100\\% Cacao%'])
  })

  it('pages with an inclusive upper bound', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, { runId: null, stage: null, reason: null }, { limit: 25, offset: 50 })

    expect(calls).toContainEqual(['range', 50, 74])
  })
})

describe('OUTCOME_STAGES', () => {
  it('matches the check constraint in 004_import_runs.sql', () => {
    expect([...OUTCOME_STAGES]).toEqual(['rejected', 'dropped', 'review'])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd /d/famcart/admin && npx vitest run test/outcomes.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `admin/src/lib/data/outcomes.ts`:

```ts
// The records a run did not write.
//
// This is the other half of the Product Pipeline page's honesty problem. The
// counts say 7,435 were dropped by the gate; this says WHICH, and lets you type
// a name you half-remember and find out why it is not in the catalog.
//
// The rows live in the catalog project, are written only by catalog-importer
// with its service-role key, and are readable here by any signed-in account --
// the same policy product_catalog has, because these are barcodes and names
// derived from public Open Food Facts data and nothing about a household is in
// them.
import type { SupabaseClient } from '@supabase/supabase-js'
import { getCatalogSupabase } from '../supabase'
import { queryError } from './errors'
import { CatalogNotConfigured, escapeLike } from './products'
import type { Page, PageParams } from './types'

export type OutcomeStage = 'rejected' | 'dropped' | 'review'

/** Mirrors the check constraint in 004_import_runs.sql. */
export const OUTCOME_STAGES = ['rejected', 'dropped', 'review'] as const

export interface OutcomeRow {
  id: number
  run_id: string
  barcode: string
  name: string | null
  maker: string | null
  score: number | null
  stage: OutcomeStage
  reason: string
  flags: string[]
}

export interface OutcomeFilters {
  runId?: string | null
  stage?: OutcomeStage | null
  reason?: string | null
}

type FilterBuilder = ReturnType<ReturnType<SupabaseClient['from']>['select']>

/**
 * Applying the filters, separated from issuing the request so the query shape
 * can be tested without a network.
 *
 * Every filter is omitted when absent rather than matched against null:
 * `.eq('stage', null)` is a query for rows whose stage IS null, which is every
 * row in the table and none of them at once depending on how PostgREST feels
 * about it. Not a filter you want built by accident.
 */
export function buildOutcomeQuery(
  request: FilterBuilder,
  filters: OutcomeFilters,
  params: PageParams,
): FilterBuilder {
  let query = request
  if (filters.runId) query = query.eq('run_id', filters.runId)
  if (filters.stage) query = query.eq('stage', filters.stage)
  if (filters.reason) query = query.eq('reason', filters.reason)

  const search = params.query?.trim()
  if (search) query = query.ilike('name', `%${escapeLike(search)}%`)

  // Worst score first: the interesting question is "what did we nearly keep",
  // and nulls (the pre-scoring rejects) sort last because "no name" is never
  // the row somebody came looking for.
  query = query.order('score', { ascending: false, nullsFirst: false }).order('id', { ascending: true })

  const limit = params.limit ?? 25
  const offset = params.offset ?? 0
  // range() is inclusive at both ends, so the upper bound is offset + limit - 1.
  return query.range(offset, offset + limit - 1)
}

export async function fetchOutcomes(
  filters: OutcomeFilters,
  params: PageParams,
  signal: AbortSignal,
): Promise<Page<OutcomeRow>> {
  const client = getCatalogSupabase()
  if (!client) throw new CatalogNotConfigured()

  const request = client
    .from('catalog_import_outcomes')
    .select('id,run_id,barcode,name,maker,score,stage,reason,flags', { count: 'exact' })

  const { data, error, count } = await buildOutcomeQuery(request as never, filters, params).abortSignal(
    signal,
  )

  if (error) queryError('catalog_import_outcomes', error)

  return {
    rows: (data ?? []) as OutcomeRow[],
    total: count ?? 0,
    offset: params.offset ?? 0,
  }
}
```

Note: `escapeLike` and `CatalogNotConfigured` must be exported from `products.ts`. Check first — if either is module-private, add `export` to its declaration in that file and nothing else.

- [ ] **Step 4: Run the tests**

```bash
cd /d/famcart/admin && npx vitest run test/outcomes.test.ts && npm run typecheck
```

Expected: PASS, 5 tests, clean typecheck.

- [ ] **Step 5: Commit**

```bash
cd /d/famcart/admin
git add src/lib/data/outcomes.ts src/lib/data/products.ts test/outcomes.test.ts
git commit -m "Read the discarded records, filtered and paged"
```

---

### Task 8: The Pipeline view goes live

**Files:**
- Modify: `admin/src/views/PipelineView.vue`

**Interfaces:**
- Consumes: `runLedger`, `runFunnel`, `fetchRunRows`, `IngestionRun.row` (Task 6).
- Produces: no new exports.

- [ ] **Step 1: Replace the two unrecorded tiles**

In `admin/src/views/PipelineView.vue`, replace the two `StatTile`s currently carrying `unrecorded`:

```vue
        <div class="span-3">
          <StatTile
            label="Records processed"
            unrecorded
            unrecorded-reason="Not persisted by import_catalog_products()"
          />
        </div>
        <div class="span-3">
          <StatTile
            label="Rejected records"
            unrecorded
            unrecorded-reason="A rejected record leaves no row"
          />
        </div>
```

with:

```vue
        <div class="span-3">
          <StatTile
            label="Records processed"
            :value="latestFunnel?.read ?? null"
            hint="Read from the market subset by the newest run"
          />
        </div>
        <div class="span-3">
          <StatTile
            label="Didn't land"
            :value="latestFunnel ? latestFunnel.rejected + latestFunnel.dropped + latestFunnel.review : null"
            hint="Rejected, dropped or left in the review band"
          />
        </div>
```

- [ ] **Step 2: Add the funnel computed**

In the `<script setup>` block, after the `snapshot` computed, add:

```ts
// The newest run that recorded a funnel. Not simply runs[0]: a run published
// from a load with no matching score has no stage counts, and falling back to
// the one behind it beats showing an empty tile.
const latestFunnel = computed(() => {
  for (const run of snapshot.value?.runs ?? []) {
    if (!run.row) continue
    const funnel = runFunnel(run.row)
    if (funnel.available) return funnel.value
  }
  return null
})
```

Add `runFunnel` and `runLedger` to the import from `../lib/data/pipeline`, and drop `fetchRunLedger` from it.

- [ ] **Step 3: Replace the drawer's ledger block**

Replace:

```vue
          <StateBlock
            v-if="!ledger.available"
            state="unrecorded"
            title="What this run discarded"
            :message="ledger.reason"
            :would-require="ledger.wouldRequire"
          />
```

with:

```vue
          <StateBlock
            v-if="!ledger.available"
            state="unrecorded"
            title="What this run discarded"
            :message="ledger.reason"
            :would-require="ledger.wouldRequire"
          />
          <dl v-else class="drawer-facts u-facts">
            <div>
              <dt>Records read</dt>
              <dd class="u-num">{{ formatCount(ledger.value.recordsRead) }}</dd>
            </div>
            <div>
              <dt>Rejected before scoring</dt>
              <dd class="u-num">{{ formatCount(ledger.value.recordsRejected) }}</dd>
            </div>
            <div>
              <dt>Rows refreshed</dt>
              <dd class="u-num">{{ formatCount(ledger.value.updated) }}</dd>
            </div>
            <div>
              <dt>Barcode conflicts</dt>
              <dd class="u-num">{{ formatCount(ledger.value.barcodeConflicts) }}</dd>
            </div>
            <div>
              <dt>Deduped</dt>
              <dd class="u-num">{{ formatCount(ledger.value.duplicates) }}</dd>
            </div>
            <div>
              <dt>Failed chunks</dt>
              <dd class="u-num">{{ formatCount(ledger.value.errors) }}</dd>
            </div>
          </dl>

          <StateBlock
            v-if="openRun?.row?.outcomes_pruned"
            state="unrecorded"
            title="The records themselves are gone"
            message="Retention keeps the discarded records of the 5 most recent runs per source. This run's counts are exact; its individual records have been pruned."
            would-require="Nothing — this is the retention rule working. Re-publish from catalog-importer if you still have this run's out/ directory."
            compact
          />

          <RouterLink
            v-else-if="openRun?.row"
            :to="`/products?scope=outcomes&run=${encodeURIComponent(openRun.row.id)}`"
            class="drawer-link"
          >Browse what this run discarded</RouterLink>
```

- [ ] **Step 4: Rewire the ledger computed**

Replace:

```ts
const ledger = computed(() => fetchRunLedger(openRun.value?.version ?? null))
```

with:

```ts
// Pure now, over a row the drawer already holds. Nothing left to fetch.
const ledger = computed(() =>
  openRun.value?.row
    ? runLedger(openRun.value.row)
    : unavailable(
        'This run predates the import ledger, so only what its rows imply is known.',
        'Nothing — runs published from now on carry their own counts.',
      ),
)
```

Import `unavailable` from `../lib/data/types`.

- [ ] **Step 5: Add the funnel panel**

Replace the `PanelCard` titled "Pipeline logs" — keep it, and add this panel immediately above it:

```vue
      <PanelCard
        title="Where everything went"
        note="The newest run that recorded a funnel. Each stage is what the importer decided, not what the catalog implies."
        fill
      >
        <StateBlock
          v-if="!latestFunnel"
          state="unrecorded"
          title="No run has published a funnel"
          message="Runs recorded before the import ledger existed carry only the rows they created."
          would-require="Run `npm run publish` in catalog-importer against a scored run."
        />
        <BarChart
          v-else
          :bars="funnelBars"
          :format="formatCount"
          dense
        />
      </PanelCard>
```

and add the bars computed beside `latestFunnel`:

```ts
const funnelBars = computed(() => {
  const funnel = latestFunnel.value
  if (!funnel) return []
  return [
    { key: 'read', label: 'Read', value: funnel.read, meta: 'from the market subset' },
    { key: 'rejected', label: 'Rejected', value: funnel.rejected, meta: 'before scoring' },
    { key: 'dropped', label: 'Dropped', value: funnel.dropped, meta: 'by the gate' },
    { key: 'review', label: 'In review', value: funnel.review, meta: 'awaiting a verdict' },
    { key: 'auto', label: 'Auto-load', value: funnel.auto, meta: 'accepted' },
    { key: 'capped', label: 'Capped', value: funnel.capped, meta: 'over the per-market cap' },
  ]
})
```

- [ ] **Step 6: Verify in the browser**

```bash
cd /d/famcart/admin && npm run dev
```

Open the Product Pipeline page. Expected: the two tiles show numbers, the funnel panel renders six bars, and clicking a run opens a drawer with real discard counts and a "Browse what this run discarded" link. The "Trigger a run" panel is unchanged and still says runs cannot be started from a browser.

- [ ] **Step 7: Typecheck, lint and commit**

```bash
cd /d/famcart/admin && npm run typecheck && npm run lint && npx vitest run
git add src/views/PipelineView.vue
git commit -m "Show the funnel and what each run discarded"
```

---

### Task 9: The third scope on Products

**Files:**
- Modify: `admin/src/views/ProductsView.vue`

**Interfaces:**
- Consumes: `fetchOutcomes`, `OUTCOME_STAGES`, `OutcomeRow` (Task 7).
- Produces: no new exports.

- [ ] **Step 1: Widen the scope ref and read the route**

In `admin/src/views/ProductsView.vue`, change:

```ts
const scope = ref<'catalog' | 'local'>('catalog')
```

to:

```ts
const scope = ref<'catalog' | 'local' | 'outcomes'>('catalog')

// The run drawer links straight here. Reading it on mount rather than watching
// it: this is an entry point, not a filter that changes under you.
const route = useRoute()
const outcomeRun = ref<string | null>((route.query.run as string) ?? null)
const outcomeStage = ref<OutcomeStage | null>(null)
if (route.query.scope === 'outcomes') scope.value = 'outcomes'
```

Add `import { useRoute } from 'vue-router'` and the outcomes imports:

```ts
import { fetchOutcomes, OUTCOME_STAGES, type OutcomeRow, type OutcomeStage } from '../lib/data/outcomes'
```

Also widen the segment handler:

```ts
  scope.value = value as 'catalog' | 'local' | 'outcomes'
```

- [ ] **Step 2: Add the query**

Beside the existing `catalog` and `local` queries:

```ts
const outcomes = useQuery(
  (signal) =>
    fetchOutcomes(
      { runId: outcomeRun.value, stage: outcomeStage.value, reason: null },
      { query: params.value.query, limit, offset: params.value.offset },
      signal,
    ),
  { watch: [params, outcomeRun, outcomeStage], enabled: () => scope.value === 'outcomes' },
)
```

Add `outcomeRun` and `outcomeStage` to the `filters` array that resets the pager, and extend `active` and `total`:

```ts
const active = computed(() =>
  scope.value === 'catalog' ? catalog : scope.value === 'local' ? local : outcomes,
)
```

- [ ] **Step 3: Add the segment and the columns**

Add a third segment to the scope `SegmentedControl`:

```ts
            { value: 'outcomes', label: 'Didn\u2019t land', title: 'Records the importer rejected, dropped or left in review' },
```

and the column set:

```ts
const outcomeColumns: Column<OutcomeRow>[] = [
  { key: 'name', label: 'Product', width: '34%' },
  { key: 'maker', label: 'Maker', width: '16%', hideBelow: 1100 },
  { key: 'stage', label: 'Stage', width: '12%' },
  { key: 'reason', label: 'Why', width: '22%' },
  { key: 'score', label: 'Score', numeric: true, width: '8%' },
  { key: 'barcode', label: 'Barcode', width: '14%', hideBelow: 1400 },
]
```

- [ ] **Step 4: Add the table and the stage filter**

In the template, alongside the existing scope-conditional blocks:

```vue
        <SegmentedControl
          v-if="scope === 'outcomes'"
          :model-value="outcomeStage ?? 'all'"
          :segments="[
            { value: 'all', label: 'All' },
            { value: 'rejected', label: 'Rejected', title: 'Thrown out before scoring — usually no usable name' },
            { value: 'dropped', label: 'Dropped', title: 'Scored, and the gate said no' },
            { value: 'review', label: 'In review', title: 'In the middle band, awaiting a human verdict' },
          ]"
          label="Stage"
          @update:model-value="outcomeStage = $event === 'all' ? null : ($event as OutcomeStage)"
        />
```

and the table:

```vue
      <DataTable
        v-else-if="scope === 'outcomes'"
        :dense="dense"
        :columns="outcomeColumns"
        :rows="outcomes.data.value?.rows ?? []"
        row-key="id"
        empty-title="Nothing recorded"
        empty-message="No run has published its discarded records yet, or this run's have been pruned."
      >
        <template #cell-name="{ row }">
          <span v-if="row.name">{{ row.name }}</span>
          <!-- 12,554 of last run's 12,859 rejects were rejected FOR having no
               name. An em dash is the honest cell; "Unknown" would imply we
               looked it up and failed. -->
          <span v-else class="u-muted">— no name</span>
        </template>
        <template #cell-stage="{ row }">
          <StatusPill
            :tone="row.stage === 'review' ? 'warn' : 'idle'"
            :label="String(row.stage)"
            :dot="false"
          />
        </template>
        <template #cell-score="{ row }">
          <span v-if="row.score !== null" class="u-num">{{ row.score }}</span>
          <span v-else class="u-muted">--</span>
        </template>
        <template #cell-barcode="{ row }">
          <CopyValue v-if="row.barcode" :value="String(row.barcode)" label="barcode" />
          <span v-else class="u-muted">--</span>
        </template>
      </DataTable>
```

Import `StatusPill` and `CopyValue` if the file does not already have them.

- [ ] **Step 5: Update the page description**

The `PageHeader` description currently describes two tables. Append one sentence:

```
A third scope shows what the importer decided NOT to write — rejected before scoring, dropped by the gate, or still in the review band — for the runs retention still holds.
```

- [ ] **Step 6: Verify in the browser**

```bash
cd /d/famcart/admin && npm run dev
```

From the Pipeline page, click a run, then "Browse what this run discarded". Expected: Products opens on the *Didn't land* scope, filtered to that run. Search a name and confirm it filters. Switch the stage segment and confirm the counts change.

- [ ] **Step 7: Typecheck, lint, test and commit**

```bash
cd /d/famcart/admin && npm run typecheck && npm run lint && npx vitest run
git add src/views/ProductsView.vue
git commit -m "Browse what the importer decided not to write"
```

---

### Task 10: Ship it

**Files:**
- Modify: `admin/README.md` (if it documents the sections — check first; if it does not, skip)
- Modify: `D:\famcart\CLAUDE.md`

**Interfaces:** none.

- [ ] **Step 1: Push the migration to the real catalog project**

```bash
cd /d/famcart/catalog-importer
npx supabase db push --dry-run --include-all --linked --workdir supabase-catalog
```

Expected: the dry run lists `004_import_runs.sql` and nothing else. Confirm that before continuing — if it lists any of `001`–`003`, stop: something has diverged and pushing would restate the whole catalog schema.

```bash
npx supabase db push --include-all --linked --workdir supabase-catalog
```

- [ ] **Step 2: Backfill from what is on disk**

```bash
cd /d/famcart/catalog-importer && npm run publish
```

Expected: one run published. It will be visibly partial — `report.md` is from 2026-08-19 and `load-plan.json` names `off-2026-08-20`, so the funnel and the load report describe different runs. That is why the run row keeps them in separate columns instead of stitching them into one number.

- [ ] **Step 3: Note the new table in CLAUDE.md**

In `D:\famcart\CLAUDE.md`, in the section "What this repo still depends on is the RPC contract", add after the existing paragraph:

```markdown
The catalog project now also holds `catalog_import_runs` and
`catalog_import_outcomes`, written by catalog-importer's `publish` step and read
by the admin dashboard. They are the database's only memory of a run as an
event: `import_catalog_products()` still returns its report to the CLI and still
does not persist it, so the ledger is written from the outside. Retention keeps
every run row and the discarded records of the five most recent runs per source.
```

- [ ] **Step 4: Full verification**

```bash
cd /d/famcart/catalog-importer && npx tsc --noEmit && npx vitest run
npx supabase db reset --workdir supabase-catalog && npx supabase test db --workdir supabase-catalog
cd /d/famcart/admin && npm run typecheck && npm run lint && npx vitest run && npm run build
```

Expected: every command clean. Report the actual output — if anything fails, say so rather than summarising it as passing.

- [ ] **Step 5: Commit and open the PRs**

```bash
cd /d/famcart/catalog-importer && git add -A && git commit -m "Document the import ledger" && git push -u origin feat/pipeline-outcomes
cd /d/famcart && git add CLAUDE.md && git commit -m "Note the import ledger in the catalog project"
cd /d/famcart/admin && git push -u origin feat/pipeline-outcomes
```

---

## Notes for the executor

**The two repos are not independent.** Tasks 6–9 will not run against a database that has not had Task 1's migration applied. Do Tasks 1–5 first, in order, and keep `.env.scripts` pointed at the LOCAL catalog stack until Task 10 — Task 5 Step 8 and Task 10 Step 2 both write.

**`escapeLike` and `CatalogNotConfigured`** are used by Task 7 and may be module-private in `products.ts`. Exporting them is the whole change; do not move or reimplement them.

**`StatTile`'s `unrecorded` prop stays in the codebase.** Search Analytics still uses it, and so does the logs panel. This feature narrows where it applies; it does not retire it.
