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
   * Source ids this worker has a market subset cached for.
   *
   * Only the worker can know this: the subsets are files on its disk. Without
   * it the dashboard offers all three sources and two of them fail in under a
   * second with "no market subset", which is a button that should never have
   * been enabled.
   */
  sources: string[] | null
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
  if (request.status !== 'running') return false
  if (!request.claimed_by) return true
  return !liveWorkers(workers).some((w) => w.id === request.claimed_by)
}

/**
 * Whether the runner could actually run a stage for this source.
 *
 * A worker that reports nothing -- an older one, or one that has not heartbeated
 * since the column existed -- is treated as able to run anything, which is what
 * it was before this existed. Guessing the other way would disable every button
 * on a runner that is working fine.
 */
export function sourceReady(runner: WorkerRow | null, source: string): boolean {
  if (!runner) return false
  if (runner.sources === null) return true
  return runner.sources.includes(source)
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
