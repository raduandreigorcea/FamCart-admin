import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RANGE,
  TIME_RANGES,
  bucketLabel,
  previousSinceIso,
  resolveRange,
  sinceIso,
} from '../src/lib/timeRange'

// timeRange is the first thing tested because everything dated on this
// dashboard goes through it, and because it takes an injectable `now` -- so
// these assertions are about the arithmetic rather than about when the suite
// happened to run.

const NOW = Date.parse('2026-08-23T12:00:00.000Z')

describe('resolveRange', () => {
  it('resolves each known key to its own range', () => {
    for (const range of TIME_RANGES) {
      expect(resolveRange(range.key).key).toBe(range.key)
    }
  })

  it('falls back to 7d for an unknown, null or undefined key', () => {
    expect(resolveRange('nonsense').key).toBe('7d')
    expect(resolveRange(null).key).toBe('7d')
    expect(resolveRange(undefined).key).toBe('7d')
  })

  it('agrees with DEFAULT_RANGE about what the default is', () => {
    // These are declared separately in the module. If one is edited without the
    // other, a page's initial segmented-control selection stops matching the
    // data it is actually showing.
    expect(resolveRange(null).key).toBe(DEFAULT_RANGE)
  })
})

describe('sinceIso', () => {
  it('subtracts exactly the range width from now', () => {
    expect(sinceIso(resolveRange('24h'), NOW)).toBe('2026-08-22T12:00:00.000Z')
    expect(sinceIso(resolveRange('7d'), NOW)).toBe('2026-08-16T12:00:00.000Z')
    expect(sinceIso(resolveRange('30d'), NOW)).toBe('2026-07-24T12:00:00.000Z')
    expect(sinceIso(resolveRange('90d'), NOW)).toBe('2026-05-25T12:00:00.000Z')
  })
})

describe('previousSinceIso', () => {
  it('reaches back exactly twice the range width', () => {
    // This is the contract deltaOf() depends on: the "previous" call covers BOTH
    // windows, so subtracting the current one leaves the preceding period.
    expect(previousSinceIso(resolveRange('7d'), NOW)).toBe('2026-08-09T12:00:00.000Z')
  })

  it('is always earlier than sinceIso for the same range', () => {
    for (const range of TIME_RANGES) {
      expect(previousSinceIso(range, NOW) < sinceIso(range, NOW)).toBe(true)
    }
  })
})

describe('bucket pairing', () => {
  it('never pairs a long range with a fine bucket', () => {
    // The module's stated reason for deriving the bucket rather than letting a
    // view choose: 90 days of hourly buckets is 2,160 bars on a 600px chart.
    const bucketsIn = (hours: number, bucket: string) =>
      bucket === 'hour' ? hours : bucket === 'day' ? hours / 24 : hours / (24 * 7)

    for (const range of TIME_RANGES) {
      expect(bucketsIn(range.hours, range.bucket)).toBeLessThanOrEqual(30)
    }
  })
})

describe('bucketLabel', () => {
  it('labels hourly buckets with a time and coarser ones with a date', () => {
    const at = '2026-08-23T09:30:00.000Z'
    expect(bucketLabel(at, 'hour')).toMatch(/\d{2}:\d{2}/)
    expect(bucketLabel(at, 'day')).toMatch(/23 Aug/)
    expect(bucketLabel(at, 'week')).toMatch(/23 Aug/)
  })

  it('returns the placeholder rather than "Invalid Date" for junk', () => {
    expect(bucketLabel('not a date', 'day')).toBe('--')
  })
})
