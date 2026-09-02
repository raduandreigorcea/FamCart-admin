import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'

// The Catalog view. Same shape as ContributedView and a heavier blast radius:
// this project is shared live by production and development, so one removal here
// takes the product from every household of both.
//
// What is worth pinning is the wiring nobody sees when it is wrong. A decline
// that still writes. An edit that creates a second row instead of correcting the
// first. A delete aimed at whichever row happens to be first. And the confirm
// message, which is the only place the blast radius is stated at all -- a
// generic "are you sure?" would make this look like the app-database delete,
// which it is not.

const fetchCatalogProducts = vi.fn()
const createCatalogProduct = vi.fn().mockResolvedValue('new-id')
const updateCatalogProduct = vi.fn().mockResolvedValue(undefined)
const deleteCatalogProduct = vi.fn().mockResolvedValue(undefined)
const catalogConfigured = vi.fn().mockReturnValue(true)

vi.mock('../src/lib/data/catalog', () => ({
  fetchCatalogProducts,
  createCatalogProduct,
  updateCatalogProduct,
  deleteCatalogProduct,
  catalogConfigured,
  // Real rather than stubbed: it is three lines of counting and the Filters
  // button's badge is drawn from it, so a stub would test the stub.
  activeFilterCount: (f: Record<string, unknown>) =>
    Object.values(f).filter((v) => v !== null && v !== undefined).length,
  CatalogNotConfigured: class extends Error {},
}))

const CatalogView = (await import('../src/views/CatalogView.vue')).default as unknown as Component

const stubs = {
  PageHeader: {
    props: ['title'],
    template: '<div class="head">{{ title }}<slot name="tools" /></div>',
  },
  PanelCard: { template: '<section><slot name="actions" /><slot /><slot name="footer" /></section>' },
  StateBlock: { props: ['title'], template: '<div class="state">{{ title }}</div>' },
  FilterBar: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: `<div><input class="filter" :value="modelValue"
      @input="$emit('update:modelValue', $event.target.value)" /><slot /></div>`,
  },
  AppIcon: { props: ['name'], template: '<i />' },
  // The drawer is a set of selects over SideDrawer; what this view owes it is
  // the object, so the stub exposes setting one filter and nothing else.
  CatalogFilterDrawer: {
    props: ['open', 'modelValue'],
    emits: ['update:modelValue', 'close'],
    template: `<div v-if="open" class="drawer">
      <button class="drawer__ro" @click="$emit('update:modelValue', { ...modelValue, market: 'RO' })">ro</button>
      <button class="drawer__nobarcode" @click="$emit('update:modelValue', { ...modelValue, hasBarcode: false })">nb</button>
      <button class="drawer__close" @click="$emit('close')">x</button>
    </div>`,
  },
  SegmentedControl: {
    props: ['modelValue', 'segments'],
    emits: ['update:modelValue'],
    template: `<span><button v-for="s in segments" :key="s.value" class="seg__item"
      :data-value="s.value" @click="$emit('update:modelValue', s.value)">{{ s.label }}</button></span>`,
  },
  TablePager: {
    props: ['total', 'offset', 'limit'],
    emits: ['go'],
    template: `<nav class="pager"><button class="pager__next"
      @click="$emit('go', offset + limit)">next</button></nav>`,
  },
  DataTable: {
    props: ['rows', 'rowKey'],
    template: `<table><tbody>
      <tr v-for="r in rows" :key="r[rowKey]" class="row">
        <td><slot name="cell-canonical_name" :row="r" /></td>
        <td><slot name="cell-markets" :row="r" /></td>
        <td><slot name="cell-popularity" :row="r" /></td>
        <td><slot name="cell-actions" :row="r" /></td>
      </tr>
    </tbody></table>`,
  },
  StatusPill: { props: ['label'], template: '<span class="pill">{{ label }}</span>' },
  CopyValue: { props: ['value'], template: '<span class="copy">{{ value }}</span>' },
  CatalogFormDialog: {
    props: ['open', 'product', 'busy', 'error'],
    emits: ['submit', 'cancel'],
    template: `<div v-if="open" class="form" :data-editing="product ? product.id : ''">
      <em class="form__error">{{ error }}</em>
      <button class="form__save" @click="$emit('submit', { name: 'Typed', type: 'generic', lang: 'en', brand: null, category: null, markets: [], barcode: null, baseWeight: 0 })">save</button>
      <button class="form__cancel" @click="$emit('cancel')">cancel</button>
    </div>`,
  },
  ConfirmDialog: {
    props: ['open', 'title', 'message', 'busy', 'error'],
    emits: ['confirm', 'cancel'],
    template: `<div v-if="open" class="confirm">
      <em class="confirm__title">{{ title }}</em>
      <em class="confirm__message">{{ message }}</em>
      <button class="confirm__go" @click="$emit('confirm')">go</button>
      <button class="confirm__no" @click="$emit('cancel')">no</button>
    </div>`,
  },
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'c-1',
    product_type: 'generic',
    canonical_name: 'Rice Cakes',
    name_lang: 'en',
    brand: null,
    category: null,
    markets: ['RO', 'DE'],
    quality_tier: 'B',
    quantity: null,
    quantity_unit: null,
    image_url: null,
    base_weight: 3,
    add_count: 0,
    popularity: 3,
    source_count: 1,
    sources: ['admin'],
    barcodes: [],
    alias_count: 0,
    created_at: '2026-08-25T09:00:00.000Z',
    total_count: 444,
    ...over,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

async function mounted(rows: unknown[] = [row()]) {
  fetchCatalogProducts.mockResolvedValue({ rows, total: 444, offset: 0 })
  const wrapper = mount(CatalogView, { global: { stubs } })
  await flush()
  await wrapper.vm.$nextTick()
  return wrapper
}

const lastArgs = () => fetchCatalogProducts.mock.calls.at(-1)?.[0] as Record<string, unknown>

describe('CatalogView', () => {
  beforeEach(() => {
    fetchCatalogProducts.mockReset()
    createCatalogProduct.mockReset().mockResolvedValue('new-id')
    updateCatalogProduct.mockReset().mockResolvedValue(undefined)
    deleteCatalogProduct.mockReset().mockResolvedValue(undefined)
    catalogConfigured.mockReturnValue(true)
  })

  it('asks for everything on arrival', async () => {
    await mounted()
    expect(lastArgs().type).toBeNull()
    expect(lastArgs().offset).toBe(0)
  })

  it('sends the chosen type to the RPC, and null for All', async () => {
    const wrapper = await mounted()

    await wrapper.find('.seg__item[data-value="commercial"]').trigger('click')
    await flush()
    expect(lastArgs().type).toBe('commercial')

    await wrapper.find('.seg__item[data-value="all"]').trigger('click')
    await flush()
    expect(lastArgs().type).toBeNull()
  })

  it('returns to the first page when a filter changes', async () => {
    const wrapper = await mounted()

    await wrapper.find('.pager__next').trigger('click')
    await flush()
    expect(lastArgs().offset).toBe(25)

    await wrapper.find('.seg__item[data-value="generic"]').trigger('click')
    await flush()
    expect(lastArgs().offset).toBe(0)
  })

  // ─── the filter drawer and its chips ───────────────────────────────────────

  it('passes what the drawer sets straight through to the RPC', async () => {
    const wrapper = await mounted()

    await wrapper.find('.filters-btn').trigger('click')
    await wrapper.find('.drawer__ro').trigger('click')
    await flush()

    expect(lastArgs().market).toBe('RO')
  })

  // false, not absent. The two are the same falsy value in JavaScript and
  // opposite questions here, and "products with no barcode" is the half somebody
  // actually comes to this page to find.
  it('keeps a tri-state set to false rather than dropping it', async () => {
    const wrapper = await mounted()

    await wrapper.find('.filters-btn').trigger('click')
    await wrapper.find('.drawer__nobarcode').trigger('click')
    await flush()

    expect(lastArgs().hasBarcode).toBe(false)
    expect(wrapper.find('.filters-btn__count').text()).toBe('1')
  })

  // The drawer is shut most of the time, and a filtered table looks exactly like
  // a thin catalog. Without the chips the page would be narrowed with nothing on
  // screen saying so.
  it('names every active filter outside the drawer, and removes one on click', async () => {
    const wrapper = await mounted()

    await wrapper.find('.filters-btn').trigger('click')
    await wrapper.find('.drawer__ro').trigger('click')
    await wrapper.find('.drawer__nobarcode').trigger('click')
    await flush()

    // Substring, not equality: each chip also carries an icon and the screen
    // reader's "Remove filter".
    const labels = wrapper.findAll('.chips__item').map((c) => c.text())
    expect(labels.some((l) => l.includes('Market: Romania'))).toBe(true)
    expect(labels.some((l) => l.includes('No barcode'))).toBe(true)

    await wrapper.findAll('.chips__item')[0].trigger('click')
    await flush()
    expect(lastArgs().market).toBeUndefined()
    expect(lastArgs().hasBarcode).toBe(false)
  })

  it('clears every filter at once', async () => {
    const wrapper = await mounted()

    await wrapper.find('.filters-btn').trigger('click')
    await wrapper.find('.drawer__ro').trigger('click')
    await wrapper.find('.drawer__nobarcode').trigger('click')
    await flush()

    await wrapper.find('.chips__clear').trigger('click')
    await flush()

    expect(wrapper.findAll('.chips__item')).toHaveLength(0)
    expect(lastArgs().market).toBeUndefined()
    expect(lastArgs().hasBarcode).toBeUndefined()
  })

  // Filter to eleven rows while sitting on page four and every one of them is
  // off the end. Same rule the type control and the search box already follow.
  it('returns to the first page when a drawer filter changes', async () => {
    const wrapper = await mounted()

    await wrapper.find('.pager__next').trigger('click')
    await flush()
    expect(lastArgs().offset).toBe(25)

    await wrapper.find('.filters-btn').trigger('click')
    await wrapper.find('.drawer__ro').trigger('click')
    await flush()
    expect(lastArgs().offset).toBe(0)
  })

  it('creates when there is no row behind the form, and updates when there is', async () => {
    const wrapper = await mounted()

    await wrapper.find('.head button').trigger('click')
    await wrapper.find('.form__save').trigger('click')
    await flush()
    expect(createCatalogProduct).toHaveBeenCalledTimes(1)
    expect(updateCatalogProduct).not.toHaveBeenCalled()

    await wrapper.find('.row .u-btn').trigger('click')
    await wrapper.find('.form__save').trigger('click')
    await flush()
    expect(updateCatalogProduct).toHaveBeenCalledTimes(1)
    expect(updateCatalogProduct.mock.calls[0][0]).toBe('c-1')
  })

  it('writes nothing when the removal is declined', async () => {
    const wrapper = await mounted()

    await wrapper.findAll('.row .u-btn')[1].trigger('click')
    expect(wrapper.find('.confirm').exists()).toBe(true)

    await wrapper.find('.confirm__no').trigger('click')
    await flush()

    expect(deleteCatalogProduct).not.toHaveBeenCalled()
  })

  it('deletes the row that was asked about, not the first one', async () => {
    const wrapper = await mounted([row({ id: 'c-1' }), row({ id: 'c-2' })])

    await wrapper.findAll('.row')[1].findAll('.u-btn')[1].trigger('click')
    await wrapper.find('.confirm__go').trigger('click')
    await flush()

    expect(deleteCatalogProduct.mock.calls[0][0]).toBe('c-2')
  })

  // The only place the blast radius is stated. A generic confirmation would make
  // this read like the app-database delete, which affects one database and no
  // aliases.
  it('says what a removal actually costs, including the aliases', async () => {
    const wrapper = await mounted([row({ alias_count: 5, barcodes: ['5949000000017'] })])

    await wrapper.findAll('.row .u-btn')[1].trigger('click')
    const message = wrapper.find('.confirm__message').text()

    expect(message).toContain('production and development')
    expect(message).toContain('5 aliases')
    expect(message).toContain('barcode')
  })

  // The bar this replaced scaled to the page maximum, and the page is ordered by
  // popularity, so every row drew at 98-100%. What is actually worth seeing is
  // how much of the number was earned rather than set.
  it('says where a popularity came from rather than drawing a flat bar', async () => {
    const wrapper = await mounted([
      row({ id: 'c-1', popularity: 102, base_weight: 100, add_count: 2 }),
      row({ id: 'c-2', popularity: 100, base_weight: 100, add_count: 0 }),
      row({ id: 'c-3', popularity: 4, base_weight: 0, add_count: 4 }),
    ])

    const splits = wrapper.findAll('.pop__split').map((e) => e.text())
    expect(splits).toEqual(['2 earned', 'editorial only', 'all earned'])

    // Only the rows with real adds take any colour; most of a page is editorial
    // and saying so in colour twenty-five times is noise.
    expect(wrapper.findAll('.pop__split--earned')).toHaveLength(2)
  })

  it('keeps the form open and shows the reason when a write is refused', async () => {
    const wrapper = await mounted()
    createCatalogProduct.mockRejectedValueOnce(
      new Error('The catalog already holds a product that normalises to that name.'),
    )

    await wrapper.find('.head button').trigger('click')
    await wrapper.find('.form__save').trigger('click')
    await flush()

    expect(wrapper.find('.form').exists()).toBe(true)
    expect(wrapper.find('.form__error').text()).toContain('already holds a product')
  })

  // The catalog credentials are optional. An absent catalog is an empty state,
  // not an error, and must not offer an Add button that cannot work.
  it('reports an unconfigured catalog instead of a broken table', async () => {
    catalogConfigured.mockReturnValue(false)
    fetchCatalogProducts.mockResolvedValue({ rows: [], total: 0, offset: 0 })

    const wrapper = mount(CatalogView, { global: { stubs } })
    await flush()

    expect(wrapper.find('.state').exists()).toBe(true)
    expect(wrapper.find('.head button').exists()).toBe(false)
    expect(fetchCatalogProducts).not.toHaveBeenCalled()
  })
})
