import { getAppSupabase } from '../supabase'
import { sortGuard } from './types'
import type { AdminListRow, Page, PageParams } from './types'
import { queryError } from './errors'

export const LIST_SORTS = [
  'name',
  'members',
  'items_open',
  'purchases',
  'created_at',
  'last_active',
] as const

export type ListSort = (typeof LIST_SORTS)[number]

export interface ListDetail {
  list: {
    id: string
    name: string
    emoji: string | null
    invite_code: string
    created_by: string
    owner_name: string | null
    owner_image_url: string | null
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
    /** Set means an admin withdrew it. It still opens; see admin_list_facts. */
    deleted_at: string | null
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
  // The items on the list. This key was `list` while the entity was called a
  // household; after the rename that collided with the `list` key above, and
  // jsonb keeps the last duplicate, so the list object it overwrote silently
  // vanished. 008_admin.sql moved this key to `items` to fix it.
  items: {
    id: string
    name: string
    maker: string | null
    quantity: number
    checked: boolean
    checked_at: string | null
    added_by: string
    added_by_name: string | null
    added_by_image_url: string | null
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
    contributed_by_name: string | null
    contributed_by_image_url: string | null
  }[]
  recent_checkouts: {
    checkout_id: string
    purchased_at: string
    purchased_by: string
    purchased_by_name: string | null
    purchased_by_image_url: string | null
    items: number
    quantity: number
  }[]
}

export const isListSort = sortGuard(LIST_SORTS)

export async function fetchLists(
  params: PageParams<ListSort>,
  signal: AbortSignal,
): Promise<Page<AdminListRow>> {
  const limit = params.limit ?? 25
  const offset = params.offset ?? 0

  const { data, error } = await getAppSupabase()
    .rpc('admin_lists', {
      p_query: params.query?.trim() || null,
      p_sort: params.sort ?? 'last_active',
      p_dir: params.dir ?? 'desc',
      p_limit: limit,
      p_offset: offset,
    })
    .abortSignal(signal)

  if (error) {
    queryError('admin_lists', error)
  }

  const rows = (data ?? []) as AdminListRow[]
  return { rows, total: rows[0]?.total_count ?? 0, offset }
}

export async function fetchListDetail(
  listId: string,
  signal: AbortSignal,
): Promise<ListDetail | null> {
  const { data, error } = await getAppSupabase()
    .rpc('admin_list_detail', { p_list_id: listId })
    .abortSignal(signal)

  if (error) {
    queryError('admin_list_detail', error)
  }
  return (data as ListDetail | null) ?? null
}

// ─── deletion, which is a flag and not a delete ──────────────────────────────
//
// The RPCs behind these set lists.deleted_at and everything inside the
// list disappears through active_list_ids() in the database. Nothing
// is removed, which is what makes the Bans view honest rather than decorative.

/** One row of the Bans view's withdrawn-lists table. */
export interface DeletedListRow {
  id: string
  name: string
  emoji: string | null
  deleted_at: string
  /** Still inside it. The number that answers "is this safe to leave deleted?" */
  members: number
  items_total: number
}

export async function deleteList(id: string, signal: AbortSignal): Promise<void> {
  const { error } = await getAppSupabase()
    .rpc('admin_delete_list', { p_id: id })
    .abortSignal(signal)
  if (error) queryError('admin_delete_list', error)
}

export async function restoreList(id: string, signal: AbortSignal): Promise<void> {
  const { error } = await getAppSupabase()
    .rpc('admin_restore_list', { p_id: id })
    .abortSignal(signal)
  if (error) queryError('admin_restore_list', error)
}

export async function fetchDeletedLists(signal: AbortSignal): Promise<DeletedListRow[]> {
  const { data, error } = await getAppSupabase()
    .rpc('admin_deleted_lists')
    .abortSignal(signal)
  if (error) queryError('admin_deleted_lists', error)
  return (data ?? []) as DeletedListRow[]
}
