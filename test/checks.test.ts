import { describe, it, expect } from 'vitest'

// The checks on Health: one line each for the things that must be working --
// the live site, the pipelines, the services, the scrapers -- green or not.
//
// Every one of them reaches something outside this dashboard, so each takes its
// fetch as an argument and is tested against a scripted one. What matters most
// is the rule the whole page keeps: a check that could not be made is never
// reported as passing.

import {
  PIPELINES,
  SCRAPE_WINDOW_MS,
  checkPipeline,
  checkServices,
  checkSite,
  probeCheck,
  scrapersCheck,
  shopLabel,
} from '../src/lib/data/checks'
import { ServiceUnavailable } from '../src/lib/data/services'
import type { RetailerHealth } from '../src/lib/data/catalog'

const signal = () => new AbortController().signal
const NOW = Date.parse('2026-09-17T12:00:00Z')

function answering(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

const failing: typeof fetch = (async () => {
  throw new TypeError('Failed to fetch')
}) as unknown as typeof fetch

describe('checkSite', () => {
  it('passes when the site answers at all', async () => {
    const check = await checkSite(signal(), answering('ok'))
    expect(check.tone).toBe('good')
    expect(check.label).toBe('Live site')
  })

  it('fails when the request never gets an answer', async () => {
    const check = await checkSite(signal(), failing)
    expect(check.tone).toBe('bad')
    expect(check.detail).toContain('Failed to fetch')
  })
})

describe('checkPipeline', () => {
  const ci = PIPELINES[0]
  const run = (over: Record<string, unknown>) => ({
    workflow_runs: [
      {
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/x/y/actions/runs/1',
        updated_at: '2026-09-17T09:00:00Z',
        ...over,
      },
    ],
  })

  it('names the pipelines it watches: app CI, the release, catalog CI', () => {
    expect(PIPELINES.map((p) => p.label)).toEqual(['App CI', 'Release APK', 'Catalog CI'])
  })

  it('passes a pipeline whose last run succeeded, and links to it', async () => {
    const check = await checkPipeline(ci, signal(), answering(run({})), NOW)
    expect(check.tone).toBe('good')
    expect(check.detail).toContain('Passed')
    expect(check.href).toBe('https://github.com/x/y/actions/runs/1')
  })

  it('fails a pipeline whose last run failed', async () => {
    const check = await checkPipeline(ci, signal(), answering(run({ conclusion: 'failure' })), NOW)
    expect(check.tone).toBe('bad')
    expect(check.detail).toContain('Failed')
  })

  it('shows a pipeline still going as running, not as passed', async () => {
    const check = await checkPipeline(ci, signal(), answering(run({ status: 'in_progress', conclusion: null })), NOW)
    expect(check.tone).toBe('live')
  })

  it('warns on a cancelled run', async () => {
    const check = await checkPipeline(ci, signal(), answering(run({ conclusion: 'cancelled' })), NOW)
    expect(check.tone).toBe('warn')
  })

  // GitHub allows sixty unauthenticated requests an hour. Running out is not a
  // broken pipeline, and it is not a passing one either.
  it('says it could not check when GitHub refuses, rather than passing', async () => {
    const check = await checkPipeline(ci, signal(), answering({ message: 'API rate limit exceeded' }, 403), NOW)
    expect(check.tone).toBe('warn')
    expect(check.detail).toContain('Not checked')
  })

  it('says it could not check when there is no run at all', async () => {
    const check = await checkPipeline(ci, signal(), answering({ workflow_runs: [] }), NOW)
    expect(check.tone).toBe('warn')
  })
})

describe('checkServices', () => {
  it('gives each service its own line, connected or not', async () => {
    const checks = await checkServices(signal(), {
      sentry: async () => [],
      onesignal: async () => {
        throw new ServiceUnavailable('onesignal', 'not_configured', ['ONESIGNAL_APP_ID'])
      },
      clerk: async () => {
        throw new Error('admin-services/clerk: HTTP 502')
      },
    })
    expect(checks.map((c) => [c.label, c.tone])).toEqual([
      ['Sentry', 'good'],
      ['OneSignal', 'bad'],
      ['Clerk', 'bad'],
    ])
    expect(checks[1].detail).toContain('ONESIGNAL_APP_ID')
    expect(checks[2].detail).toContain('502')
  })
})

describe('probeCheck', () => {
  it('turns a probe into a line with its latency', () => {
    const check = probeCheck({ target: 'app', label: 'App database', ok: true, latencyMs: 84, detail: '' })
    expect(check).toMatchObject({ label: 'App database', tone: 'good' })
    expect(check.detail).toContain('84')
  })

  it('fails a probe that did not answer', () => {
    const check = probeCheck({ target: 'catalog', label: 'Catalog project', ok: false, latencyMs: null, detail: 'timeout' })
    expect(check).toMatchObject({ tone: 'bad', detail: 'timeout' })
  })
})

describe('shopLabel', () => {
  // Nine shops are Lidl. The name alone says nothing, the slug read "lidl be".
  it('is the shop\'s name with its country in capitals', () => {
    expect(shopLabel({ slug: 'lidl-be', name: 'Lidl', country: 'be' })).toBe('Lidl BE')
  })

  it('makes a name out of the slug when the catalog sends none', () => {
    expect(shopLabel({ slug: 'mega-image', country: 'RO' })).toBe('Mega image RO')
  })
})

describe('scrapersCheck', () => {
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
  function shop(slug: string, country: string, run: Record<string, unknown> | null, over: Partial<RetailerHealth> = {}): RetailerHealth {
    return {
      slug,
      name: slug.split('-')[0].replace(/^./, (c) => c.toUpperCase()),
      country,
      enabled: true,
      listings: 1,
      available: 1,
      last_run: run === null ? null : ({
        status: 'completed',
        started_at: hoursAgo(3),
        finished_at: hoursAgo(2),
        products_found: 1, products_valid: 1, products_rejected: 0,
        inserted: 0, updated: 0, unchanged: 1, marked_unavailable: 0, error_count: 0,
        error: null,
        last_alive_at: null,
        ...run,
      } as RetailerHealth['last_run']),
      previous_valid: 1,
      delta: 0,
      ...over,
    }
  }

  it('passes when every shop ran recently and none broke', () => {
    const check = scrapersCheck([shop('lidl', 'RO', {}), shop('lidl-it', 'IT', {})], NOW)
    expect(check.tone).toBe('good')
    expect(check.detail).toContain('2 shops')
  })

  it('names the shops that failed, went quiet, never ran or are overdue', () => {
    const check = scrapersCheck(
      [
        shop('lidl-be', 'BE', { status: 'failed' }),
        shop('carrefour', 'RO', { status: 'running', finished_at: null, last_alive_at: hoursAgo(1) }),
        shop('aldi-ie', 'IE', null),
        shop('hofer', 'AT', { started_at: new Date(NOW - SCRAPE_WINDOW_MS - 60_000).toISOString() }),
        shop('lidl', 'RO', {}),
      ],
      NOW,
    )
    expect(check.tone).toBe('bad')
    expect(check.detail).toContain('Lidl BE failed')
    expect(check.detail).toContain('Carrefour RO has gone quiet')
    expect(check.detail).toContain('Aldi IE never ran')
    expect(check.detail).toContain('Hofer AT has not run')
    expect(check.detail).not.toContain('Lidl RO')
  })

  it('only warns for a run that refused to sweep', () => {
    const check = scrapersCheck([shop('auchan', 'RO', { status: 'partial' })], NOW)
    expect(check.tone).toBe('warn')
  })

  it('leaves a disabled shop out', () => {
    const check = scrapersCheck([shop('penny', 'RO', null, { enabled: false }), shop('lidl', 'RO', {})], NOW)
    expect(check.tone).toBe('good')
  })

  it('is not a pass when the scrapers could not be read', () => {
    expect(scrapersCheck(null, NOW).tone).toBe('idle')
  })
})
