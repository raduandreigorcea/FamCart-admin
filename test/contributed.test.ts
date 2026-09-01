import { describe, expect, it, vi, beforeEach } from 'vitest'

// A thin wrapper over admin_local_products, and the thing worth asserting about
// a thin wrapper is that it passes the right argument NAMES: PostgREST resolves
// an RPC by argument name, so a rename in 008_admin.sql and a stale name here
// fail at runtime as a 404 that mentions neither.
//
// The scope argument earns its own tests. It is the page's only filter, and the
// failure mode of a filter that is not forwarded is silence -- the table still
// renders rows, they are simply the wrong ones, and nothing anywhere says so.

const rpc = vi.fn()
const abortSignal = vi.fn()

vi.mock('../src/lib/supabase', () => ({
  getAppSupabase: () => ({ rpc }),
  getCatalogSupabase: () => null,
}))

const { fetchContributedProducts } = await import('../src/lib/data/contributed')

function resolving(data: unknown = [], error: unknown = null) {
  abortSignal.mockResolvedValue({ data, error })
  rpc.mockReturnValue({ abortSignal })
}

const signal = () => new AbortController().signal

/** The argument object of the most recent RPC call. */
const args = () => rpc.mock.calls.at(-1)?.[1] as Record<string, unknown>

describe('fetchContributedProducts', () => {
  beforeEach(() => {
    rpc.mockReset()
    abortSignal.mockReset()
  })

  it('calls admin_local_products with every argument the RPC declares', async () => {
    resolving()
    await fetchContributedProducts({ query: 'lapte', limit: 10, offset: 20 }, signal())

    expect(rpc).toHaveBeenCalledWith('admin_local_products', {
      p_query: 'lapte',
      p_source: null,
      p_scope: 'all',
      p_limit: 10,
      p_offset: 20,
    })
  })

  it('forwards the scope rather than always asking for everything', async () => {
    resolving()
    await fetchContributedProducts({ scope: 'promoted' }, signal())
    expect(args().p_scope).toBe('promoted')

    await fetchContributedProducts({ scope: 'community' }, signal())
    expect(args().p_scope).toBe('community')
  })

  // The RPC treats null as "no search". An empty box and a box holding spaces
  // are the same thing to a person and must be the same thing to the query, or
  // the first keystroke of a search that is then cleared leaves the table
  // filtered by whitespace and returning nothing.
  it('sends null rather than an empty or blank query', async () => {
    resolving()
    await fetchContributedProducts({ query: '   ' }, signal())
    expect(args().p_query).toBeNull()

    await fetchContributedProducts({ query: '' }, signal())
    expect(args().p_query).toBeNull()
  })

  it('trims a real query instead of searching for the spaces around it', async () => {
    resolving()
    await fetchContributedProducts({ query: '  lapte  ' }, signal())
    expect(args().p_query).toBe('lapte')
  })

  // total_count rides on every row rather than arriving separately, so an empty
  // page has nowhere to carry it. Zero is the only honest answer there.
  it('reads the total off the first row, and reports zero when there are none', async () => {
    resolving([{ id: 'p-1', total_count: 60 }])
    const page = await fetchContributedProducts({}, signal())
    expect(page.total).toBe(60)
    expect(page.rows).toHaveLength(1)

    resolving([])
    const empty = await fetchContributedProducts({}, signal())
    expect(empty.total).toBe(0)
    expect(empty.rows).toEqual([])
  })

  it('throws rather than returning an empty page when the RPC errors', async () => {
    resolving(null, { message: 'permission denied', code: '42501' })
    await expect(fetchContributedProducts({}, signal())).rejects.toThrow()
  })
})
