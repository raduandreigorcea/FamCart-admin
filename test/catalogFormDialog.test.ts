import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'

// The form that decides what "empty" means.
//
// The RPC behind it reads null as "I am not mentioning this column" and an empty
// string as "clear it". That distinction is what makes the barcode safe to
// expose: a caller that does not mention one cannot wipe one. It also means this
// component has to send '' rather than null when a field was deliberately
// cleared, and the two are indistinguishable from the outside -- a clear that
// quietly does nothing looks exactly like a clear that worked until you reload.
//
// Creating is the mirror case: there is nothing to leave alone, so an empty
// field is simply no value.

vi.mock('../src/lib/useModal', () => ({ useModal: () => {} }))

const CatalogFormDialog = (await import('../src/components/CatalogFormDialog.vue'))
  .default as unknown as Component

function product(over: Record<string, unknown> = {}) {
  return {
    id: 'c-1',
    canonical_name: 'Editable Thing',
    brand: 'Acme',
    category: 'pantry',
    quantity: 500,
    quantity_unit: 'g',
    image_url: 'https://example.com/a.jpg',
    add_count: 0,
    popularity: 4,
    barcodes: ['4000000000021'],
    first_seen_at: '2026-01-01T00:00:00Z',
    total_count: 1,
    ...over,
  }
}

function mountDialog(p: unknown | null) {
  return mount(CatalogFormDialog, {
    props: { open: true, product: p, busy: false, error: '' },
    global: { stubs: { Teleport: true } },
  })
}

const submitted = (w: ReturnType<typeof mount>) =>
  (w.emitted('submit')?.[0]?.[0] ?? null) as Record<string, unknown> | null

describe('CatalogFormDialog', () => {
  it('fills every field from the product it was opened on', async () => {
    const wrapper = mountDialog(product())
    await wrapper.vm.$nextTick()

    await wrapper.find('form').trigger('submit')

    expect(submitted(wrapper)).toMatchObject({
      name: 'Editable Thing',
      brand: 'Acme',
      category: 'pantry',
      barcode: '4000000000021',
      quantity: 500,
      quantityUnit: 'g',
      imageUrl: 'https://example.com/a.jpg',
    })
  })

  // THE ONE THAT MATTERS. Cleared while editing must be '', because null would
  // tell the RPC the column was never mentioned and the barcode would stay.
  it('sends an emptied field as empty when editing, not as null', async () => {
    const wrapper = mountDialog(product())
    await wrapper.vm.$nextTick()

    const inputs = wrapper.findAll('input')
    for (const input of inputs) {
      const el = input.element as HTMLInputElement
      if (el.value === '4000000000021' || el.value.startsWith('https://')) await input.setValue('')
    }
    await wrapper.find('form').trigger('submit')

    const out = submitted(wrapper)
    expect(out?.barcode).toBe('')
    expect(out?.imageUrl).toBe('')
  })

  // The mirror: nothing exists to leave alone yet, and the create RPC reads an
  // empty barcode as no barcode rather than as an instruction.
  it('sends an empty field as null when creating', async () => {
    const wrapper = mountDialog(null)
    await wrapper.vm.$nextTick()

    await wrapper.findAll('input')[0].setValue('Something New')
    await wrapper.find('form').trigger('submit')

    const out = submitted(wrapper)
    expect(out?.barcode).toBeNull()
    expect(out?.imageUrl).toBeNull()
    expect(out?.category).toBeNull()
  })

  it('offers the barcode when editing, which it once withheld', async () => {
    const wrapper = mountDialog(product())
    await wrapper.vm.$nextTick()

    const values = wrapper.findAll('input').map((i) => (i.element as HTMLInputElement).value)
    expect(values).toContain('4000000000021')
  })

  // The component stays alive between openings, so a stale value here would show
  // the previous product's barcode against this one's name.
  it('refills when reopened on a different product', async () => {
    const wrapper = mountDialog(product())
    await wrapper.vm.$nextTick()

    await wrapper.setProps({ open: false })
    await wrapper.setProps({
      open: true,
      product: product({ id: 'c-2', canonical_name: 'Other', barcodes: ['4000000000038'] }),
    })
    await wrapper.vm.$nextTick()

    await wrapper.find('form').trigger('submit')
    expect(submitted(wrapper)).toMatchObject({ name: 'Other', barcode: '4000000000038' })
  })

  // A concept has no barcode, so the field is gone rather than disabled: there
  // is nothing to type into it that the database would accept.
  // The two tests that were here exercised the generic/commercial split: a
  // generic product had no barcode field at all, and saving a commercial one as
  // generic sent an explicit clear. The rebuilt catalog has no product type --
  // every row came off a shelf -- so the barcode field is simply always there.
  it('always offers the barcode, since there is no such thing as a concept now', () => {
    const wrapper = mountDialog(product({ barcodes: [] }))
    expect(wrapper.findAll('.cf__label').map((l) => l.text())).toContain('Barcode')
  })

  it('refuses to submit with no name', async () => {
    const wrapper = mountDialog(null)
    await wrapper.vm.$nextTick()

    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('submit')).toBeUndefined()
  })
})
