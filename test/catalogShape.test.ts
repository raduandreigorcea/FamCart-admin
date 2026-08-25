import { beforeEach, describe, expect, it, vi } from 'vitest'

// The catalog shape cache, which is where BG-1 lived: two of three callers
// re-awaited a cached promise while the header stamped a fresh "as of" time,
// so Refresh reported success and changed nothing.
//
// These tests exist to make that specific failure impossible to reintroduce.
// They mock the Supabase client rather than the module's own internals, so what
// is asserted is the observable contract -- how many times the database is
// actually read -- rather than the shape of the cache variable.

const pages = vi.hoisted(() => ({
  calls: 0,
  /** What catalog_stats() hands back. The server aggregates now, not us. */
  shape: null as Record<string, unknown> | null,
  /** Set to make the next read fail the way PostgREST reports an error. */
  error: null as { message: string; code?: string } | null,
  /** Every signal the build has handed to the client, in order. */
  signals: [] as AbortSignal[],
  /** Set to hold each page open until release() is called. */
  gate: null as { promise: Promise<void>; release: () => void } | null,
}))

// The shape now comes from one catalog_stats() call rather than a paging loop,
// so the mock moved with it. What these tests assert did not: how many times the
// database is read, and whether Refresh really re-reads it.
vi.mock('../src/lib/supabase', () => ({
  getCatalogSupabase: () => ({
    rpc: () => ({
      abortSignal: async (signal: AbortSignal) => {
        pages.calls += 1
        pages.signals.push(signal)
        if (pages.gate) await pages.gate.promise
        if (signal.aborted) throw new DOMException('aborted', 'AbortError')
        if (pages.error) return { data: null, error: pages.error }
        return { data: pages.shape, error: null }
      },
    }),
  }),
  getAppSupabase: () => {
    throw new Error('the shape must never touch the app database')
  },
}))

const { loadCatalogShape, refreshCatalogShape } = await import('../src/lib/data/products')

function shape(over: Record<string, unknown> = {}) {
  return {
    total: 1,
    truncated: false,
    bySource: [{ source: 'openfoodfacts', rows: 1, withBarcode: 1, withMarkets: 1 }],
    byVersion: [],
    byMarket: [{ market: 'RO', rows: 1 }],
    byCreatedDay: [{ day: '2026-08-20', rows: 1 }],
    coverage: { withBarcode: 1, withMaker: 1, withAliases: 1, withMarkets: 1 },
    popularity: { adopted: 1, totalAddCount: 2, topAddCount: 2 },
    ...over,
  }
}

beforeEach(async () => {
  // Start every test with an EMPTY cache, not a warm one.
  //
  // There is deliberately no exported invalidate() any more -- that separate
  // call was the cause of BG-1 -- so the way to empty the cache is to let a
  // forced build fail, which the module drops rather than caching. That the
  // trick works at all is itself the "a failed build is not cached" contract
  // asserted below.
  pages.error = { message: 'cache reset' }
  await refreshCatalogShape().catch(() => {})

  pages.error = null
  pages.shape = shape()
  pages.calls = 0
  pages.signals = []
  pages.gate = null
})

/** A latch the fake client waits on, so a build can be caught mid-flight. */
function openGate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  pages.gate = { promise, release }
  return () => {
    pages.gate = null
    release()
  }
}

describe('loadCatalogShape caching', () => {
  it('reads the database once and serves every later caller from cache', async () => {
    await loadCatalogShape()
    await loadCatalogShape()
    await loadCatalogShape()
    expect(pages.calls).toBe(1)
  })

  it('shares one in-flight request between concurrent callers', async () => {
    await Promise.all([loadCatalogShape(), loadCatalogShape(), loadCatalogShape()])
    expect(pages.calls).toBe(1)
  })
})

describe('refreshCatalogShape', () => {
  it('actually re-reads the database', async () => {
    // THE REGRESSION TEST FOR BG-1. Before the fix, the second call here
    // returned the cached promise and pages.calls stayed at 1 -- which is what
    // made Refresh a no-op on Products and Search.
    await loadCatalogShape()
    expect(pages.calls).toBe(1)

    await refreshCatalogShape()
    expect(pages.calls).toBe(2)
  })

  it('returns the new rows, not the ones cached before it', async () => {
    const before = await loadCatalogShape()
    expect(before.total).toBe(1)

    pages.shape = shape({ total: 3 })
    const after = await refreshCatalogShape()

    expect(after.total).toBe(3)
    // And the cache now serves the new answer to everyone else.
    expect((await loadCatalogShape()).total).toBe(3)
  })

  it('swaps the cache synchronously, so a refetch on the next line sees it', async () => {
    // This is what lets a view write `refreshCatalogShape(); query.refetch()`
    // without awaiting in between. If the swap were deferred, the refetch would
    // pick up the stale promise and the button would silently do nothing again.
    await loadCatalogShape()
    pages.shape = shape({ total: 2 })

    const forced = refreshCatalogShape()
    const followUp = loadCatalogShape()

    expect(await followUp).toBe(await forced)
    expect((await followUp).total).toBe(2)
    expect(pages.calls).toBe(2)
  })
})

describe('truncation (BG-5)', () => {
  it('is false for a catalog that fits under the ceiling', async () => {
    const shape = await loadCatalogShape()
    expect(shape.truncated).toBe(false)
  })

  // The client-side row ceiling is gone: there is no paging loop left to trip
  // it, and catalog_stats() aggregates the whole table or nothing. The test that
  // drove 200 pages to 200,000 rows went with it.
  //
  // `truncated` did NOT go with it. It is still in the contract and still
  // propagates, because the thing that sets it moved to the server rather than
  // stopping being true -- and a partial answer presented as a complete one is
  // the failure this whole file exists to prevent, wherever it is computed.
  it('carries the flag into the pipeline snapshot', async () => {
    const { buildPipelineSnapshot } = await import('../src/lib/data/pipeline')

    pages.shape = shape({ truncated: true })
    const truncatedShape = await refreshCatalogShape()
    expect(buildPipelineSnapshot(truncatedShape, []).truncated).toBe(true)

    pages.shape = shape({ truncated: false })
    const wholeShape = await refreshCatalogShape()
    expect(buildPipelineSnapshot(wholeShape, []).truncated).toBe(false)
  })
})

describe('a failed build', () => {
  it('is not cached, so the next attempt retries instead of staying broken', async () => {
    pages.error = { message: 'network down', code: 'PGRST000' }

    await expect(loadCatalogShape()).rejects.toThrow(/network down/)
    expect(pages.calls).toBe(1)

    // The network comes back. A plain load -- not a forced refresh -- must
    // retry, or the section stays broken until a page reload.
    pages.error = null
    const recovered = await loadCatalogShape()

    expect(pages.calls).toBe(2)
    expect(recovered.total).toBe(1)
  })

  it('carries the PostgREST code forward, which describeError keys off', async () => {
    pages.error = { message: 'permission denied', code: '42501' }

    await expect(loadCatalogShape()).rejects.toMatchObject({ code: '42501' })
  })
})

describe('a superseded build', () => {
  it('aborts the request the older build is waiting on', async () => {
    const release = openGate()
    const first = loadCatalogShape()
    await Promise.resolve()

    expect(pages.signals).toHaveLength(1)
    expect(pages.signals[0].aborted).toBe(false)

    const second = refreshCatalogShape()
    expect(pages.signals[0].aborted).toBe(true)

    release()
    await Promise.all([first, second])
  })

  it('hands the older awaiter the newer result rather than an abort error', async () => {
    // The whole reason the abort is safe. A caller asked for the catalog's
    // shape, not for one particular attempt at it, and an AbortError it never
    // requested is not something it can render or act on.
    const release = openGate()
    const first = loadCatalogShape()
    await Promise.resolve()

    pages.shape = shape({ total: 2 })
    const second = refreshCatalogShape()
    release()

    await expect(first).resolves.toEqual(await second)
    expect((await first).total).toBe(2)
  })

  it('still rejects when the build failed for a real reason', async () => {
    // The supersede path must not swallow genuine failures.
    pages.error = { message: 'permission denied', code: '42501' }
    await expect(refreshCatalogShape()).rejects.toMatchObject({ code: '42501' })
  })
})
