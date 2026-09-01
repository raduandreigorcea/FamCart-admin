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

  it('updates by id and leaves unmentioned columns alone', async () => {
    resolving()
    await updateCatalogProduct('c-1', { name: 'Rice Cake', type: 'generic', lang: 'en' }, signal())

    expect(args().p_id).toBe('c-1')
    // Null, not [] or ''. The RPC reads null as "not mentioned", and an update
    // that omitted the barcode would otherwise erase one.
    expect(args().p_markets).toBeNull()
    expect(args().p_base_weight).toBeNull()
    expect(args().p_barcode).toBeNull()
    expect(args().p_quantity).toBeNull()
    expect(args().p_quantity_unit).toBeNull()
    expect(args().p_image_url).toBeNull()
    expect(args().p_quality_tier).toBeNull()
  })

  it('sends every editable column when the form supplies one', async () => {
    resolving()
    await updateCatalogProduct(
      'c-1',
      {
        name: 'Rice Cake',
        type: 'commercial',
        lang: 'de',
        brand: 'Acme',
        category: 'snacks',
        markets: ['DE'],
        baseWeight: 9,
        barcode: '4000000000038',
        quantity: 750,
        quantityUnit: 'ml',
        imageUrl: 'https://example.com/a.jpg',
        qualityTier: 'A',
      },
      signal(),
    )

    expect(args()).toEqual({
      p_id: 'c-1',
      p_name: 'Rice Cake',
      p_type: 'commercial',
      p_lang: 'de',
      p_brand: 'Acme',
      p_category: 'snacks',
      p_markets: ['DE'],
      p_base_weight: 9,
      p_barcode: '4000000000038',
      p_quantity: 750,
      p_quantity_unit: 'ml',
      p_image_url: 'https://example.com/a.jpg',
      p_quality_tier: 'A',
    })
  })

  // The distinction the whole convention rests on: '' clears, null leaves.
  // Sending null for a cleared field would make the clear silently do nothing.
  it('passes an emptied field through as empty rather than as null', async () => {
    resolving()
    await updateCatalogProduct(
      'c-1',
      { name: 'Rice Cake', type: 'generic', lang: 'en', barcode: '', imageUrl: '', quantityUnit: '' },
      signal(),
    )

    expect(args().p_barcode).toBe('')
    expect(args().p_image_url).toBe('')
    expect(args().p_quantity_unit).toBe('')
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
