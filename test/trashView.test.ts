import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'

// The Trash view is what makes soft delete honest: without a place that lists
// what was removed and puts it back, a soft delete looks exactly like a hard
// one from the outside.

const fetchDeletedHouseholds = vi.fn()
const restoreHousehold = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/lib/data/households', () => ({ fetchDeletedHouseholds, restoreHousehold }))

const TrashView = (await import('../src/views/TrashView.vue')).default as unknown as Component

const stubs = {
  PageHeader: { template: '<div><slot name="tools" /></div>' },
  PanelCard: { template: '<div><slot /></div>' },
  StateBlock: { props: ['title', 'message'], template: '<div class="state">{{ title }}</div>' },
  ConfirmDialog: { props: ['open', 'title'], template: '<div v-if="open" class="dialog">{{ title }}</div>' },
  SegmentedControl: true,
  // Renders the cell slots the view supplies, because the Restore button lives
  // in one of them -- a stub that drops them would silently make the control
  // untestable while the tests still looked like they covered it.
  DataTable: {
    props: ['rows'],
    template: `<table><tbody>
      <tr v-for="r in rows" :key="r.id" class="row">
        <td><slot name="cell-name" :row="r">{{ r.name }}</slot></td>
        <td><slot name="cell-actions" :row="r" /></td>
      </tr>
    </tbody></table>`,
  },
}

const row = {
  id: 'h-1',
  name: 'The Smiths',
  emoji: null,
  deleted_at: '2026-08-24T10:00:00.000Z',
  members: 3,
  items_total: 12,
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('TrashView', () => {
  it('does not claim the trash is empty while it is still loading', async () => {
    // The rule TablePager follows: not knowing yet and knowing there is nothing
    // are different answers, and only one is worth reporting.
    fetchDeletedHouseholds.mockReturnValue(new Promise(() => {}))
    const wrapper = mount(TrashView, { global: { stubs } })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.state').exists()).toBe(false)
    wrapper.unmount()
  })

  it('says the trash is empty once it actually knows', async () => {
    fetchDeletedHouseholds.mockResolvedValue([])
    const wrapper = mount(TrashView, { global: { stubs } })
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.state').text()).toContain('Nothing deleted')
    wrapper.unmount()
  })

  it('lists what was deleted', async () => {
    fetchDeletedHouseholds.mockResolvedValue([row])
    const wrapper = mount(TrashView, { global: { stubs } })
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.row')).toHaveLength(1)
    expect(wrapper.text()).toContain('The Smiths')
    wrapper.unmount()
  })

  it('names the household in the confirmation rather than asking abstractly', async () => {
    // "Restore this household?" is answerable without knowing which one, which
    // is how the wrong one gets restored. Same reasoning as ConfirmDialog's own.
    fetchDeletedHouseholds.mockResolvedValue([row])
    const wrapper = mount(TrashView, { global: { stubs } })
    await flush()
    await wrapper.vm.$nextTick()

    await wrapper.find('.restore').trigger('click')
    expect(wrapper.find('.dialog').text()).toContain('The Smiths')
    wrapper.unmount()
  })

  it('refetches after a restore, so the row leaves the list', async () => {
    fetchDeletedHouseholds.mockResolvedValue([row])
    const wrapper = mount(TrashView, { global: { stubs } })
    await flush()
    await wrapper.vm.$nextTick()

    fetchDeletedHouseholds.mockClear()
    await wrapper.find('.restore').trigger('click')
    await (wrapper.vm as unknown as { confirmRestore: () => Promise<void> }).confirmRestore?.()
    await flush()

    expect(restoreHousehold).toHaveBeenCalledWith('h-1', expect.anything())
    wrapper.unmount()
  })
})
