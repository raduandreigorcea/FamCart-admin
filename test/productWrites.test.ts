import { describe, expect, it, vi, beforeEach } from 'vitest'

// The three writes an admin can make to the app catalog. Thin wrappers, so the
// thing worth asserting is the argument NAMES -- PostgREST resolves an RPC by
// name, and a rename in the app database's 008_admin.sql with a stale name here is a
// 404 that mentions neither side.
//
// The null-versus-zero distinction on base weight gets its own test because it
// is the one argument where the two possible readings are both plausible and
// only one is right: null means "leave it", and sending 0 instead would quietly
// erase an editorial weight somebody set on purpose.

const rpc = vi.fn()
const abortSignal = vi.fn()

vi.mock('../src/lib/supabase', () => ({
  getAppSupabase: () => ({ rpc }),
  getCatalogSupabase: () => null,
}))

const { createProduct, updateProduct, deleteProduct } = await import(
  '../src/lib/data/contributed'
)

function resolving(data: unknown = null, error: unknown = null) {
  abortSignal.mockResolvedValue({ data, error })
  rpc.mockReturnValue({ abortSignal })
}

const signal = () => new AbortController().signal
const args = () => rpc.mock.calls.at(-1)?.[1] as Record<string, unknown>

describe('product writes', () => {
  beforeEach(() => {
    rpc.mockReset()
    abortSignal.mockReset()
  })

  it('creates with every argument admin_create_product declares', async () => {
    resolving('new-id')
    const id = await createProduct(
      { name: 'Apa Plata 2L', maker: 'Dorna', barcode: '594', baseWeight: 5 },
      signal(),
    )

    expect(rpc).toHaveBeenCalledWith('admin_create_product', {
      p_name: 'Apa Plata 2L',
      p_maker: 'Dorna',
      p_barcode: '594',
      p_base_weight: 5,
    })
    expect(id).toBe('new-id')
  })

  it('sends nulls rather than empty strings for an absent brand and barcode', async () => {
    resolving('new-id')
    await createProduct({ name: 'Bread' }, signal())

    expect(args().p_maker).toBeNull()
    expect(args().p_barcode).toBeNull()
  })

  it('updates by id, with the row it is changing', async () => {
    resolving()
    await updateProduct('p-1', { name: 'Bread', maker: null, barcode: null, baseWeight: 3 }, signal())

    expect(rpc).toHaveBeenCalledWith('admin_update_product', {
      p_id: 'p-1',
      p_name: 'Bread',
      p_maker: null,
      p_barcode: null,
      p_base_weight: 3,
    })
  })

  // The distinction the RPC reads as "leave it alone". A scoped row is edited
  // without the base-weight field on screen at all, so this is the path every
  // household-row correction takes.
  it('sends a null base weight rather than zero when none was given', async () => {
    resolving()
    await updateProduct('p-1', { name: 'Bread' }, signal())
    expect(args().p_base_weight).toBeNull()

    await updateProduct('p-1', { name: 'Bread', baseWeight: 0 }, signal())
    expect(args().p_base_weight).toBe(0)
  })

  it('deletes by id', async () => {
    resolving()
    await deleteProduct('p-1', signal())
    expect(rpc).toHaveBeenCalledWith('admin_delete_product', { p_id: 'p-1' })
  })

  // Every one of these RPCs raises a sentence meant to be shown. Swallowing the
  // error would turn "Another product already claims that barcode." into a
  // dialog that closed as though it had worked.
  it.each([
    ['createProduct', () => createProduct({ name: 'x' }, signal())],
    ['updateProduct', () => updateProduct('p-1', { name: 'x' }, signal())],
    ['deleteProduct', () => deleteProduct('p-1', signal())],
  ])('%s throws rather than reporting a success it did not get', async (_name, call) => {
    resolving(null, { message: 'Another product already claims that barcode.', code: 'P0001' })
    await expect(call()).rejects.toThrow(/already claims that barcode/)
  })
})
