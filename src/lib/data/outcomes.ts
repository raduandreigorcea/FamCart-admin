// The records a run did not write.
//
// This is the other half of the Product Pipeline page's honesty problem. The
// counts say 7,435 were dropped by the gate; this says WHICH, and lets you type
// a name you half-remember and find out why it is not in the catalog.
//
// The rows live in the catalog project, are written only by catalog-importer
// with its service-role key, and are readable here by any signed-in account --
// the same policy product_catalog has, because these are barcodes and names
// derived from public Open Food Facts data and nothing about a household is in
// them.
//
// Retention keeps the 5 most recent runs per source, so an older run's drawer
// says its records were pruned rather than showing an empty table. That is what
// catalog_import_runs.outcomes_pruned is for.
import { getCatalogSupabase } from '../supabase'
import { queryError, type QueryFailure } from './errors'
import { CatalogNotConfigured, escapeLike } from './products'
import type { Page, PageParams } from './types'

export type OutcomeStage = 'rejected' | 'dropped' | 'review'

/** Mirrors the check constraint in 004_import_runs.sql. */
export const OUTCOME_STAGES = ['rejected', 'dropped', 'review'] as const

/** A row of the catalog project's catalog_import_outcomes. */
export interface OutcomeRow {
  id: number
  run_id: string
  barcode: string
  /** Null for pre-scoring rejects -- most were rejected FOR having no name. */
  name: string | null
  maker: string | null
  /** Null for pre-scoring rejects, which never reached the scorer. */
  score: number | null
  stage: OutcomeStage
  reason: string
  flags: string[]
}

export interface OutcomeFilters {
  runId?: string | null
  stage?: OutcomeStage | null
  reason?: string | null
}

/**
 * Anything with the chainable filter methods this module calls.
 *
 * Structural on purpose: it lets the tests hand in a recorder and assert the
 * query SHAPE without a network, which is the only way to catch a filter that
 * silently matches everything.
 */
interface FilterBuilder {
  eq(column: string, value: unknown): FilterBuilder
  ilike(column: string, pattern: string): FilterBuilder
  order(column: string, options: { ascending: boolean; nullsFirst?: boolean }): FilterBuilder
  range(from: number, to: number): FilterBuilder
}

/** A built query, plus the call that runs it. */
interface Executable extends FilterBuilder {
  abortSignal(signal: AbortSignal): PromiseLike<{
    data: OutcomeRow[] | null
    error: QueryFailure | null
    count: number | null
  }>
}

const DEFAULT_LIMIT = 25

/**
 * Applying the filters, separated from issuing the request so the query shape
 * can be tested without a network.
 *
 * Every filter is omitted when absent rather than matched against null:
 * `.eq('stage', null)` is not "no filter", it is a query for rows whose stage IS
 * null, and the column is NOT NULL. That returns nothing, silently, which is the
 * worst way for a filter to be wrong.
 */
export function buildOutcomeQuery<T extends FilterBuilder>(
  request: T,
  filters: OutcomeFilters,
  params: PageParams,
): T {
  let query = request
  if (filters.runId) query = query.eq('run_id', filters.runId) as T
  if (filters.stage) query = query.eq('stage', filters.stage) as T
  if (filters.reason) query = query.eq('reason', filters.reason) as T

  const search = params.query?.trim()
  if (search) query = query.ilike('name', `%${escapeLike(search)}%`) as T

  // Worst-kept-first: the interesting question is "what did we nearly keep".
  // Nulls last because a pre-scoring reject has no score and is never the row
  // somebody came looking for. `id` breaks ties so paging is stable -- without
  // it, two rows of equal score can swap between pages and one is never seen.
  query = query.order('score', { ascending: false, nullsFirst: false }) as T
  query = query.order('id', { ascending: true }) as T

  const limit = params.limit ?? DEFAULT_LIMIT
  const offset = params.offset ?? 0
  // range() is inclusive at both ends, so the upper bound is offset + limit - 1.
  return query.range(offset, offset + limit - 1) as T
}

export async function fetchOutcomes(
  filters: OutcomeFilters,
  params: PageParams,
  signal: AbortSignal,
): Promise<Page<OutcomeRow>> {
  const client = getCatalogSupabase()
  if (!client) throw new CatalogNotConfigured()

  // The cast is deliberate and lives here, once.
  //
  // Letting TypeScript infer the real PostgrestFilterBuilder through
  // buildOutcomeQuery makes it walk that type's generics until it gives up --
  // `error TS2589: Type instantiation is excessively deep and possibly
  // infinite`. Naming the four methods we call plus the one that runs the query
  // keeps the chain shallow, and keeps the shape testable with a recorder.
  const request = client
    .from('catalog_import_outcomes')
    .select('id,run_id,barcode,name,maker,score,stage,reason,flags', {
      count: 'exact',
    }) as unknown as Executable

  const { data, error, count } = await buildOutcomeQuery(request, filters, params).abortSignal(
    signal,
  )

  if (error) {
    queryError('catalog_import_outcomes', error)
  }

  return {
    rows: (data ?? []) as OutcomeRow[],
    total: count ?? 0,
    offset: params.offset ?? 0,
  }
}
