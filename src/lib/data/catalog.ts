import { getCatalogSupabase } from '../supabase'
import { queryError } from './errors'
import type { Page, PageParams } from './types'

// The reference catalog: the rows the app ships and discovers, which belong to
// nobody and are shared LIVE by production and development at once.
//
// A separate Supabase project, in a separate organisation, with a schema that
// shares nothing with the app database but a rule. Its table is
// `catalog_products`; the app's is `product_catalog`; the two are not copies and
// no longer even read alike, which was the point of renaming one in the rebuild.
//
// EVERYTHING HERE IS AN RPC, and that is not a style choice. 002_products.sql
// ends with `revoke all on public.catalog_products from anon, authenticated`, so
// there is no table access to fall back on even for a signed-in admin. The four
// functions in the catalog's 009_admin.sql are the entire surface.
//
// A WRITE HERE IS HEAVIER THAN A WRITE TO THE APP DATABASE. Deleting removes the
// product for every household of both projects immediately, along with its
// aliases in six languages, its barcodes and its provenance, all of which
// cascade. The view says so at the point of asking.

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

export type CatalogProductType = 'generic' | 'commercial'

/** Mirrors catalog_admin_products' return columns in 009_admin.sql. */
export interface CatalogProductRow {
  id: string
  product_type: CatalogProductType
  canonical_name: string
  name_lang: string
  brand: string | null
  category: string | null
  markets: string[]
  quality_tier: string
  /**
   * These three were declared here before the RPC returned them, which was not a
   * cosmetic gap: CatalogFormDialog fills its form from this row and submits
   * every field, so while they arrived undefined, correcting a product's name
   * cleared its size and its image.
   */
  quantity: number | null
  quantity_unit: string | null
  image_url: string | null
  base_weight: number
  add_count: number
  popularity: number
  source_count: number
  /** Every provenance this row carries. 'admin' is one written from here. */
  sources: string[]
  barcodes: string[]
  alias_count: number
  created_at: string
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
 * `market` and `hasMarket` are separate questions and neither can be spelled as
 * the other. A product's markets may be empty, which means nobody recorded where
 * it is sold rather than that it is sold nowhere -- so filtering by RO hides
 * every unplaced row, and finding those rows is what hasMarket is for.
 */
export interface CatalogFilters {
  type?: CatalogProductType | null
  market?: string | null
  tier?: string | null
  category?: string | null
  source?: string | null
  lang?: string | null
  hasBarcode?: boolean | null
  hasBrand?: boolean | null
  hasImage?: boolean | null
  hasQuantity?: boolean | null
  hasMarket?: boolean | null
  /** true: households have added it. false: editorial weight and nothing else. */
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
      p_type: params.type ?? null,
      p_market: params.market ?? null,
      p_tier: params.tier ?? null,
      p_category: params.category ?? null,
      p_source: params.source ?? null,
      p_lang: params.lang ?? null,
      p_has_barcode: params.hasBarcode ?? null,
      p_has_brand: params.hasBrand ?? null,
      p_has_image: params.hasImage ?? null,
      p_has_quantity: params.hasQuantity ?? null,
      p_has_market: params.hasMarket ?? null,
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
  type: CatalogProductType
  lang: string
  brand?: string | null
  category?: string | null
  markets?: string[]
  barcode?: string | null
  baseWeight?: number | null
  quantity?: number | null
  quantityUnit?: string | null
  imageUrl?: string | null
  qualityTier?: string | null
}

export async function createCatalogProduct(
  draft: CatalogDraft,
  signal: AbortSignal,
): Promise<string> {
  const { data, error } = await client()
    .rpc('catalog_admin_create_product', {
      p_name: draft.name,
      p_type: draft.type,
      p_lang: draft.lang,
      p_brand: draft.brand ?? null,
      p_category: draft.category ?? null,
      p_markets: draft.markets ?? [],
      p_barcode: draft.barcode ?? null,
      p_base_weight: draft.baseWeight ?? 0,
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
      p_type: draft.type,
      p_lang: draft.lang,
      p_brand: draft.brand ?? null,
      p_category: draft.category ?? null,
      p_markets: draft.markets ?? null,
      p_base_weight: draft.baseWeight ?? null,
      p_barcode: draft.barcode ?? null,
      p_quantity: draft.quantity ?? null,
      p_quantity_unit: draft.quantityUnit ?? null,
      p_image_url: draft.imageUrl ?? null,
      p_quality_tier: draft.qualityTier ?? null,
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
