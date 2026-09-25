import { getCatalogSupabase } from '../supabase'
import { queryError } from './errors'
import { CatalogNotConfigured } from './catalog'

// What a scrape run said while it ran, and what it touched (catalog 023).
//
// The log is a table read behind the same admins-only policy as the runs, and
// a Realtime subscription on top of it: every line the scraper ships is an
// INSERT, delivered to this page while it is open. The page ALSO polls, the way
// Scrapers does. Realtime is the fast path, not the only one, and a socket
// that failed to join must not look like a scraper that went quiet.

export interface RunLogLine {
  id: number
  run_id: string
  t: string
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
  fields: Record<string, unknown> | null
}

/** Lines per read. A normal night's run is a few hundred; the cap is 5,000 info. */
export const LOG_PAGE = 1000

/** A run's lines after `afterId`, oldest first. */
export async function fetchRunLogs(runId: string, afterId: number, signal: AbortSignal): Promise<RunLogLine[]> {
  const supabase = getCatalogSupabase()
  if (!supabase) throw new CatalogNotConfigured()
  const { data, error } = await supabase
    .from('catalog_run_logs')
    .select('id, run_id, t, level, scope, message, fields')
    .eq('run_id', runId)
    .gt('id', afterId)
    .order('id', { ascending: true })
    .limit(LOG_PAGE)
    .abortSignal(signal)
  if (error) queryError('catalog_run_logs', error)
  return (data ?? []) as RunLogLine[]
}

/**
 * New lines for one run as they are written. Returns the way to stop, which the
 * caller MUST call when it unmounts: an open channel holds a socket slot.
 */
export function subscribeRunLogs(runId: string, onLine: (line: RunLogLine) => void): () => void {
  const supabase = getCatalogSupabase()
  if (!supabase) return () => {}
  const channel = supabase
    .channel(`run-logs-${runId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'catalog_run_logs', filter: `run_id=eq.${runId}` },
      (payload) => onLine(payload.new as RunLogLine),
    )
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}

export type ListingKind = 'new' | 'repriced' | 'gone'

export interface RunListing {
  external_id: string
  name: string
  price: number | null
  previous_price: number | null
  currency: string | null
  available: boolean
  product_url: string
}

export const LISTING_PAGE = 50

export async function fetchRunListings(
  runId: string,
  kind: ListingKind,
  offset: number,
  signal: AbortSignal,
): Promise<{ rows: RunListing[]; total: number }> {
  const supabase = getCatalogSupabase()
  if (!supabase) throw new CatalogNotConfigured()
  const { data, error } = await supabase
    .rpc('catalog_admin_run_listings', { p_run_id: runId, p_kind: kind, p_limit: LISTING_PAGE, p_offset: offset })
    .abortSignal(signal)
  if (error) queryError('catalog_admin_run_listings', error)
  const rows = (data ?? []) as Array<RunListing & { total: number }>
  return { rows, total: rows.length ? Number(rows[0].total) : 0 }
}
