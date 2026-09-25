import { describe, it, expect, vi, beforeEach } from 'vitest'

// The scrape run history, read straight from catalog_scrape_runs.
//
// This is the one catalog read that is a table rather than an RPC, and it can
// be: 003_runs.sql grants `select` to authenticated behind a policy that admits
// catalog admins only. What the page needs from it is small but easy to get
// subtly wrong -- newest first, the shop's slug rather than its uuid, and a
// running run's duration measured against now rather than read as zero.

const calls = vi.hoisted(() => ({ table: '', select: '', order: null as unknown, limit: 0, eq: null as unknown }))
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
              eq: (column: string, value: unknown) => {
                calls.eq = [column, value]
                return builder
              },
              // Thenable, and chainable into maybeSingle(), which supabase-js
              // wants after abortSignal().
              abortSignal: () => {
                const result = Promise.resolve({ data: answer.data, error: answer.error })
                return Object.assign(result, { maybeSingle: () => result })
              },
            }
            return builder
          },
        }
      : null,
}))

const {
  fetchScrapeRuns,
  fetchScrapeRun,
  fetchShopRuns,
  isRunId,
  SHOP_HISTORY_LIMIT,
  runDurationMs,
  formatRunDuration,
  expectedCount,
  runProgress,
  removedCount,
  runMessage,
  ALL_COUNTRIES,
  countriesIn,
  runPill,
  isRemovalJob,
  splitCards,
  CARD_COUNT,
  cardsThatFit,
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
    progress_done: null,
    progress_total: null,
    progress_unit: null,
    stats: null,
    retailer: { slug: 'lidl', name: 'Lidl', country: 'RO' },
    ...over,
  }
}

beforeEach(() => {
  answer.configured = true
  answer.data = []
  answer.error = null
})

const RUN_ID = '8f7c3a52-1d3e-4c55-9a53-2f1b7e0c9d11'

// One run, for its own page (ScrapeRunView), and the shop's other runs beside it.
describe('one run', () => {
  it('refuses what is not a uuid without asking the database', async () => {
    expect(isRunId('abc')).toBe(false)
    expect(isRunId(RUN_ID)).toBe(true)
    calls.table = ''
    expect(await fetchScrapeRun('abc', signal())).toBeNull()
    expect(calls.table).toBe('')
  })

  it('reads the run by id, flattened like the list', async () => {
    answer.data = row({ id: RUN_ID })
    const got = await fetchScrapeRun(RUN_ID, signal())
    expect(calls.eq).toEqual(['id', RUN_ID])
    expect(got?.shop).toBe('lidl')
    expect(got?.shopName).toBe('Lidl')
  })

  it('is null for a run that is not there', async () => {
    answer.data = null
    expect(await fetchScrapeRun(RUN_ID, signal())).toBeNull()
  })

  it("reads one shop's runs, newest first", async () => {
    answer.data = [row()]
    const runs = await fetchShopRuns('ret-1', signal())
    expect(calls.eq).toEqual(['retailer_id', 'ret-1'])
    expect(calls.order).toEqual(['started_at', { ascending: false }])
    expect(calls.limit).toBe(SHOP_HISTORY_LIMIT)
    expect(runs[0].shop).toBe('lidl')
  })
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

describe('splitCards', () => {
  const at = (id: string, slug: string, started: string) =>
    row({ id, started_at: started, retailer: { slug, name: slug, country: 'RO' } })

  // Newest first, as the rows arrive from fetchScrapeRuns.
  const runs = () => [
    at('a2', 'a', '2026-09-17T09:00:00Z'),
    at('b1', 'b', '2026-09-17T08:00:00Z'),
    at('a1', 'a', '2026-09-17T07:00:00Z'),
    at('c1', 'c', '2026-09-17T06:00:00Z'),
    at('d1', 'd', '2026-09-17T05:00:00Z'),
    at('e1', 'e', '2026-09-17T04:00:00Z'),
    at('f1', 'f', '2026-09-17T03:00:00Z'),
  ]

  // The newest runs, whatever their shop: a shop that ran twice lately is on two
  // cards. That is the point -- a country with four shops still shows five runs.
  it('puts the five newest runs on the cards, whatever their shop, and the rest in the history', async () => {
    answer.data = runs()
    const { cards, history } = splitCards(await fetchScrapeRuns(signal()))
    expect(CARD_COUNT).toBe(5)
    expect(cards.map((r) => r.id)).toEqual(['a2', 'b1', 'a1', 'c1', 'd1'])
    expect(history.map((r) => r.id)).toEqual(['e1', 'f1'])
  })

  it('shows every run on a card when there are fewer than five', async () => {
    answer.data = runs().slice(0, 2)
    const { cards, history } = splitCards(await fetchScrapeRuns(signal()))
    expect(cards.map((r) => r.id)).toEqual(['a2', 'b1'])
    expect(history).toEqual([])
  })

  // As many cards as fit on one row, so a narrow window shows three cards and
  // not five wrapped onto two rows. What does not fit is in the history.
  it('takes as many cards as it is given room for', async () => {
    answer.data = runs()
    const { cards, history } = splitCards(await fetchScrapeRuns(signal()), 3)
    expect(cards.map((r) => r.id)).toEqual(['a2', 'b1', 'a1'])
    expect(history.map((r) => r.id)).toEqual(['c1', 'd1', 'e1', 'f1'])
  })
})

describe('cardsThatFit', () => {
  // A card is at least 14rem (224px at 16px) and the gap is 12px.
  const fit = (width: number) => cardsThatFit(width, 16, 12)

  it('fits one card per 14rem and a gap, up to five', () => {
    expect(fit(224)).toBe(1)
    expect(fit(459)).toBe(1)
    expect(fit(460)).toBe(2)
    expect(fit(708)).toBe(3)
    expect(fit(956)).toBe(4)
    expect(fit(1204)).toBe(5)
    expect(fit(3000)).toBe(CARD_COUNT)
  })

  it('always shows at least one', () => {
    expect(fit(0)).toBe(1)
    expect(fit(100)).toBe(1)
  })
})

describe('the sign of life', () => {
  const now = Date.parse('2026-09-17T10:00:00Z')
  const running = (lastAlive: string | null, over: Record<string, unknown> = {}) =>
    row({ status: 'running', finished_at: null, started_at: '2026-09-17T08:00:00Z', last_alive_at: lastAlive, ...over })

  it('asks for the pages read and when the shop was last heard from', async () => {
    await fetchScrapeRuns(signal())
    expect(calls.select).toContain('pages_read')
    expect(calls.select).toContain('last_alive_at')
    expect(calls.select).toContain('progress_done, progress_total, progress_unit')
  })

  it('measures the quiet from the last sign of life', async () => {
    answer.data = [running('2026-09-17T09:59:40Z')]
    const [run] = await fetchScrapeRuns(signal())
    expect(quietFor(run, now)).toBe(20_000)
  })

  // Every scraper beats within a minute, so a run with no beat at all two hours
  // in is dead, not old-fashioned. One just started is given its first minutes.
  it('measures a run that never reported one from its start', async () => {
    answer.data = [running(null), running(null, { started_at: new Date(now - 60_000).toISOString() })]
    const [dead, fresh] = await fetchScrapeRuns(signal())
    expect(quietFor(dead, now)).toBeNull()
    expect(isStalled(dead, now)).toBe(true)
    expect(isStalled(fresh, now)).toBe(false)
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

  // The card and the history table must agree, and the table is where a shop
  // that is not on the row is read -- so both take their pill from here.
  it('gives a stalled run its own pill, and every other run its status', async () => {
    answer.data = [
      running(new Date(now - STALE_AFTER_MS - 1000).toISOString()),
      running(new Date(now - 1000).toISOString()),
      row({ status: 'failed' }),
    ]
    const [silent, alive, failed] = await fetchScrapeRuns(signal())
    expect(runPill(silent, now)).toEqual({ tone: 'warn', label: 'No sign of life', busy: false })
    expect(runPill(alive, now)).toEqual({ tone: 'live', label: 'Running', busy: true })
    expect(runPill(failed, now)).toEqual({ tone: 'bad', label: 'Failed', busy: false })
  })

  // A run partial on purpose -- Carrefour's nightly groceries-only pass, a slice,
  // a removals-only run -- is not a run that refused to sweep.
  it('gives a deliberate partial run a finished pill, and a refused one a warning', async () => {
    answer.data = [
      row({ id: 'planned', status: 'partial', stats: { deliberate: true } }),
      row({ id: 'refused', status: 'partial', stats: { rejections: {} } }),
    ]
    const [planned, refused] = await fetchScrapeRuns(signal())
    expect(runPill(planned, now)).toEqual({ tone: 'good', label: 'Done', busy: false })
    expect(runPill(refused, now)).toEqual({ tone: 'warn', label: 'Refused to sweep', busy: false })
  })

  // A removal job is recognised the same whether the catalog said so in its
  // stats or, on older runs, only in the reason it closed with.
  it('knows a removal job by its stats or by what it closed with', async () => {
    answer.data = [
      row({ id: 'live', status: 'running', finished_at: null, last_alive_at: new Date(now).toISOString(), stats: { removals_only: true } }),
      row({ id: 'old', status: 'partial', stats: { deliberate: true }, error: 'removals only: trusted the grocery pass of 2026-09-16T00:00:00.000Z' }),
      row({ id: 'plain', status: 'completed' }),
    ]
    const [live, old, plain] = await fetchScrapeRuns(signal())
    expect(isRemovalJob(live)).toBe(true)
    expect(isRemovalJob(old)).toBe(true)
    expect(isRemovalJob(plain)).toBe(false)
  })

  // The pill reports the OUTCOME and never the kind: a removal job that crashed
  // has to read as failed, with its kind said beside the shop's name instead.
  it('leaves the kind of job out of the pill', async () => {
    answer.data = [
      row({ id: 'live', status: 'running', finished_at: null, last_alive_at: new Date(now).toISOString(), stats: { removals_only: true } }),
      row({ id: 'done', status: 'partial', stats: { deliberate: true, removals_only: true } }),
      row({ id: 'sad', status: 'failed', stats: { removals_only: true } }),
    ]
    const [live, done, sad] = await fetchScrapeRuns(signal())
    expect(runPill(live, now)).toEqual({ tone: 'live', label: 'Running', busy: true })
    expect(runPill(done, now)).toEqual({ tone: 'good', label: 'Done', busy: false })
    expect(runPill(sad, now).tone).toBe('bad')
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

describe('removedCount', () => {
  // A removals-only run imports nothing and removes thousands; the history must
  // be able to say so.
  it('reads the listings a run removed out of its stats', async () => {
    answer.data = [row({ stats: { rejections: {}, purged_listings: 1234 } }), row({ id: 'old', stats: { rejections: {} } }), row({ id: 'none' })]
    const [removed, older, none] = await fetchScrapeRuns(signal())
    expect(removedCount(removed)).toBe(1234)
    expect(removedCount(older)).toBe(0)
    expect(removedCount(none)).toBe(0)
  })

  it('asks for the stats', async () => {
    await fetchScrapeRuns(signal())
    expect(calls.select).toContain('stats')
  })
})

describe('runProgress', () => {
  const running = (over: Record<string, unknown> = {}) =>
    row({ id: 'now', status: 'running', finished_at: null, started_at: '2026-09-17T08:00:00Z', products_found: 400, ...over })
  const done = row({ id: 'before', status: 'completed', started_at: '2026-09-16T08:00:00Z', products_found: 800 })

  // The scraper's own plan is the truth; the last run is a guess about it.
  it('prefers the plan the scraper reported, in its own unit', async () => {
    answer.data = [running({ progress_done: 30, progress_total: 3568, progress_unit: 'departments' }), done]
    const [now, ...rest] = await fetchScrapeRuns(signal())
    expect(runProgress(now, [now, ...rest])).toEqual({ value: 30, max: 3568, label: '30 of 3,568 departments' })
  })

  it('falls back to what the last completed run read', async () => {
    answer.data = [running(), done]
    const [now, ...rest] = await fetchScrapeRuns(signal())
    expect(runProgress(now, [now, ...rest])).toEqual({ value: 400, max: 800, label: 'of about 800 products' })
  })

  it('has nothing to measure a first run by that reported no plan', async () => {
    answer.data = [running()]
    const [now] = await fetchScrapeRuns(signal())
    expect(runProgress(now, [now])).toBeNull()
  })

  it('draws a finished run as a full bar of what it read', async () => {
    answer.data = [done]
    const [run] = await fetchScrapeRuns(signal())
    expect(runProgress(run, [run])).toEqual({ value: 800, max: 800, label: '800 products' })
  })

  it('keeps a finished run’s plan, so a failed one shows how far it got', async () => {
    answer.data = [row({ status: 'failed', progress_done: 223, progress_total: 1490, progress_unit: 'departments' })]
    const [run] = await fetchScrapeRuns(signal())
    expect(runProgress(run, [run])).toEqual({ value: 223, max: 1490, label: '223 of 1,490 departments' })
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

  // The catalog's reaper (007) explains itself at length, and the card has two
  // lines. What happened, in words that fit: the job never got to close the run.
  it('says an abandoned run was killed, in words that fit a card', () => {
    expect(runMessage({
      shop: 'carrefour',
      error: 'abandoned: no result was ever recorded, so the process died without closing it',
    })).toBe('Killed before it could finish')
  })

  it('leaves any other message whole, capitalised', () => {
    expect(runMessage({ shop: 'lidl-be', error: 'crawl ended early: circuit opened' })).toBe(
      'Crawl ended early: circuit opened',
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
