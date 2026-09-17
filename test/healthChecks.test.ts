import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { Component } from 'vue'

// Health's checks and its two database sizes.
//
// The checks are one line per thing that must be working. Their fetchers reach
// GitHub, the live site and the services, so they are replaced here; the pure
// parts -- scrapersCheck, probeCheck, shopLabel -- stay real, because stubbing a
// pure function tests the stub.

const state = vi.hoisted(() => ({
  site: null as unknown,
  pipelines: [] as unknown[],
  services: [] as unknown[],
  stats: null as unknown,
  health: null as unknown,
  probes: [] as unknown[],
}))

vi.mock('../src/lib/data/checks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/data/checks')>()),
  checkSite: async () => state.site,
  checkPipelines: async () => state.pipelines,
  checkServices: async () => state.services,
}))

vi.mock('../src/lib/data/catalog', () => ({
  catalogConfigured: () => true,
  fetchCatalogStats: async () => state.stats,
}))

vi.mock('../src/lib/data/health', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/data/health')>()),
  probeProjects: async () => state.probes,
  fetchHealth: async () => state.health,
  fetchEventDigest: async () => [],
  fetchSecurityEvents: async () => ({ rows: [], total: 0 }),
  fetchRateLimits: async () => [],
}))

const HealthView = (await import('../src/views/HealthView.vue')).default as unknown as Component

const stubs = {
  PageHeader: { props: ['title'], template: '<div>{{ title }}<slot name="tools" /></div>' },
  PanelCard: {
    props: ['title'],
    template: '<section>{{ title }}<slot name="actions" /><slot /><slot name="footer" /></section>',
  },
  StatTile: { props: ['label', 'value'], template: '<div class="tile">{{ label }}={{ value }}</div>' },
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

const good = (key: string, label: string) => ({ key, label, tone: 'good', detail: 'Fine' })

function healthRow() {
  return {
    database_size: 15_500_000,
    server_version: '17',
    server_time: '2026-09-17T12:00:00Z',
    connections: { total: 10, active: 1, idle_in_transaction: 0 },
    tables: [],
    migrations: [],
  }
}

function statsRow(retailers: unknown[] = []) {
  return {
    counted_at: '2026-09-17T11:45:00Z',
    products: 1, listings: 1, unavailable: 0, identifiers: 0,
    with_barcode: 0, with_price: 0, earned: 0, orphans: 0,
    database_size: 420_000_000,
    retailers,
  }
}

async function mountPage() {
  const wrapper = mount(HealthView, { global: { stubs } })
  await flushPromises()
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  state.site = good('site', 'Live site')
  state.pipelines = [good('app-ci', 'App CI'), good('release', 'Release APK'), good('catalog-ci', 'Catalog CI')]
  state.services = [good('service-sentry', 'Sentry'), good('service-onesignal', 'OneSignal'), good('service-clerk', 'Clerk')]
  state.stats = statsRow()
  state.health = healthRow()
  state.probes = [
    { target: 'app', label: 'App database', ok: true, latencyMs: 80, detail: '' },
    { target: 'catalog', label: 'Catalog project', ok: true, latencyMs: 90, detail: '' },
  ]
})

describe('the database sizes', () => {
  // They were one tile, and it was the app's. The catalog is the big one.
  it('are two tiles, the app database and the catalog database', async () => {
    const tiles = (await mountPage()).findAll('.tile').map((t) => t.text())
    expect(tiles).toContain('App database=15500000')
    expect(tiles).toContain('Catalog database=420000000')
  })

  it('leave the catalog tile empty when the catalog sends no size', async () => {
    state.stats = { ...statsRow(), database_size: undefined }
    const tiles = (await mountPage()).findAll('.tile').map((t) => t.text())
    expect(tiles).toContain('Catalog database=')
  })
})

describe('the checks', () => {
  it('list every thing that must be working, one line each', async () => {
    const labels = (await mountPage()).findAll('.check__label').map((l) => l.text())
    expect(labels).toEqual([
      'App database', 'Catalog project', 'Live site',
      'Sentry', 'OneSignal', 'Clerk',
      'Scrapers',
      'App CI', 'Release APK', 'Catalog CI',
    ])
  })

  it('put a failing pipeline in the banner, so it is not only in the list', async () => {
    state.pipelines = [
      { key: 'app-ci', label: 'App CI', tone: 'bad', detail: 'Failed 2 hours ago', href: 'https://x' },
    ]
    const banner = (await mountPage()).find('.status')
    expect(banner.classes()).toContain('status--bad')
    expect(banner.text()).toContain('App CI: Failed 2 hours ago')
  })

  it('put a site that does not answer in the banner', async () => {
    state.site = { key: 'site', label: 'Live site', tone: 'bad', detail: 'Not answering: Failed to fetch' }
    expect((await mountPage()).find('.status').text()).toContain('Live site: Not answering')
  })

  it('put a pipeline that could not be checked in the banner as a warning, never as a pass', async () => {
    state.pipelines = [{ key: 'app-ci', label: 'App CI', tone: 'warn', detail: 'Not checked: GitHub rate limit' }]
    const banner = (await mountPage()).find('.status')
    expect(banner.text()).toContain('App CI: Not checked')
    expect(banner.text()).not.toContain('Everything is working')
  })

  it('say everything is working when every line is green', async () => {
    const banner = (await mountPage()).find('.status')
    expect(banner.text()).toContain('Everything is working')
  })
})
