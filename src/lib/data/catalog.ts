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

export async function fetchCatalogProducts(
  params: PageParams & { type?: CatalogProductType | null },
  signal: AbortSignal,
): Promise<Page<CatalogProductRow>> {
  const limit = params.limit ?? 25
  const offset = params.offset ?? 0

  const { data, error } = await client()
    .rpc('catalog_admin_products', {
      p_query: params.query?.trim() || null,
      p_type: params.type ?? null,
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
 * Correct a reference product.
 *
 * A null `markets` means "leave them alone" rather than "clear them", matching
 * the RPC. The two readings are both plausible and only one is right: markets
 * are a relevance signal the ranking leans on, and quietly emptying them on an
 * unrelated rename would demote the product everywhere at once.
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
