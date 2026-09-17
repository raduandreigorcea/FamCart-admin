import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { Component } from 'vue'

// The hover card: more about a terse value -- a country code, a user id -- shown
// on hover or keyboard focus, without leaving the page.
//
// What is tested is the contract WCAG 1.4.13 asks of content shown on hover:
// it waits a moment before opening, so a pointer passing over a table does not
// flash cards; it stays open while the pointer moves onto it; it closes on
// Escape without moving the pointer; and it opens from the keyboard too.

const users = vi.hoisted(() => ({ detail: null as unknown, calls: 0 }))

vi.mock('../src/lib/data/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/data/users')>()),
  fetchUserDetail: async () => {
    users.calls++
    return users.detail
  },
}))

const HoverCard = (await import('../src/components/HoverCard.vue')).default as unknown as Component
const CountryCode = (await import('../src/components/CountryCode.vue')).default as unknown as Component
const UserId = (await import('../src/components/UserId.vue')).default as unknown as Component
const { forgetUserCards } = await import('../src/lib/data/userCard')

const stubs = {
  RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  UserAvatar: { props: ['name', 'src'], template: '<img class="avatar" :alt="name" :src="src" />' },
}

function mountCard() {
  return mount(HoverCard, {
    slots: { default: 'BE', card: '<p class="inside">Belgium</p>' },
    attachTo: document.body,
    global: { stubs },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  users.calls = 0
  users.detail = null
  forgetUserCards()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('HoverCard', () => {
  it('opens after a short wait on hover, not at once', async () => {
    const wrapper = mountCard()
    await wrapper.find('.hover').trigger('mouseenter')
    expect(document.querySelector('.inside')).toBeNull()
    await vi.advanceTimersByTimeAsync(400)
    expect(document.querySelector('.inside')?.textContent).toBe('Belgium')
    wrapper.unmount()
  })

  it('does not open when the pointer only passes over', async () => {
    const wrapper = mountCard()
    await wrapper.find('.hover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(100)
    await wrapper.find('.hover').trigger('mouseleave')
    await vi.advanceTimersByTimeAsync(600)
    expect(document.querySelector('.inside')).toBeNull()
    wrapper.unmount()
  })

  it('stays open while the pointer moves onto the card', async () => {
    const wrapper = mountCard()
    await wrapper.find('.hover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(400)
    await wrapper.find('.hover').trigger('mouseleave')
    document.querySelector('.hover__card')!.dispatchEvent(new MouseEvent('mouseenter'))
    await vi.advanceTimersByTimeAsync(600)
    expect(document.querySelector('.inside')).not.toBeNull()
    wrapper.unmount()
  })

  it('closes after the pointer leaves both', async () => {
    const wrapper = mountCard()
    await wrapper.find('.hover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(400)
    await wrapper.find('.hover').trigger('mouseleave')
    await vi.advanceTimersByTimeAsync(600)
    expect(document.querySelector('.inside')).toBeNull()
    wrapper.unmount()
  })

  it('opens on keyboard focus and closes on Escape', async () => {
    const wrapper = mountCard()
    await wrapper.find('.hover').trigger('focusin')
    await vi.advanceTimersByTimeAsync(400)
    expect(document.querySelector('.inside')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(document.querySelector('.inside')).toBeNull()
    wrapper.unmount()
  })

  it('is reachable from the keyboard, and says what it describes while open', async () => {
    const wrapper = mountCard()
    const trigger = wrapper.find('.hover')
    expect(trigger.attributes('tabindex')).toBe('0')
    await trigger.trigger('focusin')
    await vi.advanceTimersByTimeAsync(400)
    const id = trigger.attributes('aria-describedby')
    expect(id).toBeTruthy()
    expect(document.getElementById(id!)?.textContent).toContain('Belgium')
    wrapper.unmount()
  })
  it('keeps the control’s own cursor when it sits inside one', () => {
    const inside = mount(HoverCard, { props: { focusable: false }, slots: { default: 'BE' }, global: { stubs } })
    const alone = mount(HoverCard, { slots: { default: 'BE' }, global: { stubs } })
    expect(inside.find('.hover').classes()).toContain('hover--inside')
    expect(alone.find('.hover').classes()).not.toContain('hover--inside')
  })
})


describe('CountryCode', () => {
  it('shows the code, and the country\'s name on hover', async () => {
    const wrapper = mount(CountryCode, { props: { code: 'ch', note: '2 shops' }, attachTo: document.body, global: { stubs } })
    expect(wrapper.text()).toBe('CH')
    await wrapper.find('.hover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(400)
    const card = document.querySelector('.hover__card')!
    expect(card.textContent).toContain('Switzerland')
    expect(card.textContent).toContain('2 shops')
    wrapper.unmount()
  })
})

describe('UserId', () => {
  const detail = {
    profile: { user_id: 'user_3D7fKKF1I9xyLOo7JxtSKW5N3WE', display_name: 'Radu', image_url: 'https://img/radu.png', households: 2 },
    is_admin: true,
  }

  it('shows the short id, and the person on hover, with a way to their page', async () => {
    users.detail = detail
    const wrapper = mount(UserId, { props: { id: detail.profile.user_id }, attachTo: document.body, global: { stubs } })
    expect(wrapper.text()).toContain('W5N3WE')
    await wrapper.find('.hover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    const card = document.querySelector('.hover__card')!
    expect(card.textContent).toContain('Radu')
    expect(card.textContent).toContain('2 households')
    expect(card.querySelector('img')?.getAttribute('src')).toBe('https://img/radu.png')
    expect(card.querySelector(`a[href="/users/${detail.profile.user_id}"]`)).not.toBeNull()
    wrapper.unmount()
  })

  // A table of fifty ids must not be fifty requests on load, nor one per hover.
  it('asks for a person once, on the first hover, however often it is shown', async () => {
    users.detail = detail
    const a = mount(UserId, { props: { id: 'user_same' }, attachTo: document.body, global: { stubs } })
    const b = mount(UserId, { props: { id: 'user_same' }, attachTo: document.body, global: { stubs } })
    expect(users.calls).toBe(0)
    for (const w of [a, b, a]) {
      await w.find('.hover').trigger('mouseenter')
      await vi.advanceTimersByTimeAsync(400)
      await flushPromises()
      await w.find('.hover').trigger('mouseleave')
      await vi.advanceTimersByTimeAsync(600)
    }
    expect(users.calls).toBe(1)
    a.unmount()
    b.unmount()
  })

  it('says so when the account has no profile any more', async () => {
    users.detail = null
    const wrapper = mount(UserId, { props: { id: 'user_gone' }, attachTo: document.body, global: { stubs } })
    await wrapper.find('.hover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(document.querySelector('.hover__card')!.textContent).toContain('No profile')
    wrapper.unmount()
  })
})
