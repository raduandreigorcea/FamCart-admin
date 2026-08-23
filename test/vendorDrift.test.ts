import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// AR-2. src/vendor/ holds byte-for-byte copies of FamCart modules, and
// vendor.meta.json declares its SHA-256 hashes "authoritative" -- naming
// FamCart's own test/vendorDrift.test.js as the thing that enforces them.
//
// That file lives in the PARENT repo. This one is a submodule that must also
// work as a standalone clone, which is the entire reason the files are vendored
// rather than imported -- and in exactly that mode, nothing was checking them.
// A guarantee only enforced from somewhere you might not have checked out is
// not a guarantee.
//
// So: the same check, here, reading the same manifest.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = join(root, 'src', 'vendor')

interface Manifest {
  files: Record<string, { upstream: string; sha256: string; vendoredAt: string; why: string }>
}

const manifest = JSON.parse(
  readFileSync(join(vendorDir, 'vendor.meta.json'), 'utf8'),
) as Manifest

/**
 * The manifest hashes LF-NORMALISED bytes, and the reason is in its own header:
 * FamCart is developed on Windows with core.autocrlf=true, so the working copy
 * is CRLF there and LF on a Linux runner. Hashing raw bytes would make this
 * test pass on one and fail on the other -- which is worse than not having it,
 * because it would train everyone to ignore the failure.
 */
function normalisedHash(path: string): string {
  const raw = readFileSync(path, 'utf8')
  return createHash('sha256').update(raw.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

describe('vendored FamCart modules', () => {
  it('declares the files that are actually vendored', () => {
    expect(Object.keys(manifest.files).sort()).toEqual(['style.css', 'theme.ts'])
  })

  it.each(Object.entries(manifest.files))(
    '%s still matches the hash in vendor.meta.json',
    (name, entry) => {
      const actual = normalisedHash(join(vendorDir, name))

      // A failure here means someone edited a vendored copy directly. The fix
      // is never to update the hash: change the upstream module in FamCart,
      // re-copy it, and then update the hash. Editing here silently forks the
      // design system, one colour at a time.
      expect(actual, `${name} has drifted from ${entry.upstream}`).toBe(entry.sha256)
    },
  )

  it('records where each copy came from and why', () => {
    for (const [name, entry] of Object.entries(manifest.files)) {
      expect(entry.upstream, `${name} is missing its upstream path`).toBeTruthy()
      expect(entry.why, `${name} is missing its rationale`).toBeTruthy()
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
