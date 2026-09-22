import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper, type DOMWrapper } from '@vue/test-utils'
import type { Component } from 'vue'

// The Scrapers page: is a shop being read right now, how far has it got, and
// how did the last runs end.
//
// Its reason to exist over the Health panel is the run in progress. A nightly
// crawl takes hours, and "is it moving" is only answerable by a page that asks
// again on its own -- so the refresh is tested, including that it stops when
// the page is left, since a timer that outlives its page keeps querying a small
// database for nobody.

const state = vi.hoisted(() => ({
  runs: [] as unknown[],
  configured: true,
  fetches: 0,
  stats: null as unknown,
  query: {} as Record<string, string>,
}))

// The page reads ?country= and ?run= from the route: the Health banner links
// straight to a shop's run.
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: state.query }),
}))

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
    progress_done: null,
    progress_total: null,
    progress_unit: null,
    stats: null,
    ...over,
  }
}

/** A country segment by its code, or 'All'. Found by text: the codes carry a
 *  hover card rather than a native title. */
function radio(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
  return wrapper
    .findAll('[role="radio"]')
    .find((r) => (r.find('.code').exists() ? r.find('.code').text() : r.text()) === label)!
}

async function mountPage() {
  const wrapper = mount(ScrapersView, { global: { stubs } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  state.query = {}
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
        last_alive_at: new Date().toISOString(),
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

  it('gives each of the newest runs a card, a shop run twice included', async () => {
    state.runs = [
      run({ id: 'c2', shop: 'carrefour', status: 'failed' }),
      run({ id: 'l', shop: 'lidl' }),
      run({ id: 'c1', shop: 'carrefour', status: 'completed' }),
    ]
    const wrapper = await mountPage()
    expect(wrapper.findAll('.shop')).toHaveLength(3)
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

    await radio(wrapper, 'AT').trigger('click')
    expect(wrapper.findAll('.shop')).toHaveLength(2)
    // Both of Austria's runs are cards, so nothing is left for its history.
    expect(wrapper.find('.history').attributes('data-rows')).toBe('0')

    await radio(wrapper, 'All').trigger('click')
    expect(wrapper.findAll('.shop')).toHaveLength(3)
  })

  it('offers All and each country that has a run, by code', async () => {
    state.runs = [
      run({ id: '1', shop: 'lidl-it', country: 'IT' }),
      run({ id: '2', shop: 'lidl', country: 'RO' }),
    ]
    const labels = (await mountPage())
      .findAll('[role="radio"]')
      .map((b) => (b.find('.code').exists() ? b.find('.code').text() : b.text()))
    expect(labels).toEqual(['All', 'IT', 'RO'])
  })

  // The codes in the selector are the terse values the hover card is for: CH is
  // Switzerland, not Czechia. The card replaces the native title, so a code has
  // one tooltip, not two -- and a screen reader still hears the country's name.
  it('shows the full country name on hover over its code in the selector', async () => {
    vi.useFakeTimers()
    state.runs = [
      run({ id: '1', shop: 'lidl-ch', country: 'CH' }),
      run({ id: '2', shop: 'lidl', country: 'RO' }),
    ]
    const wrapper = await mountPage()
    const ch = wrapper.findAll('[role="radio"]').find((r) => r.text().startsWith('CH'))!
    expect(ch.attributes('title')).toBeUndefined()
    expect(ch.text()).toContain('Switzerland')
    await ch.find('.hover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(400)
    expect(document.querySelector('.hover__card')?.textContent).toContain('Switzerland')
    wrapper.unmount()
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
    await radio(wrapper, 'IT').trigger('click')
    expect(wrapper.findAll('.shop')).toHaveLength(1)

    state.runs = [run({ id: '2', shop: 'lidl', country: 'RO' }), run({ id: '3', shop: 'lidl-at', country: 'AT' })]
    await vi.advanceTimersByTimeAsync(30_000)
    await flushPromises()
    expect(wrapper.findAll('.shop')).toHaveLength(2)
    expect(wrapper.find('[role="radio"][aria-checked="true"]').text()).toBe('All')
  })

  // The five newest runs are cards; everything older is the history, and a run
  // is in one or the other, never both.
  it('shows the five newest runs as cards and the rest in the history', async () => {
    state.runs = [
      run({ id: '1', shop: 's1', shopName: 'One', started_at: '2026-09-17T06:06:00Z' }),
      run({ id: '2', shop: 's2', shopName: 'Two', started_at: '2026-09-17T06:05:00Z' }),
      run({ id: '3', shop: 's3', shopName: 'Three', started_at: '2026-09-17T06:04:00Z' }),
      run({ id: '4', shop: 's4', shopName: 'Four', started_at: '2026-09-17T06:03:00Z' }),
      run({ id: '5', shop: 's5', shopName: 'Five', started_at: '2026-09-17T06:02:00Z' }),
      run({ id: '6', shop: 's6', shopName: 'Six', started_at: '2026-09-17T06:01:00Z' }),
      run({ id: '7', shop: 's1', shopName: 'One', started_at: '2026-09-16T06:00:00Z' }),
    ]
    const wrapper = await mountPage()
    const names = wrapper.findAll('.shop__name').map((n) => n.text())
    // The name carries its country now, a hover card of its own.
    expect(names).toEqual(['One RO', 'Two RO', 'Three RO', 'Four RO', 'Five RO'])
    expect(wrapper.find('.history').attributes('data-rows')).toBe('2')
  })

  it('does the same inside a chosen country', async () => {
    state.runs = [1, 2, 3, 4, 5, 6]
      .map((n) => run({ id: `a${n}`, shop: `at${n}`, country: 'AT', started_at: `2026-09-17T0${9 - n}:00:00Z` }))
      .concat(run({ id: 'r', shop: 'lidl', country: 'RO', started_at: '2026-09-17T09:30:00Z' }))
    const wrapper = await mountPage()
    await radio(wrapper, 'AT').trigger('click')
    expect(wrapper.findAll('.shop')).toHaveLength(5)
    expect(wrapper.find('.history').attributes('data-rows')).toBe('1')
  })

  it('says the hour a run started on its card', async () => {
    const started = new Date()
    started.setHours(6, 11, 0, 0)
    state.runs = [run({ started_at: started.toISOString(), finished_at: new Date(started.getTime() + 300_000).toISOString() })]
    const text = (await mountPage()).find('.shop').text()
    expect(text).toContain('Started 06:11')
    expect(text).toContain('took 5 min')
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

    await radio(wrapper, 'IT').trigger('click')
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

  // Carrefour never completes and a shop abroad has no first run behind it; the
  // bar comes from what the scraper itself said it will read.
  it('draws a running shop\'s bar from the plan the scraper reported', async () => {
    state.runs = [
      run({
        shop: 'carrefour', shopName: 'Carrefour', status: 'running', finished_at: null,
        started_at: new Date(Date.now() - 3_600_000).toISOString(),
        progress_done: 1200, progress_total: 3568, progress_unit: 'departments',
      }),
    ]
    const wrapper = await mountPage()
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('1200')
    expect(wrapper.find('.shop__plan').text()).toBe('1,200 of 3,568 departments')
  })

  it('draws a working bar for a running shop with nothing to measure against', async () => {
    state.runs = [run({ status: 'running', finished_at: null, started_at: new Date().toISOString() })]
    const bar = (await mountPage()).find('[role="progressbar"]')
    expect(bar.classes()).toContain('shop__progress--indeterminate')
  })

  it('gives a finished run a full bar and a tick', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('412')
    expect(wrapper.find('.shop__plan').text()).toBe('412 products')
    expect(wrapper.find('.shop__mark').classes()).toContain('shop__mark--good')
    expect(wrapper.find('.shop__mark').classes()).not.toContain('shop__mark--off')
  })

  // A cross where a finished run's tick is: the same slot, so a row of cards
  // still lines up, and an ending you can read without parsing the pill.
  it('marks a failed run with a cross, and shows where it stopped', async () => {
    state.runs = [run({ status: 'failed', progress_done: 223, progress_total: 1490, progress_unit: 'departments' })]
    const wrapper = await mountPage()
    expect(wrapper.find('.shop__plan').text()).toBe('223 of 1,490 departments')
    expect(wrapper.find('.shop__mark').classes()).toContain('shop__mark--bad')
    expect(wrapper.find('.shop__mark').classes()).not.toContain('shop__mark--off')
  })

  it('leaves the mark off a run still going', async () => {
    state.runs = [run({ status: 'running', finished_at: null, last_alive_at: new Date().toISOString() })]
    const wrapper = await mountPage()
    expect(wrapper.find('.shop__mark').classes()).toContain('shop__mark--off')
  })

  // A row of cards lines up only if every card draws every row.
  it('draws the same rows on a card with nothing to put in them', async () => {
    state.runs = [run({ status: 'failed', products_found: 0 })]
    const wrapper = await mountPage()
    expect(wrapper.find('.shop__track').exists()).toBe(true)
    expect(wrapper.find('.shop__plan').exists()).toBe(true)
    expect(wrapper.find('.shop__why').classes()).toContain('shop__why--empty')
  })

  it('calls a run that never beat dead, in a sentence that fits', async () => {
    state.runs = [run({ status: 'running', finished_at: null, started_at: new Date(Date.now() - 8 * 3_600_000).toISOString() })]
    const text = (await mountPage()).text()
    expect(text).toContain('No sign of life since it started')
  })

  it('shows a removal job by what it deleted', async () => {
    state.runs = [
      run({
        shop: 'carrefour', shopName: 'Carrefour', status: 'partial', products_found: 9000,
        stats: { deliberate: true, removals_only: true, purged_listings: 3120, purged_products: 2904 },
      }),
    ]
    const text = (await mountPage()).text()
    expect(text).toContain('Removal')
    expect(text).toContain('3,120')
    expect(text).toContain('listings removed')
    expect(text).not.toContain('New')
    // The products that went with the listings, not `products_found`, which a
    // job that imports nothing leaves at zero however much it deleted.
    expect(text).toContain('Products')
    expect(text).toContain('2,904')
    expect(text).not.toContain('Read')
  })

  // The kind of job survives a bad ending. Both real removal jobs crashed at the
  // very end, after deleting 15,438 listings between them, and a card that put
  // the kind in the status pill could only say "Failed" about those.
  it('still says Removal when a removal job failed', async () => {
    state.runs = [
      run({
        shop: 'carrefour', shopName: 'Carrefour', status: 'failed', products_found: 9000,
        error: 'crawl ended early: carrefour: no product payload on https://carrefour.ro',
        stats: { removals_only: true, purged_listings: 15115 },
      }),
    ]
    const text = (await mountPage()).text()
    expect(text).toContain('Removal')
    expect(text).toContain('Failed')
    expect(text).toContain('15,115')
  })

  // An importing run's card says what it added, and nothing about what went
  // away: the purge count belongs to a removal job, and the sweep count cannot
  // be acted on -- see the comment beside the facts in ScrapersView.
  it('says only what an importing run added', async () => {
    state.runs = [
      run({ pages_read: 880, updated: 3, marked_unavailable: 27, stats: { rejections: {}, purged_listings: 14210 } }),
    ]
    const facts = (await mountPage()).find('.shop__facts').text()
    // Pages on a run that has finished, not only on one still going: the card
    // leads with the effort, the way a removal job's card does.
    expect(facts).toContain('Pages')
    expect(facts).toContain('880')
    expect(facts).toContain('New')
    expect(facts).toContain('Updated')
    expect(facts).not.toContain('Gone')
    expect(facts).not.toContain('Removed')
    expect(facts).not.toContain('14,210')
    expect(facts).not.toContain('27')
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

  // Romania has four shops and dozens of runs; its cards are its five newest runs,
  // not its four shops.
  it('fills the five cards from one shop\'s runs when that is what is newest', async () => {
    state.runs = [1, 2, 3, 4, 5, 6, 7].map((n) => run({ id: `r${n}` }))
    const wrapper = await mountPage()
    expect(wrapper.findAll('.shop')).toHaveLength(5)
    expect(wrapper.find('.history').attributes('data-rows')).toBe('2')
  })

  // From the Health banner: "Lidl BE failed" opens Belgium with that run marked.
  it('opens on the country in the link, and marks the run it names', async () => {
    state.query = { country: 'be', run: 'be-old' }
    state.runs = [
      run({ id: 'it-1', shop: 'lidl-it', country: 'IT' }),
      run({ id: 'be-new', shop: 'lidl-be', country: 'BE' }),
      run({ id: 'ro-1', shop: 'lidl', country: 'RO' }),
    ]
    const wrapper = await mountPage()
    expect(wrapper.find('[role="radio"][aria-checked="true"] .code').text()).toBe('BE')
    expect(wrapper.findAll('.shop')).toHaveLength(1)

    state.runs = [...state.runs, run({ id: 'be-old', shop: 'lidl-be', country: 'BE', status: 'failed' })]
    const again = await mountPage()
    expect(again.find('#run-be-old').classes()).toContain('shop--focus')
  })

  it('ignores a country in the link that has no runs', async () => {
    state.query = { country: 'FR' }
    state.runs = [run({ id: '1', country: 'IT' }), run({ id: '2', shop: 'x', country: 'RO' })]
    const wrapper = await mountPage()
    expect(wrapper.find('[role="radio"][aria-checked="true"]').text()).toBe('All')
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

  // Between the cards and the history it split the page in two; the cards are
  // the history's newest rows, so nothing sits between them.
  it('puts the totals above the cards, so nothing separates the cards from the history', async () => {
    state.stats = {
      counted_at: new Date().toISOString(),
      products: 1, listings: 1, unavailable: 0, identifiers: 0,
      with_barcode: 0, with_price: 0, earned: 0, orphans: 0, retailers: [],
    }
    const html = (await mountPage()).html()
    expect(html.indexOf('class="totals"')).toBeLessThan(html.indexOf('class="shops"'))
    expect(html.indexOf('class="shops"')).toBeLessThan(html.indexOf('class="history"'))
  })

  it('says the catalog is not connected, instead of an empty page', async () => {
    state.configured = false
    const wrapper = await mountPage()
    expect(wrapper.find('.state').exists()).toBe(true)
    expect(state.fetches).toBe(0)
  })
})
