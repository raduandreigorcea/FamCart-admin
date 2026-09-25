import { getCatalogSupabase } from '../supabase'
import { formatCount } from '../format'
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
  /** The shop's uuid. The run page reads the shop's other runs by it. */
  retailer_id: string
  /** The retailer's slug, flattened out of the embedded row. Identity. */
  shop: string
  /** What the shop calls itself -- "Mega Image", not "mega-image". Display. */
  shopName: string
  /**
   * Where the shop sells, as the catalog's market code. Not decoration: nine
   * shops are called "Lidl", and without it they are nine identical rows.
   */
  country: string
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
  /** GTINs and other identifiers the import attached to products. */
  identifiers_added: number
  /** An identifier already held by a different product: a merge nobody made. */
  conflicts: number
  /** Rows the importer could not write, each one inside a batch that did land. */
  error_count: number
  error: string | null
  /**
   * Pages the scraper has read, whether or not they held a product to import
   * (catalog 022). The number that moves while products_found cannot.
   */
  pages_read: number
  /**
   * When the scraper last heard back from the shop. Reported once a minute
   * while answers arrive, so a stale value means it stopped hearing back. Null
   * on a run from a scraper that predates the report.
   */
  last_alive_at: string | null
  /**
   * How far the crawl is through its OWN plan, in its own unit (catalog 022):
   * sitemap "pages", Carrefour "departments", Auchan "categories". Null until
   * the scraper reports one, and on runs from before it could.
   */
  progress_done: number | null
  progress_total: number | null
  progress_unit: string | null
  /**
   * What the run counted along the way (catalog run.ts): rejections, and --
   * since 2026-09-17 -- what it REMOVED as outside groceries. Null or without
   * those keys on older runs.
   */
  stats: {
    purged_listings?: number
    purged_products?: number
    excluded?: number
    deliberate?: boolean
    removals_only?: boolean
  } | null
}

/**
 * Enough for a week of twenty-two shops a night, with failures and retries.
 *
 * It was 50 when four shops ran, and 50 is two nights now: a shop whose job
 * stayed queued would fall out of the rows and vanish from the page as if it had
 * never existed, which is the one state this page must not hide.
 */
export const RUN_HISTORY_LIMIT = 200

const COLUMNS =
  'id, retailer_id, status, started_at, finished_at, products_found, products_valid, products_rejected, ' +
  'inserted, updated, unchanged, products_created, marked_unavailable, error, ' +
  'identifiers_added, conflicts, error_count, ' +
  'pages_read, last_alive_at, progress_done, progress_total, progress_unit, stats, ' +
  'retailer:catalog_retailers(slug, name, country)'

type Retailer = { slug: string; name: string | null; country: string | null }

type RawRun = Omit<ScrapeRunRow, 'shop' | 'shopName' | 'country'> & {
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

  return ((data ?? []) as unknown as RawRun[]).map(toRow)
}

function toRow({ retailer, ...run }: RawRun): ScrapeRunRow {
  // A many-to-one embed arrives as an object; the generated types cannot tell
  // and allow an array, so both are read rather than one being assumed.
  const shop = Array.isArray(retailer) ? retailer[0] : retailer
  return {
    ...run,
    shop: shop?.slug ?? 'unknown',
    shopName: shop?.name || shop?.slug || 'Unknown shop',
    country: shop?.country ?? '',
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a route param can be a run's id at all. Checked before asking, because
 * Postgres answers a malformed uuid with an error (22P02), and /scrapers/abc
 * should say "no such run", not "could not read the run".
 */
export function isRunId(value: string): boolean {
  return UUID.test(value)
}

/** One run, for its own page. Null when there is no such run. */
export async function fetchScrapeRun(id: string, signal: AbortSignal): Promise<ScrapeRunRow | null> {
  if (!isRunId(id)) return null
  const supabase = getCatalogSupabase()
  if (!supabase) throw new CatalogNotConfigured()
  const { data, error } = await supabase
    .from('catalog_scrape_runs')
    .select(COLUMNS)
    .eq('id', id)
    .abortSignal(signal)
    .maybeSingle()
  if (error) queryError('catalog_scrape_runs', error)
  return data ? toRow(data as unknown as RawRun) : null
}

/** A month of nights for one shop: what the run page's charts are drawn from. */
export const SHOP_HISTORY_LIMIT = 30

export async function fetchShopRuns(retailerId: string, signal: AbortSignal): Promise<ScrapeRunRow[]> {
  const supabase = getCatalogSupabase()
  if (!supabase) throw new CatalogNotConfigured()
  const { data, error } = await supabase
    .from('catalog_scrape_runs')
    .select(COLUMNS)
    .eq('retailer_id', retailerId)
    .order('started_at', { ascending: false })
    .limit(SHOP_HISTORY_LIMIT)
    .abortSignal(signal)
  if (error) queryError('catalog_scrape_runs', error)
  return ((data ?? []) as unknown as RawRun[]).map(toRow)
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

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })

/**
 * A market code as a person reads it: "GB" is "United Kingdom". English, like
 * every other word on the dashboard. Anything that is not a region code comes
 * back as it was rather than as a guess.
 */
export function countryName(code: string): string {
  if (!code) return 'Unknown country'
  try {
    return regionNames.of(code) ?? code
  } catch {
    return code
  }
}

/** The selector's "every country" value. Not a market code, so it cannot collide. */
export const ALL_COUNTRIES = 'all'

/**
 * The countries the selector offers: each one that has a run in the rows at
 * hand, once, by code. Only those, because a country with no run yet would be a
 * button that empties the page and says nothing about why.
 */
export function countriesIn(runs: ScrapeRunRow[]): string[] {
  return [...new Set(runs.map((run) => run.country).filter(Boolean))].sort()
}

/**
 * How long a running scraper has been silent before the page says so.
 *
 * The scraper reports once a minute while any answer arrives, and the slowest
 * shop takes ~3.5 s a page, so ten silent minutes is ten missed reports -- not a
 * slow page, and not a slow database. Long enough that a stall in the catalog
 * instance (seconds, see RETRY_DELAYS_MS in the catalog) never trips it.
 */
export const STALE_AFTER_MS = 10 * 60_000

/** How long since the shop was last heard from, or null if it never reported. */
export function quietFor(run: Pick<ScrapeRunRow, 'last_alive_at'>, now = Date.now()): number | null {
  if (!run.last_alive_at) return null
  return Math.max(0, now - Date.parse(run.last_alive_at))
}

/**
 * A run that says it is running and has not heard from its shop in a while.
 *
 * A run that never reported at all is measured from its start: every scraper
 * sends a sign of life within a minute, so one that has sent none for ten
 * minutes is a process that died before the report existed or before its first
 * beat. Three such rows sat "Running" for eight hours on 2026-09-17.
 */
export function isStalled(
  run: Pick<ScrapeRunRow, 'status' | 'last_alive_at'> & { started_at?: string },
  now = Date.now(),
): boolean {
  if (run.status !== 'running') return false
  const quiet = quietFor(run, now) ?? (run.started_at ? Math.max(0, now - Date.parse(run.started_at)) : null)
  return quiet !== null && quiet > STALE_AFTER_MS
}

/**
 * What a run's status pill says, for the card and the history table alike.
 *
 * One place, because the table is where a shop that did not make the card row
 * is read, and a stalled run that the card calls "No sign of life" must not be
 * "Running" one screen further down.
 */
/** A partial run that was partial on purpose (catalog run.ts, stats.deliberate). */
export function isDeliberate(run: { status: string; stats?: { deliberate?: boolean } | null }): boolean {
  return run.status === 'partial' && run.stats?.deliberate === true
}

/**
 * A Carrefour `--removals-only` job: it reads, imports nothing, and deletes what
 * is not groceries. Runs from before the catalog said so in `stats` are known by
 * the reason they closed with (catalog cli/scrape.ts).
 */
export function isRemovalJob(run: { stats?: ScrapeRunRow['stats']; error?: string | null }): boolean {
  return run.stats?.removals_only === true || (run.error?.startsWith('removals only') ?? false)
}

export function runPill(
  run: Pick<ScrapeRunRow, 'status' | 'last_alive_at'> & { stats?: ScrapeRunRow['stats']; error?: string | null },
  now = Date.now(),
): { tone: 'good' | 'warn' | 'bad' | 'live'; label: string; busy: boolean } {
  if (isStalled(run, now)) return { tone: 'warn', label: 'No sign of life', busy: false }
  // NOTHING ABOUT REMOVAL JOBS HERE. The pill says how a run ENDED; that it was
  // a removal job is a separate label beside the shop's name (ShopRunCard's
  // `kind`). They were one pill once, and the kind could only win when the run
  // ended deliberately partial -- so the two real removal jobs, which crashed
  // after deleting 15,438 listings, showed a bare red "Failed" and nothing else.
  // Partial ON PURPOSE -- Carrefour's nightly groceries-only pass, a slice, a
  // removals-only run -- is a run that did what it was asked. Only a run the
  // database refused to sweep is partial for a reason somebody should read.
  if (isDeliberate(run)) return { tone: 'good', label: 'Done', busy: false }
  return { tone: runTone(run.status), label: runLabel(run.status), busy: run.status === 'running' }
}

/** How many runs the Scrapers page draws as cards: one row of its grid. */
export const CARD_COUNT = 5

/**
 * The newest runs as cards, everything else as history, and never a run in both.
 *
 * Runs, not shops: a shop that ran twice lately is on two cards. A card per shop
 * was tried and read wrong -- Romania has four shops and dozens of runs, and
 * showed four cards over a long history. Takes the rows newest first, as
 * fetchScrapeRuns returns them.
 */
export function splitCards(runs: ScrapeRunRow[]): { cards: ScrapeRunRow[]; history: ScrapeRunRow[] } {
  return { cards: runs.slice(0, CARD_COUNT), history: runs.slice(CARD_COUNT) }
}

/** One country's runs, or every run for ALL_COUNTRIES. */
export function inCountry(runs: ScrapeRunRow[], country: string): ScrapeRunRow[] {
  return country === ALL_COUNTRIES ? runs : runs.filter((run) => run.country === country)
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
 * Running is `live`, a yellow of its own. Not the accent, which in this design
 * system is the same green as `good`, so a running shop and a finished one read
 * as the same state; and no longer `idle`, whose grey read as a shop nobody had
 * started.
 */
export function runTone(status: RunStatus): 'good' | 'warn' | 'bad' | 'live' {
  if (status === 'completed') return 'good'
  if (status === 'partial') return 'warn'
  if (status === 'failed') return 'bad'
  return 'live'
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
 * Listings the run removed as outside groceries. A removals-only run imports
 * nothing, so this is the one number that says what it did.
 */
export function removedCount(run: Pick<ScrapeRunRow, 'stats'>): number {
  const n = run.stats?.purged_listings
  return typeof n === 'number' && n > 0 ? n : 0
}

/**
 * Products the purge took with the listings, once a product had none left.
 *
 * Always the smaller of the two and never derivable from it: 15,115 listings
 * took 13,421 products on 2026-09-17, and the difference is the articles some
 * other shop still sells as groceries.
 */
export function removedProducts(run: Pick<ScrapeRunRow, 'stats'>): number {
  const n = run.stats?.purged_products
  return typeof n === 'number' && n > 0 ? n : 0
}

/**
 * What a card's bar measures, and how to say it: the scraper's own plan when it
 * reported one, else, for a run that finished what it set out to do, its own
 * count as a full bar, else the same shop's last completed run, else nothing.
 *
 * Every card gets a bar, finished ones included: a failed run's bar shows how
 * far it got, a finished one's shows the whole plan read.
 *
 * The plan comes first because it is the truth, where the last run is a guess
 * about it -- and because it is the only one a first run, or Carrefour, which
 * never completes, can have.
 */
export function runProgress(
  run: ScrapeRunRow,
  runs: ScrapeRunRow[],
): { value: number; max: number; label: string } | null {
  if (run.progress_total && run.progress_total > 0 && run.progress_done !== null) {
    const unit = run.progress_unit || 'steps'
    return {
      value: run.progress_done,
      max: run.progress_total,
      label: `${formatCount(run.progress_done)} of ${formatCount(run.progress_total)} ${unit}`,
    }
  }
  if ((run.status === 'completed' || isDeliberate(run)) && run.products_found > 0) {
    return { value: run.products_found, max: run.products_found, label: `${formatCount(run.products_found)} products` }
  }
  const expected = expectedCount(run, runs)
  if (expected) {
    return { value: run.products_found, max: expected, label: `of about ${formatCount(expected)} products` }
  }
  return null
}

/**
 * What a run said, readable. The importer prefixes every failure with the shop's
 * slug, which the page already shows beside it, so that half is dropped.
 */
export function runMessage(run: Pick<ScrapeRunRow, 'shop' | 'error'>): string | null {
  if (!run.error) return null
  // The catalog's reaper (007) writes a whole sentence explaining how it knows,
  // and a card has two lines. What it means is short: the job was killed before
  // it could close its own run -- in practice, the nightly time limit.
  if (run.error.startsWith('abandoned:')) return 'Killed before it could finish'
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
