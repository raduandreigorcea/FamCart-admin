import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { Component } from 'vue'

// One run's own page. It must say "no such run" for an id that is not one, show
// every number the row carries, and keep asking while the run is still going.

const state = vi.hoisted(() => ({
  runId: '8f7c3a52-1d3e-4c55-9a53-2f1b7e0c9d11',
  run: null as unknown,
  shopRuns: [] as unknown[],
  runFetches: 0,
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { runId: state.runId } }),
  RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
}))

vi.mock('../src/lib/data/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/data/catalog')>()),
  catalogConfigured: () => true,
}))

vi.mock('../src/lib/data/scrapers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/data/scrapers')>()),
  fetchScrapeRun: async () => {
    state.runFetches++
    return state.run
  },
  fetchShopRuns: async () => state.shopRuns,
}))

vi.mock('../src/lib/data/runLogs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/data/runLogs')>()),
  fetchRunListings: async () => ({ rows: [], total: 0 }),
}))

const View = (await import('../src/views/ScrapeRunView.vue')).default as unknown as Component

const stubs = {
  PageHeader: { props: ['title'], template: '<header>{{ title }}<slot name="tools" /></header>' },
  PanelCard: { props: ['title'], template: '<section :data-title="title"><slot name="actions" /><slot /></section>' },
  StateBlock: { props: ['title', 'message'], template: '<div class="state">{{ title }} {{ message }}</div>' },
  StatusPill: { props: ['label'], template: '<span class="pill">{{ label }}</span>' },
  LineChart: { props: ['series'], template: '<svg class="chart" />' },
  SegmentedControl: true,
  DataTable: { props: ['rows'], template: '<table />' },
  TablePager: true,
  RunLogPanel: true,
  CountryCode: { props: ['code'], template: '<abbr>{{ code }}</abbr>' },
}

function run(over: Record<string, unknown> = {}) {
  return {
    id: state.runId,
    retailer_id: 'ret-1',
    shop: 'lidl',
    shopName: 'Lidl',
    country: 'RO',
    status: 'completed',
    started_at: '2026-09-25T01:20:00Z',
    finished_at: '2026-09-25T01:24:00Z',
    products_found: 511,
    products_valid: 509,
    products_rejected: 2,
    inserted: 3,
    updated: 40,
    unchanged: 466,
    products_created: 3,
    identifiers_added: 1,
    conflicts: 0,
    marked_unavailable: 4,
    error_count: 0,
    error: null,
    pages_read: 520,
    last_alive_at: '2026-09-25T01:23:50Z',
    progress_done: null,
    progress_total: null,
    progress_unit: null,
    stats: { rejections: { no_price: 2 } },
    ...over,
  }
}

beforeEach(() => {
  state.runId = '8f7c3a52-1d3e-4c55-9a53-2f1b7e0c9d11'
  state.run = run()
  state.shopRuns = [run(), run({ id: 'older', started_at: '2026-09-24T01:20:00Z' })]
  state.runFetches = 0
})

describe('ScrapeRunView', () => {
  it('says there is no such run', async () => {
    state.run = null
    const wrapper = mount(View, { global: { stubs } })
    await flushPromises()
    expect(wrapper.find('.state').text()).toContain('No such run')
  })

  it('shows every count the row carries, the hidden ones included', async () => {
    const wrapper = mount(View, { global: { stubs } })
    await flushPromises()
    const text = wrapper.text()
    for (const label of ['Valid', 'Rejected', 'Inserted', 'Unchanged', 'Identifiers added', 'Conflicts', 'Errors']) {
      expect(text).toContain(label)
    }
    expect(text).toContain('466')
    expect(text).toContain('rejections.no_price')
  })

  it("draws the shop's history", async () => {
    const wrapper = mount(View, { global: { stubs } })
    await flushPromises()
    expect(wrapper.findAll('.chart').length).toBeGreaterThan(0)
  })

  it('asks again while the run is still going, and stops when it is left', async () => {
    vi.useFakeTimers()
    try {
      state.run = run({ status: 'running', finished_at: null, last_alive_at: new Date().toISOString() })
      const wrapper = mount(View, { global: { stubs } })
      await flushPromises()
      const before = state.runFetches
      await vi.advanceTimersByTimeAsync(30_000)
      expect(state.runFetches).toBe(before + 1)
      wrapper.unmount()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(state.runFetches).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not ask again once the run has finished', async () => {
    vi.useFakeTimers()
    try {
      mount(View, { global: { stubs } })
      await flushPromises()
      const before = state.runFetches
      await vi.advanceTimersByTimeAsync(60_000)
      expect(state.runFetches).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
