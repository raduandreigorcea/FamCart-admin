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
