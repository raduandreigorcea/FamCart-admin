import { getCatalogSupabase } from '../supabase'
import { queryError } from './errors'
import type { Page, PageParams } from './types'

// The reference catalog: the rows the app searches, which belong to nobody and
// are shared LIVE by production and development at once.
//
// A separate Supabase project, in a separate organisation, with a schema that
// shares nothing with the app database but a folding rule. Its table is
// `catalog_products`; the app's is `product_catalog`; the two are not copies.
//
// WHAT CHANGED, AND WHY THE FILTERS LOOK DIFFERENT. The catalog used to be grown
// from Open Food Facts: a curated seed of generic concepts, names in six
// languages, quality tiers, and rows discovered live from three external food
// databases. It was rebuilt on 2026-09-04 around what real shops actually list,
// so `p_type`, `p_lang`, `p_tier` and `p_source` describe nothing that exists any
// more. What a product HAS now is retailers, listings, prices and a stock state,
// so that is what you can filter on.
//
// EVERYTHING HERE IS AN RPC, and that is not a style choice. 002_catalog.sql ends
// with `revoke all on public.catalog_products from anon, authenticated`, so there
// is no table access to fall back on even for a signed-in admin. The five
// functions in 006_admin.sql are the entire surface.
//
// A WRITE HERE IS HEAVIER THAN A WRITE TO THE APP DATABASE. Deleting removes the
// product for every household of both projects immediately, along with its
// barcodes and every retailer's listing of it, all of which cascade -- though
// unlike before, the next scrape will simply put it back, which is usually the
// right answer to "this row is wrong". The view says so at the point of asking.

/** Not configured is an ordinary state: the catalog credentials are optional. */
export class CatalogNotConfigured extends Error {
  constructor() {
    super('The catalog project is not configured.')
    this.name = 'CatalogNotConfigured'
  }
}

function client() {
  const supabase = getCatalogSupabase()
  if (!supabase) throw new CatalogNotConfigured()
  return supabase
}

export function catalogConfigured(): boolean {
  return getCatalogSupabase() !== null
}

/** Mirrors catalog_admin_products' return columns in 006_admin.sql. */
export interface CatalogProductRow {
  id: string
  canonical_name: string
  brand: string | null
  category: string | null
  /**
   * These three were declared here before the RPC returned them, which was not a
   * cosmetic gap: CatalogFormDialog fills its form from this row and submits
   * every field, so while they arrived undefined, correcting a product's name
   * cleared its size and its image.
   */
  quantity: number | null
  quantity_unit: string | null
  image_url: string | null
  /** Earned by real people adding the product. No import ever writes it. */
  add_count: number
  listing_count: number
  popularity: number
  /** Every shop currently carrying it. */
  retailers: string[]
  barcodes: string[]
  /** Cheapest price among the listings that are in stock, if any. */
  min_price: number | null
  currency: string | null
  /** True when at least one shop has it. */
  available: boolean
  /** The identity the dedupe rule actually uses. Shown so a merge is arguable. */
  merge_key: string
  first_seen_at: string
  total_count: number
}

/**
 * Every way the browse RPC can be narrowed, mapping one-to-one onto the RPC's
 * arguments.
 *
 * `null` MEANS "DO NOT ASK" throughout, including for the booleans, where it is
 * the third state: true selects the rows that have the thing, false selects the
 * rows that do not, and null selects both. A missing key and an explicit null
 * are the same thing on purpose, so a caller can build this object field by
 * field without having to know which filters it left out.
 *
 * `retailer` and `hasListing` are separate questions and neither can be spelled
 * as the other. Filtering by Auchan hides every product no shop carries; finding
 * THOSE -- a product created by hand, or one every shop has dropped -- is what
 * hasListing is for.
 */
export interface CatalogFilters {
  retailer?: string | null
  category?: string | null
  hasBarcode?: boolean | null
  hasBrand?: boolean | null
  hasImage?: boolean | null
  hasQuantity?: boolean | null
  hasListing?: boolean | null
  /** true: at least one shop has it in stock right now. */
  available?: boolean | null
  /** true: households have added it. false: no one has, whatever the shops say. */
  earned?: boolean | null
  /**
   * A window rather than an instant, and resolved to a timestamp at request
   * time rather than when the filter was chosen. "Added in the last 7 days"
   * means seven days before this question, not seven days before the click that
   * asked it -- a dashboard left open overnight would otherwise quietly go on
   * answering yesterday's question.
   */
  addedWithinDays?: number | null
}

/** Which filters are actually set, for the count on the Filters button. */
export function activeFilterCount(filters: CatalogFilters): number {
  return Object.values(filters).filter((v) => v !== null && v !== undefined).length
}

export async function fetchCatalogProducts(
  params: PageParams & CatalogFilters,
  signal: AbortSignal,
): Promise<Page<CatalogProductRow>> {
  const limit = params.limit ?? 25
  const offset = params.offset ?? 0

  // Every argument is named and every one is sent, including the nulls. The
  // catalog is a separate repository and PostgREST resolves an RPC by the
  // argument names in the body, so this object IS the contract -- there is
  // nothing on either side that would notice a rename. catalogAdmin.test.ts
  // pins the names for that reason.
  const { data, error } = await client()
    .rpc('catalog_admin_products', {
      p_query: params.query?.trim() || null,
      p_retailer: params.retailer ?? null,
      p_category: params.category ?? null,
      p_has_barcode: params.hasBarcode ?? null,
      p_has_brand: params.hasBrand ?? null,
      p_has_image: params.hasImage ?? null,
      p_has_quantity: params.hasQuantity ?? null,
      p_has_listing: params.hasListing ?? null,
      p_available: params.available ?? null,
      p_earned: params.earned ?? null,
      p_added_since:
        params.addedWithinDays != null
          ? new Date(Date.now() - params.addedWithinDays * 86_400_000).toISOString()
          : null,
      p_limit: limit,
      p_offset: offset,
    })
    .abortSignal(signal)

  if (error) queryError('catalog_admin_products', error)

  const rows = (data ?? []) as CatalogProductRow[]
  return { rows, total: rows[0]?.total_count ?? 0, offset }
}

export interface CatalogDraft {
  name: string
  brand?: string | null
  category?: string | null
  quantity?: number | null
  quantityUnit?: string | null
  barcode?: string | null
  imageUrl?: string | null
}

/**
 * Create a product by hand.
 *
 * It arrives with NO LISTING, which means no shop is selling it. That is a
 * legitimate thing to want -- correcting a name before a scrape catches up, or
 * holding a product the scrapers cannot see -- and it also means it will never
 * be swept, because a sweep only ever touches listings.
 */
export async function createCatalogProduct(
  draft: CatalogDraft,
  signal: AbortSignal,
): Promise<string> {
  const { data, error } = await client()
    .rpc('catalog_admin_create_product', {
      p_name: draft.name,
      p_brand: draft.brand ?? null,
      p_category: draft.category ?? null,
      p_quantity: draft.quantity ?? null,
      p_quantity_unit: draft.quantityUnit ?? null,
      p_barcode: draft.barcode ?? null,
      p_image_url: draft.imageUrl ?? null,
    })
    .abortSignal(signal)

  if (error) queryError('catalog_admin_create_product', error)
  return data as string
}

/**
 * Correct a reference product, every editable column of it.
 *
 * ONE CONVENTION, matching the RPC: `null` leaves a column exactly as it is, an
 * empty string clears it, anything else sets it. That is why these are `?? null`
 * rather than `?? ''` -- a caller that does not mention the barcode must not be
 * able to remove one, and the difference between "not mentioned" and "emptied on
 * purpose" is the whole reason the barcode is safe to offer here at all.
 *
 * The form sends every field on every save, so it says what it means: a cleared
 * input arrives as '' and clears the column.
 *
 * A CORRECTION IS NOT PERMANENT. The next scrape will not undo it -- an import
 * fills blanks but never renames or re-brands a product that already has one --
 * but it will keep the retailer's own wording on the listing, which is what
 * search also matches against.
 */
export async function updateCatalogProduct(
  id: string,
  draft: CatalogDraft,
  signal: AbortSignal,
): Promise<void> {
  const { error } = await client()
    .rpc('catalog_admin_update_product', {
      p_id: id,
      p_name: draft.name,
      p_brand: draft.brand ?? null,
      p_category: draft.category ?? null,
      p_quantity: draft.quantity ?? null,
      p_quantity_unit: draft.quantityUnit ?? null,
      p_image_url: draft.imageUrl ?? null,
      p_barcode: draft.barcode ?? null,
    })
    .abortSignal(signal)

  if (error) queryError('catalog_admin_update_product', error)
}

/** Idempotent server-side: a second click is not an error. */
export async function deleteCatalogProduct(id: string, signal: AbortSignal): Promise<void> {
  const { error } = await client()
    .rpc('catalog_admin_delete_product', { p_id: id })
    .abortSignal(signal)

  if (error) queryError('catalog_admin_delete_product', error)
}

/** One retailer's scrape health, from catalog_stats(). */
export interface RetailerHealth {
  slug: string
  country: string
  enabled: boolean
  listings: number
  available: number
  last_run: {
    status: 'running' | 'completed' | 'partial' | 'failed'
    started_at: string
    finished_at: string | null
    products_found: number
    products_valid: number
    products_rejected: number
    inserted: number
    updated: number
    unchanged: number
    marked_unavailable: number
    error_count: number
    error: string | null
  } | null
  previous_valid: number | null
  /** This run's valid count against the last completed one's. */
  delta: number | null
}

export interface CatalogStats {
  products: number
  listings: number
  unavailable: number
  identifiers: number
  with_barcode: number
  with_price: number
  earned: number
  /** Products no shop currently lists: created by hand, or dropped everywhere. */
  orphans: number
  retailers: RetailerHealth[]
}

/**
 * The catalog's health, and specifically the alarm for the failure that reports
 * nothing.
 *
 * A scraper can rot without erroring: a shop changes its markup or its API, the
 * scraper keeps completing, and the numbers quietly fall. `delta` is this run's
 * valid count against the last completed one's, and a run that refused to sweep
 * says why in `last_run.error`. That is the difference between noticing in a day
 * and noticing when somebody complains that search got worse.
 */
export async function fetchCatalogStats(signal: AbortSignal): Promise<CatalogStats> {
  const { data, error } = await client().rpc('catalog_stats').abortSignal(signal)
  if (error) queryError('catalog_stats', error)
  return data as CatalogStats
}
