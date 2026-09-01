import { describe, expect, it } from 'vitest'
import { sortGuard } from '../src/lib/data/types'
import { USER_SORTS, isUserSort } from '../src/lib/data/users'
import { HOUSEHOLD_SORTS, isHouseholdSort } from '../src/lib/data/households'

// TQ-2. The *_SORTS arrays carry a comment saying they mirror the CASE arms in
// the RPCs, and until now nothing used them: every view declared
// ref('last_active'), TypeScript inferred `string`, and a mistyped key sailed
// through to PostgREST and came back as a 400 naming no column.
//
// DataTable emits a bare string on a header click, so a guard at that boundary
// is the only thing standing between a typo and a runtime failure.

describe('sortGuard', () => {
  it('accepts exactly the keys it was given', () => {
    const isColour = sortGuard(['red', 'green'] as const)
    expect(isColour('red')).toBe(true)
    expect(isColour('green')).toBe(true)
    expect(isColour('blue')).toBe(false)
  })

  it('rejects the near-misses that a typo actually produces', () => {
    const isColour = sortGuard(['red'] as const)
    expect(isColour('Red')).toBe(false) // case
    expect(isColour('red ')).toBe(false) // stray space
    expect(isColour('')).toBe(false)
  })

  it('is not fooled by inherited Object properties', () => {
    // `includes` on the array rather than a lookup on an object literal, which
    // would answer true for 'toString' and 'constructor'.
    const isColour = sortGuard(['red'] as const)
    expect(isColour('toString')).toBe(false)
    expect(isColour('constructor')).toBe(false)
    expect(isColour('__proto__')).toBe(false)
  })

  it('narrows the type, not just the value', () => {
    const isColour = sortGuard(['red', 'green'] as const)
    const key: string = 'red'

    if (isColour(key)) {
      // If the predicate did not narrow, this assignment would not compile.
      const narrowed: 'red' | 'green' = key
      expect(narrowed).toBe('red')
    } else {
      throw new Error('unreachable')
    }
  })
})

describe('the two list guards', () => {
  it('accepts every key its own list declares', () => {
    for (const key of USER_SORTS) expect(isUserSort(key)).toBe(true)
    for (const key of HOUSEHOLD_SORTS) expect(isHouseholdSort(key)).toBe(true)
  })

  it('rejects a column that exists on the row but not in the RPC', () => {
    // The realistic mistake: adding a sortable column to a table without adding
    // the matching CASE arm server-side. These are real fields that the RPCs do
    // not accept as sort keys.
    expect(isUserSort('image_url')).toBe(false)
    expect(isUserSort('items_open')).toBe(false)
    expect(isHouseholdSort('invite_code')).toBe(false)
  })

  it('does not let one list accept the keys of another', () => {
    // 'name' is a household sort; it is not a user sort, where the equivalent
    // column is display_name.
    expect(isUserSort('name')).toBe(false)
    expect(isHouseholdSort('display_name')).toBe(false)
  })

  it('rejects SQL-ish junk outright', () => {
    // Not a real injection risk -- the RPCs match these against a CASE and
    // ignore anything else -- but the guard should stop it in the browser
    // rather than spending a round trip to be told no.
    expect(isUserSort('last_active; drop table users')).toBe(false)
    expect(isHouseholdSort('members desc')).toBe(false)
  })
})
