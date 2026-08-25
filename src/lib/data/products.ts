import { getAppSupabase, getCatalogSupabase } from '../supabase'
import { sortGuard } from './types'
import type { CatalogProductRow, LocalProductRow, Page, PageParams } from './types'
import { queryError } from './errors'

// Products live in TWO tables in two different databases, and the fact that they
// do is the confusing part of this system rather than an implementation detail.
// So this module addresses both and never pretends they are one:
//
//   catalog project . product_catalog  - imported and curated reference rows.
//                                        Belong to nobody. No household_id column
//                                        at all, and `source` can never be
//                                        'community'.
//   app project     . product_catalog  - rows a household contributed through
//                                        add_custom_product(), plus anything
//                                        promoted out of them once three distinct
//                                        households asked for it.
//
// One product can exist as an imported row in the first AND a promoted row in
// the second. FamCart's own suggestions code dedupes them at search time; this
// dashboard deliberately does not, because "the same product is in both" is
// exactly the thing an operator opens a catalog page to find out.
//
// The catalog project needs no admin RPC: its policy is `to authenticated` with
// `using (true)`, so an ordinary signed-in token can already read every row. The
// app project's copy is household-scoped and goes through admin_local_products().

const CATALOG_COLUMNS =
  'id,name,maker,barcode,search_aliases,markets,base_weight,add_count,popularity,source,source_ref,source_version,created_at'

export const CATALOG_SORTS = ['popularity', 'add_count', 'base_weight', 'created_at', 'name'] as const
export type CatalogSort = (typeof CATALOG_SORTS)[number]

export const isCatalogSort = sortGuard(CATALOG_SORTS)

/**
 * Neutralise the LIKE metacharacters in a term the operator typed.
 *
 * `%` and `_` are wildcards to SQL and ordinary characters to everyone else,
 * and this catalog is full of names that contain them -- `Lapte 3,5%` is a
 * shelf label, not a pattern. Pasting one searched for "Lapte 3,5" followed by
 * anything at all, which returns the row you wanted somewhere inside a page of
 * rows you did not.
 *
 * Backslash is escaped first, or escaping the others would produce escapes of
 * their own escapes. `\` is LIKE's default escape character, so no ESCAPE
 * clause is needed and PostgREST forwards the pattern unchanged.
 *
 * NOT handled, deliberately: `*`. PostgREST rewrites `*` to `%` in like/ilike
 * patterns before Postgres sees them, and offers no way to escape it, so a
 * literal asterisk cannot be searched for through this operator at all.
 * Escaping it here would turn it into a literal `%` and match even less. It is
 * left alone and left documented.
 */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export interface CatalogFilters extends PageParams<CatalogSort> {
  source?: string | null
  market?: string | null
  sourceVersion?: string | null
  /** 'any' | 'with' | 'without' -- barcode presence, which is the usual triage. */
  barcode?: 'any' | 'with' | 'without'
}

export class CatalogNotConfigured extends Error {
  constructor() {
    super('The catalog project is not configured (VITE_CATALOG_SUPABASE_URL / _ANON_KEY).')
    this.name = 'CatalogNotConfigured'
  }
}

export function catalogConfigured(): boolean {
  return getCatalogSupabase() !== null
}

export async function fetchCatalogProducts(
  filters: CatalogFilters,
  signal: AbortSignal,
): Promise<Page<CatalogProductRow>> {
  const client = getCatalogSupabase()
  if (!client) throw new CatalogNotConfigured()

  const limit = filters.limit ?? 25
  const offset = filters.offset ?? 0
  const sort: CatalogSort = filters.sort ?? 'popularity'
  const ascending = filters.dir === 'asc'

  let request = client
    .from('product_catalog')
    .select(CATALOG_COLUMNS, { count: 'exact' })
    .range(offset, offset + limit - 1)
    .order(sort, { ascending })
    // A stable tiebreak, so page 2 cannot repeat a row from page 1 when many
    // rows share a popularity of 0 -- which, in a freshly imported catalog, most
    // of them do.
    .order('id', { ascending: true })

  const query = filters.query?.trim()
  if (query) {
    // A digits-only query is a barcode lookup, not a name search. Searching
    // `name ilike %5941234567890%` matches nothing and looks like the scanner is
    // broken; this is what makes pasting a GTIN work.
    if (/^\d{8,14}$/.test(query)) {
      request = request.eq('barcode', query)
    } else {
      // search_blob is the generated column the trigram index is built on, and
      // it already holds the folded name, maker and aliases. Matching it rather
      // than OR-ing across three columns means one index does the work.
      request = request.ilike('search_blob', `%${escapeLike(query.toLowerCase())}%`)
    }
  }

  if (filters.source) request = request.eq('source', filters.source)
  if (filters.sourceVersion) request = request.eq('source_version', filters.sourceVersion)
  if (filters.market) request = request.contains('markets', [filters.market])
  if (filters.barcode === 'with') request = request.not('barcode', 'is', null)
  if (filters.barcode === 'without') request = request.is('barcode', null)

  const { data, error, count } = await request.abortSignal(signal)
  if (error) queryError('product_catalog', error)

  return { rows: (data ?? []) as CatalogProductRow[], total: count ?? 0, offset }
}

export async function fetchCatalogProduct(
  id: string,
  signal: AbortSignal,
): Promise<CatalogProductRow | null> {
  const client = getCatalogSupabase()
  if (!client) throw new CatalogNotConfigured()

  const { data, error } = await client
    .from('product_catalog')
    .select(CATALOG_COLUMNS)
    .eq('id', id)
    // abortSignal before maybeSingle: the latter returns a terminal
    // PostgrestBuilder that no longer accepts request options.
    .abortSignal(signal)
    .maybeSingle()

  if (error) queryError('product_catalog', error)
  return (data as CatalogProductRow | null) ?? null
}

// ─── the derived quality score ───────────────────────────────────────────────
//
// LABELLED AS DERIVED EVERYWHERE IT APPEARS, because the importer has a real
// scorer and this is not it. catalog-importer/src/score/ decides what to load,
// what to send to review and what to drop, using scan counts, brand presence,
// name language and market tier; its verdict lands in out/report.md and never
// reaches the database. Nothing in product_catalog records why a row was
// accepted.
//
// What IS in the database is how complete a row is, and completeness is a decent
// proxy for how well a row will serve a search: a product with a barcode can be
// scanned, one with a maker can be told apart from its namesakes, one with
// aliases can be found by category, and one with markets can be ranked for the
// right country. So this scores those, and says so.
export interface QualityBreakdown {
  score: number
  bands: { label: string; earned: number; possible: number; met: boolean }[]
}

export function qualityScore(row: Pick<
  CatalogProductRow,
  'barcode' | 'maker' | 'search_aliases' | 'markets' | 'base_weight'
>): QualityBreakdown {
  const bands = [
    { label: 'Scannable (has a barcode)', earned: row.barcode ? 30 : 0, possible: 30, met: Boolean(row.barcode) },
    { label: 'Attributed (has a maker)', earned: row.maker ? 20 : 0, possible: 20, met: Boolean(row.maker) },
    {
      label: 'Findable by category (has aliases)',
      earned: row.search_aliases ? 20 : 0,
      possible: 20,
      met: Boolean(row.search_aliases),
    },
    {
      label: 'Placed in a market',
      earned: row.markets?.length ? 15 : 0,
      possible: 15,
      met: Boolean(row.markets?.length),
    },
    {
      // The importer's cold-start weight, which is the only trace of its scorer
      // that survives into the row. Capped so a very popular product cannot make
      // up for having no barcode and no maker.
      label: 'Editorial weight',
      earned: Math.min(15, Math.round((row.base_weight ?? 0) / 10)),
      possible: 15,
      met: (row.base_weight ?? 0) > 0,
    },
  ]
  return { score: bands.reduce((sum, b) => sum + b.earned, 0), bands }
}

export function qualityLabel(score: number): 'strong' | 'fair' | 'thin' {
  if (score >= 70) return 'strong'
  if (score >= 40) return 'fair'
  return 'thin'
}

// ─── catalog-wide aggregates ─────────────────────────────────────────────────
//
// PostgREST has no GROUP BY, and adding an aggregate RPC would mean a schema
// change in the catalog-importer repo -- which owns that database and which this
// tool is only a client of. So the shape of the catalog is computed here, from
// one narrow projection of every row.
//
// That is affordable and measured rather than assumed: about 10,800 rows of six
// small columns is roughly 700KB over the wire, once, and the result is cached
// for the session. It would not be affordable at a million rows, and the note
// below says what to do then.
//
// If this ever gets slow: add `catalog_stats()` to the catalog project's
// 003_product_catalog.sql (a definer function returning the same shape), point
// loadCatalogShape() at it, and delete the paging loop. The type it returns is
// already the contract.
export interface CatalogShape {
  total: number
  /**
   * True when the paging loop hit its ceiling and stopped early.
   *
   * Everything else in this object is then computed from a PREFIX of the
   * catalog rather than from all of it: `total` undercounts, every coverage
   * ratio is measured against the wrong denominator, and a source whose rows
   * sort late is missing entirely. The numbers stay internally consistent,
   * which is exactly what makes them dangerous -- nothing about them looks
   * wrong.
   *
   * So this is not an internal detail. Every consumer renders it, because the
   * one thing this module must never do is present a partial answer as a
   * complete one.
   */
  truncated: boolean
  bySource: { source: string; rows: number; withBarcode: number; withMarkets: number }[]
  byVersion: {
    source: string
    version: string | null
    rows: number
    firstSeen: string
    lastSeen: string
    withBarcode: number
    withAliases: number
    withMarkets: number
  }[]
  byMarket: { market: string; rows: number }[]
  byCreatedDay: { day: string; rows: number }[]
  coverage: { withBarcode: number; withMaker: number; withAliases: number; withMarkets: number }
  popularity: { adopted: number; totalAddCount: number; topAddCount: number }
}


/** What a catalog nobody has imported into looks like. */
const EMPTY_SHAPE: CatalogShape = {
  total: 0,
  truncated: false,
  bySource: [],
  byVersion: [],
  byMarket: [],
  byCreatedDay: [],
  coverage: { withBarcode: 0, withMaker: 0, withAliases: 0, withMarkets: 0 },
  popularity: { adopted: 0, totalAddCount: 0, topAddCount: 0 },
}

let shapeCache: Promise<CatalogShape> | null = null
let shapeBuild: AbortController | null = null

/**
 * The catalog's shape, computed once per session and shared.
 *
 * ─── WHY `force` IS A PARAMETER AND NOT A SEPARATE invalidate() CALL ─────────
 *
 * It used to be. `invalidateCatalogShape()` was exported beside this, and a
 * caller that wanted fresh numbers had to remember to call it FIRST and then
 * refetch. Two of the three callers did not, and the result was the worst
 * failure this codebase can have: Products and Search re-awaited the same
 * cached promise while PageHeader stamped a brand-new "as of" time beside
 * numbers that had not moved. A Refresh button that reports success and
 * changes nothing is a dashboard lying about when it last read the database.
 *
 * That was not three authors being careless. An API whose correct use is
 * "remember to call this other function first" produces divergence by default.
 * So the invalidation moved inside: there is one entry point, refreshing is an
 * argument to it, and there is no order left to get wrong.
 */
export function loadCatalogShape(force = false): Promise<CatalogShape> {
  if (shapeCache && !force) return shapeCache

  // A forced build makes the one in flight pointless, and pointless here is not
  // cheap: the loop below is SEQUENTIAL and bounded only by SHAPE_ROW_CEILING,
  // so an uncancelled predecessor can still be issuing requests minutes later.
  shapeBuild?.abort()
  const controller = new AbortController()
  shapeBuild = controller

  const promise = buildCatalogShape(controller.signal).catch((error): Promise<CatalogShape> => {
    // Superseded, not failed. Whoever was awaiting this asked for the catalog's
    // shape, not for this particular attempt at it, so hand them the build that
    // replaced this one rather than an abort they never asked about and cannot
    // act on.
    if (controller.signal.aborted && shapeCache && shapeCache !== promise) return shapeCache

    // A genuinely failed build must not be cached, or the section stays broken
    // until a reload even after the network comes back. Guarded on identity: by
    // the time this runs a newer forced load may already own the slot, and
    // clearing that one would discard a good result because an older attempt
    // failed.
    if (shapeCache === promise) shapeCache = null
    throw error
  })

  shapeCache = promise
  return promise
}

/** Refresh the aggregate. What every Refresh button on a catalog page calls. */
export function refreshCatalogShape(): Promise<CatalogShape> {
  return loadCatalogShape(true)
}

async function buildCatalogShape(signal: AbortSignal): Promise<CatalogShape> {
  const client = getCatalogSupabase()
  if (!client) throw new CatalogNotConfigured()

  // One call, and it reads a cached row rather than scanning the table.
  //
  // This used to page product_catalog a thousand rows at a time and tally the
  // result in the browser, which was the right call at 13,975 rows and became
  // 192 sequential requests at 191,394. The section header above named the fix
  // before there was anything to fix, and this is it: catalog_stats() in the
  // catalog project, returning this type.
  //
  // The database does not compute it on read either. These numbers only change
  // when an import runs, so catalog-importer refreshes them at the end of a
  // load and this reads the answer. 18.7 seconds became 0.19.
  const { data, error } = await client.rpc('catalog_stats').abortSignal(signal)
  if (error) queryError('catalog_stats', error)

  return (data ?? EMPTY_SHAPE) as CatalogShape
}

// ─── the app database's own rows ─────────────────────────────────────────────

export async function fetchLocalProducts(
  params: PageParams & { source?: string | null; scope?: 'all' | 'community' | 'promoted' },
  signal: AbortSignal,
): Promise<Page<LocalProductRow>> {
  const limit = params.limit ?? 25
  const offset = params.offset ?? 0

  const { data, error } = await getAppSupabase()
    .rpc('admin_local_products', {
      p_query: params.query?.trim() || null,
      p_source: params.source ?? null,
      p_scope: params.scope ?? 'all',
      p_limit: limit,
      p_offset: offset,
    })
    .abortSignal(signal)

  if (error) {
    queryError('admin_local_products', error)
  }

  const rows = (data ?? []) as LocalProductRow[]
  return { rows, total: rows[0]?.total_count ?? 0, offset }
}
