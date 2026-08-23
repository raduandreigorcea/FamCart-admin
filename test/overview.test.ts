import { describe, expect, it } from 'vitest'
import { deltaOf, searchVolume } from '../src/lib/data/overview'

// deltaOf carries the one piece of arithmetic on the Overview that a reader
// cannot check by eye, and the one judgement call that matters: what to show
// when the previous window was zero.
//
// The contract: `current` counts the last N hours, `cumulative` counts the last
// 2N hours, so the preceding window is the difference.

describe('deltaOf', () => {
  it('subtracts the current window out of the cumulative one', () => {
    // 30 in this window, 50 across both, so the previous window held 20.
    expect(deltaOf(30, 50)).toEqual({ change: 10, ratio: 0.5 })
  })

  it('reports a fall as a negative change', () => {
    // 20 now, 50 across both -> 30 before -> down 10 from 30.
    expect(deltaOf(20, 50)).toEqual({ change: -10, ratio: -10 / 30 })
  })

  it('reports no movement as a zero change, not as null', () => {
    expect(deltaOf(25, 50)).toEqual({ change: 25 - 25, ratio: 0 })
  })

  it('returns a null RATIO rather than +100% for a first occurrence', () => {
    // The documented judgement: a ratio against a previous window of zero is
    // not "+100%", it is a first occurrence. StatTile renders this as "new".
    const delta = deltaOf(7, 7)
    expect(delta).not.toBeNull()
    expect(delta!.change).toBe(7)
    expect(delta!.ratio).toBeNull()
  })

  it('handles both windows being empty', () => {
    expect(deltaOf(0, 0)).toEqual({ change: 0, ratio: null })
  })

  it('returns null when the numbers cannot both be true', () => {
    // cumulative < current means the two calls disagree -- a row landed between
    // them, or the RPCs raced. There is no honest delta to show, and inventing
    // one would put a confident wrong arrow on the tile.
    expect(deltaOf(50, 30)).toBeNull()
    expect(deltaOf(1, 0)).toBeNull()
  })

  it('never produces NaN or Infinity for any ordering', () => {
    for (const current of [0, 1, 7, 100]) {
      for (const cumulative of [0, 1, 7, 100, 1000]) {
        const delta = deltaOf(current, cumulative)
        if (delta === null) continue
        expect(Number.isFinite(delta.change)).toBe(true)
        if (delta.ratio !== null) expect(Number.isFinite(delta.ratio)).toBe(true)
      }
    }
  })
})

describe('searchVolume', () => {
  it('is unavailable, and says why and what would fix it', () => {
    // Not a null and not a zero. See data/types.ts for why this is a type.
    const metric = searchVolume('7d')
    expect(metric.available).toBe(false)
    if (metric.available) throw new Error('unreachable')
    expect(metric.reason).toMatch(/not recorded/i)
    expect(metric.wouldRequire).toMatch(/search_events/)
  })
})
