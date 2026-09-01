import { getAppSupabase } from '../supabase'
import { queryError } from './errors'
import type { LocalProductRow, Page, PageParams } from './types'

// Products a household typed for itself, and the ones promoted out of them.
//
// This is the app database's own `product_catalog`, and it is the only product
// table this dashboard reads. The reference catalog is a separate Supabase
// project with a schema of its own and no admin surface here; the four tabs that
// used to read it were removed because none of their RPCs survived that project
// being rebuilt.
//
// WHY THIS IS WORTH A PAGE. Every row here started as free text somebody typed
// into the add box. Once three distinct households in three distinct accounts
// ask for the same thing, promote_product_from_scoped() in 006_product_catalog
// collapses their scoped rows into one GLOBAL row and deletes the originals in
// the same statement -- so a name one person invented becomes a suggestion
// everybody sees. That is the only path in FamCart by which user-authored text
// reaches other households, which makes this table the place you look when
// something needs to be caught.
//
// The RPC carries the contributor and the household precisely so that a bad row
// can be traced back to an account worth banning, rather than only deleted.

/** Which rows to show: everything, household-scoped only, or promoted only. */
export type ContributedScope = 'all' | 'community' | 'promoted'

export async function fetchContributedProducts(
  params: PageParams & { scope?: ContributedScope },
  signal: AbortSignal,
): Promise<Page<LocalProductRow>> {
  const limit = params.limit ?? 25
  const offset = params.offset ?? 0

  const { data, error } = await getAppSupabase()
    .rpc('admin_local_products', {
      p_query: params.query?.trim() || null,
      // The RPC still takes p_source; nothing here filters on it, because every
      // row in this table has source 'community' or 'promoted' and the scope
      // control already says which.
      p_source: null,
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

// ─── writing ─────────────────────────────────────────────────────────────────
// All three go through RPCs added in 010_admin_product_writes.sql rather than
// touching the table, because product_catalog has one RLS policy and it is a
// SELECT: there is no client write path and there should not be one. The RPCs
// also compute search_text, which a client cannot -- product_search_text() has
// its EXECUTE revoked from `authenticated` so that nobody outside the database
// can work out the merge key and craft a name that collides with an existing
// product.
//
// Thin wrappers, so what matters is the argument NAMES: PostgREST resolves an
// RPC by name, and a rename in the SQL with a stale name here is a 404 that
// mentions neither side.

export interface ProductDraft {
  name: string
  maker?: string | null
  barcode?: string | null
  baseWeight?: number | null
}

/** Add a global curated product. Returns its id. */
export async function createProduct(draft: ProductDraft, signal: AbortSignal): Promise<string> {
  const { data, error } = await getAppSupabase()
    .rpc('admin_create_product', {
      p_name: draft.name,
      p_maker: draft.maker ?? null,
      p_barcode: draft.barcode ?? null,
      p_base_weight: draft.baseWeight ?? 0,
    })
    .abortSignal(signal)

  if (error) queryError('admin_create_product', error)
  return data as string
}

/**
 * Correct a product in place, scoped or global.
 *
 * A null baseWeight means "leave it alone" rather than "set it to zero", which
 * is the RPC's own reading of the argument: the edit form does not offer the
 * knob for a household's own row, and sending 0 there would quietly erase an
 * editorial weight somebody set deliberately.
 */
export async function updateProduct(
  id: string,
  draft: ProductDraft,
  signal: AbortSignal,
): Promise<void> {
  const { error } = await getAppSupabase()
    .rpc('admin_update_product', {
      p_id: id,
      p_name: draft.name,
      p_maker: draft.maker ?? null,
      p_barcode: draft.barcode ?? null,
      p_base_weight: draft.baseWeight ?? null,
    })
    .abortSignal(signal)

  if (error) queryError('admin_update_product', error)
}

/** Remove a product. Idempotent server-side: a second click is not an error. */
export async function deleteProduct(id: string, signal: AbortSignal): Promise<void> {
  const { error } = await getAppSupabase()
    .rpc('admin_delete_product', { p_id: id })
    .abortSignal(signal)

  if (error) queryError('admin_delete_product', error)
}
