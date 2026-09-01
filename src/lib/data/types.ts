// Shared shapes for the data layer, and the one convention that matters most in
// this codebase: how a metric says it does not exist yet.
//
// ─── WHY `Unavailable` IS A TYPE AND NOT A NULL ──────────────────────────────
//
// Two sections of this dashboard ask for numbers FamCart does not currently
// record. Search Analytics wants query strings, zero-result rates and
// autocomplete latency; nothing logs a search, because search_catalog() is a
// pure read that returns rows and writes nothing. Product Pipeline wants records
// processed, duplicates, rejects and errors per run; import_catalog_products()
// computes exactly those and returns them to the CLI, which prints them to
// out/load-plan.json on the operator's disk and forgets them.
//
// The tempting answers are both wrong. Inventing plausible numbers makes the
// dashboard a liar. Returning null makes it indistinguishable from a genuine
// zero, which is worse than either, because "no failed searches" and "we do not
// know about searches" look identical and only one of them is good news.
//
// So a metric that cannot be answered says so in its type, carries the reason in
// the payload, and renders as a specific empty state naming what would have to
// change. When the recording is added, the provider swaps to `available: true`
// and every consumer already handles it.

export interface Unavailable {
  available: false
  /** One sentence: what is missing. Shown as the empty state's body. */
  reason: string
  /** What would have to be built. Shown as the empty state's footnote. */
  wouldRequire: string
}

export interface Available<T> {
  available: true
  value: T
}

export type Metric<T> = Available<T> | Unavailable

export function available<T>(value: T): Available<T> {
  return { available: true, value }
}

export function unavailable(reason: string, wouldRequire: string): Unavailable {
  return { available: false, reason, wouldRequire }
}

/** Every paginated list answers the same three questions. */
export interface Page<T> {
  rows: T[]
  total: number
  offset: number
}

export interface PageParams<Sort extends string = string> {
  query?: string | null
  sort?: Sort
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/**
 * A type guard for a list's sort keys, built from the const array that already
 * mirrors the RPC's CASE arms.
 *
 * Those arrays -- USER_SORTS, HOUSEHOLD_SORTS, CATALOG_SORTS -- existed with a
 * comment saying exactly which server-side contract they mirror, and then went
 * unused: every view declared `ref('last_active')`, TypeScript inferred
 * `string`, and PageParams.sort was `string` too. The guard rail was built and
 * nothing was standing on it, so a mistyped key compiled cleanly and failed at
 * runtime as a PostgREST 400 with no clue which column was wrong.
 *
 * This closes both halves. The predicate narrows at the one place an untyped
 * string enters -- a click on a table header -- so a key the RPC does not
 * accept is rejected in the browser instead of at the database, and everything
 * downstream of it is a checked union.
 */
export function sortGuard<Sort extends string>(
  allowed: readonly Sort[],
): (key: string) => key is Sort {
  return (key: string): key is Sort => (allowed as readonly string[]).includes(key)
}

// ─── row shapes, mirroring the RPC return columns in 008_admin.sql ───────────

export interface AdminUserRow {
  user_id: string
  display_name: string
  image_url: string | null
  households: number
  owned_households: number
  moderator_of: number
  items_added: number
  items_open: number
  purchases: number
  products_added: number
  first_seen: string
  last_active: string
  is_admin: boolean
  total_count: number
}

export interface AdminHouseholdRow {
  id: string
  name: string
  emoji: string | null
  invite_code: string
  created_by: string
  owner_name: string | null
  owner_image_url: string | null
  created_at: string
  members: number
  moderators: number
  items_total: number
  items_open: number
  purchases: number
  checkouts: number
  products_added: number
  last_active: string
  total_count: number
}

export interface AdminEventRow {
  id: number
  created_at: string
  kind: string
  actor: string | null
  actor_name: string | null
  actor_image_url: string | null
  household_id: string | null
  household_name: string | null
  detail: Record<string, unknown>
  total_count: number
}

export interface ActivityBucket {
  bucket: string
  new_households: number
  members_joined: number
  items_added: number
  items_checked: number
  purchases: number
  checkouts: number
  active_users: number
}

export interface RecentActivityRow {
  kind: string
  occurred_at: string
  actor: string | null
  actor_name: string | null
  actor_image_url: string | null
  household_id: string | null
  household_name: string | null
  subject: string | null
  detail: Record<string, unknown>
}

export interface OverviewTotals {
  users: number
  households: number
  memberships: number
  list_items: number
  list_items_open: number
  purchases: number
  checkouts: number
  local_products: number
  community_products: number
  promoted_products: number
  security_events: number
}

export interface OverviewWindow {
  new_users: number
  active_users: number
  new_households: number
  members_joined: number
  items_added: number
  items_checked: number
  purchases: number
  checkouts: number
  products_added: number
  security_events: number
}

export interface OverviewPayload {
  generated_at: string
  since: string
  totals: OverviewTotals
  window: OverviewWindow
  distribution: {
    household_sizes: { members: number; households: number }[]
    members_per_user: { households: number; users: number }[]
  }
}

/** A row of the catalog project's product_catalog. */
export interface CatalogProductRow {
  id: string
  name: string
  maker: string | null
  barcode: string | null
  search_aliases: string | null
  markets: string[]
  base_weight: number
  add_count: number
  popularity: number
  source: string
  source_ref: string | null
  source_version: string | null
  created_at: string
}

/** A row of the APP database's product_catalog, which is a different table. */
export interface LocalProductRow {
  id: string
  name: string
  maker: string | null
  barcode: string | null
  source: string
  source_version: string | null
  household_id: string | null
  household_name: string | null
  contributed_by: string | null
  contributor_name: string | null
  contributor_image_url: string | null
  base_weight: number
  add_count: number
  popularity: number
  created_at: string
  total_count: number
}
