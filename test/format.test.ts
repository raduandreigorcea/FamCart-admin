import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatCompact,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  formatShare,
  humanizeKind,
  initialOf,
  shortUserId,
} from '../src/lib/format'

// format.ts exists so the dashboard never renders the same kind of value two
// ways. These tests are mostly about the ABSENT cases -- null, undefined, NaN,
// divide-by-zero -- because those are what turn a table cell into "NaN%" or
// "Invalid Date", and every one of them is a silent defect that ships.

const NOW = Date.parse('2026-08-23T12:00:00.000Z')

describe('the placeholder, everywhere', () => {
  it('renders -- rather than NaN, null or undefined', () => {
    for (const bad of [null, undefined, Number.NaN]) {
      expect(formatCount(bad)).toBe('--')
      expect(formatCompact(bad)).toBe('--')
      expect(formatPercent(bad)).toBe('--')
      expect(formatBytes(bad)).toBe('--')
      expect(formatDuration(bad)).toBe('--')
    }
    expect(formatDateTime(null)).toBe('--')
    expect(formatDate(undefined)).toBe('--')
    expect(shortUserId(null)).toBe('--')
    expect(humanizeKind(null)).toBe('--')
  })

  it('does not mistake a real zero for a missing value', () => {
    // The distinction this whole codebase is careful about. Zero is an answer.
    expect(formatCount(0)).toBe('0')
    expect(formatCompact(0)).toBe('0')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatDuration(0)).toBe('0 ms')
  })
})

describe('formatCompact', () => {
  it('shortens at the thousand and million boundaries', () => {
    expect(formatCompact(999)).toBe('999')
    expect(formatCompact(1000)).toBe('1k')
    expect(formatCompact(10_833)).toBe('10.8k')
    expect(formatCompact(999_999)).toBe('1,000k')
    expect(formatCompact(1_000_000)).toBe('1M')
    expect(formatCompact(2_450_000)).toBe('2.5M')
  })

  it('handles negatives by magnitude, not by sign', () => {
    expect(formatCompact(-10_833)).toBe('-10.8k')
    expect(formatCompact(-500)).toBe('-500')
  })
})

describe('formatShare', () => {
  it('guards the division by zero that would render NaN%', () => {
    // The documented reason this function exists rather than an inline divide.
    expect(formatShare(0, 0)).toBe('--')
    expect(formatShare(5, 0)).toBe('--')
  })

  it('formats a real share', () => {
    expect(formatShare(1, 4)).toBe('25%')
    expect(formatShare(1, 3)).toBe('33.3%')
    expect(formatShare(0, 10)).toBe('0%')
  })
})

describe('formatBytes', () => {
  it('steps through units and stops at TB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1024 ** 2)).toBe('1 MB')
    expect(formatBytes(1024 ** 3)).toBe('1 GB')
    expect(formatBytes(1024 ** 4)).toBe('1 TB')
    // Past the last unit it keeps scaling TB rather than running off the array.
    expect(formatBytes(1024 ** 5)).toBe('1,024 TB')
  })
})

describe('formatDuration', () => {
  it('switches unit at a second and a minute', () => {
    expect(formatDuration(999)).toBe('999 ms')
    expect(formatDuration(1000)).toBe('1 s')
    expect(formatDuration(59_999)).toBe('60 s')
    expect(formatDuration(60_000)).toBe('1 min')
  })

  it('rounds sub-millisecond timings rather than printing a fraction', () => {
    // performance.now() returns floats; a latency readout of "0.30000001 ms"
    // is noise.
    expect(formatDuration(0.3)).toBe('0 ms')
    expect(formatDuration(12.7)).toBe('13 ms')
  })
})

describe('formatRelative', () => {
  it('returns "never" for a missing or unparseable date', () => {
    expect(formatRelative(null, NOW)).toBe('never')
    expect(formatRelative(undefined, NOW)).toBe('never')
    expect(formatRelative('not a date', NOW)).toBe('never')
  })

  it('picks a sensible unit at each threshold', () => {
    const ago = (ms: number) => formatRelative(new Date(NOW - ms), NOW)
    expect(ago(10_000)).toMatch(/second/)
    expect(ago(5 * 60_000)).toMatch(/minute/)
    expect(ago(3 * 3_600_000)).toMatch(/hour/)
    expect(ago(2 * 86_400_000)).toMatch(/day/)
    expect(ago(40 * 86_400_000)).toMatch(/month/)
    expect(ago(400 * 86_400_000)).toMatch(/year/)
  })

  it('reads as past for the past and future for the future', () => {
    expect(formatRelative(new Date(NOW - 3_600_000), NOW)).toMatch(/ago/)
    expect(formatRelative(new Date(NOW + 3_600_000), NOW)).toMatch(/in /)
  })
})

describe('shortUserId', () => {
  it('keeps the tail, which is what distinguishes one account from another', () => {
    const id = 'user_2abcdefghijklmnopqrs'
    const short = shortUserId(id)
    expect(short.endsWith(id.slice(-6))).toBe(true)
    expect(short).toContain('…')
  })

  it('leaves a short id alone rather than truncating to something longer', () => {
    expect(shortUserId('user_2abcdef')).toBe('user_2abcdef')
  })
})

describe('humanizeKind', () => {
  it('turns a snake_case event kind into a sentence', () => {
    expect(humanizeKind('invite_code_failed')).toBe('Invite code failed')
    expect(humanizeKind('admin.granted')).toBe('Admin granted')
  })
})

describe('initialOf', () => {
  it('falls back to ? rather than an empty avatar', () => {
    expect(initialOf(null)).toBe('?')
    expect(initialOf('')).toBe('?')
    expect(initialOf('   ')).toBe('?')
  })

  it('uppercases and ignores leading whitespace', () => {
    expect(initialOf('  pat')).toBe('P')
    expect(initialOf('Ștefan')).toBe('Ș')
  })
})
