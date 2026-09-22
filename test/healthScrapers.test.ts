import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { Component } from 'vue'

// The scrapers, as Health reports them: in the banner, and nowhere else.
//
// The cards live on the Scrapers page. What Health still owes is the failure
// that reports nothing: a shop changes its markup or moves an endpoint, the
// scraper keeps completing, and the catalog quietly stops growing. Nothing
// errors -- the run is green and the number is smaller. So a shop that went
// backwards has to be named at the top of the page exactly like one that failed,
// and a banner whose whole job is to be noticed is tested for what it says.

const stats = vi.hoisted(() => ({ value: null as unknown, configured: true }))

vi.mock('../src/lib/data/catalog', () => ({
  catalogConfigured: () => stats.configured,
  fetchCatalogStats: async () => stats.value,
}))

// Everything else the page asks for answers empty; none of it is what this file
// is about. Only the fetchers are replaced -- reachabilityOf and severityOf stay
// real, because stubbing a pure function tests the stub.
vi.mock('../src/lib/data/health', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/data/health')>()
  return {
    ...actual,
    probeProjects: async () => [],
    fetchHealth: async () => null,
    fetchEventDigest: async () => [],
    fetchSecurityEvents: async () => ({ rows: [], total: 0 }),
    fetchRateLimits: async () => [],
  }
})

// The checks reach GitHub, the live site and the services; none of that is
// this file's business, and a test must not touch the network.
vi.mock('../src/lib/data/checks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/data/checks')>()),
  checkSite: async () => ({ key: 'site', label: 'Live site', tone: 'good', detail: 'Fine' }),
  checkPipelines: async () => [],
  checkServices: async () => [],
}))

const HealthView = (await import('../src/views/HealthView.vue')).default as unknown as Component

const stubs = {
  PageHeader: { props: ['title'], template: '<div>{{ title }}<slot name="tools" /></div>' },
  PanelCard: {
    props: ['title'],
    template: '<section>{{ title }}<slot name="actions" /><slot /><slot name="footer" /></section>',
  },
  StatTile: { props: ['label', 'value'], template: '<div>{{ label }} {{ value }}</div>' },
  StateBlock: { props: ['title'], template: '<div class="state">{{ title }}</div>' },
  StatusPill: { props: ['label'], template: '<span class="pill">{{ label }}</span>' },
  DataTable: { template: '<table><slot /></table>' },
  TablePager: { template: '<div />' },
  SelectField: { template: '<select />' },
  SegmentedControl: { template: '<div />' },
  CopyValue: { props: ['value'], template: '<code>{{ value }}</code>' },
  UserChip: { template: '<div />' },
  AppIcon: { props: ['name'], template: '<i />' },
  RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
}

function shop(over: Record<string, unknown> = {}) {
  return {
    slug: 'auchan',
    country: 'RO',
    enabled: true,
    listings: 59700,
    available: 40000,
    last_run: {
      id: 'run-a',
      status: 'completed',
      // Recent, relative to now: an old date is a shop the nightly job missed,
      // which is a finding of its own and would mask the one under test.
      started_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      finished_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      products_found: 59839,
      products_valid: 59839,
      products_rejected: 0,
      inserted: 27182,
      updated: 112,
      unchanged: 32506,
      marked_unavailable: 0,
      error_count: 0,
      error: null,
    },
    previous_valid: 59000,
    delta: 839,
    ...over,
  }
}

function statsFor(retailers: unknown[]) {
  return {
    counted_at: '2026-09-15T09:45:00Z',
    products: 60103,
    listings: 61312,
    unavailable: 12000,
    identifiers: 59000,
    with_barcode: 59000,
    with_price: 40000,
    earned: 3,
    orphans: 4,
    retailers,
  }
}

async function banner() {
  const wrapper = mount(HealthView, { global: { stubs } })
  await flushPromises()
  await flushPromises()
  return { wrapper, banner: wrapper.find('.status') }
}

beforeEach(() => {
  stats.configured = true
  stats.value = statsFor([shop()])
})

describe('the scrapers on Health', () => {
  it('are not drawn as cards: those live on the Scrapers page', async () => {
    const { wrapper } = await banner()
    expect(wrapper.findAll('.shop')).toHaveLength(0)
  })

  // "Auchan RO": nine shops are Lidl, so every shop is named with its country.
  it('name a failed shop in the banner, linked to where the detail is', async () => {
    stats.value = statsFor([shop({ last_run: { ...shop().last_run, status: 'failed', error: 'circuit open' } })])
    const { banner: b } = await banner()
    expect(b.classes()).toContain('status--bad')
    const link = b.find('a')
    expect(link.text()).toBe('Auchan RO failed its last run')
    // Not the whole page: the shop's country, with that run marked.
    expect(link.attributes('href')).toBe('/scrapers?country=RO&run=run-a')
  })

  it('name a shop that went backwards, because nothing else will', async () => {
    stats.value = statsFor([shop({ delta: -20000, previous_valid: 80000 })])
    const { banner: b } = await banner()
    expect(b.text()).toContain('Auchan RO found 20,000 fewer products than last time')
  })

  it('name a run that refused to sweep', async () => {
    stats.value = statsFor([shop({ last_run: { ...shop().last_run, status: 'partial' } })])
    expect((await banner()).banner.text()).toContain('Auchan RO refused to sweep')
  })

  // Carrefour's nightly run reads groceries only and closes partial on purpose.
  // Naming it every morning would teach the banner to be ignored.
  it('leave a run that was partial on purpose out of the banner', async () => {
    stats.value = statsFor([
      shop({ last_run: { ...shop().last_run, status: 'partial', stats: { deliberate: true } } }),
    ])
    expect((await banner()).banner.text()).not.toContain('Auchan')
  })

  it('name a shop that has never run at all', async () => {
    // The quietest failure of the lot: a retailer registered and never scraped
    // reads as an empty shop rather than as a missing job.
    stats.value = statsFor([shop({ last_run: null, delta: null })])
    expect((await banner()).banner.text()).toContain('Auchan RO has never been scraped')
  })

  it('leave a disabled shop that never ran alone', async () => {
    stats.value = statsFor([shop({ enabled: false, last_run: null, delta: null })])
    expect((await banner()).banner.text()).not.toContain('Auchan')
  })

  it('do not flag a shop that is still reading', async () => {
    // Mid-crawl, the count is compared against a finished run, so every crawl in
    // progress would otherwise read as a collapse.
    stats.value = statsFor([
      shop({ delta: -4375, last_run: { ...shop().last_run, status: 'running', finished_at: null, last_alive_at: new Date().toISOString() } }),
    ])
    expect((await banner()).banner.text()).not.toContain('Auchan')
  })

  it('leave a healthy shop out of the banner, so a mention keeps meaning something', async () => {
    expect((await banner()).banner.text()).not.toContain('Auchan')
  })

  it('say nothing at all when the catalog is not configured', async () => {
    stats.configured = false
    const { wrapper } = await banner()
    expect(wrapper.text()).not.toContain('Auchan')
    expect(wrapper.find('a[href^="/scrapers"]').exists()).toBe(false)
  })
})

describe('the banner', () => {
  it('never reports health when nothing was measured', async () => {
    // The probes answer empty in this file, which is "not measured", not "fine".
    const { banner: b } = await banner()
    expect(b.text()).not.toContain('Everything is working')
    expect(b.text()).toContain('Reachability could not be measured')
  })
})

describe('a shop the banner names by what the new checks can see', () => {
  it('names a crawl that went quiet', async () => {
    stats.value = statsFor([
      shop({
        last_run: {
          ...shop().last_run,
          status: 'running',
          finished_at: null,
          last_alive_at: new Date(Date.now() - 30 * 60_000).toISOString(),
        },
      }),
    ])
    expect((await banner()).banner.text()).toContain('Auchan RO has gone quiet')
  })

  it('names a shop the nightly job did not reach', async () => {
    stats.value = statsFor([
      shop({ last_run: { ...shop().last_run, started_at: new Date(Date.now() - 30 * 3_600_000).toISOString() } }),
    ])
    expect((await banner()).banner.text()).toContain('Auchan RO has not run in over a day')
  })

  it('uses the name the catalog sends for the shop', async () => {
    stats.value = statsFor([
      shop({ slug: 'lidl-be', name: 'Lidl', country: 'BE', last_run: { ...shop().last_run, status: 'failed' } }),
    ])
    expect((await banner()).banner.text()).toContain('Lidl BE failed its last run')
  })
})
