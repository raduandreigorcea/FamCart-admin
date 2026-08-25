# Starting a run from the dashboard

**Date:** 2026-08-25
**Status:** design, approach approved in chat, not yet planned
**Spans:** `catalog-importer` (schema, stage refactor, worker), `famcart/admin` (UI)

## The problem

The Pipeline page has a panel that says runs cannot be started from a browser, and
lists five `npm run` commands instead. That panel is honest and it is also the
thing the dashboard was built to stop doing.

Piece 1 moved review verdicts into the database, so approving a product is now a
click. But a verdict changes nothing until somebody opens a terminal and types
`npm run score`, so the loop the dashboard exists to close is still open at one
end.

## Why a browser cannot just do it

Three structural reasons, all still true:

- The importer holds `CATALOG_SUPABASE_SERVICE_ROLE_KEY`, which can rewrite every
  row in the catalog. It must never reach a browser.
- A full `acquire` downloads ~12 GB and needs ~15 GB of free disk.
- It is a Node CLI on a filesystem. Nothing is listening.

So the dashboard does not run the pipeline. It **asks for a run**, and a process
on the operator's machine does the work. The two never talk to each other.

## Shape

The catalog project is the only thing both sides can reach, and it is already how
they communicate. It becomes the queue.

```
dashboard  --enqueue-->  catalog_run_requests  <--claim--  worker (npm run worker)
                                 ^                              |
                                 +----- progress, logs ---------+
                         dashboard polls the row while it is active
```

This survives the dashboard being deployed later, which was the constraint that
ruled out a localhost agent: nothing depends on the two being on one machine.

The cost is honest and has to be visible: **the button only works while the worker
is running.** A heartbeat makes that a state the UI can render rather than a
request that vanishes.

## What can be queued, and what cannot

Four job kinds, each mapping to a stage that exists today:

| kind | what it does | roughly |
|---|---|---|
| `normalize` | market subset to `out/staged.jsonl` | minutes |
| `score` | gate + cap, publishes the run, applies verdicts | minutes |
| `load` | dry run, writes `out/load-diff.md` | a minute |
| `load-apply` | writes the catalog | a minute |

**`acquire` is deliberately not queueable.** A full dump is ~12 GB and hours; a
delta still pulls a day's changes. Neither belongs behind a button that looks like
the other four, and a job that can run for hours needs cancellation and resumption
semantics the rest do not. It stays a terminal command, and the panel says so
rather than pretending the list is complete.

That still closes the loop this was built for: approve in Review, press
**Re-score**, watch it, read the diff, press **Apply**.

## Schema

A new `006_run_requests.sql` in the catalog project. New file, not an edit to
005: the earlier files are already recorded as applied.

### `catalog_run_requests`

```sql
id            uuid primary key default gen_random_uuid()
kind          text not null       -- normalize | score | load | load-apply
source        text not null       -- openfoodfacts | openproductsfacts | openbeautyfacts
status        text not null default 'queued'
                                  -- queued | running | done | failed | cancelling | cancelled
requested_by  text                -- Clerk user id
requested_at  timestamptz not null default now()
claimed_by    text                -- worker id
claimed_at    timestamptz
finished_at   timestamptz
run_id        uuid                -- the catalog_import_runs row this produced, when it made one
stage         text                -- what it is doing right now, for the UI
progress_done integer
progress_total integer            -- null when the stage cannot count ahead
error         text
log           jsonb not null default '[]'::jsonb
```

`log` is a capped array of `{at, level, text}`, newest appended, **trimmed to the
last 200 entries by the worker before each write**. It is not a real log drain and
does not pretend to be; it is the last screenful, which is what somebody watching
a run actually reads. `fetchPipelineLogs()` in the dashboard currently returns
`unavailable` naming exactly this as what would be required, and this narrows
that to "for runs started from here".

Progress is `done`/`total` rather than a percentage so the UI can render "chunk 12
of 240" for a load and a bare count for a stage that cannot see the end.

### `catalog_workers`

```sql
id             text primary key   -- stable per machine: hostname + a generated suffix
hostname       text
started_at     timestamptz not null default now()
last_seen_at   timestamptz not null default now()
current_request uuid references public.catalog_run_requests(id) on delete set null
```

One row per worker, heartbeated every 5 seconds. The dashboard treats a worker as
**offline when `last_seen_at` is older than 30 seconds**, which is six missed
beats: long enough that a slow chunk does not flap the badge, short enough that
pressing a dead button is rare.

### The RPCs

All `security definer`, all calling `catalog_admin_guard()` from 005, all granted
to `authenticated` and revoked from `anon`. Same discipline as the review RPCs.

- `enqueue_run(p_kind, p_source)` returns the new request id. Refuses when a
  request for the same source is already `queued` or `running`: two loads racing
  over one `out/` directory on one machine is not a queue, it is a corruption.
- `cancel_run(p_id)` moves `queued` straight to `cancelled`, and `running` to
  `cancelling`. It cannot kill a process; the worker checks between chunks.
- `list_run_requests(p_limit)` the recent queue, newest first.
- `get_run_request(p_id)` one row including its log, which is what the UI polls.
- `list_workers()` so the UI can say offline.

The worker's own writes — claiming, progress, logs, finishing — go through
`service_role` with the key it already holds, not through these.

**Claiming is `for update skip locked`:**

```sql
create or replace function public.claim_next_run_request(p_worker text)
...
  select id into v_id
  from public.catalog_run_requests
  where status = 'queued'
  order by requested_at
  for update skip locked
  limit 1;
```

Granted to `service_role` only. Two workers on two machines is not the expected
setup, but a queue whose claim is a read followed by a write is a queue that
hands the same job to both, and `skip locked` costs one clause.

## The stage refactor

`cli.ts` reads `argv` in sixteen places, inside the stage bodies. A worker cannot
call `score()` because `score()` decides what to do by looking at
`process.argv`.

So each stage moves to `src/stages/<name>.ts` as a function taking an explicit
options object and an optional reporter:

```ts
export interface StageContext {
  source: SourceConfig
  log: (level: 'info' | 'warn' | 'error', text: string) => void
  progress: (done: number, total: number | null, stage: string) => void
  cancelled: () => boolean
}

export async function runScore(ctx: StageContext, opts: { offline: boolean }): Promise<ScoreResult>
export async function runNormalize(ctx: StageContext): Promise<NormalizeResult>
export async function runLoad(ctx: StageContext, opts: { apply: boolean }): Promise<LoadResult>
```

`cli.ts` becomes the adapter that turns `argv` into those options and prints
through a `log` that writes to the console. The worker passes a `log` that appends
to the request row. **No behaviour changes**, which is what makes this safe: the
existing tests cover the stage internals and keep passing, and the terminal output
stays identical because the console reporter prints what the stage used to print.

`cancelled()` is checked between chunks in `load` and between the gate and the cap
in `score`. A cancel that has to wait for the current chunk is honest; one that
kills the process mid-write is not.

## The worker

`npm run worker`, a new command in the same CLI.

```
poll every 2s: claim_next_run_request(workerId)
  none      -> heartbeat, sleep
  claimed   -> run the stage, streaming progress and log lines to the row
               finish: status done|failed, finished_at, error
```

One job at a time, always. It holds `out/` on a real filesystem, and two stages
writing `scored.jsonl` at once loses one of them.

It exits cleanly on SIGINT, marking a running request `failed` with
`error = 'worker stopped'` rather than leaving it `running` forever. A request
whose worker died without that — power cut — is detected by the dashboard through
the heartbeat: `running` plus an offline worker renders as stalled, and the row
can be cancelled.

## The dashboard

`admin/src/lib/data/runs.ts`, the RPC wrappers, following `review.ts`.

`PipelineView.vue` replaces the "Trigger a run" unavailable panel with a real one:

- **Runner state** first, because everything else depends on it: `Runner online`
  with the hostname, or `Runner offline` with `npm run worker` and the reason it
  is needed. The buttons are disabled when offline, with the badge as the
  explanation rather than a failed request.
- **Four buttons** in pipeline order, plus a source selector. `Apply` is behind a
  `ConfirmDialog` naming the source and what it writes; the other three are not,
  because a dry run and a re-score cost time and nothing else.
- **The active run**, while one is queued or running: stage, progress, elapsed,
  the last log lines, and Cancel. Polled every 2 seconds through `useQuery`'s
  existing refetch, not Realtime: the catalog project has no publication, adding
  one is a migration plus a subscription lifecycle, and a job measured in minutes
  does not need sub-second updates.
- **Recent requests**, a small table with kind, source, status, duration, and the
  error when one failed.

Polling stops when nothing is active, so an idle Pipeline page makes no more
requests than it does today.

When a run finishes, the Review page's banner count and the run list are stale, so
finishing triggers a refetch of the page's other queries.

## Failure states

| state | what the UI shows |
|---|---|
| catalog not configured | the existing unconfigured block, unchanged |
| not a catalog admin | `42501` through `describeError`'s forbidden branch |
| no worker ever seen | Runner offline, with the command |
| worker offline, request queued | queued, with "waiting for a runner" |
| worker offline, request running | stalled, with Cancel offered |
| stage threw | failed, with the error and the last log lines |

## Testing

**pgTAP** in the catalog suite: a non-admin cannot enqueue or cancel; enqueue
refuses a second request for a source that already has one active; two concurrent
claims return different rows and never the same one; cancel moves `queued` to
`cancelled` and `running` to `cancelling`; `list_workers` reports staleness.

**Vitest, catalog-importer:** each extracted stage against its existing fixtures,
asserting the refactor changed nothing; the worker's claim-run-finish loop against
a fake client, including a stage that throws (row ends `failed`, error recorded)
and a cancel observed mid-run (row ends `cancelled`); the log trimmer caps at 200.

**Vitest, admin:** RPC argument shapes; the runner-offline computation from
`last_seen_at`; a component test that the buttons are disabled with no worker,
that Apply is confirmed, and that a failed request renders its error.

## Order of work

1. `006_run_requests.sql` + pgTAP
2. The stage refactor, with the existing suite green and terminal output unchanged
3. The worker, plus `npm run worker`
4. `admin/src/lib/data/runs.ts`
5. The Pipeline panel
6. Cancel, and the stalled state

Steps 1-3 are usable without any UI: `enqueue_run` can be called from SQL and the
worker will run it, which is how the worker gets tested before a button exists.

## Out of scope

- **`acquire`**, for the reasons above. It stays terminal.
- **Gate tuning** from the UI. Still its own piece if it is ever wanted.
- **A hosted runner.** The worker runs where the disk and the key are. If the
  dashboard is deployed later this design does not change; only the worker's
  location would, and that is a separate decision with a cost attached.
