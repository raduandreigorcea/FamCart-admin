import { getAppSupabase } from '../supabase'
import type { RangeKey, TimeRange } from '../timeRange'
import { previousSinceIso, sinceIso } from '../timeRange'
import {
  unavailable,
  type ActivityBucket,
  type Metric,
  type OverviewPayload,
  type OverviewWindow,
  type RecentActivityRow,
} from './types'

// The overview screen's data, and the one place a period-over-period delta is
// computed.

function db() {
  return getAppSupabase()
}

function rpcError(context: string, error: { message: string; code?: string } | null): never {
  const wrapped = new Error(`${context}: ${error?.message ?? 'unknown error'}`) as Error & {
    code?: string
  }
  wrapped.code = error?.code
  throw wrapped
}

export async function fetchOverview(range: TimeRange, signal: AbortSignal): Promise<OverviewPayload> {
  const { data, error } = await db()
    .rpc('admin_overview', { p_since: sinceIso(range) })
    .abortSignal(signal)
  if (error) rpcError('admin_overview', error)
  return data as OverviewPayload
}

/**
 * The same window immediately before this one, so a tile can show a delta.
 *
 * Fetched as a second call rather than computed inside one RPC deliberately: the
 * comparison is a presentation choice, and baking it into the function would
 * mean every caller pays for it including the ones that only want totals.
 */
export async function fetchPreviousWindow(
  range: TimeRange,
  signal: AbortSignal,
): Promise<OverviewWindow> {
  const { data, error } = await db()
    .rpc('admin_overview', { p_since: previousSinceIso(range) })
    .abortSignal(signal)
  if (error) rpcError('admin_overview (previous)', error)
  const payload = data as OverviewPayload

  // admin_overview counts everything since a timestamp, so the "previous" call
  // covers BOTH windows. Subtracting the current one leaves the earlier period
  // alone, which is what a delta compares against.
  return payload.window
}

export interface Delta {
  /** Absolute change against the preceding window of equal length. */
  change: number
  /** Fractional change, or null where the previous window was zero. */
  ratio: number | null
}

/**
 * `current` counts the last N hours. `cumulative` counts the last 2N hours, so
 * the preceding window is the difference. Returns null when there is nothing to
 * compare against, which a tile renders as no delta rather than as +100%.
 */
export function deltaOf(current: number, cumulative: number): Delta | null {
  const previous = cumulative - current
  if (previous < 0) return null
  const change = current - previous
  return { change, ratio: previous === 0 ? null : change / previous }
}

export async function fetchActivitySeries(
  range: TimeRange,
  signal: AbortSignal,
): Promise<ActivityBucket[]> {
  const { data, error } = await db()
    .rpc('admin_activity_series', { p_since: sinceIso(range), p_bucket: range.bucket })
    .abortSignal(signal)
  if (error) rpcError('admin_activity_series', error)
  return (data ?? []) as ActivityBucket[]
}

export async function fetchRecentActivity(
  limit: number,
  signal: AbortSignal,
): Promise<RecentActivityRow[]> {
  const { data, error } = await db()
    .rpc('admin_recent_activity', { p_limit: limit })
    .abortSignal(signal)
  if (error) rpcError('admin_recent_activity', error)
  return (data ?? []) as RecentActivityRow[]
}

// ─── the one overview tile that has no data behind it ────────────────────────
//
// "Searches" is on the overview because it is one of the numbers worth watching.
// It is also one FamCart does not have: the add-item box calls search_catalog()
// on the catalog project, which selects rows and returns them, and no row is
// written anywhere as a result. There is no table to count, no log to parse, and
// no proxy that is honest -- product adds are a fraction of searches and a very
// biased one, since they exclude precisely the searches that failed.
//
// So the tile says so. See src/lib/data/search.ts for the same treatment applied
// to a whole section, and for the adjacent signals that ARE real.
export function searchVolume(_range: RangeKey): Metric<number> {
  return unavailable(
    'Searches are not recorded. search_catalog() reads the catalog and writes nothing, so there is no row to count.',
    'A search_events table in the catalog project, written by search_catalog() on each call.',
  )
}
