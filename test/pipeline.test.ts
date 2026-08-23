import { describe, expect, it } from 'vitest'
import { IMPORT_SOURCES, buildPipelineSnapshot } from '../src/lib/data/pipeline'
import type { CatalogShape } from '../src/lib/data/products'

// buildPipelineSnapshot reconstructs ingestion history from nothing but the
// rows each run left behind. It is the most reasoning-dense pure function in
// the codebase and, before this, the least verified.

const NOW = Date.parse('2026-08-23T12:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

function shape(over: Partial<CatalogShape> = {}): CatalogShape {
  return {
    total: 0,
    truncated: false,
    bySource: [],
    byVersion: [],
    byMarket: [],
    byCreatedDay: [],
    coverage: { withBarcode: 0, withMaker: 0, withAliases: 0, withMarkets: 0 },
    popularity: { adopted: 0, totalAddCount: 0, topAddCount: 0 },
    ...over,
  }
}

function version(over: Partial<CatalogShape['byVersion'][number]> = {}) {
  return {
    source: 'openfoodfacts',
    version: 'off-2026-08-20',
    rows: 100,
    firstSeen: daysAgo(3),
    lastSeen: daysAgo(3),
    withBarcode: 90,
    withAliases: 50,
    withMarkets: 80,
    ...over,
  }
}

describe('runs', () => {
  it('excludes the curated seed, which is not an import run', () => {
    // The stated rule: the seed has no source_version and was written by hand,
    // so listing it would put an event in the timeline that never happened.
    const snapshot = buildPipelineSnapshot(
      shape({
        byVersion: [
          version(),
          version({ source: 'curated', version: null, rows: 40 }),
        ],
      }),
      NOW,
    )

    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs.every((r) => r.source !== 'curated')).toBe(true)
  })

  it('orders runs newest first', () => {
    const snapshot = buildPipelineSnapshot(
      shape({
        byVersion: [
          version({ version: 'off-old', lastSeen: daysAgo(30) }),
          version({ version: 'off-new', lastSeen: daysAgo(1) }),
          version({ version: 'off-mid', lastSeen: daysAgo(10) }),
        ],
      }),
      NOW,
    )

    expect(snapshot.runs.map((r) => r.version)).toEqual(['off-new', 'off-mid', 'off-old'])
  })

  it('reports the newest run as the last one', () => {
    const snapshot = buildPipelineSnapshot(
      shape({
        byVersion: [
          version({ version: 'off-old', lastSeen: daysAgo(30) }),
          version({ version: 'off-new', lastSeen: daysAgo(2) }),
        ],
      }),
      NOW,
    )

    expect(snapshot.lastRunVersion).toBe('off-new')
    expect(snapshot.lastRunAt).toBe(daysAgo(2))
  })

  it('has no last run when only the curated seed exists', () => {
    const snapshot = buildPipelineSnapshot(
      shape({ byVersion: [version({ source: 'curated', version: null })] }),
      NOW,
    )

    expect(snapshot.runs).toHaveLength(0)
    expect(snapshot.lastRunAt).toBeNull()
    expect(snapshot.lastRunVersion).toBeNull()
  })
})

describe('source health', () => {
  it('lists every import source, including ones that never ran', () => {
    // So a source that has gone completely silent is a visible row rather than
    // an absence nobody notices.
    const snapshot = buildPipelineSnapshot(shape(), NOW)

    expect(snapshot.sources.map((s) => s.source)).toEqual([...IMPORT_SOURCES])
    expect(snapshot.sources.every((s) => s.status === 'never')).toBe(true)
    expect(snapshot.sources.every((s) => s.ageDays === null)).toBe(true)
  })

  it('grades freshness at the documented thresholds', () => {
    const at = (days: number) =>
      buildPipelineSnapshot(
        shape({ byVersion: [version({ lastSeen: daysAgo(days) })] }),
        NOW,
      ).sources.find((s) => s.source === 'openfoodfacts')!

    expect(at(0).status).toBe('fresh')
    expect(at(14).status).toBe('fresh') // inclusive upper bound
    expect(at(15).status).toBe('ageing')
    expect(at(60).status).toBe('ageing') // inclusive upper bound
    expect(at(61).status).toBe('stale')
  })

  it('reports age in whole days', () => {
    const source = buildPipelineSnapshot(
      shape({ byVersion: [version({ lastSeen: daysAgo(7) })] }),
      NOW,
    ).sources.find((s) => s.source === 'openfoodfacts')!

    expect(source.ageDays).toBe(7)
  })

  it('carries per-source totals through from the shape', () => {
    const snapshot = buildPipelineSnapshot(
      shape({
        bySource: [{ source: 'openbeautyfacts', rows: 320, withBarcode: 300, withMarkets: 120 }],
        byVersion: [version({ source: 'openbeautyfacts' })],
      }),
      NOW,
    )

    const beauty = snapshot.sources.find((s) => s.source === 'openbeautyfacts')!
    expect(beauty.rows).toBe(320)
    expect(beauty.withBarcode).toBe(300)
    expect(beauty.withMarkets).toBe(120)
  })

  it('picks the newest version per source when several ran', () => {
    const snapshot = buildPipelineSnapshot(
      shape({
        byVersion: [
          version({ version: 'off-2026-01-01', lastSeen: daysAgo(200) }),
          version({ version: 'off-2026-08-20', lastSeen: daysAgo(3) }),
        ],
      }),
      NOW,
    )

    const off = snapshot.sources.find((s) => s.source === 'openfoodfacts')!
    expect(off.latestVersion).toBe('off-2026-08-20')
    expect(off.status).toBe('fresh')
  })
})

describe('truncation (BG-5)', () => {
  it('travels from the shape into the snapshot', () => {
    expect(buildPipelineSnapshot(shape({ truncated: true }), NOW).truncated).toBe(true)
    expect(buildPipelineSnapshot(shape({ truncated: false }), NOW).truncated).toBe(false)
  })
})
