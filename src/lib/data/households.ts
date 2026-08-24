import { getAppSupabase } from '../supabase'
import { sortGuard } from './types'
import type { AdminHouseholdRow, Page, PageParams } from './types'
import { queryError } from './errors'

export const HOUSEHOLD_SORTS = [
  'name',
  'members',
  'items_open',
  'purchases',
  'created_at',
  'last_active',
] as const

export type HouseholdSort = (typeof HOUSEHOLD_SORTS)[number]

export interface HouseholdDetail {
  household: {
    id: string
    name: string
    emoji: string | null
    invite_code: string
    created_by: string
    owner_name: string | null
    max_items_per_member: number
    created_at: string
    members: number
    moderators: number
    items_total: number
    items_open: number
    purchases: number
    checkouts: number
    products_added: number
    last_active: string
  }
  members: {
    user_id: string
    display_name: string | null
    image_url: string | null
    role: string
    is_owner: boolean
    joined_at: string
    items_open: number
    items_added: number
    purchases: number
  }[]
  list: {
    id: string
    name: string
    maker: string | null
    quantity: number
    checked: boolean
    checked_at: string | null
    added_by: string
    added_by_name: string | null
    created_at: string
  }[]
  top_products: {
    name: string
    maker: string | null
    times: number
    quantity: number
    last_bought: string
  }[]
  contributed_products: {
    id: string
    name: string
    maker: string | null
    barcode: string | null
    add_count: number
    created_at: string
    contributed_by: string | null
  }[]
  recent_checkouts: {
    checkout_id: string
    purchased_at: string
    purchased_by: string
    purchased_by_name: string | null
    items: number
    quantity: number
  }[]
}

export const isHouseholdSort = sortGuard(HOUSEHOLD_SORTS)

export async function fetchHouseholds(
  params: PageParams<HouseholdSort>,
  signal: AbortSignal,
): Promise<Page<AdminHouseholdRow>> {
  const limit = params.limit ?? 25
  const offset = params.offset ?? 0

  const { data, error } = await getAppSupabase()
    .rpc('admin_list_households', {
      p_query: params.query?.trim() || null,
      p_sort: params.sort ?? 'last_active',
      p_dir: params.dir ?? 'desc',
      p_limit: limit,
      p_offset: offset,
    })
    .abortSignal(signal)

  if (error) {
    queryError('admin_list_households', error)
  }

  const rows = (data ?? []) as AdminHouseholdRow[]
  return { rows, total: rows[0]?.total_count ?? 0, offset }
}

export async function fetchHouseholdDetail(
  householdId: string,
  signal: AbortSignal,
): Promise<HouseholdDetail | null> {
  const { data, error } = await getAppSupabase()
    .rpc('admin_household_detail', { p_household_id: householdId })
    .abortSignal(signal)

  if (error) {
    queryError('admin_household_detail', error)
  }
  return (data as HouseholdDetail | null) ?? null
}

// ─── deletion, which is a flag and not a delete ──────────────────────────────
//
// The RPCs behind these set households.deleted_at and everything inside the
// household disappears through active_household_ids() in the database. Nothing
// is removed, which is what makes the Trash view honest rather than decorative.

/** One row of the Trash view. */
export interface DeletedHouseholdRow {
  id: string
  name: string
  emoji: string | null
  deleted_at: string
  /** Still inside it. The number that answers "is this safe to leave deleted?" */
  members: number
  items_total: number
}

export async function deleteHousehold(id: string, signal: AbortSignal): Promise<void> {
  const { error } = await getAppSupabase()
    .rpc('admin_delete_household', { p_id: id })
    .abortSignal(signal)
  if (error) queryError('admin_delete_household', error)
}

export async function restoreHousehold(id: string, signal: AbortSignal): Promise<void> {
  const { error } = await getAppSupabase()
    .rpc('admin_restore_household', { p_id: id })
    .abortSignal(signal)
  if (error) queryError('admin_restore_household', error)
}

export async function fetchDeletedHouseholds(signal: AbortSignal): Promise<DeletedHouseholdRow[]> {
  const { data, error } = await getAppSupabase()
    .rpc('admin_deleted_households')
    .abortSignal(signal)
  if (error) queryError('admin_deleted_households', error)
  return (data ?? []) as DeletedHouseholdRow[]
}
