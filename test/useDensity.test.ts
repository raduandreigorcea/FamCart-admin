import { beforeEach, describe, expect, it, vi } from 'vitest'

// Density was a per-view `ref('comfortable')` on two of seven table views, so
// five tables -- including the four on System Health -- could not be compacted
// at all, and the two that could forgot the choice on navigation. Both halves
// are the same mistake: density is a property of the reader, not of a page.

const store = new Map<string, string>()

vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

beforeEach(() => {
  store.clear()
  vi.resetModules()
})

async function load() {
  return import('../src/lib/useDensity')
}

describe('useDensity', () => {
  it('defaults to comfortable', async () => {
    const { useDensity } = await load()
    const d = useDensity()
    expect(d.density.value).toBe('comfortable')
    expect(d.dense.value).toBe(false)
  })

  it('exposes `dense` in the shape DataTable takes', async () => {
    const { useDensity } = await load()
    const d = useDensity()
    d.setDensity('compact')
    expect(d.dense.value).toBe(true)
  })

  it('is one setting, shared by every table', async () => {
    // The point of the whole change: two callers, one answer. Previously each
    // view held its own ref and five views held none.
    const { useDensity } = await load()
    const users = useDensity()
    const health = useDensity()

    users.setDensity('compact')
    expect(health.density.value).toBe('compact')
    expect(health.dense.value).toBe(true)
  })

  it('survives navigation by persisting the choice', async () => {
    const first = await load()
    first.useDensity().setDensity('compact')
    expect(store.get('famcart-admin:density')).toBe('compact')

    // A fresh module registry stands in for a reload.
    vi.resetModules()
    const second = await load()
    expect(second.useDensity().density.value).toBe('compact')
  })

  it('falls back to comfortable when storage is unreadable', async () => {
    // A private window, or site data blocked. Roomy rows harm nobody; a throw
    // during setup would take the whole shell down.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      },
    })
    const { useDensity } = await load()
    const d = useDensity()
    expect(d.density.value).toBe('comfortable')
    expect(() => d.setDensity('compact')).not.toThrow()
    expect(d.density.value).toBe('compact')
  })

  it('ignores a stored value that is not a density', async () => {
    store.set('famcart-admin:density', 'enormous')
    const { useDensity } = await load()
    expect(useDensity().density.value).toBe('comfortable')
  })
})
