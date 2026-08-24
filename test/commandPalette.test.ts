import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// The palette fires three requests at three databases per search. Before this,
// each got `new AbortController().signal` -- a controller nobody kept and
// nobody ever aborted -- so a superseded search was superseded only in its
// effect on screen. The requests themselves ran to completion.
//
// These tests hold the signals the component hands out and assert on when they
// are aborted, because that is the only observable difference between a
// cancelled request and a discarded one.

const signals: AbortSignal[] = []

function record(signal: AbortSignal) {
  signals.push(signal)
  return Promise.resolve({ rows: [], total: 0, offset: 0 })
}

vi.mock('../src/lib/data/users', () => ({
  fetchUsers: (_params: unknown, signal: AbortSignal) => record(signal),
}))
vi.mock('../src/lib/data/households', () => ({
  fetchHouseholds: (_params: unknown, signal: AbortSignal) => record(signal),
}))
vi.mock('../src/lib/data/products', () => ({
  catalogConfigured: () => true,
  fetchCatalogProducts: (_params: unknown, signal: AbortSignal) => record(signal),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const CommandPalette = (await import('../src/components/CommandPalette.vue')).default

function mountPalette() {
  return mount(CommandPalette, {
    props: { open: true },
    global: { stubs: { AppIcon: true } },
  })
}

/** Type into the box and let the 180ms debounce elapse. */
async function search(wrapper: ReturnType<typeof mountPalette>, term: string) {
  await wrapper.find('input').setValue(term)
  await vi.advanceTimersByTimeAsync(200)
}

beforeEach(() => {
  signals.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CommandPalette cancellation', () => {
  it('passes one shared signal to all three sources', async () => {
    const wrapper = mountPalette()
    await search(wrapper, 'smith')

    expect(signals).toHaveLength(3)
    expect(new Set(signals).size).toBe(1)
    wrapper.unmount()
  })

  it('aborts the previous search when a new one starts', async () => {
    const wrapper = mountPalette()
    await search(wrapper, 'smith')
    const first = signals[0]
    expect(first.aborted).toBe(false)

    await search(wrapper, 'smithers')
    expect(first.aborted).toBe(true)
    expect(signals[signals.length - 1].aborted).toBe(false)

    wrapper.unmount()
  })

  it('aborts in flight work when the palette closes', async () => {
    const wrapper = mountPalette()
    await search(wrapper, 'smith')
    const inFlight = signals[0]

    await wrapper.setProps({ open: false })
    expect(inFlight.aborted).toBe(true)

    wrapper.unmount()
  })

  it('does not schedule a further search after closing', async () => {
    // Closing clears `query`, which trips the watcher that schedules a run. The
    // timer has to go with the request, or the close leaves work behind it.
    const wrapper = mountPalette()
    await search(wrapper, 'smith')
    expect(signals).toHaveLength(3)

    await wrapper.setProps({ open: false })
    await vi.advanceTimersByTimeAsync(500)

    expect(signals).toHaveLength(3)
    wrapper.unmount()
  })

  it('aborts on unmount', async () => {
    const wrapper = mountPalette()
    await search(wrapper, 'smith')
    const inFlight = signals[0]

    wrapper.unmount()
    expect(inFlight.aborted).toBe(true)
  })
})
