import { describe, expect, it, vi, beforeEach } from 'vitest'

// The reference catalog's admin surface. Thin wrappers over the four RPCs in the
// catalog project's 009_admin.sql, so the argument NAMES are the contract:
// PostgREST resolves by name, across a repository boundary here, with nothing on
// either side that would notice a rename.
//
// Two arguments carry a null-versus-value distinction where both readings are
// plausible and only one is right, and both get a test. Null markets means
// "leave them alone", not "clear them" -- markets are the relevance signal the
// ranking leans on, and emptying them during an unrelated rename would demote
// the product everywhere at once. Null barcode on an update means "do not touch
// the identifier", because a scan resolves through that value and nowhere else.

const rpc = vi.fn()
const abortSignal = vi.fn()
const getCatalogSupabase = vi.fn()

vi.mock('../src/lib/supabase', () => ({
  getAppSupabase: () => ({ rpc }),
  getCatalogSupabase,
}))

const {
  fetchCatalogProducts,
  createCatalogProduct,
  updateCatalogProduct,
  deleteCatalogProduct,
  catalogConfigured,
  CatalogNotConfigured,
} = await import('../src/lib/data/catalog')

function resolving(data: unknown = [], error: unknown = null) {
  getCatalogSupabase.mockReturnValue({ rpc })
  abortSignal.mockResolvedValue({ data, error })
  rpc.mockReturnValue({ abortSignal })
}

const signal = () => new AbortController().signal
const args = () => rpc.mock.calls.at(-1)?.[1] as Record<string, unknown>

describe('the catalog admin surface', () => {
  beforeEach(() => {
    rpc.mockReset()
    abortSignal.mockReset()
    getCatalogSupabase.mockReset()
  })

  it('browses with every argument catalog_admin_products declares', async () => {
    resolving()
    await fetchCatalogProducts({ query: 'lapte', type: 'generic', limit: 10, offset: 20 }, signal())

    expect(rpc).toHaveBeenCalledWith('catalog_admin_products', {
      p_query: 'lapte',
      p_type: 'generic',
      p_limit: 10,
      p_offset: 20,
    })
  })

  it('sends null for a blank search and no type filter', async () => {
    resolving()
    await fetchCatalogProducts({ query: '   ' }, signal())
    expect(args().p_query).toBeNull()
    expect(args().p_type).toBeNull()
  })

  it('reads the total off the first row and reports zero for an empty page', async () => {
    resolving([{ id: 'c-1', total_count: 444 }])
    expect((await fetchCatalogProducts({}, signal())).total).toBe(444)

    resolving([])
    expect((await fetchCatalogProducts({}, signal())).total).toBe(0)
  })

  it('creates with every argument the RPC declares', async () => {
    resolving('new-id')
    const id = await createCatalogProduct(
      {
        name: 'Rice Cakes',
        type: 'generic',
        lang: 'en',
        brand: null,
        category: null,
        markets: ['RO', 'DE'],
        barcode: '5949000000017',
        baseWeight: 3,
      },
      signal(),
    )

    expect(rpc).toHaveBeenCalledWith('catalog_admin_create_product', {
      p_name: 'Rice Cakes',
      p_type: 'generic',
      p_lang: 'en',
      p_brand: null,
      p_category: null,
      p_markets: ['RO', 'DE'],
      p_barcode: '5949000000017',
      p_base_weight: 3,
    })
    expect(id).toBe('new-id')
  })

  it('updates by id and leaves markets alone when none were given', async () => {
    resolving()
    await updateCatalogProduct('c-1', { name: 'Rice Cake', type: 'generic', lang: 'en' }, signal())

    expect(args().p_id).toBe('c-1')
    // Null, not []. An empty array would clear them.
    expect(args().p_markets).toBeNull()
    expect(args().p_base_weight).toBeNull()
  })

  it('passes an explicitly empty market list through as empty', async () => {
    resolving()
    await updateCatalogProduct(
      'c-1',
      { name: 'Rice Cake', type: 'generic', lang: 'en', markets: [] },
      signal(),
    )
    expect(args().p_markets).toEqual([])
  })

  it('deletes by id', async () => {
    resolving()
    await deleteCatalogProduct('c-1', signal())
    expect(rpc).toHaveBeenCalledWith('catalog_admin_delete_product', { p_id: 'c-1' })
  })

  it.each([
    ['fetch', () => fetchCatalogProducts({}, signal())],
    ['create', () => createCatalogProduct({ name: 'x', type: 'generic', lang: 'en' }, signal())],
    ['update', () => updateCatalogProduct('c-1', { name: 'x', type: 'generic', lang: 'en' }, signal())],
    ['delete', () => deleteCatalogProduct('c-1', signal())],
  ])('%s throws rather than reporting a success it did not get', async (_n, call) => {
    resolving(null, { message: 'Another product already claims that barcode.', code: 'P0001' })
    await expect(call()).rejects.toThrow(/already claims that barcode/)
  })

  // The catalog credentials are optional, and an absent catalog must be an
  // ordinary empty state rather than a crash: every other section is unaffected.
  it('reports the catalog as unconfigured rather than failing obscurely', async () => {
    getCatalogSupabase.mockReturnValue(null)

    expect(catalogConfigured()).toBe(false)
    await expect(fetchCatalogProducts({}, signal())).rejects.toBeInstanceOf(CatalogNotConfigured)
    await expect(deleteCatalogProduct('c-1', signal())).rejects.toBeInstanceOf(CatalogNotConfigured)
  })
})
