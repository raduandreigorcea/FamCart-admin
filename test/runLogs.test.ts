import { describe, it, expect, vi } from 'vitest'

// A run's log lines and the listings it touched, from the catalog (catalog 023).
// The subscription is the part that is easy to leak: a channel left open after
// the page is gone keeps a socket and a Realtime slot for nobody.

const calls = vi.hoisted(() => ({
  table: '',
  gt: null as unknown,
  eq: null as unknown,
  order: null as unknown,
  limit: 0,
  rpc: null as unknown,
  channel: '',
  filter: null as unknown,
  removed: 0,
}))
const answer = vi.hoisted(() => ({ data: [] as unknown, error: null as unknown }))
const realtime = vi.hoisted(() => ({ handler: null as null | ((p: { new: unknown }) => void) }))

vi.mock('../src/lib/supabase', () => ({
  getAppSupabase: () => null,
  getCatalogSupabase: () => {
    const builder = {
      select: () => builder,
      eq: (c: string, v: unknown) => ((calls.eq = [c, v]), builder),
      gt: (c: string, v: unknown) => ((calls.gt = [c, v]), builder),
      order: (c: string, o: unknown) => ((calls.order = [c, o]), builder),
      limit: (n: number) => ((calls.limit = n), builder),
      abortSignal: async () => ({ data: answer.data, error: answer.error }),
    }
    const channel = {
      on: (_event: string, filter: unknown, handler: (p: { new: unknown }) => void) => {
        calls.filter = filter
        realtime.handler = handler
        return channel
      },
      subscribe: () => channel,
    }
    return {
      from: (t: string) => ((calls.table = t), builder),
      rpc: (name: string, args: unknown) => {
        calls.rpc = [name, args]
        return { abortSignal: async () => ({ data: answer.data, error: answer.error }) }
      },
      channel: (name: string) => ((calls.channel = name), channel),
      removeChannel: async () => {
        calls.removed++
      },
    }
  },
}))

const { fetchRunLogs, subscribeRunLogs, fetchRunListings, LOG_PAGE, LISTING_PAGE } = await import(
  '../src/lib/data/runLogs'
)
const signal = () => new AbortController().signal

describe('run logs', () => {
  it("reads a run's lines after the last one seen, oldest first", async () => {
    answer.data = [{ id: 5, message: 'x' }]
    const lines = await fetchRunLogs('run-1', 4, signal())
    expect(calls.table).toBe('catalog_run_logs')
    expect(calls.eq).toEqual(['run_id', 'run-1'])
    expect(calls.gt).toEqual(['id', 4])
    expect(calls.order).toEqual(['id', { ascending: true }])
    expect(calls.limit).toBe(LOG_PAGE)
    expect(lines).toHaveLength(1)
  })

  it('surfaces the database refusing, rather than an empty log', async () => {
    answer.error = { message: 'permission denied', code: '42501' }
    await expect(fetchRunLogs('run-1', 0, signal())).rejects.toThrow()
    answer.error = null
  })

  it('subscribes to inserts for that run only, and lets go', () => {
    const got: unknown[] = []
    const stop = subscribeRunLogs('run-1', (line) => got.push(line))
    expect(calls.filter).toMatchObject({ event: 'INSERT', table: 'catalog_run_logs', filter: 'run_id=eq.run-1' })
    realtime.handler?.({ new: { id: 1, message: 'live' } })
    expect(got).toEqual([{ id: 1, message: 'live' }])
    stop()
    expect(calls.removed).toBe(1)
  })
})

describe('run listings', () => {
  it('asks for one kind, one page, and reads the total off the rows', async () => {
    answer.data = [{ external_id: 'A1', total: 120 }]
    const page = await fetchRunListings('run-1', 'new', 50, signal())
    expect(calls.rpc).toEqual([
      'catalog_admin_run_listings',
      { p_run_id: 'run-1', p_kind: 'new', p_limit: LISTING_PAGE, p_offset: 50 },
    ])
    expect(page.total).toBe(120)
    expect(page.rows[0].external_id).toBe('A1')
  })

  it('an empty page has a total of zero', async () => {
    answer.data = []
    expect((await fetchRunListings('run-1', 'gone', 0, signal())).total).toBe(0)
  })
})
