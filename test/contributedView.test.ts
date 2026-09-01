import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'

// The Contributed view is what is left of a four-tab Catalog section whose RPCs
// all died with the catalog project's rebuild. The half that survived reads the
// APP database, and it is the one worth keeping: every row started as free text
// somebody typed, and promote_product_from_scoped() turns some of them into
// suggestions everybody sees.
//
// Two properties matter and both are invisible when wrong. The scope segment
// must actually reach the RPC -- a control that filters nothing looks identical
// to one that does until you check the arguments. And changing it must return to
// the first page, because page 4 of "all" is not page 4 of "promoted".

const fetchContributedProducts = vi.fn()
const createProduct = vi.fn().mockResolvedValue('new-id')
const updateProduct = vi.fn().mockResolvedValue(undefined)
const deleteProduct = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/lib/data/contributed', () => ({
  fetchContributedProducts,
  createProduct,
  updateProduct,
  deleteProduct,
}))

const ContributedView = (await import('../src/views/ContributedView.vue'))
  .default as unknown as Component

const stubs = {
  PageHeader: {
    props: ['title'],
    template: '<div class="head">{{ title }}<slot name="tools" /></div>',
  },
  PanelCard: { template: '<section><slot name="actions" /><slot /><slot name="footer" /></section>' },
  FilterBar: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: `<input class="filter" :value="modelValue"
      @input="$emit('update:modelValue', $event.target.value)" />`,
  },
  SegmentedControl: {
    props: ['modelValue', 'segments'],
    emits: ['update:modelValue'],
    template: `<span><button
      v-for="s in segments" :key="s.value" class="seg__item" :data-value="s.value"
      @click="$emit('update:modelValue', s.value)"
    >{{ s.label }}</button></span>`,
  },
  TablePager: {
    props: ['total', 'offset', 'limit'],
    emits: ['go'],
    template: `<nav class="pager" :data-offset="offset">
      <button class="pager__next" @click="$emit('go', offset + limit)">next</button>
    </nav>`,
  },
  // Renders the cell slots so the scope pill and the contributor trail are
  // actually exercised rather than merely present in the source.
  DataTable: {
    props: ['rows', 'rowKey', 'columns'],
    template: `<table><tbody>
      <tr v-for="r in rows" :key="r[rowKey]" class="row">
        <td><slot name="cell-name" :row="r" /></td>
        <td><slot name="cell-scope" :row="r" /></td>
        <td><slot name="cell-household_name" :row="r" /></td>
        <td><slot name="cell-actions" :row="r" /></td>
      </tr>
    </tbody></table>`,
  },
  // Both dialogs emit rather than being reached into: the point of these tests
  // is the wiring between a click and an RPC, and calling the handler directly
  // would test the function while leaving that wiring uncovered.
  ProductFormDialog: {
    props: ['open', 'product', 'busy', 'error'],
    emits: ['submit', 'cancel'],
    template: `<div v-if="open" class="form" :data-editing="product ? product.id : ''">
      <em class="form__error">{{ error }}</em>
      <button class="form__save" @click="$emit('submit', { name: 'Typed', maker: null, barcode: null, baseWeight: 0 })">save</button>
      <button class="form__cancel" @click="$emit('cancel')">cancel</button>
    </div>`,
  },
  ConfirmDialog: {
    props: ['open', 'title', 'busy', 'error'],
    emits: ['confirm', 'cancel'],
    template: `<div v-if="open" class="confirm">{{ title }}
      <button class="confirm__go" @click="$emit('confirm')">go</button>
      <button class="confirm__no" @click="$emit('cancel')">no</button>
    </div>`,
  },
  StatusPill: { props: ['label'], template: '<span class="pill">{{ label }}</span>' },
  RouterLink: { props: ['to'], template: '<a class="link" :href="to"><slot /></a>' },
  CopyValue: { props: ['value'], template: '<span>{{ value }}</span>' },
  UserChip: { props: ['id', 'name'], template: '<span class="chip">{{ name || id }}</span>' },
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    name: 'Lapte de casa',
    maker: null,
    barcode: null,
    source: 'community',
    source_version: null,
    household_id: 'h-1',
    household_name: 'The Smiths',
    contributed_by: 'user_abc',
    contributor_name: 'Pip',
    contributor_image_url: null,
    base_weight: 0,
    add_count: 2,
    popularity: 2,
    created_at: '2026-08-25T09:00:00.000Z',
    total_count: 60,
    ...over,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

async function mounted(rows: unknown[] = [row()]) {
  fetchContributedProducts.mockResolvedValue({ rows, total: 60, offset: 0 })
  const wrapper = mount(ContributedView, { global: { stubs } })
  await flush()
  await wrapper.vm.$nextTick()
  return wrapper
}

/** The scope argument of the most recent call. */
const lastScope = () =>
  fetchContributedProducts.mock.calls.at(-1)?.[0]?.scope as string | undefined

const lastOffset = () =>
  fetchContributedProducts.mock.calls.at(-1)?.[0]?.offset as number | undefined

describe('ContributedView', () => {
  beforeEach(() => {
    // All four, not just the read. The write mocks are module-level, so without
    // this a toHaveBeenCalledTimes(1) passes or fails on the order the tests
    // happen to run in, which is the shape of a test that is green by luck.
    fetchContributedProducts.mockReset()
    createProduct.mockReset().mockResolvedValue('new-id')
    updateProduct.mockReset().mockResolvedValue(undefined)
    deleteProduct.mockReset().mockResolvedValue(undefined)
  })

  it('asks for everything on arrival', async () => {
    await mounted()

    expect(fetchContributedProducts).toHaveBeenCalled()
    expect(lastScope()).toBe('all')
    expect(lastOffset()).toBe(0)
  })

  it('sends the chosen scope to the RPC', async () => {
    const wrapper = await mounted()

    await wrapper.find('.seg__item[data-value="promoted"]').trigger('click')
    await flush()

    expect(lastScope()).toBe('promoted')
  })

  // The distinction the page exists to draw: a household row is visible to one
  // household, a promoted row is visible to everybody.
  it('separates a household row from a promoted one', async () => {
    const wrapper = await mounted([
      row({ id: 'p-1', household_id: 'h-1' }),
      row({ id: 'p-2', household_id: null, household_name: null }),
    ])

    const pills = wrapper.findAll('.pill').map((p) => p.text())
    expect(pills).toEqual(['Household', 'Promoted'])
  })

  // Only a household-scoped row has a household to go to. A promoted row was
  // collapsed out of several and belongs to none of them.
  it('links a household row back to its household and a promoted row nowhere', async () => {
    const wrapper = await mounted([
      row({ id: 'p-1', household_id: 'h-1' }),
      row({ id: 'p-2', household_id: null, household_name: null }),
    ])

    const links = wrapper.findAll('.link')
    expect(links).toHaveLength(1)
    expect(links[0].attributes('href')).toBe('/households/h-1')
  })

  it('returns to the first page when the scope changes', async () => {
    const wrapper = await mounted()

    await wrapper.find('.pager__next').trigger('click')
    await flush()
    expect(lastOffset()).toBe(25)

    await wrapper.find('.seg__item[data-value="community"]').trigger('click')
    await flush()

    expect(lastScope()).toBe('community')
    expect(lastOffset()).toBe(0)
  })

  it('returns to the first page when the search changes', async () => {
    const wrapper = await mounted()

    await wrapper.find('.pager__next').trigger('click')
    await flush()
    expect(lastOffset()).toBe(25)

    await wrapper.find('.filter').setValue('lapte')
    await flush()

    expect(lastOffset()).toBe(0)
  })
  // ── writing ────────────────────────────────────────────────────────────────

  it('opens an empty form to add, and a filled one to edit', async () => {
    const wrapper = await mounted()

    await wrapper.find('.head button').trigger('click')
    expect(wrapper.find('.form').attributes('data-editing')).toBe('')

    await wrapper.find('.form__cancel').trigger('click')
    await wrapper.find('.row .u-btn').trigger('click')
    expect(wrapper.find('.form').attributes('data-editing')).toBe('p-1')
  })

  it('creates when there is no row behind the form, and updates when there is', async () => {
    const wrapper = await mounted()

    await wrapper.find('.head button').trigger('click')
    await wrapper.find('.form__save').trigger('click')
    await flush()
    expect(createProduct).toHaveBeenCalledTimes(1)
    expect(updateProduct).not.toHaveBeenCalled()

    await wrapper.find('.row .u-btn').trigger('click')
    await wrapper.find('.form__save').trigger('click')
    await flush()
    expect(updateProduct).toHaveBeenCalledTimes(1)
    expect(updateProduct.mock.calls[0][0]).toBe('p-1')
  })

  // The dialog is the only thing between a mis-tap and a product that everyone
  // could see disappearing. Declining must write nothing at all.
  it('writes nothing when the removal is declined', async () => {
    const wrapper = await mounted()

    await wrapper.findAll('.row .u-btn')[1].trigger('click')
    expect(wrapper.find('.confirm').exists()).toBe(true)

    await wrapper.find('.confirm__no').trigger('click')
    await flush()

    expect(deleteProduct).not.toHaveBeenCalled()
    expect(wrapper.find('.confirm').exists()).toBe(false)
  })

  it('deletes the row that was asked about, not the first one', async () => {
    const wrapper = await mounted([row({ id: 'p-1' }), row({ id: 'p-2' })])

    await wrapper.findAll('.row')[1].findAll('.u-btn')[1].trigger('click')
    await wrapper.find('.confirm__go').trigger('click')
    await flush()

    expect(deleteProduct).toHaveBeenCalledTimes(1)
    expect(deleteProduct.mock.calls[0][0]).toBe('p-2')
  })

  // A create can land anywhere in an ordering this page does not control, so the
  // list has to be re-read rather than patched.
  it('refetches after a successful write', async () => {
    const wrapper = await mounted()
    const before = fetchContributedProducts.mock.calls.length

    await wrapper.find('.head button').trigger('click')
    await wrapper.find('.form__save').trigger('click')
    await flush()

    expect(fetchContributedProducts.mock.calls.length).toBeGreaterThan(before)
  })

  // The RPCs raise sentences written to be shown. A dialog that closed on a
  // failure would report a success that never happened.
  it('keeps the form open and shows the reason when a write is refused', async () => {
    const wrapper = await mounted()
    createProduct.mockRejectedValueOnce(
      Object.assign(new Error('Another product already claims that barcode.'), {
        code: 'P0001',
      }),
    )

    await wrapper.find('.head button').trigger('click')
    await wrapper.find('.form__save').trigger('click')
    await flush()

    expect(wrapper.find('.form').exists()).toBe(true)
    expect(wrapper.find('.form__error').text()).toContain('already claims that barcode')
  })
})
