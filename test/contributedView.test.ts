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

vi.mock('../src/lib/data/contributed', () => ({ fetchContributedProducts }))

const ContributedView = (await import('../src/views/ContributedView.vue'))
  .default as unknown as Component

const stubs = {
  PageHeader: { props: ['title'], template: '<div class="head">{{ title }}</div>' },
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
      </tr>
    </tbody></table>`,
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
    fetchContributedProducts.mockReset()
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
})
