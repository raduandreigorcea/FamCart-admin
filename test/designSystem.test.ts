import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The design system, asserted rather than hoped for.
//
// A visual review of the running app found the same small uppercase caption
// written out FOURTEEN times across eleven files -- identical but for the gap
// beneath it, which had drifted to 2px in some and 3px in others, and for its
// tracking, which had reached four different values (0.05, 0.06, 0.08em and a
// table header that had gone its own way). Nobody decided any of that; it is
// what happens when a style is copied instead of named.
//
// These tests are cheap and they are the only thing that keeps it from
// happening again, because nothing else in the toolchain can see it.

const ROOTS = ['src/components', 'src/views']

function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  for (const root of ROOTS) {
    for (const file of readdirSync(root)) {
      if (file.endsWith('.vue')) out.push({ path: join(root, file), text: readFileSync(join(root, file), 'utf8') })
    }
  }
  out.push({ path: 'src/App.vue', text: readFileSync('src/App.vue', 'utf8') })
  return out
}

const files = sources()

describe('the caption style', () => {
  it('is not written out by hand anywhere', () => {
    // `.u-caption` and `.u-facts dt` in admin.css are the only definitions.
    const offenders = files
      .filter((f) => /text-transform:\s*uppercase;[\s\S]{0,80}?letter-spacing:\s*0\.0\d+em/.test(f.text))
      .map((f) => f.path)

    expect(offenders).toEqual([])
  })

  it('uses the tracking token wherever uppercase tracking is set', () => {
    const offenders = files.filter((f) => /letter-spacing:\s*0\.0[5-9]\d*em/.test(f.text)).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('is defined exactly once, in the global sheet', () => {
    const admin = readFileSync('src/styles/admin.css', 'utf8')
    expect(admin).toMatch(/\.u-caption,\s*\r?\n\.u-facts dt \{/)
    expect(admin).toMatch(/--tracking-caption:/)
    expect(admin).toMatch(/--caption-gap:/)
  })
})

describe('the spacing scale', () => {
  it('does not respell a value the scale already has', () => {
    // --space-1 is 4px and --space-1-5 is 6px. Values below those (1-3px) have
    // no token and are optical adjustments, which is why only these two are
    // checked.
    const offenders: string[] = []
    for (const f of files) {
      for (const m of f.text.matchAll(/(?:padding|margin|gap|inset)[a-z-]*:\s*([^;]*\b[46]px\b[^;]*);/g)) {
        offenders.push(`${f.path}: ${m[0].trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('focus indication', () => {
  it('never removes an outline without putting something back', () => {
    // A control that sets `outline: none` must define its own :focus or sit in
    // a wrapper that answers :focus-within -- otherwise it is the one control
    // in the tool a keyboard cannot find.
    const offenders = files
      .filter((f) => /outline:\s*none/.test(f.text))
      .filter((f) => !/:focus(-visible|-within)?\s*\{|:focus-within\s*\{/.test(f.text))
      .filter((f) => !/tabindex="-1"/.test(f.text)) // programmatic focus target
      .map((f) => f.path)

    expect(offenders).toEqual([])
  })
})

describe('the way a person is drawn', () => {
  // The same dozen lines -- a round <img> with an initial beside it as the
  // fallback -- had been written out six times, in four diameters, with two
  // different fallback treatments. UserAvatar owns it now and UserChip pairs it
  // with the name, so those two are the only files allowed to draw one.
  const OWNERS = ['UserAvatar.vue', 'UserChip.vue']
  const others = files.filter((f) => !OWNERS.some((owner) => f.path.endsWith(owner)))

  it('is not hand-rolled anywhere else', () => {
    // A square cropped to a pill radius, beside a name, is an avatar whatever
    // the class around it is called.
    const offenders = others
      .filter((f) => /border-radius:\s*var\(--radius-pill\);/.test(f.text))
      .filter((f) => /object-fit:\s*cover/.test(f.text))
      .map((f) => f.path)

    expect(offenders).toEqual([])
  })

  it('leaves initialOf to the component that draws the fallback', () => {
    // A view reaching for initialOf is a view about to draw its own avatar.
    const offenders = others.filter((f) => /\binitialOf\b/.test(f.text)).map((f) => f.path)
    expect(offenders).toEqual([])
  })
})

describe('table column widths', () => {
  // DataTable lays out fixed, so a column's declared width is the width it gets
  // rather than a hint its content may overrule. That is what stopped one
  // 368-character ban reason from stretching its column to 2272px and pushing
  // the row's own action button off the right-hand edge.
  //
  // Fixed layout makes these numbers load-bearing in a way auto layout never
  // did, and both of the rules below only started to matter because of it.
  const COLUMN_SETS = /const (\w+): Column<[^>]*>\[\]\s*=\s*\[([\s\S]*?)\n\]/g
  const ENTRY = /\{[^{}]*\bkey:\s*'([^']+)'[^{}]*\}/g

  const sets = files.flatMap((f) =>
    [...f.text.matchAll(COLUMN_SETS)].map((m) => ({
      where: f.path + ' ' + m[1],
      entries: [...m[2].matchAll(ENTRY)].map((e) => ({
        key: e[1],
        width: e[0].match(/width:\s*'(\d+(?:\.\d+)?)%'/),
      })),
    })),
  )

  it('is set on the one table component', () => {
    const table = readFileSync('src/components/DataTable.vue', 'utf8')
    expect(table).toMatch(/table-layout:\s*fixed/)
  })

  it('is declared by every column of every table', () => {
    const offenders = sets.flatMap((s) =>
      s.entries.filter((e) => !e.width).map((e) => s.where + ': ' + e.key),
    )
    expect(offenders).toEqual([])
  })

  it('sums to exactly 100% per table', () => {
    // Over 100 and the browser scales every column down to fit, so each one
    // silently gets less than it asked for -- Users summed to 105 and its
    // Households header, the longest word in the narrowest column, overflowed
    // by 7px. Under 100 and the slack is shared out to nobody's plan. Either
    // way the numbers stop describing the layout, which is the only reason to
    // write them.
    const offenders = sets
      .map((s) => ({
        where: s.where,
        total: s.entries.reduce((n, e) => n + (e.width ? parseFloat(e.width[1]) : 0), 0),
      }))
      .filter((s) => s.total !== 100)
      .map((s) => s.where + ' = ' + s.total + '%')

    expect(offenders).toEqual([])
  })
})

describe('the button', () => {
  // Four of them, none agreeing: Refresh at 34px tall with an 8px radius and
  // semibold text, and four copies of a 25px / 10px / regular one for Delete,
  // Suspend, Restore and Lift ban. A header row held three shapes.
  //
  // The one that mattered was the danger copy, which had drifted close enough
  // to StatusPill -- same --danger-border, same --danger-text, 1.7px apart in
  // height, 0.9px off its baseline -- that "Suspended" and "Lift suspension"
  // read as a matched pair with no way to tell which one did something.
  it('does not have a second destructive style written by hand', () => {
    // The signature of that copy: a rule that paints itself with the danger
    // border and then asks to be clicked.
    const offenders = files
      .filter((f) => {
        const rules = f.text.match(/\{[^{}]*\}/g) ?? []
        return rules.some(
          (r) => /--danger-border/.test(r) && /cursor:\s*pointer/.test(r),
        )
      })
      .map((f) => f.path)

    expect(offenders).toEqual([])
  })

  it('is defined once, in the global sheet', () => {
    const admin = readFileSync('src/styles/admin.css', 'utf8')
    expect(admin).toMatch(/\.u-btn \{/)
    expect(admin).toMatch(/\.u-btn--danger \{/)
  })

  it('varies by colour and never by shape', () => {
    // Geometry belongs to .u-btn alone. The moment the modifier is allowed a
    // height or a radius the two shapes start drifting apart again, which is
    // the whole way this went wrong the first time.
    const admin = readFileSync('src/styles/admin.css', 'utf8')
    const from = admin.indexOf('.u-btn--danger {')
    const body = admin.slice(from, admin.indexOf('}', from))

    expect(body).not.toMatch(/height|padding|border-radius|font-size|font-weight/)
  })
})
