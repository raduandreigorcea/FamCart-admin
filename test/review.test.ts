import { describe, expect, it } from 'vitest'
import { decisionRpcArgs, reviewRpcArgs, reviewSignal } from '../src/lib/data/review'

// The argument shape, asserted without a network, for the same reason
// buildOutcomeQuery is its own function next door: a filter that is silently
// wrong in the direction of matching everything is the worst kind, and it is
// invisible unless something checks the call itself.

describe('reviewRpcArgs', () => {
  it('sends null for an empty filter rather than an empty string', () => {
    expect(
      reviewRpcArgs({ runId: null, reason: null, query: '  ' }, { limit: 25, offset: 0 }),
    ).toEqual({
      p_run: null,
      p_reason: null,
      p_query: null,
      p_limit: 25,
      p_offset: 0,
    })
  })

  it('passes the filters it was given', () => {
    expect(
      reviewRpcArgs(
        { runId: 'r1', reason: 'middle-band', query: 'ciocolata' },
        { limit: 50, offset: 100 },
      ),
    ).toEqual({
      p_run: 'r1',
      p_reason: 'middle-band',
      p_query: 'ciocolata',
      p_limit: 50,
      p_offset: 100,
    })
  })

  it('defaults the page when none was given', () => {
    const args = reviewRpcArgs({}, {})
    expect(args.p_limit).toBe(25)
    expect(args.p_offset).toBe(0)
  })
})

describe('decisionRpcArgs', () => {
  it('sends null for an unset verdict filter', () => {
    expect(decisionRpcArgs({ verdict: null, query: '' }, {})).toEqual({
      p_verdict: null,
      p_query: null,
      p_limit: 25,
      p_offset: 0,
    })
  })

  it('passes a verdict filter through', () => {
    expect(decisionRpcArgs({ verdict: 'reject', query: null }, { limit: 10 }).p_verdict).toBe(
      'reject',
    )
  })
})

// Rows written before 005_review.sql have an empty signals object and cannot be
// backfilled: the values came from that run's scored.jsonl, which retention has
// aged out. "Never scanned" and "we did not write it down" are opposite facts
// and the reviewer is deciding on exactly this.
describe('reviewSignal', () => {
  it('returns null for a signal that was never recorded', () => {
    expect(reviewSignal({}, 'scans')).toBeNull()
  })

  it('returns a recorded zero as zero, not as absent', () => {
    expect(reviewSignal({ scans: 0 }, 'scans')).toBe(0)
  })

  it('returns a recorded null as null', () => {
    expect(reviewSignal({ scans: null }, 'scans')).toBeNull()
  })

  it('returns a recorded value', () => {
    expect(reviewSignal({ lang: 'ro' }, 'lang')).toBe('ro')
  })

  it('survives a row whose signals column is missing entirely', () => {
    expect(reviewSignal(undefined as never, 'markets')).toBeNull()
  })
})
