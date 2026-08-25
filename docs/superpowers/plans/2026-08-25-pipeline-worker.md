# Pipeline Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin start a pipeline stage from the dashboard and watch it run, with the work executed by a worker process on the operator's machine.

**Architecture:** The dashboard and the operator's PC never talk to each other. Both talk to the catalog project, which becomes the queue: the dashboard calls a guarded `enqueue_run` RPC, `npm run worker` claims the row with `for update skip locked`, runs the stage, and streams progress and log lines back onto the row the dashboard polls every two seconds.

**Tech Stack:** Postgres 15 + pgTAP (catalog project), Node 22 + tsx + Vitest (catalog-importer), Vue 3 + Vitest + happy-dom (admin).

**Spec:** `admin/docs/superpowers/specs/2026-08-25-pipeline-worker-design.md`

## Global Constraints

- **Two repos.** Tasks 1-5 land in `catalog-importer` (`D:\famcart\catalog-importer`). Tasks 6-8 land in `admin` (`D:\famcart\admin`). Commit in the submodule you changed.
- **No service-role key in the admin bundle, ever.** The dashboard only ever calls guarded RPCs.
- **New migration file**, never an edit to 001-005. Those are already recorded as applied; a change inside one is invisible to `db push`.
- **Constraints restated below the table** with `alter table ... drop constraint if exists` + `add constraint`, never left inside `create table if not exists`.
- **Always reset before testing:** `npx supabase db reset --workdir supabase-catalog` then `npx supabase test db --workdir supabase-catalog`, both run from `D:\famcart\catalog-importer`.
- **`42501` is the not-an-admin code**, matching `catalog_admin_guard()` in 005.
- **The stage refactor changes no behaviour.** Terminal output must stay byte-identical; the existing suite must stay green without edits to its assertions.
- **`acquire` is not queueable.** Four kinds only: `normalize`, `score`, `load`, `load-apply`.
- **No em dashes** in any comment, copy, or commit message.
- **Commit messages: no Claude attribution, no Co-Authored-By.**

---

### Task 1: The queue schema

**Files:**
- Create: `supabase-catalog/supabase/migrations/006_run_requests.sql`
- Modify: `supabase-catalog/supabase/tests/catalog.test.sql`

**Interfaces:**
- Consumes: `public.catalog_admin_guard()`, `public.requesting_user_id()` from earlier migrations.
- Produces: tables `public.catalog_run_requests`, `public.catalog_workers`; functions `enqueue_run(text, text) returns uuid`, `cancel_run(uuid) returns void`, `list_run_requests(integer) returns table(...)`, `get_run_request(uuid) returns table(...)`, `list_workers() returns table(...)`, `claim_next_run_request(text) returns table(...)`, `heartbeat_worker(text, text, uuid) returns void`.

- [ ] **Step 1: Write the migration**

Create `supabase-catalog/supabase/migrations/006_run_requests.sql`:

```sql
-- Asking for a run, from something that cannot perform one.
--
-- The Pipeline page had a panel saying runs cannot be started from a browser and
-- listing five npm commands instead. That was honest and it was also the thing
-- this dashboard exists to stop doing: piece 1 made approving a product a click,
-- and then the click did nothing until somebody opened a terminal.
--
-- Three reasons a browser still cannot run the pipeline, all unchanged: the
-- importer holds a service-role key that can rewrite every row in the catalog; a
-- full acquire needs ~15 GB of free disk; and it is a CLI on a filesystem with
-- nothing listening.
--
-- So the dashboard does not run anything. It writes a row here, and a worker on
-- the operator's machine claims it. The two never talk to each other, which is
-- also what lets the dashboard be deployed later without redesigning this.

-- ─── the queue ───────────────────────────────────────────────────────────────
create table if not exists public.catalog_run_requests (
  id             uuid        primary key default gen_random_uuid(),
  kind           text        not null,
  source         text        not null,
  status         text        not null default 'queued',

  requested_by   text,
  requested_at   timestamptz not null default now(),

  claimed_by     text,
  claimed_at     timestamptz,
  finished_at    timestamptz,

  -- The catalog_import_runs row this produced, when the stage made one. Only
  -- score opens a run; a dry-run load does not.
  run_id         uuid,

  -- What it is doing right now. Free text from the stage, shown as-is.
  stage          text,
  progress_done  integer,
  -- Null when the stage cannot count ahead. A normalize streams a file of
  -- unknown length; a load knows its chunk count before it starts. Rendering
  -- "12 of 240" and a bare "3,914" are different UIs and the difference is
  -- exactly this column being null.
  progress_total integer,

  error          text,

  -- The last screenful, as {at, level, text}, trimmed to 200 entries by the
  -- worker before each write. Not a log drain and it does not pretend to be:
  -- fetchPipelineLogs() in the dashboard returns `unavailable` naming a real one
  -- as what would be required, and this narrows that to "for runs started here".
  log            jsonb       not null default '[]'::jsonb
);

alter table public.catalog_run_requests
  drop constraint if exists catalog_run_requests_kind_check;
alter table public.catalog_run_requests
  add constraint catalog_run_requests_kind_check
  check (kind in ('normalize', 'score', 'load', 'load-apply'));

alter table public.catalog_run_requests
  drop constraint if exists catalog_run_requests_status_check;
alter table public.catalog_run_requests
  add constraint catalog_run_requests_status_check
  check (status in ('queued', 'running', 'done', 'failed', 'cancelling', 'cancelled'));

alter table public.catalog_run_requests
  drop constraint if exists catalog_run_requests_source_check;
alter table public.catalog_run_requests
  add constraint catalog_run_requests_source_check
  check (source in ('openfoodfacts', 'openproductsfacts', 'openbeautyfacts'));

create index if not exists catalog_run_requests_queued
  on public.catalog_run_requests (status, requested_at);

create index if not exists catalog_run_requests_recent
  on public.catalog_run_requests (requested_at desc);

comment on table public.catalog_run_requests is
  'A request for the importer to run a stage. Written by the admin dashboard, '
  'claimed and updated by `npm run worker` on the operator''s machine.';

alter table public.catalog_run_requests enable row level security;
revoke all on public.catalog_run_requests from anon, authenticated;
grant select, insert, update on public.catalog_run_requests to service_role;

-- ─── who is listening ────────────────────────────────────────────────────────
--
-- Without this the button is a request that vanishes. A heartbeat turns "no
-- worker is running" into a state the UI can render before you press anything,
-- which is the difference between a disabled button with an explanation and a
-- job that sits queued forever with no clue why.
create table if not exists public.catalog_workers (
  id              text        primary key,
  hostname        text,
  started_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  current_request uuid        references public.catalog_run_requests(id) on delete set null
);

create index if not exists catalog_workers_seen
  on public.catalog_workers (last_seen_at desc);

alter table public.catalog_workers enable row level security;
revoke all on public.catalog_workers from anon, authenticated;
grant select, insert, update, delete on public.catalog_workers to service_role;

-- ─── what the dashboard may do ───────────────────────────────────────────────
--
-- All guarded, all granted to authenticated, all revoked from anon. Same
-- discipline 005 sets out for the review RPCs.

-- Refuses a second request for a source that already has one active. Two loads
-- racing over one out/ directory on one machine is not a queue, it is a
-- corruption: they write the same scored.jsonl and one of them loses.
create or replace function public.enqueue_run(p_kind text, p_source text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  perform public.catalog_admin_guard();

  if exists (
    select 1 from public.catalog_run_requests
    where source = p_source and status in ('queued', 'running', 'cancelling')
  ) then
    raise exception 'a run for % is already queued or running', p_source
      using errcode = '55006';
  end if;

  insert into public.catalog_run_requests (kind, source, requested_by)
  values (p_kind, p_source, public.requesting_user_id())
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.enqueue_run(text, text) from public, anon;
grant execute on function public.enqueue_run(text, text) to authenticated;

-- Cannot kill a process. A queued request is cancelled outright; a running one
-- is asked to stop, and the worker notices between chunks. A cancel that waited
-- for the current chunk is honest; one that claimed to kill a process mid-write
-- would not be.
create or replace function public.cancel_run(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
begin
  perform public.catalog_admin_guard();

  update public.catalog_run_requests
  set status = case when status = 'queued' then 'cancelled' else 'cancelling' end,
      finished_at = case when status = 'queued' then now() else finished_at end
  where id = p_id and status in ('queued', 'running');
end;
$$;

revoke all on function public.cancel_run(uuid) from public, anon;
grant execute on function public.cancel_run(uuid) to authenticated;

create or replace function public.list_run_requests(p_limit integer default 20)
returns table (
  id uuid, kind text, source text, status text,
  requested_by text, requested_at timestamptz,
  claimed_by text, claimed_at timestamptz, finished_at timestamptz,
  run_id uuid, stage text, progress_done integer, progress_total integer,
  error text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.catalog_admin_guard();

  return query
  select r.id, r.kind, r.source, r.status,
         r.requested_by, r.requested_at,
         r.claimed_by, r.claimed_at, r.finished_at,
         r.run_id, r.stage, r.progress_done, r.progress_total,
         r.error
  from public.catalog_run_requests r
  order by r.requested_at desc
  limit greatest(p_limit, 0);
end;
$$;

revoke all on function public.list_run_requests(integer) from public, anon;
grant execute on function public.list_run_requests(integer) to authenticated;

-- The one the UI polls while something is active. Separate from the list
-- because it carries the log, and shipping 200 log entries per row of a
-- twenty-row table on a two-second poll is the difference between a live view
-- and a bandwidth problem.
create or replace function public.get_run_request(p_id uuid)
returns table (
  id uuid, kind text, source text, status text,
  requested_at timestamptz, claimed_at timestamptz, finished_at timestamptz,
  run_id uuid, stage text, progress_done integer, progress_total integer,
  error text, log jsonb
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.catalog_admin_guard();

  return query
  select r.id, r.kind, r.source, r.status,
         r.requested_at, r.claimed_at, r.finished_at,
         r.run_id, r.stage, r.progress_done, r.progress_total,
         r.error, r.log
  from public.catalog_run_requests r
  where r.id = p_id;
end;
$$;

revoke all on function public.get_run_request(uuid) from public, anon;
grant execute on function public.get_run_request(uuid) to authenticated;

create or replace function public.list_workers()
returns table (
  id text, hostname text, started_at timestamptz,
  last_seen_at timestamptz, current_request uuid, seconds_since_seen numeric
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.catalog_admin_guard();

  return query
  select w.id, w.hostname, w.started_at, w.last_seen_at, w.current_request,
         extract(epoch from (now() - w.last_seen_at))::numeric
  from public.catalog_workers w
  order by w.last_seen_at desc;
end;
$$;

revoke all on function public.list_workers() from public, anon;
grant execute on function public.list_workers() to authenticated;

-- ─── what the worker may do ──────────────────────────────────────────────────
--
-- service_role only. The worker holds the key already; these exist so claiming
-- is atomic, not to gate it.

-- for update skip locked, and not as ceremony. A claim that is a read followed
-- by a write hands the same job to two workers, and two workers on one out/
-- directory lose each other's files. Two machines is not the expected setup;
-- the clause costs nothing and removes the question.
create or replace function public.claim_next_run_request(p_worker text)
returns table (id uuid, kind text, source text)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  select r.id into v_id
  from public.catalog_run_requests r
  where r.status = 'queued'
  order by r.requested_at
  for update skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  update public.catalog_run_requests
  set status = 'running', claimed_by = p_worker, claimed_at = now()
  where catalog_run_requests.id = v_id;

  return query
  select r.id, r.kind, r.source
  from public.catalog_run_requests r
  where r.id = v_id;
end;
$$;

revoke all on function public.claim_next_run_request(text) from public, anon, authenticated;
grant execute on function public.claim_next_run_request(text) to service_role;

create or replace function public.heartbeat_worker(
  p_worker text,
  p_hostname text default null,
  p_request uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
begin
  insert into public.catalog_workers (id, hostname, last_seen_at, current_request)
  values (p_worker, p_hostname, now(), p_request)
  on conflict (id) do update
    set last_seen_at    = now(),
        hostname        = coalesce(excluded.hostname, catalog_workers.hostname),
        current_request = excluded.current_request;
end;
$$;

revoke all on function public.heartbeat_worker(text, text, uuid) from public, anon, authenticated;
grant execute on function public.heartbeat_worker(text, text, uuid) to service_role;
```

- [ ] **Step 2: Add the pgTAP tests**

Append to `supabase-catalog/supabase/tests/catalog.test.sql`, before the final
`select * from finish();`, and raise the plan count by 14 (from 92 to 106):

```sql
-- ── 8. The run queue ─────────────────────────────────────────────────────────

-- Section 7 left `reset role`. Go back to a signed-in non-admin the same way it
-- did, rather than switching claims inside a statement.
set local role authenticated;
set local request.jwt.claims = '{"sub": "user_nobody"}';

select throws_ok(
  $$ select public.enqueue_run('score', 'openfoodfacts') $$,
  '42501',
  'admin only',
  'a non-admin cannot enqueue a run'
);

select throws_ok(
  $$ select public.cancel_run('00000000-0000-0000-0000-000000000000'::uuid) $$,
  '42501',
  'admin only',
  'a non-admin cannot cancel a run'
);

set local request.jwt.claims = '{"sub": "user_admin"}';

select lives_ok(
  $$ select public.enqueue_run('score', 'openfoodfacts') $$,
  'an admin can enqueue a run'
);

select is(
  (select count(*)::int from public.list_run_requests(10)),
  1,
  'the request is listed'
);

select is(
  (select status from public.list_run_requests(10)),
  'queued',
  'a new request starts queued'
);

select is(
  (select requested_by from public.list_run_requests(10)),
  'user_admin',
  'the request records who asked'
);

select throws_ok(
  $$ select public.enqueue_run('load', 'openfoodfacts') $$,
  '55006',
  null,
  'a second request for the same source is refused while one is active'
);

select lives_ok(
  $$ select public.enqueue_run('score', 'openbeautyfacts') $$,
  'a different source may be enqueued at the same time'
);

-- Claiming, as the worker does it.
reset role;

select is(
  (select count(*)::int from public.claim_next_run_request('worker-a')),
  1,
  'claiming returns one request'
);

select is(
  (select count(*)::int from public.catalog_run_requests where status = 'running'),
  1,
  'the claimed request is running'
);

select isnt(
  (select id from public.claim_next_run_request('worker-b')),
  (select id from public.catalog_run_requests where claimed_by = 'worker-a'),
  'a second claim never returns the row the first one took'
);

select is(
  (select count(*)::int from public.claim_next_run_request('worker-c')),
  0,
  'claiming an empty queue returns nothing'
);

select lives_ok(
  $$ select public.heartbeat_worker('worker-a', 'desktop', null) $$,
  'a worker can heartbeat'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "user_admin"}';

select cmp_ok(
  (select seconds_since_seen from public.list_workers() where id = 'worker-a'),
  '<',
  5::numeric,
  'a fresh heartbeat reads as seconds old'
);

-- Cancelling a running request asks rather than kills.
select public.cancel_run(
  (select id from public.catalog_run_requests where status = 'running' limit 1)
);

select is(
  (select count(*)::int from public.catalog_run_requests where status = 'cancelling'),
  1,
  'cancelling a running request asks the worker to stop rather than killing it'
);

select public.cancel_run(
  (select id from public.catalog_run_requests where status = 'queued' limit 1)
);

select is(
  (select count(*)::int from public.catalog_run_requests where status = 'cancelled'),
  1,
  'cancelling a queued request cancels it outright, with no worker involved'
);

reset role;
```

- [ ] **Step 3: Reset and run the suite**

Run from `D:\famcart\catalog-importer`:

```bash
npx supabase db reset --workdir supabase-catalog
npx supabase test db --workdir supabase-catalog
```

Expected: 106 passing. If the count is off, the message names the actual number;
set `plan(...)` to it rather than guessing.

- [ ] **Step 4: Commit**

```bash
git add supabase-catalog/supabase/migrations/006_run_requests.sql supabase-catalog/supabase/tests/catalog.test.sql
git commit -m "Add the run queue the dashboard writes to and the worker claims"
```

---

### Task 2: Extract the stages so something other than argv can call them

**Files:**
- Create: `src/stages/types.ts`, `src/stages/normalize.ts`, `src/stages/score.ts`, `src/stages/load.ts`
- Modify: `src/cli.ts`
- Test: `test/stages.test.ts`

**Interfaces:**
- Consumes: everything the current stage bodies import.
- Produces:
  - `StageContext` in `src/stages/types.ts`: `{ source: SourceConfig; log(level, text): void; progress(stage: string, done: number, total: number | null): void; cancelled(): boolean }`
  - `consoleContext(source: SourceConfig): StageContext`
  - `runNormalize(ctx: StageContext): Promise<{ staged: number; rejected: number }>`
  - `runScore(ctx: StageContext, opts: { offline: boolean }): Promise<{ scored: number; queued: number; runId: string }>`
  - `runLoad(ctx: StageContext, opts: { apply: boolean }): Promise<{ rows: number; errors: number; runId: string | null }>`

- [ ] **Step 1: Write the failing test**

Create `test/stages.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { consoleContext } from '../src/stages/types.ts'
import { SOURCES } from '../src/config.ts'

describe('consoleContext', () => {
  it('prints info through console.log and warnings through console.warn', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const ctx = consoleContext(SOURCES.openfoodfacts)
    ctx.log('info', 'hello')
    ctx.log('warn', 'careful')

    expect(log).toHaveBeenCalledWith('hello')
    expect(warn).toHaveBeenCalledWith('careful')

    log.mockRestore()
    warn.mockRestore()
  })

  // The terminal is not a progress bar. A stage reporting progress to a console
  // context must print nothing, or every load would emit 240 lines nobody asked
  // for and the output would stop matching what it was before the refactor.
  it('swallows progress, because the terminal already prints its own lines', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const ctx = consoleContext(SOURCES.openfoodfacts)
    ctx.progress('chunking', 3, 10)

    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('is never cancelled, because a terminal run is cancelled with ctrl-c', () => {
    expect(consoleContext(SOURCES.openfoodfacts).cancelled()).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/stages.test.ts`
Expected: FAIL, cannot resolve `../src/stages/types.ts`.

- [ ] **Step 3: Write `src/stages/types.ts`**

```ts
// What a stage reports to, so a stage can be run by something that is not a
// terminal.
//
// cli.ts used to read process.argv inside the stage bodies, in sixteen places.
// That made the stages uncallable: `score()` decided what to do by looking at
// the command line, so a worker could not ask it to score anything. The bodies
// moved here unchanged and take an explicit options object instead; cli.ts is
// the adapter that turns argv into one.
//
// The reporter is the other half. A stage used to console.log directly, which
// is right for a terminal and useless to a worker that needs those lines in a
// database row. Now it calls ctx.log(), and who is listening decides what that
// means.
import type { SourceConfig } from '../types.ts'

export type LogLevel = 'info' | 'warn' | 'error'

export interface StageContext {
  source: SourceConfig
  log(level: LogLevel, text: string): void
  /**
   * Where the stage has got to. `total` is null when the stage cannot count
   * ahead: normalize streams a file of unknown length, while load knows its
   * chunk count before it starts. Rendering "12 of 240" and a bare "3,914" are
   * different UIs and the difference is exactly this being null.
   */
  progress(stage: string, done: number, total: number | null): void
  /** Checked between chunks. A stage never stops mid-write. */
  cancelled(): boolean
}

/**
 * The terminal. Prints exactly what the stages printed before the refactor,
 * which is what makes the refactor safe to verify: same commands, same output.
 *
 * Progress is deliberately swallowed. The stages already print their own
 * per-chunk lines, and echoing progress on top would add 240 lines to a load
 * that nobody asked for.
 */
export function consoleContext(source: SourceConfig): StageContext {
  return {
    source,
    log(level, text) {
      if (level === 'error') console.error(text)
      else if (level === 'warn') console.warn(text)
      else console.log(text)
    },
    progress() {},
    cancelled: () => false,
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/stages.test.ts`
Expected: PASS.

- [ ] **Step 5: Move the normalize body into `src/stages/normalize.ts`**

Cut the body of `normalize()` out of `cli.ts` and paste it here, replacing
`console.warn`/`console.log` with `ctx.log(...)` and `source` with `ctx.source`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  loadBrandAliases,
  loadCasingExceptions,
  loadMarkets,
  loadNameBlocklist,
  outDir,
  paths,
} from '../config.ts'
import { streamSubset } from '../acquire/dump.ts'
import { normalizeProduct } from '../normalize/index.ts'
import { hasCategoryTaxonomy, loadCategoryTaxonomy } from '../normalize/aliases.ts'
import type { StagedProduct } from '../types.ts'
import type { StageContext } from './types.ts'

const writeJsonl = (path: string, rows: unknown[]) => {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    path,
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
    'utf8',
  )
}

export async function runNormalize(
  ctx: StageContext,
): Promise<{ staged: number; rejected: number }> {
  const normalizeCtx = {
    aliases: loadBrandAliases(),
    casing: loadCasingExceptions(),
    markets: loadMarkets(),
    blocklist: loadNameBlocklist(),
    // Cached on disk by `acquire:taxonomy`. Absent means no cross-language
    // aliases rather than a failure, so a run started before the taxonomy was
    // fetched still produces a usable catalog, just a monolingual one.
    taxonomy: hasCategoryTaxonomy(ctx.source) ? loadCategoryTaxonomy(ctx.source) : undefined,
  }
  if (!normalizeCtx.taxonomy) {
    ctx.log(
      'warn',
      'No category taxonomy cached — products will have no cross-language search terms.' +
        '  Run `npm run acquire:taxonomy` first to fix that.',
    )
  }

  const staged: StagedProduct[] = []
  const rejected: { barcode: string; reason: string; detail?: string }[] = []

  // Streamed rather than collected: across six markets of a full dump the array
  // this used to build is hundreds of thousands of objects held at once.
  for await (const record of streamSubset(ctx.source)) {
    const result = normalizeProduct(record, normalizeCtx)
    if (result.ok) staged.push(result.product)
    else rejected.push(result.rejected)

    // Every 5,000 rather than every row: a progress write per record would be
    // hundreds of thousands of database updates for a bar that moves in pixels.
    const seen = staged.length + rejected.length
    if (seen % 5000 === 0) ctx.progress('normalizing', seen, null)
  }

  writeJsonl(paths.staged, staged)
  writeJsonl(paths.rejected, rejected)
  ctx.log(
    'info',
    `${staged.length.toLocaleString()} products staged, ${rejected.length.toLocaleString()} rejected.\n` +
      `  ${paths.staged}\n  ${paths.rejected}\n\nNext: npm run score`,
  )

  return { staged: staged.length, rejected: rejected.length }
}
```

- [ ] **Step 6: Point `cli.ts` at it**

Replace the whole `normalize()` function in `cli.ts` with:

```ts
async function normalize() {
  await runNormalize(consoleContext(source))
}
```

and add `import { runNormalize } from './stages/normalize.ts'` plus
`import { consoleContext } from './stages/types.ts'`. Delete any imports that
`cli.ts` no longer uses; `npx tsc --noEmit` names them.

- [ ] **Step 7: Move `score` and `load` the same way**

`src/stages/score.ts` exports
`runScore(ctx, { offline }): Promise<{ scored: number; queued: number; runId: string }>`,
holding the current body of `score()` with these substitutions: `hasFlag('--offline')`
becomes `opts.offline`, every `console.*` becomes `ctx.log(...)`, `source` becomes
`ctx.source`, and it returns `{ scored: scored.length, queued, runId: run.id }`.

`src/stages/load.ts` exports
`runLoad(ctx, { apply }): Promise<{ rows: number; errors: number; runId: string | null }>`,
holding the current body of `load()` with `hasFlag('--apply')` replaced by
`opts.apply`. Inside the chunk loop, after each chunk, add:

```ts
      ctx.progress('loading', index + 1, batches.length)
      if (ctx.cancelled()) {
        ctx.log('warn', `Cancelled after chunk ${index + 1} of ${batches.length}.`)
        break
      }
```

The cancel check goes **after** the chunk completes, never between building a
batch and writing it: a stage that stops mid-write leaves the catalog in a state
nobody asked for, and one that stops after a completed chunk leaves it in a state
the report already describes.

`cli.ts` keeps `score()` and `load()` as two-line adapters:

```ts
async function score() {
  await runScore(consoleContext(source), { offline: hasFlag('--offline') })
}

async function load() {
  await runLoad(consoleContext(source), { apply: hasFlag('--apply') })
}
```

- [ ] **Step 8: Prove the refactor changed nothing**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all 164 existing tests pass **without any edit to their assertions**.
If a test needed changing, the refactor changed behaviour; revert that part and
redo it.

- [ ] **Step 9: Commit**

```bash
git add src/stages src/cli.ts test/stages.test.ts
git commit -m "Extract the stages from argv so something other than a terminal can run them"
```

---

### Task 3: The worker's client

**Files:**
- Create: `src/worker/client.ts`
- Test: `test/workerClient.test.ts`

**Interfaces:**
- Consumes: `claim_next_run_request`, `heartbeat_worker` from Task 1; `createServiceClient()` from `src/load/supabase.ts`.
- Produces: in `src/worker/client.ts`: `type LogEntry = { at: string; level: LogLevel; text: string }`, `LOG_CAP = 200`, `trimLog(existing: LogEntry[], added: LogEntry[]): LogEntry[]`, `workerId(): string`, and `class RequestWriter` with `constructor(db, requestId)`, `log(level, text)`, `progress(stage, done, total)`, `flush(): Promise<void>`, `finish(status, fields): Promise<void>`, `isCancelled(): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

Create `test/workerClient.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LOG_CAP, trimLog, workerId } from '../src/worker/client.ts'

const entry = (text: string) => ({ at: '2026-08-25T00:00:00.000Z', level: 'info' as const, text })

describe('trimLog', () => {
  it('appends to what is already there', () => {
    expect(trimLog([entry('a')], [entry('b')]).map((e) => e.text)).toEqual(['a', 'b'])
  })

  // The column is the last screenful, not a log drain. Without a cap a load of
  // 240 chunks writes a row that grows on every single update.
  it('keeps only the newest LOG_CAP entries', () => {
    const existing = Array.from({ length: LOG_CAP }, (_, i) => entry(`old-${i}`))
    const result = trimLog(existing, [entry('newest')])

    expect(result).toHaveLength(LOG_CAP)
    expect(result[result.length - 1].text).toBe('newest')
    expect(result[0].text).toBe('old-1')
  })

  it('caps a single oversized batch too', () => {
    const added = Array.from({ length: LOG_CAP + 50 }, (_, i) => entry(`n-${i}`))
    expect(trimLog([], added)).toHaveLength(LOG_CAP)
  })
})

describe('workerId', () => {
  it('is stable within a process and carries the hostname', () => {
    expect(workerId()).toBe(workerId())
    expect(workerId()).toMatch(/^.+-[a-z0-9]{6}$/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/workerClient.test.ts`
Expected: FAIL, cannot resolve `../src/worker/client.ts`.

- [ ] **Step 3: Implement `src/worker/client.ts`**

```ts
// The worker's side of the row.
//
// Everything the worker writes goes through the service-role key it already
// holds, not through the guarded RPCs the dashboard uses. Those exist to stop a
// browser writing here; the worker IS the thing that writes here.
import { hostname } from 'node:os'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LogLevel } from '../stages/types.ts'

export interface LogEntry {
  at: string
  level: LogLevel
  text: string
}

/**
 * The last screenful.
 *
 * Not a log drain and it does not pretend to be. A load of 240 chunks emits a
 * line each; keeping all of them would grow the row on every update, and nobody
 * watching a run reads past the last screen anyway.
 */
export const LOG_CAP = 200

export function trimLog(existing: LogEntry[], added: LogEntry[]): LogEntry[] {
  const all = [...existing, ...added]
  return all.length <= LOG_CAP ? all : all.slice(all.length - LOG_CAP)
}

let id: string | null = null

/**
 * Stable for the life of the process, and carrying the hostname so the
 * dashboard can say WHICH machine is listening rather than just that one is.
 * The suffix keeps two workers on one machine apart.
 */
export function workerId(): string {
  if (!id) id = `${hostname()}-${Math.random().toString(36).slice(2, 8)}`
  return id
}

/**
 * Buffered writes for one request.
 *
 * A stage emits log lines faster than a database should be written to: a
 * normalize logs every 5,000 records and a load logs every chunk. Buffering and
 * flushing on a timer turns a write per line into a write per second, and the
 * UI polls every two seconds anyway, so nothing is lost that anybody could see.
 */
export class RequestWriter {
  private pending: LogEntry[] = []
  private stage: string | null = null
  private done: number | null = null
  private total: number | null = null
  private dirty = false

  constructor(
    private db: SupabaseClient,
    private requestId: string,
  ) {}

  log(level: LogLevel, text: string): void {
    for (const line of text.split('\n')) {
      this.pending.push({ at: new Date().toISOString(), level, text: line })
    }
    this.dirty = true
  }

  progress(stage: string, done: number, total: number | null): void {
    this.stage = stage
    this.done = done
    this.total = total
    this.dirty = true
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    const added = this.pending
    this.pending = []
    this.dirty = false

    // Read-modify-write on the log, which is safe because exactly one worker
    // owns a claimed request. Two writers here would need an append in SQL.
    const { data } = await this.db
      .from('catalog_run_requests')
      .select('log')
      .eq('id', this.requestId)
      .single()

    const existing = ((data?.log ?? []) as LogEntry[]) ?? []

    await this.db
      .from('catalog_run_requests')
      .update({
        log: trimLog(existing, added),
        ...(this.stage !== null ? { stage: this.stage } : {}),
        ...(this.done !== null ? { progress_done: this.done } : {}),
        progress_total: this.total,
      })
      .eq('id', this.requestId)
  }

  async finish(
    status: 'done' | 'failed' | 'cancelled',
    fields: { error?: string | null; runId?: string | null } = {},
  ): Promise<void> {
    await this.flush()
    await this.db
      .from('catalog_run_requests')
      .update({
        status,
        finished_at: new Date().toISOString(),
        error: fields.error ?? null,
        ...(fields.runId ? { run_id: fields.runId } : {}),
      })
      .eq('id', this.requestId)
  }

  /** Cancel is cooperative: the dashboard sets `cancelling`, the stage notices. */
  async isCancelled(): Promise<boolean> {
    const { data } = await this.db
      .from('catalog_run_requests')
      .select('status')
      .eq('id', this.requestId)
      .single()
    return data?.status === 'cancelling'
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/workerClient.test.ts && npx tsc --noEmit`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/worker/client.ts test/workerClient.test.ts
git commit -m "Add the worker's buffered writer for a claimed request"
```

---

### Task 4: The worker loop

**Files:**
- Create: `src/worker/loop.ts`
- Test: `test/workerLoop.test.ts`

**Interfaces:**
- Consumes: `RequestWriter`, `workerId` from Task 3; `runNormalize`, `runScore`, `runLoad`, `StageContext` from Task 2.
- Produces: `runOnce(deps: WorkerDeps): Promise<'idle' | 'ran'>` and `interface WorkerDeps { claim(): Promise<ClaimedRequest | null>; heartbeat(request: string | null): Promise<void>; makeWriter(id: string): RequestWriter; stages: StageRunners }` in `src/worker/loop.ts`, where `ClaimedRequest = { id: string; kind: string; source: string }`.

- [ ] **Step 1: Write the failing test**

Create `test/workerLoop.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { runOnce } from '../src/worker/loop.ts'

function deps(over: Record<string, unknown> = {}) {
  const finish = vi.fn().mockResolvedValue(undefined)
  const writer = {
    log: vi.fn(),
    progress: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    finish,
    isCancelled: vi.fn().mockResolvedValue(false),
  }
  return {
    writer,
    finish,
    deps: {
      claim: vi.fn().mockResolvedValue({ id: 'r1', kind: 'score', source: 'openfoodfacts' }),
      heartbeat: vi.fn().mockResolvedValue(undefined),
      makeWriter: () => writer,
      stages: {
        normalize: vi.fn().mockResolvedValue({ staged: 1, rejected: 0 }),
        score: vi.fn().mockResolvedValue({ scored: 3, queued: 0, runId: 'run-1' }),
        load: vi.fn().mockResolvedValue({ rows: 2, errors: 0, runId: null }),
      },
      ...over,
    } as never,
  }
}

describe('runOnce', () => {
  it('reports idle and heartbeats when the queue is empty', async () => {
    const { deps: d } = deps({ claim: vi.fn().mockResolvedValue(null) })
    expect(await runOnce(d)).toBe('idle')
    expect((d as never as { heartbeat: ReturnType<typeof vi.fn> }).heartbeat).toHaveBeenCalled()
  })

  it('runs the stage the request names and finishes done', async () => {
    const { deps: d, finish } = deps()
    expect(await runOnce(d)).toBe('ran')

    expect((d as never as { stages: { score: ReturnType<typeof vi.fn> } }).stages.score)
      .toHaveBeenCalled()
    expect(finish).toHaveBeenCalledWith('done', expect.objectContaining({ runId: 'run-1' }))
  })

  it('passes apply: true only for load-apply', async () => {
    const dry = deps({ claim: vi.fn().mockResolvedValue({ id: 'r', kind: 'load', source: 'openfoodfacts' }) })
    await runOnce(dry.deps)
    expect((dry.deps as never as { stages: { load: ReturnType<typeof vi.fn> } }).stages.load)
      .toHaveBeenCalledWith(expect.anything(), { apply: false })

    const wet = deps({ claim: vi.fn().mockResolvedValue({ id: 'r', kind: 'load-apply', source: 'openfoodfacts' }) })
    await runOnce(wet.deps)
    expect((wet.deps as never as { stages: { load: ReturnType<typeof vi.fn> } }).stages.load)
      .toHaveBeenCalledWith(expect.anything(), { apply: true })
  })

  // A stage that throws must leave the row `failed` with the reason, not
  // `running` forever. A request nobody can explain is worse than one that says
  // it broke.
  it('records a thrown stage as failed with its message', async () => {
    const { deps: d, finish } = deps()
    ;(d as never as { stages: { score: ReturnType<typeof vi.fn> } }).stages.score =
      vi.fn().mockRejectedValue(new Error('subset missing'))

    expect(await runOnce(d)).toBe('ran')
    expect(finish).toHaveBeenCalledWith('failed', expect.objectContaining({ error: 'subset missing' }))
  })

  it('finishes cancelled when the request was asked to stop', async () => {
    const { deps: d, writer, finish } = deps()
    writer.isCancelled = vi.fn().mockResolvedValue(true)

    await runOnce(d)
    expect(finish).toHaveBeenCalledWith('cancelled', expect.anything())
  })

  it('refuses a kind it does not know rather than guessing', async () => {
    const { deps: d, finish } = deps({
      claim: vi.fn().mockResolvedValue({ id: 'r', kind: 'acquire', source: 'openfoodfacts' }),
    })

    await runOnce(d)
    expect(finish).toHaveBeenCalledWith('failed', expect.objectContaining({
      error: expect.stringContaining('acquire'),
    }))
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/workerLoop.test.ts`
Expected: FAIL, cannot resolve `../src/worker/loop.ts`.

- [ ] **Step 3: Implement `src/worker/loop.ts`**

```ts
// One turn of the worker.
//
// Split from the process that runs it so the interesting part is testable
// without a database, a filesystem or a clock: runOnce() takes its dependencies
// and does exactly one claim-run-finish.
import { resolveSource } from '../config.ts'
import type { StageContext } from '../stages/types.ts'
import type { RequestWriter } from './client.ts'

export interface ClaimedRequest {
  id: string
  kind: string
  source: string
}

export interface StageRunners {
  normalize(ctx: StageContext): Promise<{ staged: number; rejected: number }>
  score(ctx: StageContext, opts: { offline: boolean }): Promise<{ scored: number; queued: number; runId: string }>
  load(ctx: StageContext, opts: { apply: boolean }): Promise<{ rows: number; errors: number; runId: string | null }>
}

export interface WorkerDeps {
  claim(): Promise<ClaimedRequest | null>
  heartbeat(request: string | null): Promise<void>
  makeWriter(requestId: string): RequestWriter
  stages: StageRunners
}

export async function runOnce(deps: WorkerDeps): Promise<'idle' | 'ran'> {
  const claimed = await deps.claim()
  if (!claimed) {
    await deps.heartbeat(null)
    return 'idle'
  }

  await deps.heartbeat(claimed.id)
  const writer = deps.makeWriter(claimed.id)

  // Read once per progress tick rather than per row: cancellation is checked
  // between chunks, so a request that asks to stop waits at most one chunk.
  let cancelled = false
  const ctx: StageContext = {
    source: resolveSource(claimed.source),
    log: (level, text) => writer.log(level, text),
    progress: (stage, done, total) => {
      writer.progress(stage, done, total)
      void writer.flush()
    },
    cancelled: () => cancelled,
  }

  const watch = setInterval(() => {
    void writer.isCancelled().then((c) => {
      cancelled = c
    })
  }, 2000)

  let runId: string | null = null
  try {
    writer.log('info', `Starting ${claimed.kind} for ${claimed.source}.`)

    if (claimed.kind === 'normalize') {
      await deps.stages.normalize(ctx)
    } else if (claimed.kind === 'score') {
      runId = (await deps.stages.score(ctx, { offline: false })).runId
    } else if (claimed.kind === 'load' || claimed.kind === 'load-apply') {
      runId = (await deps.stages.load(ctx, { apply: claimed.kind === 'load-apply' })).runId
    } else {
      // Never guess. `acquire` is deliberately not queueable, and a kind that
      // reached here past the check constraint means the two ends disagree.
      throw new Error(`unknown job kind: ${claimed.kind}`)
    }

    // Re-read rather than trusting the flag: the watcher may have set it
    // moments before the stage returned on its own.
    if (cancelled || (await writer.isCancelled())) {
      await writer.finish('cancelled', { runId })
    } else {
      writer.log('info', 'Finished.')
      await writer.finish('done', { runId })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writer.log('error', message)
    await writer.finish('failed', { error: message, runId })
  } finally {
    clearInterval(watch)
    await deps.heartbeat(null)
  }

  return 'ran'
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/workerLoop.test.ts && npx tsc --noEmit`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/worker/loop.ts test/workerLoop.test.ts
git commit -m "Add the worker's claim, run and finish turn"
```

---

### Task 5: `npm run worker`

**Files:**
- Create: `src/worker/index.ts`
- Modify: `src/cli.ts` (register `worker`), `package.json`, `README.md`

**Interfaces:**
- Consumes: `runOnce`, `WorkerDeps` from Task 4; `RequestWriter`, `workerId` from Task 3; the three stage runners from Task 2.
- Produces: `startWorker(): Promise<void>` in `src/worker/index.ts`; the `worker` CLI command.

- [ ] **Step 1: Implement `src/worker/index.ts`**

```ts
// The process that turns a queued request into a run.
//
// It exists because the dashboard cannot: the importer holds a service-role key
// that can rewrite every row in the catalog, needs ~15 GB of disk for a dump,
// and is a CLI on a filesystem with nothing listening. So the browser asks, and
// this answers.
//
// Leave it running while you work in the dashboard. It is idle apart from a
// heartbeat and a query every two seconds.
import { hostname } from 'node:os'
import { createServiceClient } from '../load/supabase.ts'
import { loadCredentials } from '../config.ts'
import { runNormalize } from '../stages/normalize.ts'
import { runScore } from '../stages/score.ts'
import { runLoad } from '../stages/load.ts'
import { RequestWriter, workerId } from './client.ts'
import { runOnce, type ClaimedRequest, type WorkerDeps } from './loop.ts'

const POLL_MS = 2000

export async function startWorker(): Promise<void> {
  const db = createServiceClient()
  const id = workerId()

  console.log(`Worker ${id}`)
  console.log(`Target:  ${new URL(loadCredentials().url).host}`)
  console.log('Waiting for work. Ctrl-C to stop.\n')

  const deps: WorkerDeps = {
    async claim() {
      const { data, error } = await db.rpc('claim_next_run_request', { p_worker: id })
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as ClaimedRequest[]
      return rows.length ? rows[0] : null
    },
    async heartbeat(request) {
      const { error } = await db.rpc('heartbeat_worker', {
        p_worker: id,
        p_hostname: hostname(),
        p_request: request,
      })
      if (error) throw new Error(error.message)
    },
    makeWriter: (requestId) => new RequestWriter(db, requestId),
    stages: { normalize: runNormalize, score: runScore, load: runLoad },
  }

  let stopping = false
  let active: string | null = null

  // A worker killed mid-run leaves its request `running` forever, and the
  // dashboard can only report that as stalled. Marking it on the way out turns
  // the common case -- ctrl-c -- into a row that explains itself. A power cut
  // still produces a stalled row, which is what the heartbeat is for.
  const stop = async () => {
    if (stopping) return
    stopping = true
    console.log('\nStopping.')
    if (active) {
      await db
        .from('catalog_run_requests')
        .update({
          status: 'failed',
          error: 'worker stopped',
          finished_at: new Date().toISOString(),
        })
        .eq('id', active)
        .eq('status', 'running')
    }
    await db.from('catalog_workers').delete().eq('id', id)
    process.exit(0)
  }

  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())

  while (!stopping) {
    try {
      const claimBefore = deps.claim
      // Track what is being worked on, so the SIGINT handler can mark it.
      const wrapped: WorkerDeps = {
        ...deps,
        async claim() {
          const c = await claimBefore.call(deps)
          active = c?.id ?? null
          if (c) console.log(`Claimed ${c.kind} for ${c.source} (${c.id}).`)
          return c
        },
      }
      const result = await runOnce(wrapped)
      if (result === 'ran') console.log('Done.\n')
      active = null
    } catch (error) {
      // A worker that exits on a transient network error is a worker nobody
      // leaves running. Log it and carry on; the next poll retries.
      console.error(error instanceof Error ? error.message : String(error))
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}
```

- [ ] **Step 2: Register the command**

In `src/cli.ts`, add `import { startWorker } from './worker/index.ts'` and add to
`COMMANDS`:

```ts
  worker: startWorker,
```

- [ ] **Step 3: Add the script**

In `package.json`, beside the other scripts:

```json
    "worker": "tsx src/cli.ts worker",
```

- [ ] **Step 4: Document it in the README**

Under "Running it", after the pipeline command block, add:

```
### Running stages from the admin dashboard

The dashboard cannot run the pipeline: the importer holds a service-role key and
needs the disk. It can ask for one.

```
npm run worker
```

Leave that running and the dashboard's Pipeline page can start `normalize`,
`score`, `load` and `load --apply`, showing progress and the last log lines as
they happen. With no worker running the buttons are disabled and say so.

`acquire` is deliberately not on that list. A full dump is ~12 GB and hours, and
it does not belong behind a button that looks like the other four.
```

- [ ] **Step 5: Verify against the local stack**

Run from `D:\famcart\catalog-importer`, with the local catalog stack up:

```bash
npx supabase db reset --workdir supabase-catalog
npx vitest run && npx tsc --noEmit
```

Expected: PASS. The worker's own loop is covered by Task 4; this step is the
typecheck and the suite staying green.

- [ ] **Step 6: Commit**

```bash
git add src/worker/index.ts src/cli.ts package.json README.md
git commit -m "Add npm run worker, which turns a queued request into a run"
```

---

### Task 6: The dashboard's data module

**Files:**
- Create: `admin/src/lib/data/runs.ts`
- Test: `admin/test/runs.test.ts`

**Interfaces:**
- Consumes: the five authenticated RPCs from Task 1; `getCatalogSupabase()`, `CatalogNotConfigured`, `queryError`.
- Produces: types `RunRequest`, `RunRequestDetail`, `WorkerRow`, `RunKind`; functions `enqueueRun(kind, source)`, `cancelRun(id)`, `fetchRunRequests(limit, signal)`, `fetchRunRequest(id, signal)`, `fetchWorkers(signal)`, `runnerOnline(workers, staleAfterSeconds?)`, `isActive(status)`; constant `WORKER_STALE_SECONDS = 30`.

- [ ] **Step 1: Write the failing test**

Create `admin/test/runs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { WORKER_STALE_SECONDS, isActive, runnerOnline } from '../src/lib/data/runs'

const worker = (seconds: number) => ({
  id: 'w1',
  hostname: 'desktop',
  started_at: '2026-08-25T00:00:00.000Z',
  last_seen_at: '2026-08-25T00:00:00.000Z',
  current_request: null,
  seconds_since_seen: seconds,
})

describe('runnerOnline', () => {
  it('is offline when nothing has ever checked in', () => {
    expect(runnerOnline([])).toBeNull()
  })

  it('is online for a fresh heartbeat', () => {
    expect(runnerOnline([worker(3)])?.hostname).toBe('desktop')
  })

  // Six missed beats. Long enough that a slow chunk does not flap the badge,
  // short enough that pressing a dead button is rare.
  it('is offline once the heartbeat is older than the stale window', () => {
    expect(runnerOnline([worker(WORKER_STALE_SECONDS + 1)])).toBeNull()
  })

  it('picks the freshest worker when several have checked in', () => {
    const stale = { ...worker(120), id: 'old', hostname: 'laptop' }
    expect(runnerOnline([stale, worker(2)])?.hostname).toBe('desktop')
  })
})

describe('isActive', () => {
  it('counts queued, running and cancelling as active', () => {
    expect(['queued', 'running', 'cancelling'].every(isActive)).toBe(true)
  })

  it('counts finished states as inactive, so polling can stop', () => {
    expect(['done', 'failed', 'cancelled'].some(isActive)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/runs.test.ts`
Expected: FAIL, cannot resolve `../src/lib/data/runs`.

- [ ] **Step 3: Implement `admin/src/lib/data/runs.ts`**

```ts
import { getCatalogSupabase } from '../supabase'
import { queryError } from './errors'
import { CatalogNotConfigured } from './products'

// Asking for a run, and watching one.
//
// The dashboard cannot run the pipeline and this module does not pretend
// otherwise: every call here writes to or reads from a queue in the catalog
// project. A worker on the operator's machine does the work, because it is the
// only thing holding a service-role key and 15 GB of disk.
//
// Which is why runnerOnline() matters as much as enqueueRun(). A button that
// queues into a void is worse than a disabled one, so the UI asks who is
// listening before it offers to start anything.

export type RunKind = 'normalize' | 'score' | 'load' | 'load-apply'
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelling' | 'cancelled'

export interface RunRequest {
  id: string
  kind: RunKind
  source: string
  status: RunStatus
  requested_by: string | null
  requested_at: string
  claimed_by: string | null
  claimed_at: string | null
  finished_at: string | null
  run_id: string | null
  stage: string | null
  progress_done: number | null
  progress_total: number | null
  error: string | null
}

export interface LogEntry {
  at: string
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface RunRequestDetail extends Omit<RunRequest, 'requested_by' | 'claimed_by'> {
  log: LogEntry[]
}

export interface WorkerRow {
  id: string
  hostname: string | null
  started_at: string
  last_seen_at: string
  current_request: string | null
  seconds_since_seen: number
}

/**
 * Six missed heartbeats at five seconds each.
 *
 * Long enough that a slow chunk does not flap the badge between online and
 * offline while somebody is watching it; short enough that pressing a button
 * whose worker died is rare.
 */
export const WORKER_STALE_SECONDS = 30

/** Whether this status still deserves polling. */
export function isActive(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'cancelling'
}

/** The freshest worker that has checked in recently, or null for nobody. */
export function runnerOnline(
  workers: WorkerRow[],
  staleAfterSeconds: number = WORKER_STALE_SECONDS,
): WorkerRow | null {
  const live = workers
    .filter((w) => Number(w.seconds_since_seen) <= staleAfterSeconds)
    .sort((a, b) => Number(a.seconds_since_seen) - Number(b.seconds_since_seen))
  return live.length ? live[0] : null
}

function client() {
  const db = getCatalogSupabase()
  if (!db) throw new CatalogNotConfigured()
  return db
}

export async function enqueueRun(kind: RunKind, source: string): Promise<string> {
  const { data, error } = await client().rpc('enqueue_run', { p_kind: kind, p_source: source })
  if (error) queryError('enqueue_run', error)
  return String(data)
}

export async function cancelRun(id: string): Promise<void> {
  const { error } = await client().rpc('cancel_run', { p_id: id })
  if (error) queryError('cancel_run', error)
}

export async function fetchRunRequests(limit: number, signal: AbortSignal): Promise<RunRequest[]> {
  const { data, error } = await client()
    .rpc('list_run_requests', { p_limit: limit })
    .abortSignal(signal)
  if (error) queryError('list_run_requests', error)
  return (data ?? []) as RunRequest[]
}

export async function fetchRunRequest(
  id: string,
  signal: AbortSignal,
): Promise<RunRequestDetail | null> {
  const { data, error } = await client()
    .rpc('get_run_request', { p_id: id })
    .abortSignal(signal)
  if (error) queryError('get_run_request', error)
  const rows = (data ?? []) as RunRequestDetail[]
  return rows.length ? rows[0] : null
}

export async function fetchWorkers(signal: AbortSignal): Promise<WorkerRow[]> {
  const { data, error } = await client().rpc('list_workers').abortSignal(signal)
  if (error) queryError('list_workers', error)
  return (data ?? []) as WorkerRow[]
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/runs.test.ts && npm run typecheck`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/lib/data/runs.ts test/runs.test.ts
git commit -m "Read and write the run queue from the dashboard"
```

---

### Task 7: The Pipeline panel

**Files:**
- Create: `admin/src/components/RunControl.vue`
- Modify: `admin/src/views/PipelineView.vue`, `admin/src/lib/data/pipeline.ts`
- Test: `admin/test/runControl.test.ts`

**Interfaces:**
- Consumes: everything Task 6 produced.
- Produces: `RunControl.vue`, taking no props and owning its own queries.

A separate component rather than more of `PipelineView.vue`, which is already 612
lines: the run control owns four queries, a poll timer and a confirm dialog, and
none of that belongs in a view that is otherwise read-only.

- [ ] **Step 1: Write the failing test**

Create `admin/test/runControl.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'

const enqueueRun = vi.fn().mockResolvedValue('req-1')
const cancelRun = vi.fn().mockResolvedValue(undefined)
const fetchRunRequests = vi.fn()
const fetchRunRequest = vi.fn()
const fetchWorkers = vi.fn()

vi.mock('../src/lib/data/runs', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/data/runs')>(
    '../src/lib/data/runs',
  )
  return { ...actual, enqueueRun, cancelRun, fetchRunRequests, fetchRunRequest, fetchWorkers }
})

vi.mock('../src/lib/data/products', () => ({
  catalogConfigured: () => true,
  CatalogNotConfigured: class extends Error {},
}))

const RunControl = (await import('../src/components/RunControl.vue')).default as unknown as Component

const stubs = {
  PanelCard: { template: '<div><slot /></div>' },
  StateBlock: { props: ['title', 'message'], template: '<div>{{ title }} {{ message }}</div>' },
  StatusPill: { props: ['label'], template: '<span>{{ label }}</span>' },
  ConfirmDialog: { props: ['open', 'title'], template: '<div v-if="open" class="dialog">{{ title }}</div>' },
  DataTable: { props: ['rows'], template: '<table><tr v-for="r in rows" :key="r.id"><td>{{ r.kind }}</td></tr></table>' },
}

const liveWorker = {
  id: 'w1', hostname: 'desktop', started_at: '2026-08-25T00:00:00.000Z',
  last_seen_at: '2026-08-25T00:00:00.000Z', current_request: null, seconds_since_seen: 2,
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  enqueueRun.mockClear()
  cancelRun.mockClear()
  fetchWorkers.mockReset().mockResolvedValue([liveWorker])
  fetchRunRequests.mockReset().mockResolvedValue([])
  fetchRunRequest.mockReset().mockResolvedValue(null)
})

describe('RunControl', () => {
  it('names the machine that is listening', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()
    expect(w.text()).toMatch(/desktop/)
  })

  // A button that queues into a void is worse than a disabled one.
  it('disables the buttons and says why when no worker has checked in', async () => {
    fetchWorkers.mockResolvedValue([])
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.find('[data-test="run-score"]').attributes('disabled')).toBeDefined()
    expect(w.text()).toMatch(/npm run worker/)
  })

  it('enqueues a score without a confirmation', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    await w.find('[data-test="run-score"]').trigger('click')
    await flush()

    expect(enqueueRun).toHaveBeenCalledWith('score', 'openfoodfacts')
  })

  // Apply writes the catalog. The other three cost time and nothing else.
  it('confirms before applying, and does not enqueue until confirmed', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    await w.find('[data-test="run-load-apply"]').trigger('click')
    await flush()

    expect(w.find('.dialog').exists()).toBe(true)
    expect(enqueueRun).not.toHaveBeenCalled()
  })

  it('shows progress and the last log lines while a run is active', async () => {
    fetchRunRequests.mockResolvedValue([
      { id: 'r1', kind: 'load', source: 'openfoodfacts', status: 'running', requested_by: null,
        requested_at: '2026-08-25T00:00:00.000Z', claimed_by: 'w1', claimed_at: null,
        finished_at: null, run_id: null, stage: 'loading', progress_done: 12,
        progress_total: 240, error: null },
    ])
    fetchRunRequest.mockResolvedValue({
      id: 'r1', kind: 'load', source: 'openfoodfacts', status: 'running',
      requested_at: '2026-08-25T00:00:00.000Z', claimed_at: null, finished_at: null,
      run_id: null, stage: 'loading', progress_done: 12, progress_total: 240, error: null,
      log: [{ at: '2026-08-25T00:00:01.000Z', level: 'info', text: 'chunk 12/240' }],
    })

    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.text()).toContain('12')
    expect(w.text()).toContain('240')
    expect(w.text()).toContain('chunk 12/240')
  })

  // A worker that died without marking its request leaves it `running` forever.
  // A spinner that never finishes is the one state this panel must not show.
  it('calls a running request stalled when no worker is listening', async () => {
    fetchWorkers.mockResolvedValue([])
    fetchRunRequests.mockResolvedValue([
      { id: 'r3', kind: 'score', source: 'openfoodfacts', status: 'running', requested_by: null,
        requested_at: '2026-08-25T00:00:00.000Z', claimed_by: 'w1', claimed_at: null,
        finished_at: null, run_id: null, stage: 'scoring', progress_done: 5,
        progress_total: null, error: null },
    ])
    const w = mount(RunControl, { global: { stubs } })
    await flush()
    expect(w.text()).toMatch(/stalled/i)
  })

  it('renders a failure with its reason', async () => {
    fetchRunRequests.mockResolvedValue([
      { id: 'r2', kind: 'score', source: 'openfoodfacts', status: 'failed', requested_by: null,
        requested_at: '2026-08-25T00:00:00.000Z', claimed_by: 'w1', claimed_at: null,
        finished_at: '2026-08-25T00:01:00.000Z', run_id: null, stage: null,
        progress_done: null, progress_total: null, error: 'subset missing' },
    ])
    const w = mount(RunControl, { global: { stubs } })
    await flush()
    expect(w.text()).toContain('subset missing')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/runControl.test.ts`
Expected: FAIL, cannot resolve `../src/components/RunControl.vue`.

- [ ] **Step 3: Build `RunControl.vue`**

Read `admin/src/views/TrashView.vue` first for the write-action shape and
`admin/src/views/ReviewView.vue` for the confirm-dialog shape, then build a
component with:

- Three `useQuery` calls: `fetchWorkers`, `fetchRunRequests(20)`, and
  `fetchRunRequest(activeId)` enabled only while something is active.
- A `setInterval` of 2000ms, started when an active request appears and cleared
  when none is active or on unmount, calling `refetch()` on the three queries.
  Polling an idle page is the thing this must not do: with nothing active it
  makes no more requests than the page does today.
- A source `<select>` over the three sources, defaulting to `openfoodfacts`.
- Four buttons with `data-test="run-normalize"`, `run-score`, `run-load`,
  `run-load-apply`, disabled when `runnerOnline(...)` is null or a request is
  active. `run-load-apply` opens a `ConfirmDialog` naming the source; the other
  three call `enqueueRun` directly.
- A runner line: the hostname when online, or `Runner offline` plus
  `npm run worker` in `catalog-importer` and one sentence on why it is needed.
- The active block: kind, source, stage, `done of total` when total is not null
  and a bare count when it is, elapsed since `requested_at`, a Cancel button, and
  the last 12 log entries newest last in a scrollable `<pre>`.
- A `DataTable` of recent requests: kind, source, status via `StatusPill`,
  duration, and the error text when failed.
- On a request reaching a finished status, emit `finished` so the view can
  refetch its own panels.
- **The stalled state.** A request that is `running` while `runnerOnline(...)` is
  null means the worker died without marking it: a power cut rather than a
  ctrl-c, which `startWorker`'s SIGINT handler covers. Render that as `Stalled`
  rather than `Running`, with Cancel offered, because a spinner that never
  finishes is the one state this panel must never show.

- [ ] **Step 4: Wire it into the view**

In `PipelineView.vue`, replace the "Trigger a run" panel body with
`<RunControl @finished="refresh" />`, keeping the panel heading. Delete the
`triggerCapability()` import and its usage.

In `admin/src/lib/data/pipeline.ts`, delete `triggerCapability()` and its
`TriggerCapability` interface, replacing the block comment above it with:

```ts
// ─── triggering a run ────────────────────────────────────────────────────────
//
// This used to be a panel explaining that a run could not be started from a
// browser, and it was right about why: the importer holds a service-role key
// that can rewrite every row in the catalog, needs ~15 GB of disk, and is a CLI
// with nothing listening.
//
// None of that changed. What changed is that the dashboard no longer tries to
// run anything: it writes a row to catalog_run_requests and a worker on the
// operator's machine claims it. See src/components/RunControl.vue and
// src/lib/data/runs.ts.
//
// `acquire` is still not startable from here, deliberately. A ~12 GB download
// measured in hours does not belong behind a button that looks like the other
// four, and it would need cancellation and resumption semantics none of them do.
```

- [ ] **Step 5: Run everything**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS all three. The existing `pipeline.test.ts` asserts on
`triggerCapability`; delete those cases, since the thing they cover is gone.

- [ ] **Step 6: Commit**

```bash
git add src/components/RunControl.vue src/views/PipelineView.vue src/lib/data/pipeline.ts test/runControl.test.ts test/pipeline.test.ts
git commit -m "Start a run from the Pipeline page, and watch it"
```

---

### Task 8: End to end against the live catalog project

**Files:**
- Modify: `admin/README.md`, `D:\famcart\CLAUDE.md`

- [ ] **Step 1: Push the migration**

From `D:\famcart\catalog-importer`, with the CLI already linked to
`qcldtkpibpihczaigaiu`:

```bash
npx supabase db push --workdir supabase-catalog --dry-run --include-all --linked
npx supabase db push --workdir supabase-catalog --include-all --linked
```

Expected: the dry run names `006_run_requests.sql` and nothing else.

- [ ] **Step 2: Run the worker and drive it from the dashboard**

In one terminal: `cd catalog-importer && npm run worker`.
In another: `cd admin && npm run dev`, then open `/pipeline`.

Confirm, in order: the runner line names the machine; `Load (dry run)` enqueues
and the worker claims it within two seconds; progress counts chunks; the log
block fills; the request ends `done`; Cancel on a fresh dry run leaves it
`cancelled`; stopping the worker with ctrl-c makes the runner line go offline
within thirty seconds and the buttons disable.

- [ ] **Step 3: Update the two documents**

In `admin/README.md`, add a row to the writes table from the review work:

```
| Start, or cancel, a pipeline run | Pipeline | the run itself is not, but nothing is written until a stage does |
```

and a line under "Where the explanations live":

```
| Why a run is queued rather than started, and what happens with no worker | `src/components/RunControl.vue` |
```

In `D:\famcart\CLAUDE.md`, under the catalog-importer commands section, add:

```
`npm run worker` is what lets the admin dashboard start `normalize`, `score`,
`load` and `load --apply`. It claims rows from `catalog_run_requests` in the
catalog project and streams progress back onto them. With no worker running the
dashboard's buttons are disabled and say so, which is the honest version of a
control that depends on a process on one machine. `acquire` is deliberately not
queueable: ~12 GB and hours does not belong behind a button.
```

- [ ] **Step 4: Commit both**

```bash
cd /d/famcart/admin && git add README.md && git commit -m "Document the run control and what it needs"
```

CLAUDE.md is gitignored in the superproject, so it is edited but not committed.

- [ ] **Step 5: Bump the submodule pointers**

```bash
cd /d/famcart
git add admin catalog-importer
git commit -m "Bump both submodules: start a pipeline run from the dashboard"
```
