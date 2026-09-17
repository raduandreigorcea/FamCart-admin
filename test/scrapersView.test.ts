import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { Component } from 'vue'

// The Scrapers page: is a shop being read right now, how far has it got, and
// how did the last runs end.
//
// Its reason to exist over the Health panel is the run in progress. A nightly
// crawl takes hours, and "is it moving" is only answerable by a page that asks
// again on its own -- so the refresh is tested, including that it stops when
// the page is left, since a timer that outlives its page keeps querying a small
// database for nobody.

const state = vi.hoisted(() => ({ runs: [] as unknown[], configured: true, fetches: 0, stats: null as unknown }))

vi.mock('../src/lib/data/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/data/catalog')>()),
  catalogConfigured: () => state.configured,
  fetchCatalogStats: async () => state.stats,
}))

vi.mock('../src/lib/data/scrapers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/data/scrapers')>()),
  fetchScrapeRuns: async () => {
    state.fetches++
    return state.runs
  },
}))

const ScrapersView = (await import('../src/views/ScrapersView.vue')).default as unknown as Component

const stubs = {
  PageHeader: { props: ['title'], template: '<div>{{ title }}<slot name="tools" /></div>' },
  PanelCard: { props: ['title'], template: '<section>{{ title }}<slot /></section>' },
  StateBlock: { props: ['title', 'message'], template: '<div class="state">{{ title }} {{ message }}</div>' },
  StatusPill: { props: ['label'], template: '<span class="pill">{{ label }}</span>' },
  DataTable: { props: ['rows'], template: '<table class="history" :data-rows="rows.length" />' },
  AppIcon: { props: ['name'], template: '<i />' },
}

function run(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    shop: 'lidl',
    shopName: 'Lidl',
    country: 'RO',
    status: 'completed',
    started_at: '2026-09-13T06:17:56Z',
    finished_at: '2026-09-13T06:25:38Z',
    products_found: 412,
    products_valid: 412,
    products_rejected: 0,
    inserted: 0,
    updated: 3,
    unchanged: 409,
    products_created: 0,
    marked_unavailable: 0,
    error: null,
    ...over,
  }
}

async function mountPage() {
  const wrapper = mount(ScrapersView, { global: { stubs } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  state.configured = true
  state.fetches = 0
  state.runs = [run()]
  state.stats = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the scrapers page', () => {
  it('shows a run in progress as running, with how much it has found so far', async () => {
    state.runs = [
      run({
        id: 'm',
        shop: 'mega-image',
        shopName: 'Mega Image',
        status: 'running',
        finished_at: null,
        products_found: 4700,
      }),
    ]
    const text = (await mountPage()).text()
    expect(text).toContain('Mega Image')
    expect(text).toContain('Running')
    expect(text).toContain('4,700')
  })

  it('shows a running shop against what its last completed run read', async () => {
    state.runs = [
      run({ id: 'now', shop: 'mega-image', shopName: 'Mega Image', status: 'running', finished_at: null, started_at: '2026-09-14T06:30:00Z', products_found: 4000 }),
      run({ id: 'before', shop: 'mega-image', shopName: 'Mega Image', status: 'completed', started_at: '2026-09-12T06:02:00Z', products_found: 8875 }),
    ]
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('of about 8,875')
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('4000')
  })

  it('shows why a run failed, in the words it recorded', async () => {
    state.runs = [
      run({ id: 'a', shop: 'auchan', status: 'failed', error: 'import failed for auchan: Gateway Timeout' }),
    ]
    const text = (await mountPage()).text()
    expect(text).toContain('Failed')
    expect(text).toContain('Gateway Timeout')
  })

  it('gives each shop one row, from its newest run', async () => {
    state.runs = [
      run({ id: 'c2', shop: 'carrefour', status: 'failed' }),
      run({ id: 'l', shop: 'lidl' }),
      run({ id: 'c1', shop: 'carrefour', status: 'completed' }),
    ]
    const wrapper = await mountPage()
    expect(wrapper.findAll('.shop-row')).toHaveLength(2)
  })

  // Twenty-two cards was a wall. The groups are what make one table readable:
  // what broke first, then home, then everything abroad.
  it('draws what broke first, then Romania, then the shops abroad', async () => {
    state.runs = [
      run({ id: '1', shop: 'lidl-it', country: 'IT' }),
      run({ id: '2', shop: 'lidl-be', country: 'BE', status: 'failed', error: 'crawl ended early' }),
      run({ id: '3', shop: 'lidl', country: 'RO' }),
    ]
    const wrapper = await mountPage()
    const headings = wrapper.findAll('.shop-group').map((g) => g.text())
    expect(headings).toEqual(['Needs attention', 'Romania', 'Abroad'])
    const firstRow = wrapper.findAll('.shop-row')[0]
    expect(firstRow.text()).toContain('BE')
    expect(firstRow.text()).toContain('Crawl ended early')
  })

  it('names the country beside a shop, so nine Lidls are nine different rows', async () => {
    state.runs = [
      run({ id: '1', shop: 'lidl-it', country: 'IT' }),
      run({ id: '2', shop: 'lidl-at', country: 'AT' }),
    ]
    const countries = (await mountPage()).findAll('.shop-row__country').map((c) => c.text())
    expect(countries).toEqual(['AT', 'IT'])
  })

  it('lists every run it read in the history', async () => {
    state.runs = [run({ id: 'a' }), run({ id: 'b' }), run({ id: 'c' })]
    const wrapper = await mountPage()
    expect(wrapper.find('.history').attributes('data-rows')).toBe('3')
  })

  it('asks again every 30 seconds, and stops when the page is left', async () => {
    vi.useFakeTimers()
    const wrapper = await mountPage()
    expect(state.fetches).toBe(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(state.fetches).toBe(2)

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.fetches).toBe(2)
  })

  it('shows the catalog totals under the shops, and says when they were counted', async () => {
    // Counted on a schedule rather than live, so a number without its age would
    // read as current when it can be a quarter of an hour behind the cards.
    state.stats = {
      counted_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      products: 102742, listings: 108400, unavailable: 38600, identifiers: 58200,
      with_barcode: 58200, with_price: 100000, earned: 3, orphans: 0, retailers: [],
    }
    const text = (await mountPage()).find('.totals').text()
    expect(text).toContain('102.7k')
    expect(text).toContain('products')
    expect(text).toContain('Counted')
  })

  it('says the catalog is not connected, instead of an empty page', async () => {
    state.configured = false
    const wrapper = await mountPage()
    expect(wrapper.find('.state').exists()).toBe(true)
    expect(state.fetches).toBe(0)
  })
})
