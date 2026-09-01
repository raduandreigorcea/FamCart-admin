import { getCatalogSupabase } from '../supabase'
import { queryError } from './errors'
import { CatalogNotConfigured } from './products'
import type { Page, PageParams } from './types'

// Deciding the review band.
//
// The importer's gate is hybrid: the clearly-good load themselves, the
// clearly-bad are dropped with a reason, and the ambiguous middle waits for a
// human. Last run that middle was 12,255 records, and the only way to rule on
// one was appending a line of JSON to a file on the operator's machine.
//
// The candidates were already in the database -- score publishes every record it
// did not write to catalog_import_outcomes, stage='review' among them. What was
// missing is a place to put the answer. These are the calls that make it a
// screen.
//
// ─── WHY THESE ARE RPCs AND outcomes.ts IS NOT ───────────────────────────────
//
// The browser next door reads catalog_import_outcomes with a PostgREST select
// and builds its filters client-side. That is right there and wrong here, for
// two reasons that are not style:
//
//   * Pending is an ANTI-JOIN: in the band, and not yet decided. Subtracting
//     decided barcodes in the browser makes the total count wrong, and therefore
//     every page after the first.
//   * The same barcode recurs across runs. The RPC does distinct on (barcode)
//     with the newest run winning; without it you are asked about the same
//     product every month, which is the exact failure the importer's
//     barcode-keyed verdicts exist to prevent.
//
// And the writes need a guard. This project's `authenticated` role is every
// FamCart account with the app installed -- product_catalog is readable by all
// of them on purpose -- so catalog_admins and catalog_admin_guard() in
// 005_review.sql are what stand between a signed-in phone and the contents of
// the catalog. The gate is there, not here.

export interface ReviewCandidate {
  barcode: string
  name: string | null
  maker: string | null
  score: number | null
  reason: string
  flags: string[]
  signals: Record<string, unknown>
  run_id: string
}

export interface ReviewDecision {
  barcode: string
  verdict: Verdict
  decided_by: string | null
  decided_at: string
  note: string | null
  /**
   * Null when the outcome rows that prompted this verdict have been pruned.
   * Retention keeps five runs per source; a verdict is kept forever, so a
   * decision outliving its evidence is normal rather than a fault.
   */
  name: string | null
  maker: string | null
  score: number | null
  reason: string | null
  flags: string[] | null
  signals: Record<string, unknown>
}

export type Verdict = 'approve' | 'reject'

export interface ReviewFilters {
  runId?: string | null
  reason?: string | null
  query?: string | null
}

export interface DecisionFilters {
  verdict?: Verdict | null
  query?: string | null
}

const DEFAULT_LIMIT = 25

/**
 * An absent filter is null, never ''.
 *
 * The RPCs read null as "no filter" and '' as a search for the empty string,
 * which every name matches. That is a filter wrong in the direction of silently
 * doing nothing, which is the hardest kind to notice on screen.
 */
const nullIfBlank = (value: string | null | undefined): string | null => {
  const text = value?.trim()
  return text ? text : null
}

/** Filters as list_review_candidates and approve_review_above both want them. */
export function reviewRpcArgs(filters: ReviewFilters, params: PageParams) {
  return {
    p_run: nullIfBlank(filters.runId),
    p_reason: nullIfBlank(filters.reason),
    p_query: nullIfBlank(filters.query),
    p_limit: params.limit ?? DEFAULT_LIMIT,
    p_offset: params.offset ?? 0,
  }
}

/** Filters as list_review_decisions wants them. */
export function decisionRpcArgs(filters: DecisionFilters, params: PageParams) {
  return {
    p_verdict: nullIfBlank(filters.verdict),
    p_query: nullIfBlank(filters.query),
    p_limit: params.limit ?? DEFAULT_LIMIT,
    p_offset: params.offset ?? 0,
  }
}

/**
 * One signal, distinguishing "not recorded" from "recorded as nothing".
 *
 * Outcome rows written before 005_review.sql carry an empty signals object and
 * cannot be backfilled: the values came from that run's scored.jsonl, which
 * retention has aged out. So an absent signal renders as a dash and a recorded
 * zero renders as zero, because "never scanned" and "we did not write it down"
 * are opposite facts and the reviewer is deciding on exactly this. Same argument
 * types.ts makes for Unavailable, at the scale of one cell.
 */
export function reviewSignal(
  signals: Record<string, unknown>,
  key: 'lang' | 'scans' | 'markets',
): unknown {
  if (!signals || !(key in signals)) return null
  const value = signals[key]
  return value === undefined ? null : value
}

function client() {
  const db = getCatalogSupabase()
  if (!db) throw new CatalogNotConfigured()
  return db
}

/**
 * count(*) over () rides along on every row, so an empty page carries no count.
 * An empty page IS zero rows for these filters, which is the honest total.
 */
function paged<T extends { total_count?: number }>(
  data: unknown,
  offset: number,
): Page<Omit<T, 'total_count'>> {
  const rows = (data ?? []) as T[]
  return {
    rows: rows.map(({ total_count: _drop, ...row }) => row) as Omit<T, 'total_count'>[],
    total: rows.length ? Number(rows[0].total_count ?? 0) : 0,
    offset,
  }
}

/**
 * Whether the signed-in account is in this project's catalog_admins.
 *
 * Asked so the screen can say one sentence instead of rendering a wall of failed
 * panels. It decides what to DRAW; every call below is refused by the database
 * regardless, which is the gate that matters.
 */
export async function isCatalogAdmin(signal: AbortSignal): Promise<boolean> {
  const { data, error } = await client().rpc('catalog_is_admin').abortSignal(signal)
  if (error) queryError('catalog_is_admin', error)
  return data === true
}

export async function fetchReviewCandidates(
  filters: ReviewFilters,
  params: PageParams,
  signal: AbortSignal,
): Promise<Page<ReviewCandidate>> {
  const { data, error } = await client()
    .rpc('list_review_candidates', reviewRpcArgs(filters, params))
    .abortSignal(signal)

  if (error) queryError('list_review_candidates', error)
  return paged<ReviewCandidate & { total_count: number }>(data, params.offset ?? 0)
}

export async function fetchReviewDecisions(
  filters: DecisionFilters,
  params: PageParams,
  signal: AbortSignal,
): Promise<Page<ReviewDecision>> {
  const { data, error } = await client()
    .rpc('list_review_decisions', decisionRpcArgs(filters, params))
    .abortSignal(signal)

  if (error) queryError('list_review_decisions', error)
  return paged<ReviewDecision & { total_count: number }>(data, params.offset ?? 0)
}

export async function recordDecision(
  barcode: string,
  verdict: Verdict,
  note?: string | null,
): Promise<void> {
  const { error } = await client().rpc('record_review_decision', {
    p_barcode: barcode,
    p_verdict: verdict,
    p_note: nullIfBlank(note),
  })
  if (error) queryError('record_review_decision', error)
}

/** Undo. Returns the product to the pending band. */
export async function clearDecision(barcode: string): Promise<void> {
  const { error } = await client().rpc('clear_review_decision', { p_barcode: barcode })
  if (error) queryError('clear_review_decision', error)
}

/**
 * Approve everything at or above a score, under the filters currently on screen.
 *
 * Takes the same filters as fetchReviewCandidates and the RPC applies them
 * identically: a bulk action whose filters drift from the list it sits under is
 * a bulk action that approves rows you never saw.
 *
 * Returns how many verdicts were written.
 */
export async function approveAbove(
  minScore: number,
  filters: ReviewFilters,
): Promise<number> {
  const { p_run, p_reason, p_query } = reviewRpcArgs(filters, {})
  const { data, error } = await client().rpc('approve_review_above', {
    p_min_score: minScore,
    p_run,
    p_reason,
    p_query,
  })
  if (error) queryError('approve_review_above', error)
  return Number(data ?? 0)
}

/**
 * Reject everything at or below a score, under the filters currently on screen.
 *
 * The mirror image of approveAbove, and the more used of the two: a 12,000-row
 * band is mostly floor, and sweeping the floor out of the way is what makes the
 * rest worth reading a row at a time.
 *
 * A record with no score is swept by neither. `score <= max` is null for an
 * unscored row exactly as `score >= min` is, and an unscored record in the
 * review band is the case a human most needs to see.
 *
 * Returns how many verdicts were written.
 */
export async function rejectBelow(
  maxScore: number,
  filters: ReviewFilters,
): Promise<number> {
  const { p_run, p_reason, p_query } = reviewRpcArgs(filters, {})
  const { data, error } = await client().rpc('reject_review_below', {
    p_max_score: maxScore,
    p_run,
    p_reason,
    p_query,
  })
  if (error) queryError('reject_review_below', error)
  return Number(data ?? 0)
}
