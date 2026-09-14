import { getCatalogSupabase } from '../supabase'
import { queryError } from './errors'
import { CatalogNotConfigured } from './catalog'

// The scrape runs, one row per attempt to read one shop into the catalog.
//
// A TABLE READ, where the rest of the catalog surface is RPCs, and it may be:
// 003_runs.sql grants `select` on catalog_scrape_runs to authenticated behind a
// policy that admits catalog admins and nobody else. There is nothing to compute
// here that the rows do not already say, so a function would only be a second
// place to keep the column list.
//
// A running run is not frozen at its start: the scraper reports progress every
// few hundred products through catalog_run_progress, so products_found on a
// `running` row is how far it has got. That is what the Scrapers page polls for.

export type RunStatus = 'running' | 'completed' | 'partial' | 'failed'

export interface ScrapeRunRow {
  id: string
  /** The retailer's slug, flattened out of the embedded row. Identity. */
  shop: string
  /** What the shop calls itself -- "Mega Image", not "mega-image". Display. */
  shopName: string
  status: RunStatus
  started_at: string
  finished_at: string | null
  products_found: number
  products_valid: number
  products_rejected: number
  inserted: number
  updated: number
  unchanged: number
  products_created: number
  marked_unavailable: number
  error: string | null
}

/** Enough for a week of four shops a night, with failures and retries. */
export const RUN_HISTORY_LIMIT = 50

const COLUMNS =
  'id, status, started_at, finished_at, products_found, products_valid, products_rejected, ' +
  'inserted, updated, unchanged, products_created, marked_unavailable, error, ' +
  'retailer:catalog_retailers(slug, name)'

type Retailer = { slug: string; name: string | null }

type RawRun = Omit<ScrapeRunRow, 'shop' | 'shopName'> & {
  retailer: Retailer | Retailer[] | null
}

export async function fetchScrapeRuns(signal: AbortSignal): Promise<ScrapeRunRow[]> {
  const supabase = getCatalogSupabase()
  if (!supabase) throw new CatalogNotConfigured()

  const { data, error } = await supabase
    .from('catalog_scrape_runs')
    .select(COLUMNS)
    .order('started_at', { ascending: false })
    .limit(RUN_HISTORY_LIMIT)
    .abortSignal(signal)
  if (error) queryError('catalog_scrape_runs', error)

  return ((data ?? []) as unknown as RawRun[]).map(({ retailer, ...run }) => {
    // A many-to-one embed arrives as an object; the generated types cannot tell
    // and allow an array, so both are read rather than one being assumed.
    const shop = Array.isArray(retailer) ? retailer[0] : retailer
    return {
      ...run,
      shop: shop?.slug ?? 'unknown',
      shopName: shop?.name || shop?.slug || 'Unknown shop',
    }
  })
}

/**
 * A run's length the way a person says it: "9 s", "52 min", "1 h 50 min".
 *
 * Not format.ts's formatDuration, which is built for query latencies and prints
 * a two-hour crawl as "109.8 min" -- a precision nobody reading a nightly job
 * wants, in a unit that makes you do the division.
 */
export function formatRunDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/**
 * Each shop's newest run, in the order the shops last started.
 *
 * Relies on the rows arriving newest first, which fetchScrapeRuns guarantees.
 */
export function latestPerShop(runs: ScrapeRunRow[]): ScrapeRunRow[] {
  const seen = new Set<string>()
  return runs.filter((run) => {
    if (seen.has(run.shop)) return false
    seen.add(run.shop)
    return true
  })
}

/** How long a run took, or for a running one, how long it has been going. */
export function runDurationMs(
  run: Pick<ScrapeRunRow, 'started_at' | 'finished_at'>,
  now = Date.now(),
): number {
  const end = run.finished_at ? Date.parse(run.finished_at) : now
  return Math.max(0, end - Date.parse(run.started_at))
}

/**
 * `partial` is neither: it imported what it saw and refused to sweep the rest.
 *
 * Running is `idle`, not the accent. The accent in this design system is the
 * same green as `good`, so a running shop and a finished one read as the same
 * state from across the page.
 */
export function runTone(status: RunStatus): 'good' | 'warn' | 'bad' | 'idle' {
  if (status === 'completed') return 'good'
  if (status === 'partial') return 'warn'
  if (status === 'failed') return 'bad'
  return 'idle'
}

/**
 * Roughly how many products a run should end up reading: what the same shop's
 * last completed run before it read. Null when none is in the rows at hand.
 *
 * An estimate and labelled as one on the page -- a shop grows and shrinks -- but
 * it is the only thing that turns "4,000 so far" into "about halfway".
 */
export function expectedCount(run: ScrapeRunRow, runs: ScrapeRunRow[]): number | null {
  const started = Date.parse(run.started_at)
  const previous = runs.find(
    (r) =>
      r.shop === run.shop &&
      r.status === 'completed' &&
      Date.parse(r.started_at) < started &&
      r.products_found > 0,
  )
  return previous ? previous.products_found : null
}

/**
 * What a run said, readable. The importer prefixes every failure with the shop's
 * slug, which the page already shows beside it, so that half is dropped.
 */
export function runMessage(run: Pick<ScrapeRunRow, 'shop' | 'error'>): string | null {
  if (!run.error) return null
  const prefix = `import failed for ${run.shop}: `
  const text = run.error.startsWith(prefix)
    ? `Import failed: ${run.error.slice(prefix.length)}`
    : run.error
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function runLabel(status: RunStatus): string {
  if (status === 'completed') return 'Completed'
  if (status === 'partial') return 'Refused to sweep'
  if (status === 'failed') return 'Failed'
  return 'Running'
}
