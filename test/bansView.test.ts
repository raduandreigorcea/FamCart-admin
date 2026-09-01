import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'

// The Bans view is what makes both of this dashboard's reversible removals
// honest: without a place that lists what was taken out and puts it back, a soft
// delete looks exactly like a hard one from the outside, and a ban looks like
// nothing at all -- it is set on one user's detail page and, before this view,
// appeared nowhere else in the tool.
//
// The two tables are tested as two, because the bug this view can most easily
// have is one list quietly rendering the other's rows or firing the other's RPC.
// They now share one panel behind a toggle, which adds a second such bug: the
// segment saying one thing while the table below it shows the other.

const fetchDeletedHouseholds = vi.fn()
const restoreHousehold = vi.fn().mockResolvedValue(undefined)
const fetchBannedUsers = vi.fn()
const unbanUser = vi.fn().mockResolvedValue(undefined)

vi.mock('../src/lib/data/households', () => ({ fetchDeletedHouseholds, restoreHousehold }))
vi.mock('../src/lib/data/users', () => ({ fetchBannedUsers, unbanUser }))

const BansView = (await import('../src/views/BansView.vue')).default as unknown as Component

const stubs = {
  PageHeader: { template: '<div><slot name="tools" /></div>' },
  PanelCard: {
    props: ['title', 'note'],
    template: '<section class="panel">{{ note }}<slot name="actions" /><slot /></section>',
  },
  // Renders its segments as buttons so a test can click one to switch scope.
  SegmentedControl: {
    props: ['modelValue', 'segments'],
    emits: ['update:modelValue'],
    template: `<span class="seg"><button
      v-for="s in segments" :key="s.value" class="seg__item"
      :class="{ 'seg__item--on': s.value === modelValue }"
      :data-value="s.value"
      @click="$emit('update:modelValue', s.value)"
    >{{ s.label }}</button></span>`,
  },
  StateBlock: { props: ['title', 'message'], template: '<div class="state">{{ title }}</div>' },
  // Emits rather than just rendering: the confirm path is the one that runs an
  // RPC, and reaching into the component to call its handler would test the
  // function while leaving the wiring to it untested.
  ConfirmDialog: {
    props: ['open', 'title', 'confirmLabel', 'error'],
    emits: ['confirm', 'cancel'],
    template: `<div v-if="open" class="dialog">
      {{ title }}<em class="dialog__label">{{ confirmLabel }}</em>
      <em class="dialog__error">{{ error }}</em>
      <button class="dialog__go" @click="$emit('confirm')">go</button>
      <button class="dialog__no" @click="$emit('cancel')">no</button>
    </div>`,
  },
  RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  CopyValue: { props: ['value', 'display'], template: '<span class="copy">{{ display || value }}</span>' },
  // Renders the cell slots the view supplies, because both reversal buttons
  // live in one -- a stub that dropped them would silently make the controls
  // untestable while the tests still looked like they covered them. Slots the
  // caller did not pass render nothing, so one stub serves both tables.
  DataTable: {
    props: ['rows', 'rowKey'],
    template: `<table><tbody>
      <tr v-for="r in rows" :key="r[rowKey]" class="row">
        <td>
          <slot name="cell-display_name" :row="r" />
          <slot name="cell-name" :row="r" />
          <slot name="cell-reason" :row="r" />
        </td>
        <td><slot name="cell-actions" :row="r" /></td>
      </tr>
    </tbody></table>`,
  },
}

const household = {
  id: 'h-1',
  name: 'The Smiths',
  emoji: null,
  deleted_at: '2026-08-24T10:00:00.000Z',
  members: 3,
  items_total: 12,
}

const banned = {
  user_id: 'user_abc',
  display_name: 'Pip the Plain',
  image_url: null,
  banned_at: '2026-08-25T09:00:00.000Z',
  households: 1,
  reason: 'posted somebody else’s address',
  banned_by: 'user_admin',
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** Switch the toggle to the named scope. */
const choose = (wrapper: ReturnType<typeof mount>, value: string) =>
  wrapper.find(`.seg__item[data-value="${value}"]`).trigger('click')

async function mounted(users: unknown, households: unknown) {
  fetchBannedUsers.mockResolvedValue(users)
  fetchDeletedHouseholds.mockResolvedValue(households)
  const wrapper = mount(BansView, { global: { stubs } })
  await flush()
  await wrapper.vm.$nextTick()
  return wrapper
}

beforeEach(() => {
  // All four, not just the two writes. The fetch mocks were left accumulating
  // across tests, which is invisible until an assertion counts calls rather than
  // just checking one happened -- and then it fails somewhere unrelated to the
  // change that added the assertion.
  restoreHousehold.mockClear()
  unbanUser.mockClear()
  fetchBannedUsers.mockClear()
  fetchDeletedHouseholds.mockClear()
})

describe('BansView', () => {
  it('does not claim either list is empty while it is still loading', async () => {
    // The rule TablePager follows: not knowing yet and knowing there is nothing
    // are different answers, and only one is worth reporting.
    fetchBannedUsers.mockReturnValue(new Promise(() => {}))
    fetchDeletedHouseholds.mockReturnValue(new Promise(() => {}))
    const wrapper = mount(BansView, { global: { stubs } })
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.state')).toHaveLength(0)
    wrapper.unmount()
  })

  it('says the banned list is empty once it actually knows', async () => {
    const wrapper = await mounted([], [])

    expect(wrapper.find('.state').text()).toContain('Nobody is banned')
    wrapper.unmount()
  })

  it('says the household list is empty once switched to it', async () => {
    const wrapper = await mounted([], [])
    await choose(wrapper, 'households')

    expect(wrapper.find('.state').text()).toContain('Nothing withdrawn')
    wrapper.unmount()
  })

  it('opens on people, and shows only that list', async () => {
    // The whole point of the toggle: the list you did not ask for contributes
    // no rows to the page.
    const wrapper = await mounted([banned], [household])

    expect(wrapper.text()).toContain('Pip the Plain')
    expect(wrapper.text()).not.toContain('The Smiths')
    wrapper.unmount()
  })

  it('swaps one list for the other rather than adding to it', async () => {
    const wrapper = await mounted([banned], [household])
    await choose(wrapper, 'households')

    expect(wrapper.text()).toContain('The Smiths')
    expect(wrapper.text()).not.toContain('Pip the Plain')
    expect(wrapper.findAll('.row')).toHaveLength(1)
    wrapper.unmount()
  })

  it('lists banned accounts with the reason they were given', async () => {
    // The reason lives only in the audit trail, so a list that showed the ban
    // without it would leave "why" answerable only from the SQL editor.
    const wrapper = await mounted([banned], [])

    expect(wrapper.findAll('.row')).toHaveLength(1)
    expect(wrapper.text()).toContain('Pip the Plain')
    expect(wrapper.text()).toContain('address')
    wrapper.unmount()
  })

  it('says so in words when a ban carries no reason', async () => {
    // Null is ordinary here -- admin_ban_user accepts a blank reason -- so the
    // cell must not render as a blank that reads as a failed lookup.
    const wrapper = await mounted([{ ...banned, reason: null }], [])

    expect(wrapper.text()).toContain('No reason given')
    wrapper.unmount()
  })

  it('names the account in the confirmation rather than asking abstractly', async () => {
    // "Lift this ban?" is answerable without knowing whose, which is how the
    // wrong one gets lifted. Same reasoning as ConfirmDialog's own.
    const wrapper = await mounted([banned], [household])

    await wrapper.find('.u-btn').trigger('click')
    expect(wrapper.find('.dialog').text()).toContain('Pip the Plain')
    expect(wrapper.find('.dialog__label').text()).toBe('Lift ban')
    wrapper.unmount()
  })

  it('makes the withdrawn household reachable from the row offering to restore it', async () => {
    // A restore is decided by looking at what is inside, and this row is the
    // only place a withdrawn household is listed. The link used to land on
    // "No such household" because admin_household_facts filtered the row out
    // for every caller, including the detail RPC.
    const wrapper = await mounted([banned], [household])
    await choose(wrapper, 'households')

    const link = wrapper.find('.row a')
    expect(link.attributes('href')).toBe('/households/h-1')
    expect(link.text()).toContain('The Smiths')
    wrapper.unmount()
  })

  it('names the household in the confirmation, and offers to restore rather than to lift', async () => {
    const wrapper = await mounted([banned], [household])
    await choose(wrapper, 'households')

    await wrapper.find('.u-btn').trigger('click')
    expect(wrapper.find('.dialog').text()).toContain('The Smiths')
    expect(wrapper.find('.dialog__label').text()).toBe('Restore')
    wrapper.unmount()
  })

  it('lifts the ban on the account whose row was pressed, and nothing else', async () => {
    const wrapper = await mounted([banned], [household])

    await wrapper.find('.u-btn').trigger('click')
    await wrapper.find('.dialog__go').trigger('click')
    await flush()

    expect(unbanUser).toHaveBeenCalledWith('user_abc', expect.anything())
    expect(restoreHousehold).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('restores the household whose row was pressed, and nothing else', async () => {
    const wrapper = await mounted([banned], [household])
    await choose(wrapper, 'households')

    await wrapper.find('.u-btn').trigger('click')
    await wrapper.find('.dialog__go').trigger('click')
    await flush()

    expect(restoreHousehold).toHaveBeenCalledWith('h-1', expect.anything())
    expect(unbanUser).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('refetches the list it changed, so the reversed row leaves it', async () => {
    // A reversal that does not reissue its own query leaves the row it just
    // undid sitting on screen, which reads as the action having failed.
    const wrapper = await mounted([banned], [household])

    fetchBannedUsers.mockClear()
    fetchDeletedHouseholds.mockClear()

    await wrapper.find('.u-btn').trigger('click')
    await wrapper.find('.dialog__go').trigger('click')
    await flush()

    expect(fetchBannedUsers).toHaveBeenCalledTimes(1)
    expect(fetchDeletedHouseholds).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('fetches only the list being shown', async () => {
    // Both queries used to run on mount so the segments could carry counts.
    // They do not any more, so fetching the hidden list is a round trip for a
    // table nobody is looking at -- and the bigger that list, the worse it is.
    const wrapper = await mounted([banned], [household])

    expect(fetchBannedUsers).toHaveBeenCalledTimes(1)
    expect(fetchDeletedHouseholds).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('fetches the other list only once it is asked for', async () => {
    const wrapper = await mounted([banned], [household])
    await choose(wrapper, 'households')
    await flush()

    expect(fetchDeletedHouseholds).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not carry a failed reversal into the next dialog', async () => {
    // Cancel after a failure and press a different row: the fresh dialog must
    // ask its own question, not report the previous row's error.
    unbanUser.mockRejectedValueOnce(new Error('admin_unban_user: boom'))
    const wrapper = await mounted([banned], [household])

    await wrapper.find('.u-btn').trigger('click')
    await wrapper.find('.dialog__go').trigger('click')
    await flush()
    expect(wrapper.find('.dialog__error').text()).toContain('boom')

    await wrapper.find('.dialog__no').trigger('click')
    await wrapper.find('.u-btn').trigger('click')

    expect(wrapper.find('.dialog__error').text()).toBe('')
    wrapper.unmount()
  })

  it('closes the dialog once the reversal goes through', async () => {
    const wrapper = await mounted([banned], [household])

    await wrapper.find('.u-btn').trigger('click')
    expect(wrapper.find('.dialog').exists()).toBe(true)

    await wrapper.find('.dialog__go').trigger('click')
    await flush()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.dialog').exists()).toBe(false)
    wrapper.unmount()
  })
})
