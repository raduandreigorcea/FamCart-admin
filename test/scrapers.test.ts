import { describe, it, expect, vi, beforeEach } from 'vitest'

// The scrape run history, read straight from catalog_scrape_runs.
//
// This is the one catalog read that is a table rather than an RPC, and it can
// be: 003_runs.sql grants `select` to authenticated behind a policy that admits
// catalog admins only. What the page needs from it is small but easy to get
// subtly wrong -- newest first, the shop's slug rather than its uuid, and a
// running run's duration measured against now rather than read as zero.

const calls = vi.hoisted(() => ({ table: '', select: '', order: null as unknown, limit: 0 }))
const answer = vi.hoisted(() => ({ data: [] as unknown, error: null as unknown, configured: true }))

vi.mock('../src/lib/supabase', () => ({
  getAppSupabase: () => null,
  getCatalogSupabase: () =>
    answer.configured
      ? {
          from: (table: string) => {
            calls.table = table
            const builder = {
              select: (columns: string) => {
                calls.select = columns
                return builder
              },
              order: (column: string, options: unknown) => {
                calls.order = [column, options]
                return builder
              },
              limit: (n: number) => {
                calls.limit = n
                return builder
              },
              abortSignal: async () => ({ data: answer.data, error: answer.error }),
            }
            return builder
          },
        }
      : null,
}))

const {
  fetchScrapeRuns,
  latestPerShop,
  runDurationMs,
  formatRunDuration,
  expectedCount,
  runMessage,
  ALL_COUNTRIES,
  countriesIn,
  byUrgency,
  STALE_AFTER_MS,
  quietFor,
  isStalled,
  inCountry,
  countryName,
  RUN_HISTORY_LIMIT,
} = await import('../src/lib/data/scrapers')
const { CatalogNotConfigured } = await import('../src/lib/data/catalog')

const signal = () => new AbortController().signal

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
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
    retailer: { slug: 'lidl', name: 'Lidl', country: 'RO' },
    ...over,
  }
}

beforeEach(() => {
  answer.configured = true
  answer.data = []
  answer.error = null
})

describe('fetchScrapeRuns', () => {
  it('asks for the newest runs first, with the shop they belong to', async () => {
    await fetchScrapeRuns(signal())
    expect(calls.table).toBe('catalog_scrape_runs')
    expect(calls.select).toContain('catalog_retailers(slug, name, country)')
    expect(calls.order).toEqual(['started_at', { ascending: false }])
    expect(calls.limit).toBe(RUN_HISTORY_LIMIT)
  })

  it('keeps the slug for identity and the shop’s own name for display', async () => {
    answer.data = [row({ retailer: { slug: 'mega-image', name: 'Mega Image' } })]
    const [run] = await fetchScrapeRuns(signal())
    expect(run.shop).toBe('mega-image')
    expect(run.shopName).toBe('Mega Image')
  })

  // Nine shops are called "Lidl". Without the country the page would list nine
  // identical names and nobody could tell Belgium failing from Italy finishing.
  it('carries the country each shop sells in', async () => {
    answer.data = [row({ retailer: { slug: 'lidl-be', name: 'Lidl', country: 'BE' } })]
    const [run] = await fetchScrapeRuns(signal())
    expect(run.country).toBe('BE')
  })

  it('falls back to the slug when a shop has no name', async () => {
    answer.data = [row({ retailer: { slug: 'penny', name: null } })]
    const [run] = await fetchScrapeRuns(signal())
    expect(run.shopName).toBe('penny')
  })

  it('surfaces the database refusing, rather than an empty history', async () => {
    // An empty list reads as "nothing has ever run", which is a different and
    // far more alarming claim than "could not ask".
    answer.error = { message: 'permission denied for table catalog_scrape_runs', code: '42501' }
    await expect(fetchScrapeRuns(signal())).rejects.toThrow()
  })

  it('refuses plainly when the catalog is not configured', async () => {
    answer.configured = false
    await expect(fetchScrapeRuns(signal())).rejects.toBeInstanceOf(CatalogNotConfigured)
  })
})

describe('latestPerShop', () => {
  it('keeps each shop’s newest run, in the order the shops last ran', async () => {
    answer.data = [
      row({ id: 'c2', retailer: { slug: 'carrefour' }, started_at: '2026-09-13T08:16:15Z' }),
      row({ id: 'a2', retailer: { slug: 'auchan' }, started_at: '2026-09-13T08:15:58Z' }),
      row({ id: 'l2', retailer: { slug: 'lidl' }, started_at: '2026-09-13T06:17:56Z' }),
      row({ id: 'c1', retailer: { slug: 'carrefour' }, started_at: '2026-09-12T09:03:18Z' }),
    ]
    const runs = await fetchScrapeRuns(signal())
    expect(latestPerShop(runs).map((r) => r.id)).toEqual(['c2', 'a2', 'l2'])
  })
})

describe('countriesIn', () => {
  const shop = (slug: string, country: string) =>
    row({ id: slug, retailer: { slug, name: 'Lidl', country } })

  // The selector offers what the page can show, no more: a country with no run
  // yet would be a button that empties the page.
  it('is each country that has a run, once, by code', async () => {
    answer.data = [shop('lidl', 'RO'), shop('lidl-it', 'IT'), shop('lidl-at', 'AT'), shop('hofer', 'AT')]
    expect(countriesIn(await fetchScrapeRuns(signal()))).toEqual(['AT', 'IT', 'RO'])
  })

  it('leaves out a run whose shop has no country', async () => {
    answer.data = [shop('lidl', 'RO'), shop('mystery', '')]
    expect(countriesIn(await fetchScrapeRuns(signal()))).toEqual(['RO'])
  })
})

describe('inCountry', () => {
  it('keeps one country\'s runs, and all of them for ALL_COUNTRIES', async () => {
    answer.data = [
      row({ id: 'a', retailer: { slug: 'lidl', name: 'Lidl', country: 'RO' } }),
      row({ id: 'b', retailer: { slug: 'lidl-it', name: 'Lidl', country: 'IT' } }),
    ]
    const runs = await fetchScrapeRuns(signal())
    expect(inCountry(runs, 'IT').map((r) => r.id)).toEqual(['b'])
    expect(inCountry(runs, ALL_COUNTRIES).map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('byUrgency', () => {
  // With every country on show there is room for one row, so what makes the row
  // is decided here: what broke, then what is moving, then the rest as it came.
  it('puts failed and refused runs first, running next, the rest in their order', async () => {
    answer.data = [
      row({ id: 'done1', status: 'completed' }),
      row({ id: 'run1', status: 'running', retailer: { slug: 'a', name: 'A', country: 'RO' } }),
      row({ id: 'fail', status: 'failed', retailer: { slug: 'b', name: 'B', country: 'RO' } }),
      row({ id: 'done2', status: 'completed', retailer: { slug: 'c', name: 'C', country: 'RO' } }),
      row({ id: 'part', status: 'partial', retailer: { slug: 'd', name: 'D', country: 'RO' } }),
    ]
    expect(byUrgency(await fetchScrapeRuns(signal())).map((r) => r.id)).toEqual([
      'fail', 'part', 'run1', 'done1', 'done2',
    ])
  })
})

describe('the sign of life', () => {
  const now = Date.parse('2026-09-17T10:00:00Z')
  const running = (lastAlive: string | null) =>
    row({ status: 'running', finished_at: null, started_at: '2026-09-17T08:00:00Z', last_alive_at: lastAlive })

  it('asks for the pages read and when the shop was last heard from', async () => {
    await fetchScrapeRuns(signal())
    expect(calls.select).toContain('pages_read')
    expect(calls.select).toContain('last_alive_at')
  })

  it('measures the quiet from the last sign of life', async () => {
    answer.data = [running('2026-09-17T09:59:40Z')]
    const [run] = await fetchScrapeRuns(signal())
    expect(quietFor(run, now)).toBe(20_000)
  })

  // A run from a scraper that predates the sign of life has none, and saying it
  // is stalled would be an alarm about the deploy, not about the shop.
  it('says nothing about a run that never reported one', async () => {
    answer.data = [running(null)]
    const [run] = await fetchScrapeRuns(signal())
    expect(quietFor(run, now)).toBeNull()
    expect(isStalled(run, now)).toBe(false)
  })

  it('calls a running run stalled once the shop has been silent too long', async () => {
    answer.data = [
      running(new Date(now - STALE_AFTER_MS + 1000).toISOString()),
      running(new Date(now - STALE_AFTER_MS - 1000).toISOString()),
    ]
    const [fresh, silent] = await fetchScrapeRuns(signal())
    expect(isStalled(fresh, now)).toBe(false)
    expect(isStalled(silent, now)).toBe(true)
  })

  it('never calls a finished run stalled, however old its last sign', async () => {
    answer.data = [row({ status: 'completed', last_alive_at: '2026-09-01T00:00:00Z' })]
    const [run] = await fetchScrapeRuns(signal())
    expect(isStalled(run, now)).toBe(false)
  })
})

describe('countryName', () => {
  it('says the country in English, as the rest of the dashboard does', () => {
    expect(countryName('GB')).toBe('United Kingdom')
    expect(countryName('RO')).toBe('Romania')
  })

  it('falls back to what it was given when it is not a country code', () => {
    expect(countryName('')).toBe('Unknown country')
    expect(countryName('??')).toBe('??')
  })
})

describe('expectedCount', () => {
  it('estimates from the same shop’s last completed run before this one', async () => {
    answer.data = [
      row({ id: 'now', retailer: { slug: 'mega-image', name: 'Mega Image' }, status: 'running', started_at: '2026-09-14T06:30:00Z', products_found: 4000 }),
      row({ id: 'fail', retailer: { slug: 'mega-image', name: 'Mega Image' }, status: 'failed', started_at: '2026-09-13T06:25:00Z', products_found: 4500 }),
      row({ id: 'lidl', started_at: '2026-09-12T08:00:00Z', products_found: 412 }),
      row({ id: 'good', retailer: { slug: 'mega-image', name: 'Mega Image' }, status: 'completed', started_at: '2026-09-12T06:02:00Z', products_found: 8875 }),
    ]
    const runs = await fetchScrapeRuns(signal())
    expect(expectedCount(runs[0], runs)).toBe(8875)
  })

  it('has no estimate when the shop never completed in the rows at hand', async () => {
    answer.data = [row({ status: 'running', started_at: '2026-09-14T06:30:00Z' })]
    const runs = await fetchScrapeRuns(signal())
    expect(expectedCount(runs[0], runs)).toBeNull()
  })
})

describe('runMessage', () => {
  it('drops the shop from an import failure, since the page already names it', () => {
    expect(runMessage({ shop: 'auchan', error: 'import failed for auchan: Gateway Timeout' })).toBe(
      'Import failed: Gateway Timeout',
    )
  })

  it('leaves any other message whole, capitalised', () => {
    expect(runMessage({ shop: 'carrefour', error: 'abandoned: no result was ever recorded' })).toBe(
      'Abandoned: no result was ever recorded',
    )
    expect(runMessage({ shop: 'lidl', error: null })).toBeNull()
  })
})

describe('formatRunDuration', () => {
  it('says a crawl in hours and minutes, not in decimal minutes', () => {
    expect(formatRunDuration(6_590_000)).toBe('1 h 50 min')
    expect(formatRunDuration(3_117_596)).toBe('52 min')
    expect(formatRunDuration(7_200_000)).toBe('2 h')
    expect(formatRunDuration(8_900)).toBe('9 s')
  })
})

describe('runDurationMs', () => {
  it('measures a finished run from start to finish', () => {
    expect(
      runDurationMs({ started_at: '2026-09-13T06:00:00Z', finished_at: '2026-09-13T06:10:00Z' }),
    ).toBe(600_000)
  })

  it('measures a running run against now, so it visibly grows', () => {
    const now = Date.parse('2026-09-13T06:05:00Z')
    expect(runDurationMs({ started_at: '2026-09-13T06:00:00Z', finished_at: null }, now)).toBe(300_000)
  })
})
