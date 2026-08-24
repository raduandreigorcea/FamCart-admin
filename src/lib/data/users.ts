import { getAppSupabase } from '../supabase'
import { sortGuard } from './types'
import type { AdminUserRow, Page, PageParams } from './types'
import { queryError } from './errors'

// The user list and one user's detail. Both come from admin_user_facts() in
// 008_admin.sql, so the numbers on the list and the numbers on the detail page
// are the same numbers rather than two queries that agree by coincidence.

export interface UserDetail {
  profile: {
    user_id: string
    display_name: string
    image_url: string | null
    profile_updated_at: string
    households: number
    owned_households: number
    moderator_of: number
    items_added: number
    items_open: number
    purchases: number
    checkouts: number
    products_added: number
    first_seen: string
    last_active: string
  }
  is_admin: boolean
  households: {
    id: string
    name: string
    emoji: string | null
    role: string
    is_owner: boolean
    joined_at: string
    members: number
    items_open: number
  }[]
  top_products: {
    name: string
    maker: string | null
    times: number
    quantity: number
    last_bought: string
  }[]
  recent_events: {
    created_at: string
    kind: string
    household_id: string | null
    detail: Record<string, unknown>
  }[]
}

/** Columns the list may be sorted by. Mirrors the CASE arms in admin_list_users. */
export const USER_SORTS = [
  'display_name',
  'households',
  'items_added',
  'purchases',
  'first_seen',
  'last_active',
] as const

export type UserSort = (typeof USER_SORTS)[number]

export const isUserSort = sortGuard(USER_SORTS)

export async function fetchUsers(
  params: PageParams<UserSort>,
  signal: AbortSignal,
): Promise<Page<AdminUserRow>> {
  const limit = params.limit ?? 25
  const offset = params.offset ?? 0

  const { data, error } = await getAppSupabase()
    .rpc('admin_list_users', {
      p_query: params.query?.trim() || null,
      p_sort: params.sort ?? 'last_active',
      p_dir: params.dir ?? 'desc',
      p_limit: limit,
      p_offset: offset,
    })
    .abortSignal(signal)

  if (error) queryError('admin_list_users', error)

  const rows = (data ?? []) as AdminUserRow[]
  // total_count rides on every row (a window function computed before the
  // limit), so an empty page means zero matches rather than an unknown total.
  return { rows, total: rows[0]?.total_count ?? 0, offset }
}

export async function fetchUserDetail(
  userId: string,
  signal: AbortSignal,
): Promise<UserDetail | null> {
  const { data, error } = await getAppSupabase()
    .rpc('admin_user_detail', { p_user_id: userId })
    .abortSignal(signal)

  if (error) queryError('admin_user_detail', error)
  // The RPC returns null for an id with no profile row, which the view renders
  // as a not-found state rather than an error.
  return (data as UserDetail | null) ?? null
}

// ─── the admin roster ────────────────────────────────────────────────────────

export interface AdminRow {
  user_id: string
  display_name: string | null
  image_url: string | null
  note: string | null
  granted_by: string | null
  granted_by_name: string | null
  granted_at: string
  is_self: boolean
}

export async function fetchAdmins(signal: AbortSignal): Promise<AdminRow[]> {
  const { data, error } = await getAppSupabase().rpc('admin_list_admins').abortSignal(signal)
  if (error) queryError('admin_list_admins', error)
  return (data ?? []) as AdminRow[]
}

/**
 * Grant and revoke: the only two writes this dashboard can make.
 *
 * No abort signal on either. Aborting a mutation does not un-apply it, it only
 * throws away the confirmation, which is how an interface ends up disagreeing
 * with the database it is describing.
 */
export async function grantAdmin(userId: string, note: string | null): Promise<void> {
  const { error } = await getAppSupabase().rpc('admin_grant', {
    p_user_id: userId,
    p_note: note?.trim() || null,
  })
  if (error) queryError('admin_grant', error)
}

export async function revokeAdmin(userId: string): Promise<void> {
  const { error } = await getAppSupabase().rpc('admin_revoke', { p_user_id: userId })
  if (error) queryError('admin_revoke', error)
}

/** Whether the signed-in account may use this tool at all. */
export async function fetchIsAdmin(): Promise<boolean> {
  const { data, error } = await getAppSupabase().rpc('is_admin')
  if (error) queryError('is_admin', error)
  return data === true
}
