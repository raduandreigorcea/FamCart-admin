import { describe, expect, it } from 'vitest'
import { OUTCOME_STAGES, buildOutcomeQuery } from '../src/lib/data/outcomes'

// A recorder standing in for a PostgREST filter builder, so the query shape is
// verified without a network. Each method returns `this`, exactly as the real
// builder does.
function recorder() {
  const calls: [string, ...unknown[]][] = []
  const builder: Record<string, unknown> = {}
  for (const method of ['eq', 'ilike', 'order', 'range']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args])
      return builder
    }
  }
  return { builder, calls }
}

const noFilters = { runId: null, stage: null, reason: null }

describe('buildOutcomeQuery', () => {
  it('filters by run, stage and reason when given', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, { runId: 'r1', stage: 'dropped', reason: 'no-scans-no-brand' }, {})

    expect(calls).toContainEqual(['eq', 'run_id', 'r1'])
    expect(calls).toContainEqual(['eq', 'stage', 'dropped'])
    expect(calls).toContainEqual(['eq', 'reason', 'no-scans-no-brand'])
  })

  // `.eq('stage', null)` is not "no filter", it is a query for rows whose stage
  // IS null -- of which there are none, the column being NOT NULL. An absent
  // filter has to be an absent call.
  it('omits a filter that was not given rather than matching on null', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, noFilters, {})

    expect(calls.some(([method, column]) => method === 'eq' && column === 'run_id')).toBe(false)
    expect(calls.some(([method, column]) => method === 'eq' && column === 'stage')).toBe(false)
    expect(calls.some(([method, column]) => method === 'eq' && column === 'reason')).toBe(false)
  })

  it('searches names case-insensitively, anywhere in the string', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, noFilters, { query: 'nutella' })

    expect(calls).toContainEqual(['ilike', 'name', '%nutella%'])
  })

  // The same escaping products.ts does. `Lapte 3,5%` is a shelf label, not a
  // pattern, and this catalog is full of them.
  it('escapes LIKE metacharacters in the search', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, noFilters, { query: '100% Cacao' })

    expect(calls).toContainEqual(['ilike', 'name', '%100\\% Cacao%'])
  })

  it('ignores a search that is only whitespace', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, noFilters, { query: '   ' })

    expect(calls.some(([method]) => method === 'ilike')).toBe(false)
  })

  // Worst-kept-first: the interesting question is what we nearly kept. Nulls
  // last because a pre-scoring reject has no score and is never the row
  // somebody came looking for.
  it('orders by score descending with nulls last', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, noFilters, {})

    expect(calls).toContainEqual(['order', 'score', { ascending: false, nullsFirst: false }])
  })

  it('pages with an inclusive upper bound', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, noFilters, { limit: 25, offset: 50 })

    expect(calls).toContainEqual(['range', 50, 74])
  })

  it('defaults to the first page of 25', () => {
    const { builder, calls } = recorder()
    buildOutcomeQuery(builder as never, noFilters, {})

    expect(calls).toContainEqual(['range', 0, 24])
  })
})

describe('OUTCOME_STAGES', () => {
  it('matches the check constraint in 004_import_runs.sql', () => {
    expect([...OUTCOME_STAGES]).toEqual(['rejected', 'dropped', 'review'])
  })
})
