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

/**
 * A request that says it is running while nothing is listening.
 *
 * The worker marks its own request failed on ctrl-c, so this is the other case:
 * a power cut, or a process killed outright. Rendering it as Running would be a
 * spinner that never finishes, which is the one state this panel must not show.
 */
export function isStalled(request: RunRequest | RunRequestDetail, runner: WorkerRow | null): boolean {
  return request.status === 'running' && runner === null
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
