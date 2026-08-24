# Publishing what the importer discarded

**Date:** 2026-08-24
**Status:** design, approach approved, not yet planned
**Spans:** `catalog-importer` (schema + CLI), `famcart/admin` (UI)

## The problem

The Product Pipeline page tells you what landed and refuses to guess at what did
not. Two tiles, the run drawer's discard block and the whole logs panel render
as `unrecorded`, because `import_catalog_products()` returns its report to the
CLI and nothing persists it, and because a record rejected before scoring never
becomes a row to count.

That refusal is correct and stays. What changes is the premise: the numbers stop
being unrecoverable, because the importer starts recording them.

Today the evidence sits in `catalog-importer/out/` on one machine:

| file | rows | what it holds |
|---|---:|---|
| `rejected.jsonl` | 12,859 | thrown out before scoring — barcode and reason only |
| `dropped.jsonl` | 7,435 | failed the quality gate — name, maker, score, reason |
| `review-queue.jsonl` | 500 | a *sample* of the 12,255-strong review band |
| `load-errors.jsonl` | 22 | failed at the write step |
| `load-plan.json` | — | the RPC report: inserted, updated, skipped, conflicts |
| `report.md` | — | the funnel, and the reason tallies behind it |

## What we are building

Two tables in the catalog project, written by the importer, read by the
dashboard with the anon key it already holds.

### Where the records actually come from

Not from the small files above. `dropped.jsonl` and `review-queue.jsonl` are
derived views written for a human at a terminal — the review queue is capped at
`REVIEW_QUEUE_CAP` (500) out of 12,255. The complete population is
`scored.jsonl`, which carries every scored product with its verdict and reason,
plus `rejected.jsonl` for the records that never reached scoring.

So the publisher reads `scored.jsonl` + `rejected.jsonl` and derives the three
stages itself. The sampling that makes the terminal usable does not follow the
data into the database.

### A run spans two commands

`score` produces the funnel counts. `load --apply` produces the RPC report. They
are separate invocations and can be days apart — as the current `out/` proves:
`report.md` is dated 2026-08-19 while `load-plan.json` is `off-2026-08-20`.

A run row is therefore **opened by `score` and completed by `load --apply`**,
keyed on a uuid minted at score time and parked in `out/run.json`.

Not keyed on `source_version`: it is derived from the dump date, so two scores of
the same dump collide, and the second would silently overwrite the first. A
re-run should be a new row you can see, not an edit you cannot.

If `load --apply` finds no `out/run.json` — loading an older `scored.jsonl`, say
— it opens a run row of its own with the stage counts null. Partial history
labelled as partial, rather than a gap.

## Schema

Lives in `catalog-importer/supabase-catalog/supabase/migrations/`, as a new file
rather than an edit to `003`. These are new tables and a restatement inside an
existing consolidated file would be invisible to `db push`. See FamCart's
CLAUDE.md on why `001`–`003` are restatements and what that costs.

### `catalog_import_runs`

One row per run. Small, and kept forever.

| column | type | written by | notes |
|---|---|---|---|
| `id` | uuid pk | score | minted client-side, parked in `out/run.json` |
| `source` | text not null | score | checked against the same import-source list `import_catalog_products()` enforces |
| `source_version` | text | score | e.g. `off-2026-08-20` |
| `scored_at` | timestamptz | score | |
| `loaded_at` | timestamptz | load --apply | null until the load lands |
| `records_read` | integer | score | the funnel, straight off `renderScoreReport` |
| `records_rejected` | integer | score | |
| `records_auto` | integer | score | |
| `records_review` | integer | score | |
| `records_dropped` | integer | score | |
| `records_capped` | integer | score | the per-market cap's `cappedAway` |
| `inserted` | integer | load --apply | from the RPC's jsonb report |
| `updated_imported` | integer | load --apply | |
| `updated_provenance_only` | integer | load --apply | |
| `skipped_invalid` | integer | load --apply | |
| `skipped_barcode_conflict` | integer | load --apply | |
| `deduped` | integer | load --apply | |
| `collapsed_scoped` | integer | load --apply | |
| `dry_run` | boolean | load --apply | a dry run is still a run worth seeing |
| `reason_tallies` | jsonb | score | the `countBy` breakdowns `report.md` renders |
| `load_errors` | jsonb | load --apply | the contents of `load-errors.jsonl` |

`reason_tallies` is jsonb rather than a fourth table because nothing queries
*across* runs by reason — the dashboard renders one run's breakdown at a time,
and the reason vocabulary belongs to the gate, which should be free to change it
without a migration.

### `catalog_import_outcomes`

One row per record that did not land.

| column | type | notes |
|---|---|---|
| `id` | bigint generated always as identity, pk | |
| `run_id` | uuid not null references `catalog_import_runs(id)` on delete cascade | the cascade is what makes pruning one statement |
| `barcode` | text not null | |
| `name` | text | null for pre-scoring rejects — most of them have no name, which is *why* they were rejected |
| `maker` | text | |
| `score` | integer | null for pre-scoring rejects, which were never scored |
| `stage` | text not null | `rejected` \| `dropped` \| `review` |
| `reason` | text not null | `no-name`, `no-scans-no-brand`, `middle-band`, … |
| `flags` | text[] | the scorer's flags, where it has any |

Indexes: `(run_id, stage)` for the drawer, a trigram index on `name` for the
"why isn't Nutella in the catalog" search, and a plain btree on `barcode` — it is
the one identifier that does not move, which is the same reason `decisions.jsonl`
keys on it.

Deliberately NOT stored: the records that *did* land. They are in
`product_catalog`, queryable today, and mirroring them would double the write for
a question already answered.

### Grants and RLS

Read to `authenticated`, exactly as `product_catalog` has it in `003`. Write to
`service_role` only.

The catalog project has no admin concept — `product_catalog` is readable by any
signed-in FamCart account. These rows are barcodes, names and scores derived from
public Open Food Facts data; nothing about a household is in them. Building an
admin gate over there to protect already-public data would be a larger change
that deserves its own decision, and this feature should not be what drags it in.
Recorded here so the choice is visible rather than inherited.

### Retention

Asymmetric, because the two tables have nothing in common but a foreign key.

- **Run rows: kept forever.** Twenty-odd columns, a few dozen rows. The history
  is the entire point of the feature.
- **Outcome rows: the 5 most recent runs per source.** ~32.5k rows a run, so
  pruning is what keeps the table bounded by construction rather than by anyone
  remembering. Done in the same transaction as the publish, by deleting older
  runs' outcomes through the cascade.

Pruning outcomes does not delete the run row. An old run keeps its counts and
loses its records, and the drawer says so — a truthful third state between "here
it is" and "never recorded", and the page already has the vocabulary for it.

## The CLI change

A new `src/publish/` module and a `publish` command, plus two call sites.

**Automatic and best-effort.** `score` publishes the run and its outcomes at the
end; `load --apply` completes the run row after the RPC returns. Neither fails
the command if the publish fails — `score` works offline today and must keep
working, and a half-loaded catalog is worse than an unpublished report.

On failure it warns loudly and names the retry, which republishes from whatever
is on disk. Idempotent: it upserts on `run.id`, so running it twice is running it
once.

```
npm run publish            # retry or backfill from out/
```

**Why automatic rather than a step you remember:** a step you have to remember is
a step that will not be run, and an unpublished run means the dashboard shows
stale history confidently. That is the exact failure mode the Pipeline page is
written to avoid.

The service-role key it needs is the one `load --apply` already uses, read from
`.env.scripts` via `src/config.ts`. No new secret, and nothing new reaches a
browser.

## The dashboard change

### `src/lib/data/pipeline.ts`

The module's shape survives; its honesty tier moves. `fetchRunLedger()` was
written with the signature it would need once the data existed — "when the run
table exists, this becomes a query and every caller already renders the result".
This is that.

- `fetchRunLedger()` becomes a query against `catalog_import_runs`. Its parameter
  changes from `source_version` to the run `id`, because a version no longer
  identifies a run uniquely — that is the point of minting a uuid.
- It still returns `Metric<RunLedger>`. `Unavailable` is now the *pruned* and
  *pre-feature* case rather than the always case.
- `fetchPipelineLogs()` stays unavailable. `load-errors.jsonl` lands on the run
  row; a per-step log still is not written anywhere.
- `triggerCapability()` is untouched. Starting a run from a browser is still
  structurally impossible and the panel still says so.

`fetchPipeline()` reads the runs table directly instead of reconstructing history
from `loadCatalogShape()`. That removes the page's dependence on paging the whole
of `product_catalog` into the browser under `SHAPE_ROW_CEILING`, so the
truncation notice stops applying to run history — a run list computed from a
prefix could be missing whole runs, and now it cannot be.

### `src/lib/data/outcomes.ts` (new)

`fetchOutcomes({ runId, stage, reason, query }, page, signal)` — server-side
filtered and paged, following the `fetchLocalProducts` pattern.

### Pipeline view

- The two `unrecorded` tiles — **Records processed** and **Rejected records** —
  go live, fed by the funnel.
- A **funnel panel**: read → rejected → dropped → review → auto → inserted, with
  the reason tallies underneath.
- The run drawer's "What this run discarded" `StateBlock` becomes real counts,
  with a **Browse what this run discarded** link — the mirror of the existing
  "Browse this run's products".

### Products view

A third scope beside *Catalog* and *App database*: **Didn't land**. It inherits
the page's search box, pager and density control, and adds two filters — stage
and reason. It sits there rather than on a new route because it is products, and
the interesting comparison is against the products that did land.

## Testing

Three layers, each already set up.

- **pgTAP** (`supabase-catalog/supabase/tests/catalog.test.sql`): grants and RLS
  on both tables; the cascade; that a non-import `source` is refused the way
  `import_catalog_products()` refuses one.
- **vitest, importer** (`catalog-importer/test/`): deriving the three stages from
  a `scored.jsonl` + `rejected.jsonl` fixture; run-id round-trip through
  `out/run.json`; that a publish failure warns and does not throw.
- **vitest, admin** (`test/pipeline.test.ts` extended, plus a new
  `test/outcomes.test.ts`): the ledger's available and pruned branches; the funnel
  math; that the truncation notice no longer covers run history.

Run against the catalog project's local stack, and reset first — `db start`
restores from a backup and skips migrations:

```bash
npx supabase db reset --workdir catalog-importer/supabase-catalog
npx supabase test db  --workdir catalog-importer/supabase-catalog
```

## Backfill

`npm run publish` against the current `out/` gives the dashboard one run on day
one rather than an empty table.

It will be visibly partial, and should be: `report.md` is from 2026-08-19 and
`load-plan.json` from `off-2026-08-20`, so the stage counts and the load counts
describe different runs. The backfilled row gets the load report and null stage
counts, rather than a stitched-together number that reads as one run and is not.

## Out of scope

- **Triggering a run from the dashboard.** Unchanged and still impossible: the
  importer is a CLI holding a service-role key, a full acquire needs ~12GB of
  download and ~15GB of disk, and nothing is listening. The panel keeps saying so.
- **Ruling on the review band from the browser.** The natural follow-on, and a
  bigger change — it needs an admin gate in the catalog project and the CLI
  reading verdicts from the database instead of `data/decisions.jsonl`. Once
  these tables exist it is a much shorter distance.
- **Per-step pipeline logs.** Still written to a terminal and nowhere else.
