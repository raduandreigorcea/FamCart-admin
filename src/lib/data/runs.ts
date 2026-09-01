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
//
// No worker exists at the moment: the repo that carried it, and the catalog
// schema it owned, were both removed. Every function here consequently fails on
// a missing table, which RunControl renders as an error instead of a ladder of
// buttons. None of it is deleted, because what this module depends on is the
// shape of the queue rather than any particular worker -- a replacement that
// claims catalog_run_requests and heartbeats into catalog_workers brings the
// whole panel back with no change here.

export type RunKind =
  | 'acquire'
  | 'acquire-delta'
  | 'normalize'
  | 'score'
  | 'load'
  | 'load-apply'
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

export interface RunRequestDetail {
  id: string
  kind: RunKind
  source: string
  status: RunStatus
  requested_at: string
  claimed_at: string | null
  finished_at: string | null
  run_id: string | null
  stage: string | null
  progress_done: number | null
  progress_total: number | null
  error: string | null
  log: LogEntry[]
}

export interface WorkerRow {
  id: string
  hostname: string | null
  started_at: string
  last_seen_at: string
  current_request: string | null
  seconds_since_seen: number
  /**
   * Source ids the worker had a market subset for, on its own disk.
   *
   * Still reported, and no longer what the dashboard decides from. A runner is
   * a CI job now: it pulls what its stage needs, runs, and is deleted, so this
   * describes a machine that will not exist in ten minutes. catalog_artifacts
   * describes the bucket, which is the thing that persists -- see ArtifactRow.
   */
  sources: string[] | null
  /** Same: what was in that job's out/, not what exists. */
  stages: { staged?: string | null; scored?: string | null } | null
}

/**
 * One file the pipeline keeps between runs, as the database records it.
 *
 * This is the dashboard's answer to "can this step run", and it replaced asking
 * the worker because there is no longer a worker to ask. `source` is which
 * catalog the file is for: subsets are per source, while the out/ files are one
 * shared slot carrying whoever last wrote them.
 */
export interface ArtifactRow {
  key: string
  source: string
  remote_key: string
  bytes: number
  updated_at: string
}

/**
 * How long a request may sit unclaimed before something is wrong.
 *
 * A dispatched job is not instant the way a polling worker was: the Edge
 * Function call, GitHub allocating a runner, a checkout and an `npm ci` are two
 * or three minutes before the stage starts. Below that this is just waiting.
 * Above it, the dispatch chain is broken -- an unset app.dispatch_url, a revoked
 * token, a disabled workflow -- and the request will sit there forever.
 */
export const UNCLAIMED_SECONDS = 240

/** A queued request that nothing has picked up in long enough to worry. */
export function isUnclaimed(
  request: RunRequest,
  now: number = Date.now(),
  afterSeconds: number = UNCLAIMED_SECONDS,
): boolean {
  if (request.status !== 'queued') return false
  return (now - new Date(request.requested_at).getTime()) / 1000 > afterSeconds
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

/** Every worker that has checked in recently enough to still be doing something. */
export function liveWorkers(
  workers: WorkerRow[],
  staleAfterSeconds: number = WORKER_STALE_SECONDS,
): WorkerRow[] {
  return workers.filter((w) => Number(w.seconds_since_seen) <= staleAfterSeconds)
}

/**
 * A request that says it is running while the worker that claimed it is gone.
 *
 * Asks about THAT worker, not about whether any worker is online, and the
 * difference is not academic: a worker killed outright never marks its request,
 * so restarting it leaves the old request running forever while the new worker
 * reports itself perfectly healthy. Checking only "is anyone listening" called
 * that Running and let it block every button on the panel.
 *
 * A request with no claimed_by has not been picked up yet, which is queued
 * rather than stalled.
 */
export function isStalled(request: RunRequest, workers: WorkerRow[]): boolean {
  // `cancelling` belongs here as much as `running` does, and leaving it out is
  // what made a killed worker lock the panel for two hours: cancel_run asks the
  // worker to stop between chunks, so a worker that never comes back leaves the
  // row asking forever. It counted as active, it never counted as stalled, and
  // every button stayed grey.
  if (request.status !== 'running' && request.status !== 'cancelling') return false
  if (!request.claimed_by) return true
  return !liveWorkers(workers).some((w) => w.id === request.claimed_by)
}

/** Which source produced the out/ file under this key, or null if there is none. */
function holder(artifacts: ArtifactRow[], key: string): string | null {
  return artifacts.find((a) => a.key === key)?.source ?? null
}

/**
 * What exists, asked of whichever thing can actually see it.
 *
 * There are two answers to "is there a staged.jsonl", and which one is true
 * depends on where the worker runs.
 *
 * A worker on a real machine is looking straight at its own disk and says so
 * over the heartbeat. That is the arrangement in use today, it is the more
 * accurate of the two, and while such a worker is online its report wins.
 *
 * A CI runner cannot answer at all: its disk is empty when it starts, holds only
 * what its own stage pulled, and is deleted minutes later. So the cloud path
 * writes catalog_artifacts instead, and with no worker online that index is what
 * is left to ask.
 *
 * Both, rather than one, because the cloud pipeline is built but not switched
 * on. Dropping the heartbeat now would leave every button but Acquire dead on
 * the machine actually running the pipeline.
 */
export function availableArtifacts(runner: WorkerRow | null, index: ArtifactRow[]): ArtifactRow[] {
  // `sources == null` is a worker that predates the column and cannot tell us
  // anything. Falling through to the index is the safe reading: it may be empty,
  // which offers only Acquire -- recoverable by pressing it -- where trusting an
  // empty answer from the worker would claim files exist that do not.
  if (!runner || runner.sources == null) return index

  const rows: ArtifactRow[] = runner.sources.map((source) => ({
    key: 'subset',
    source,
    remote_key: '',
    bytes: 0,
    updated_at: runner.last_seen_at,
  }))

  for (const key of ['staged', 'scored'] as const) {
    const source = runner.stages?.[key]
    if (source) {
      rows.push({ key, source, remote_key: '', bytes: 0, updated_at: runner.last_seen_at })
    }
  }
  return rows
}

/**
 * Whether a market subset exists for this source.
 *
 * Read off the bucket index rather than off a worker's heartbeat, and the
 * difference matters: the heartbeat described one machine's disk, and a CI
 * runner's disk is empty when it starts and gone when it finishes. There is no
 * "the worker reports nothing, assume it can do anything" fallback any more --
 * an absent row means the file is genuinely not there, which on a fresh bucket
 * correctly leaves Acquire as the only live button.
 */
export function sourceReady(artifacts: ArtifactRow[], source: string): boolean {
  return artifacts.some((a) => a.key === 'subset' && a.source === source)
}

/**
 * Whether this step can actually run right now.
 *
 * The buttons are drawn as a sequence and were once enabled regardless, so with
 * an empty out/ Apply was lit and would have failed on a missing file. Teaching
 * an order in the layout and not enforcing it in the control is worse than not
 * drawing it: it looks like a guarantee.
 */
export function stepReady(artifacts: ArtifactRow[], kind: RunKind, source: string): boolean {
  // acquire is what MAKES a source ready, so it is the one step that cannot be
  // gated on readiness. Running it through sourceReady would leave it disabled
  // on precisely the empty bucket it exists for, saying "openfoodfacts has not
  // been acquired" on the button whose job is to acquire it.
  if (kind === 'acquire') return true

  if (!sourceReady(artifacts, source)) return false

  // normalize and the delta refresh both read the subset, which sourceReady
  // has just checked.
  if (kind === 'acquire-delta' || kind === 'normalize') return true
  if (kind === 'score') return holder(artifacts, 'staged') === source
  return holder(artifacts, 'scored') === source
}

/** Why a step is not available, in the words of what to do about it. */
export function stepBlockedReason(
  artifacts: ArtifactRow[],
  kind: RunKind,
  source: string,
): string {
  if (kind === 'acquire') return ''
  if (!sourceReady(artifacts, source)) return `${source} has not been acquired`

  // Whose file it is, not whether one exists. out/ is a single slot shared by
  // all three sources, so re-scoring against another source's staged products
  // would stamp them wrong at load time.
  if (kind === 'score') {
    const staged = holder(artifacts, 'staged')
    if (staged !== source) {
      return staged
        ? `out/ holds ${staged}, not ${source}. Normalize first.`
        : 'Nothing normalized yet. Run Normalize first.'
    }
  }
  if (kind === 'load' || kind === 'load-apply') {
    const scored = holder(artifacts, 'scored')
    if (scored !== source) {
      return scored
        ? `out/ holds ${scored}, not ${source}. Re-score first.`
        : 'Nothing scored yet. Run Re-score first.'
    }
  }
  return ''
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

/**
 * End a request whose worker is never coming back.
 *
 * cancelRun asks the worker to stop; this is for when there is nobody left to
 * ask. Separate calls on purpose: one is a polite request that the run itself
 * honours, the other is an admin overruling a row, and the audit trail should
 * be able to tell them apart.
 */
export async function forceClearRun(id: string): Promise<void> {
  const { error } = await client().rpc('force_clear_run', { p_id: id })
  if (error) queryError('force_clear_run', error)
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
  const { data, error } = await client().rpc('get_run_request', { p_id: id }).abortSignal(signal)
  if (error) queryError('get_run_request', error)
  const rows = (data ?? []) as RunRequestDetail[]
  return rows.length ? rows[0] : null
}

export async function fetchWorkers(signal: AbortSignal): Promise<WorkerRow[]> {
  const { data, error } = await client().rpc('list_workers').abortSignal(signal)
  if (error) queryError('list_workers', error)
  return (data ?? []) as WorkerRow[]
}

/** What the pipeline has produced and kept, which is what the buttons run off. */
export async function fetchArtifacts(signal: AbortSignal): Promise<ArtifactRow[]> {
  const { data, error } = await client().rpc('list_artifacts').abortSignal(signal)
  if (error) queryError('list_artifacts', error)
  return (data ?? []) as ArtifactRow[]
}
