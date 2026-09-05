import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { Component } from 'vue'

// The scrapers panel, which exists for the failure that reports nothing.
//
// A shop changes its markup or moves an endpoint, the scraper keeps completing,
// and the catalog quietly stops growing. Nothing errors: the run is green and
// the number is smaller. So the number the run before it found sits on the same
// row, and a shop that went backwards is marked.
//
// A panel whose whole job is to be noticed has to be tested for being
// noticeable, not merely for rendering.

const stats = vi.hoisted(() => ({ value: null as unknown, configured: true }))

vi.mock('../src/lib/data/catalog', () => ({
  catalogConfigured: () => stats.configured,
  fetchCatalogStats: async () => stats.value,
}))

// Everything else the page asks for answers empty; none of it is what this file
// is about. Only the fetchers are replaced -- reachabilityOf, severityOf and
// failedJobs stay real, because stubbing a pure function tests the stub.
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
  RouterLink: { template: '<a><slot /></a>' },
}

function shop(over: Record<string, unknown> = {}) {
  return {
    slug: 'auchan',
    country: 'RO',
    enabled: true,
    listings: 59700,
    available: 40000,
    last_run: {
      status: 'completed',
      started_at: '2026-09-05T09:00:00Z',
      finished_at: '2026-09-05T11:00:00Z',
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

async function mountHealth() {
  const wrapper = mount(HealthView, { global: { stubs } })
  await flushPromises()
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  stats.configured = true
  stats.value = statsFor([shop()])
})

describe('the scrapers panel', () => {
  it('shows each shop and how its last run ended', async () => {
    const text = (await mountHealth()).text()
    expect(text).toContain('auchan')
    expect(text).toContain('Completed')
  })

  it('puts the previous run beside it, which is the entire point', async () => {
    // Without a delta, a run that read a tenth of a shop and finished cleanly is
    // indistinguishable from one that read all of it.
    const wrapper = await mountHealth()
    expect(wrapper.find('.shop__delta').text()).toContain('839')
  })

  it('marks a shop that went backwards', async () => {
    stats.value = statsFor([shop({ delta: -20000, previous_valid: 80000 })])
    const wrapper = await mountHealth()
    expect(wrapper.findAll('.shop--attention')).toHaveLength(1)
    expect(wrapper.find('.shop__delta--down').exists()).toBe(true)
  })

  it('marks a run that refused to sweep, and shows the reason it gave', async () => {
    // `partial` is neither a failure nor a success: it imported what it saw and
    // refused to conclude anything about the rest. The sentence saying why is
    // the most useful thing on the panel when it appears.
    stats.value = statsFor([
      shop({
        last_run: {
          ...shop().last_run,
          status: 'partial',
          error: 'found 1, previous completed run found 3 (below the 50% floor)',
        },
      }),
    ])
    const wrapper = await mountHealth()
    expect(wrapper.text()).toContain('Refused to sweep')
    expect(wrapper.text()).toContain('below the 50% floor')
    expect(wrapper.findAll('.shop--attention')).toHaveLength(1)
  })

  it('marks a failed run, and never lets it read as a healthy one', async () => {
    stats.value = statsFor([shop({ last_run: { ...shop().last_run, status: 'failed', error: 'circuit open' } })])
    const wrapper = await mountHealth()
    expect(wrapper.text()).toContain('Failed')
    expect(wrapper.findAll('.shop--attention')).toHaveLength(1)
  })

  it('marks a shop that has never run at all', async () => {
    // The quietest failure of the lot: a retailer registered and never scraped
    // reads as an empty shop rather than as a missing job.
    stats.value = statsFor([shop({ last_run: null, delta: null, listings: 0, available: 0 })])
    const wrapper = await mountHealth()
    expect(wrapper.text()).toContain('No scrape has ever run')
    expect(wrapper.findAll('.shop--attention')).toHaveLength(1)
  })

  it('leaves a healthy shop unmarked, so the mark keeps meaning something', async () => {
    const wrapper = await mountHealth()
    expect(wrapper.findAll('.shop')).toHaveLength(1)
    expect(wrapper.findAll('.shop--attention')).toHaveLength(0)
  })

  it('says nothing at all when the catalog is not configured', async () => {
    // The catalog credentials are optional, and their absence is an ordinary
    // state rather than a fault of the shops.
    stats.configured = false
    const wrapper = await mountHealth()
    expect(wrapper.findAll('.shop')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('Scrapers')
  })
})
