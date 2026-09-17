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
    pages_read: 0,
    last_alive_at: null,
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

  it('gives each shop one card, from its newest run', async () => {
    state.runs = [
      run({ id: 'c2', shop: 'carrefour', status: 'failed' }),
      run({ id: 'l', shop: 'lidl' }),
      run({ id: 'c1', shop: 'carrefour', status: 'completed' }),
    ]
    const wrapper = await mountPage()
    expect(wrapper.findAll('.shop')).toHaveLength(2)
  })

  // Twenty-two cards in one grid. The selector cuts it to one country's handful,
  // and the history below says the same thing as the cards.
  it('shows one country\'s shops when that country is chosen', async () => {
    state.runs = [
      run({ id: '1', shop: 'lidl-it', country: 'IT' }),
      run({ id: '2', shop: 'lidl-at', country: 'AT' }),
      run({ id: '3', shop: 'hofer', shopName: 'Hofer', country: 'AT' }),
    ]
    const wrapper = await mountPage()
    expect(wrapper.findAll('.shop')).toHaveLength(3)

    await wrapper.find('[role="radio"][title="Austria"]').trigger('click')
    expect(wrapper.findAll('.shop')).toHaveLength(2)
    expect(wrapper.find('.history').attributes('data-rows')).toBe('2')

    await wrapper.find('[role="radio"][title="Every country"]').trigger('click')
    expect(wrapper.findAll('.shop')).toHaveLength(3)
  })

  it('offers All and each country that has a run, by code', async () => {
    state.runs = [
      run({ id: '1', shop: 'lidl-it', country: 'IT' }),
      run({ id: '2', shop: 'lidl', country: 'RO' }),
    ]
    const labels = (await mountPage()).findAll('[role="radio"]').map((b) => b.text())
    expect(labels).toEqual(['All', 'IT', 'RO'])
  })

  it('offers no choice while every shop is in one country', async () => {
    state.runs = [run({ id: '1' }), run({ id: '2', shop: 'auchan', shopName: 'Auchan' })]
    expect((await mountPage()).find('[role="radiogroup"]').exists()).toBe(false)
  })

  it('goes back to every country when the chosen one has no runs left', async () => {
    vi.useFakeTimers()
    state.runs = [
      run({ id: '1', shop: 'lidl-it', country: 'IT' }),
      run({ id: '2', shop: 'lidl', country: 'RO' }),
      run({ id: '3', shop: 'lidl-at', country: 'AT' }),
    ]
    const wrapper = await mountPage()
    await wrapper.find('[role="radio"][title="Italy"]').trigger('click')
    expect(wrapper.findAll('.shop')).toHaveLength(1)

    state.runs = [run({ id: '2', shop: 'lidl', country: 'RO' }), run({ id: '3', shop: 'lidl-at', country: 'AT' })]
    await vi.advanceTimersByTimeAsync(30_000)
    await flushPromises()
    expect(wrapper.findAll('.shop')).toHaveLength(2)
    expect(wrapper.find('[role="radio"][aria-checked="true"]').text()).toBe('All')
  })

  // Every country at once is a wall of cards. It gets one row, as many as fit --
  // five, the grid's column count, since the test DOM lays nothing out -- and
  // says how many it left.
  // In the order they started, newest first, like the history under them: a
  // shop left off the row is still in that table, failure and all.
  it('shows one row of the newest cards for every country, and how many it left out', async () => {
    state.runs = [
      run({ id: '1', shop: 's1', shopName: 'One', country: 'RO' }),
      run({ id: '2', shop: 's2', shopName: 'Two', country: 'RO' }),
      run({ id: '3', shop: 's3', shopName: 'Three', country: 'IT' }),
      run({ id: '4', shop: 's4', shopName: 'Four', country: 'IT' }),
      run({ id: '5', shop: 's5', shopName: 'Five', country: 'AT' }),
      run({ id: '6', shop: 's6', shopName: 'Six', country: 'AT', status: 'failed' }),
    ]
    const wrapper = await mountPage()
    const names = wrapper.findAll('.shop__name').map((n) => n.text())
    expect(names).toEqual(['One', 'Two', 'Three', 'Four', 'Five'])
    expect(wrapper.find('.shops__more').text()).toContain('+1 more')
  })

  it('shows every card of a chosen country, however many', async () => {
    state.runs = [1, 2, 3, 4, 5, 6].map((n) => run({ id: `a${n}`, shop: `at${n}`, country: 'AT' }))
      .concat(run({ id: 'r', shop: 'lidl', country: 'RO' }))
    const wrapper = await mountPage()
    await wrapper.find('[role="radio"][title="Austria"]').trigger('click')
    expect(wrapper.findAll('.shop')).toHaveLength(6)
    expect(wrapper.find('.shops__more').exists()).toBe(false)
  })

  it('counts the chosen country in the totals line, and drops what is global only', async () => {
    state.runs = [run({ id: '1', shop: 'lidl-it', country: 'IT' }), run({ id: '2', shop: 'lidl', country: 'RO' })]
    state.stats = {
      counted_at: new Date().toISOString(),
      products: 90000, listings: 95000, unavailable: 20000, identifiers: 50000,
      with_barcode: 50000, with_price: 80000, earned: 3, orphans: 700, retailers: [],
      countries: { IT: { products: 225, listings: 230, unavailable: 4, with_barcode: 100 } },
    }
    const wrapper = await mountPage()
    expect(wrapper.find('.totals').text()).toContain('90k')
    expect(wrapper.find('.totals').text()).toContain('sold nowhere')

    await wrapper.find('[role="radio"][title="Italy"]').trigger('click')
    const text = wrapper.find('.totals').text()
    expect(text).toContain('225')
    expect(text).toContain('230')
    expect(text).not.toContain('90k')
    expect(text).not.toContain('sold nowhere')
  })

  // "Is it doing anything?" A running card says how many pages it has read and
  // when the shop last answered, apart from what it has imported.
  it('shows a running shop\'s pages and its last sign of life', async () => {
    state.runs = [
      run({
        status: 'running',
        finished_at: null,
        started_at: new Date(Date.now() - 3_600_000).toISOString(),
        products_found: 0,
        pages_read: 12430,
        last_alive_at: new Date(Date.now() - 20_000).toISOString(),
      }),
    ]
    const text = (await mountPage()).text()
    expect(text).toContain('12,430')
    expect(text).toContain('alive')
    expect(text).toContain('Running')
  })

  it('says a running shop has gone quiet', async () => {
    state.runs = [
      run({ id: 'ok', shop: 'lidl' }),
      run({
        id: 'quiet',
        shop: 'carrefour',
        shopName: 'Carrefour',
        status: 'running',
        finished_at: null,
        started_at: new Date(Date.now() - 3_600_000).toISOString(),
        pages_read: 900,
        last_alive_at: new Date(Date.now() - 14 * 60_000).toISOString(),
      }),
    ]
    const wrapper = await mountPage()
    const card = wrapper.findAll('.shop').find((c) => c.text().includes('Carrefour'))!
    expect(card.text()).toContain('No sign of life')
    expect(card.text()).toContain('14 min')
    expect(card.classes()).toContain('shop--attention')
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

  it('shows the catalog totals under the cards, and says when they were counted', async () => {
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
