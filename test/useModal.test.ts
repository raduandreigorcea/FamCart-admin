import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useModal } from '../src/lib/useModal'

// ConfirmDialog, SideDrawer and CommandPalette each moved focus in, closed on
// Escape and returned focus on close -- and all three declared
// `aria-modal="true"` while letting Tab walk out into the page behind, where
// the links still work and the table rows are still clickable. That attribute
// is a promise the rest of the document is inert. These tests are what makes it
// true.

/** requestAnimationFrame, awaited. useModal defers the initial focus by a frame. */
function frame() {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  document.dispatchEvent(event)
  return event
}

function harness(options: { dismissible?: () => boolean } = {}) {
  const open = ref(true)
  const closed = vi.fn(() => {
    open.value = false
  })

  const component = defineComponent({
    setup() {
      const panel = ref<HTMLElement | null>(null)
      const first = ref<HTMLElement | null>(null)
      useModal({
        open: () => open.value,
        close: closed,
        panel,
        initialFocus: () => first.value,
        dismissible: options.dismissible,
      })
      return () =>
        open.value
          ? h('div', { ref: panel, tabindex: -1, class: 'panel' }, [
              h('button', { ref: first, class: 'first' }, 'first'),
              h('button', { class: 'middle' }, 'middle'),
              h('button', { class: 'last' }, 'last'),
            ])
          : h('p', 'closed')
    },
  })

  const wrapper = mount(component, { attachTo: document.body })
  return { wrapper, open, closed }
}

afterEach(() => {
  document.body.style.overflow = ''
})

describe('useModal focus', () => {
  it('moves focus to the named element on open', async () => {
    const { wrapper } = harness()
    await frame()

    expect(document.activeElement).toBe(wrapper.find('.first').element)
    wrapper.unmount()
  })

  it('returns focus to whatever opened it', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const { wrapper, open } = harness()
    await frame()
    expect(document.activeElement).not.toBe(opener)

    open.value = false
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(opener)
    wrapper.unmount()
    opener.remove()
  })
})

describe('useModal tab trap', () => {
  it('wraps forward from the last element to the first', async () => {
    const { wrapper } = harness()
    await frame()

    const last = wrapper.find('.last').element as HTMLElement
    last.focus()

    const event = press('Tab')
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(wrapper.find('.first').element)
    wrapper.unmount()
  })

  it('wraps backward from the first element to the last', async () => {
    const { wrapper } = harness()
    await frame()

    ;(wrapper.find('.first').element as HTMLElement).focus()

    const event = press('Tab', { shiftKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(wrapper.find('.last').element)
    wrapper.unmount()
  })

  it('pulls focus back in when it is already outside the panel', async () => {
    // The state a mouse click on the page behind leaves you in. Without this,
    // the next Tab continues from there, deeper into the document.
    const outside = document.createElement('button')
    document.body.appendChild(outside)

    const { wrapper } = harness()
    await frame()
    outside.focus()

    press('Tab')
    expect(document.activeElement).toBe(wrapper.find('.first').element)

    wrapper.unmount()
    outside.remove()
  })

  it('leaves an ordinary key alone', async () => {
    const { wrapper } = harness()
    await frame()

    const event = press('ArrowDown')
    expect(event.defaultPrevented).toBe(false)
    wrapper.unmount()
  })
})

describe('useModal escape', () => {
  it('closes on Escape', async () => {
    const { wrapper, closed } = harness()
    await frame()

    press('Escape')
    expect(closed).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('refuses Escape while the modal says it is not dismissible', async () => {
    // ConfirmDialog during a write: dismissing would not cancel the request,
    // only hide whether it worked.
    const { wrapper, closed } = harness({ dismissible: () => false })
    await frame()

    press('Escape')
    expect(closed).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('useModal scroll lock', () => {
  it('locks the page behind and restores it on close', async () => {
    const { wrapper, open } = harness()
    await frame()
    expect(document.body.style.overflow).toBe('hidden')

    open.value = false
    await wrapper.vm.$nextTick()
    expect(document.body.style.overflow).toBe('')

    wrapper.unmount()
  })

  it('stays locked while a second modal is still open', async () => {
    // The palette can open over a drawer. Restoring on the first close would
    // give the page its scrollbar back underneath a dialog that is still there.
    const outer = harness()
    const inner = harness()
    await frame()
    expect(document.body.style.overflow).toBe('hidden')

    inner.open.value = false
    await inner.wrapper.vm.$nextTick()
    expect(document.body.style.overflow).toBe('hidden')

    outer.open.value = false
    await outer.wrapper.vm.$nextTick()
    expect(document.body.style.overflow).toBe('')

    inner.wrapper.unmount()
    outer.wrapper.unmount()
  })

  it('unlocks when a modal is unmounted while still open', async () => {
    // A route change under an open drawer. Nothing calls close, so without the
    // unmount hook the page stays unscrollable for the rest of the session.
    const { wrapper } = harness()
    await frame()
    expect(document.body.style.overflow).toBe('hidden')

    wrapper.unmount()
    expect(document.body.style.overflow).toBe('')
  })
})
