import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { mount } from '@vue/test-utils'
import ErrorBoundary from '../src/components/ErrorBoundary.vue'

// BG-2: before this component existed, a render throw anywhere in any view
// unmounted the whole tree and left a blank document -- no message, no route,
// nothing for the one person who could report it to report.

// vue-router hands back ONE reactive route object whose fields mutate as you
// navigate; it does not hand back a new object each time. Modelling that
// faithfully matters here, because the boundary calls useRoute() once at setup
// and watches a property of whatever it got.
const route = reactive({ fullPath: '/users' })

vi.mock('vue-router', () => ({
  useRoute: () => route,
}))

/** A child that throws on render when told to. */
const Bomb = defineComponent({
  props: { explode: { type: Boolean, default: true } },
  setup(props) {
    return () => {
      if (props.explode) throw new Error('the RPC returned a shape this page did not expect')
      return h('p', { class: 'ok' }, 'rendered fine')
    }
  },
})

async function mountBoundary(explode = true) {
  const wrapper = mount(ErrorBoundary, {
    slots: { default: () => h(Bomb, { explode }) },
    global: {
      stubs: {
        StateBlock: {
          props: ['title', 'message'],
          template: '<div class="state">{{ title }} {{ message }}<slot name="action" /></div>',
        },
      },
    },
  })
  // onErrorCaptured fires during the render pass that failed, so the boundary's
  // own markup only appears on the re-render its state change schedules. One
  // frame of nothing then the message is the real behaviour, not a test artefact.
  await nextTick()
  return wrapper
}

describe('ErrorBoundary', () => {
  it('renders its slot untouched when nothing throws', async () => {
    const wrapper = await mountBoundary(false)
    expect(wrapper.find('.ok').exists()).toBe(true)
    expect(wrapper.find('.boundary').exists()).toBe(false)
  })

  it('catches a render error instead of letting the tree unmount', async () => {
    const wrapper = await mountBoundary(true)
    expect(wrapper.find('.boundary').exists()).toBe(true)
    expect(wrapper.find('.ok').exists()).toBe(false)
  })

  it('shows the real error message rather than a paraphrase', async () => {
    // Same argument describeError() makes for Supabase messages: an internal
    // tool's operator is better served by the real text.
    const wrapper = await mountBoundary(true)
    expect(wrapper.text()).toContain('the RPC returned a shape this page did not expect')
  })

  it('offers both a retry and a reload', async () => {
    const wrapper = await mountBoundary(true)
    const labels = wrapper.findAll('button').map((b) => b.text())
    expect(labels).toContain('Try again')
    expect(labels).toContain('Reload the page')
  })

  it('exposes the stack behind a disclosure rather than in the face', async () => {
    const wrapper = await mountBoundary(true)
    expect(wrapper.find('details').exists()).toBe(true)
    expect(wrapper.find('summary').text()).toBe('Technical detail')
  })

  it('clears when the route changes, so one broken page is not a broken shell', async () => {
    route.fullPath = '/users'

    // A slot that throws only on the broken route, which is what RouterView
    // actually does: navigating renders a different component entirely.
    const PerRoute = defineComponent({
      setup() {
        return () => {
          if (route.fullPath === '/users') throw new Error('users page is broken')
          return h('p', { class: 'ok' }, 'households page is fine')
        }
      },
    })

    const wrapper = mount(ErrorBoundary, {
      slots: { default: () => h(PerRoute) },
      global: { stubs: { StateBlock: true } },
    })
    await nextTick()
    expect(wrapper.find('.boundary').exists()).toBe(true)

    // Navigating away is what a person tries first. It must work.
    route.fullPath = '/households'
    await nextTick()
    await nextTick()

    expect(wrapper.find('.boundary').exists()).toBe(false)
    expect(wrapper.find('.ok').exists()).toBe(true)
  })

  it('catches again if the retry re-throws, rather than escaping', async () => {
    const wrapper = await mountBoundary(true)
    await wrapper.findAll('button')[0].trigger('click')
    await nextTick()

    // The slot still throws, so the boundary must hold rather than unmount.
    expect(wrapper.find('.boundary').exists()).toBe(true)
  })
})
