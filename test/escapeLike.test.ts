import { describe, expect, it } from 'vitest'
import { escapeLike } from '../src/lib/data/products'

/** A single backslash, spelled out so the test file has no escaping of its own. */
const ESC = String.fromCharCode(92)

// `%` and `_` are wildcards to SQL and ordinary characters to the operator who
// pasted a shelf label into the search box. This catalog is full of names that
// contain them.

describe('escapeLike', () => {
  it('leaves an ordinary term untouched', () => {
    expect(escapeLike('lapte napolact')).toBe('lapte napolact')
    expect(escapeLike('')).toBe('')
  })

  it('escapes the percent sign a product name actually contains', () => {
    // The real case: "Lapte 3,5%" searched as a pattern meant "Lapte 3,5"
    // followed by anything, so the row you pasted arrived buried in a page of
    // rows you did not want.
    expect(escapeLike('lapte 3,5%')).toBe(`lapte 3,5${ESC}%`)
  })

  it('escapes the underscore', () => {
    expect(escapeLike('off_2026')).toBe(`off${ESC}_2026`)
  })

  it('escapes the escape character first, so escapes are not re-escaped', () => {
    // A lone backslash must become a literal backslash to LIKE, not the start
    // of an escape sequence swallowing the character after it.
    expect(escapeLike(ESC)).toBe(ESC + ESC)
    expect(escapeLike(ESC + '%')).toBe(ESC + ESC + ESC + '%')
  })

  it('escapes every occurrence, not just the first', () => {
    expect(escapeLike('100%_pure_100%')).toBe(
      `100${ESC}%${ESC}_pure${ESC}_100${ESC}%`,
    )
  })

  it('leaves the asterisk alone', () => {
    // PostgREST rewrites `*` to `%` before Postgres sees the pattern and gives
    // no way to escape it. Escaping it here would send a literal `%` and match
    // even less than leaving it. Documented in escapeLike itself.
    expect(escapeLike('kinder*')).toBe('kinder*')
  })
})
