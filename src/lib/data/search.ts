import { getAppSupabase } from '../supabase'
import { loadCatalogShape } from './products'
import { sinceIso, type TimeRange } from '../timeRange'
import { unavailable, type Metric } from './types'

// Search Analytics.
//
// ─── THE HONEST POSITION, STATED ONCE ────────────────────────────────────────
//
// FamCart does not record searches. The add-item box debounces typing, calls
// search_catalog(p_query, p_limit, p_markets) on the catalog project and
// concurrently queries the household's own contributed rows, then merges and
// dedupes them. search_catalog() is `stable` and selects; it writes nothing.
// There is no query string, no result count, no latency and no zero-result flag
// anywhere in any of the three databases.
//
// So the four metrics this section was asked for -- most searched products,
// searches with no results, popular queries, search volume over time -- have no
// data source, and the fifth, autocomplete performance, has none either.
//
// ─── WHAT THIS SECTION SHOWS INSTEAD, AND WHY IT IS NOT A CONSOLATION ────────
//
// Two things ARE recorded, and both are downstream of search:
//
//   1. What people ADDED. add_count on a catalog row is incremented by
//      bump_product_popularity() when a suggestion is picked, and
//      purchase_history records what was actually bought. Together these are
//      "what searching succeeded at", which is a real and useful signal as long
//      as it is not labelled "what people searched for".
//
//   2. What people FAILED to find. A contributed product is, definitionally, the
//      record of a search that came back empty: add_custom_product() is what runs
//      when the catalog had nothing and the user typed the name in anyway. Every
//      row in the app database's product_catalog with a household_id is a
//      zero-result search that someone cared enough about to fix by hand.
//
// The second of those is the closest thing to a zero-result report that exists,
// and it is arguably better than a query log for the purpose it serves, because
// it is filtered down to the misses that mattered. It is still not the same
// thing, and the UI says which is which.

export interface AddedProduct {
  name: string
  maker: string | null
  times: number
  quantity: number
  households: number
  lastBought: string
}

/**
 * What households actually bought in the window, aggregated across all of them.
 *
 * Read as: demand that the catalog served. Not as: what people typed.
 */
export async function fetchTopAddedProducts(
  range: TimeRange,
  limit: number,
  signal: AbortSignal,
): Promise<AddedProduct[]> {
  const { data, error } = await getAppSupabase()
    .rpc('admin_top_purchases', { p_since: sinceIso(range), p_limit: limit })
    .abortSignal(signal)

  if (error) {
    throw Object.assign(new Error(`admin_top_purchases: ${error.message}`), { code: error.code })
  }

  return ((data ?? []) as {
    name: string
    maker: string | null
    times: number
    quantity: number
    households: number
    last_bought: string
  }[]).map((r) => ({
    name: r.name,
    maker: r.maker,
    times: r.times,
    quantity: r.quantity,
    households: r.households,
    lastBought: r.last_bought,
  }))
}

/**
 * Products households had to type in themselves: the catalog's misses.
 *
 * Ordered by how many distinct households contributed the same product, because
 * that is the promotion signal too -- three distinct households is what collapses
 * scoped rows into a global one. A product sitting at two is a gap about to
 * close; a product at one is a gap nobody else has hit yet.
 */
export interface CatalogMiss {
  name: string
  maker: string | null
  households: number
  addCount: number
  firstSeen: string
  lastSeen: string
  promoted: boolean
}

export async function fetchCatalogMisses(
  limit: number,
  signal: AbortSignal,
): Promise<CatalogMiss[]> {
  const { data, error } = await getAppSupabase()
    .rpc('admin_catalog_misses', { p_limit: limit })
    .abortSignal(signal)

  if (error) {
    throw Object.assign(new Error(`admin_catalog_misses: ${error.message}`), { code: error.code })
  }

  return ((data ?? []) as {
    name: string
    maker: string | null
    households: number
    add_count: number
    first_seen: string
    last_seen: string
    promoted: boolean
  }[]).map((r) => ({
    name: r.name,
    maker: r.maker,
    households: r.households,
    addCount: r.add_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    promoted: r.promoted,
  }))
}

/**
 * How much of the catalog has ever been picked.
 *
 * add_count > 0 means a suggestion was chosen at least once. The ratio is a
 * blunt but real measure of whether importing 10,000 products bought anything:
 * a catalog where 1% of rows have ever been added is mostly ballast.
 */
export interface CatalogAdoption {
  total: number
  adopted: number
  totalAddCount: number
  topAddCount: number
  /**
   * The aggregate covered only part of the catalog, so the adoption RATIO below
   * is measured against the wrong denominator. Rendered rather than hidden: a
   * plausible-looking percentage computed from a prefix is worse than no
   * percentage.
   */
  truncated: boolean
}

export async function fetchCatalogAdoption(): Promise<CatalogAdoption> {
  const shape = await loadCatalogShape()
  return {
    total: shape.total,
    adopted: shape.popularity.adopted,
    totalAddCount: shape.popularity.totalAddCount,
    topAddCount: shape.popularity.topAddCount,
    truncated: shape.truncated,
  }
}

// ─── the four that have no source ────────────────────────────────────────────

const SEARCH_REASON =
  'Searches are not recorded anywhere. search_catalog() is a stable function that selects rows and writes none, ' +
  'so no query string, result count or timing ever reaches a database.'

const SEARCH_FIX =
  'A search_events table in the catalog project (query, result count, market, latency, at), ' +
  'written by search_catalog() before it returns. One insert per search.'

export interface SearchQueryRow {
  query: string
  searches: number
  zeroResults: number
  lastSeen: string
}

export function fetchPopularQueries(_range: TimeRange): Metric<SearchQueryRow[]> {
  return unavailable(SEARCH_REASON, SEARCH_FIX)
}

export function fetchZeroResultQueries(_range: TimeRange): Metric<SearchQueryRow[]> {
  return unavailable(
    SEARCH_REASON +
      ' The nearest real signal is the catalog misses table on this page: every product a household typed in by hand is a search that returned nothing.',
    SEARCH_FIX,
  )
}

export interface SearchVolumePoint {
  bucket: string
  searches: number
  zeroResults: number
}

export function fetchSearchVolume(_range: TimeRange): Metric<SearchVolumePoint[]> {
  return unavailable(SEARCH_REASON, SEARCH_FIX)
}

export interface AutocompletePerformance {
  p50Ms: number
  p95Ms: number
  p99Ms: number
  samples: number
}

export function fetchAutocompletePerformance(_range: TimeRange): Metric<AutocompletePerformance> {
  return unavailable(
    'Autocomplete timing is not recorded. The 300ms debounce and the round trip both happen in the browser, and nothing reports either.',
    'Either the search_events table above with a latency column, or a Sentry performance span around the suggestion request in src/lib/productSuggestions.ts.',
  )
}
