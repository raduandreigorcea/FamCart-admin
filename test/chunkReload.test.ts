import { describe, expect, it } from 'vitest'
import { isChunkLoadFailure } from '../src/router/index'

// Every route is a lazy import() and every built chunk carries a content hash.
// Deploy while a tab is open and the next navigation asks for a file that no
// longer exists; without a handler, vue-router aborts silently and the click
// does nothing, forever, with no hint that a reload fixes it.
//
// The wordings below are the real ones. They differ per engine, which is
// exactly why this is worth pinning down in a test rather than trusting one
// regex written against one browser.

describe('isChunkLoadFailure', () => {
  it('recognises the Chrome and Vite wording', () => {
    expect(
      isChunkLoadFailure(
        new Error('Failed to fetch dynamically imported module: https://x/assets/HealthView-a1b2.js'),
      ),
    ).toBe(true)
  })

  it('recognises the Firefox wording', () => {
    expect(
      isChunkLoadFailure(new Error('error loading dynamically imported module')),
    ).toBe(true)
  })

  it('recognises the Safari wordings, which match none of the others', () => {
    expect(isChunkLoadFailure(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadFailure(new TypeError('Unable to load a module'))).toBe(true)
    expect(isChunkLoadFailure(new TypeError('Load failed'))).toBe(true)
  })

  it('accepts a non-Error, since a rejected import need not throw one', () => {
    expect(isChunkLoadFailure('Failed to fetch dynamically imported module')).toBe(true)
  })

  it('does NOT swallow ordinary application errors', () => {
    // The important half. Treating a real bug as a stale chunk would reload the
    // page on every crash, hiding the fault and looping the operator.
    expect(isChunkLoadFailure(new Error('admin_list_users: permission denied'))).toBe(false)
    expect(isChunkLoadFailure(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadFailure(new TypeError('x is not a function'))).toBe(false)
    expect(isChunkLoadFailure(null)).toBe(false)
    expect(isChunkLoadFailure(undefined)).toBe(false)
  })
})
