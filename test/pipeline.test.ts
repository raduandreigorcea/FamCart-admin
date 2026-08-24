import { describe, expect, it } from 'vitest'
import {
  IMPORT_SOURCES,
  buildPipelineSnapshot,
  runFunnel,
  runLedger,
  type RunRow,
} from '../src/lib/data/pipeline'
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
      [],
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
      [],
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
      [],
      NOW,
    )

    expect(snapshot.lastRunVersion).toBe('off-new')
    expect(snapshot.lastRunAt).toBe(daysAgo(2))
  })

  it('has no last run when only the curated seed exists', () => {
    const snapshot = buildPipelineSnapshot(
      shape({ byVersion: [version({ source: 'curated', version: null })] }),
      [],
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
    const snapshot = buildPipelineSnapshot(shape(), [], NOW)

    expect(snapshot.sources.map((s) => s.source)).toEqual([...IMPORT_SOURCES])
    expect(snapshot.sources.every((s) => s.status === 'never')).toBe(true)
    expect(snapshot.sources.every((s) => s.ageDays === null)).toBe(true)
  })

  it('grades freshness at the documented thresholds', () => {
    const at = (days: number) =>
      buildPipelineSnapshot(
        shape({ byVersion: [version({ lastSeen: daysAgo(days) })] }),
        [],
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
      [],
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
      [],
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
      [],
      NOW,
    )

    const off = snapshot.sources.find((s) => s.source === 'openfoodfacts')!
    expect(off.latestVersion).toBe('off-2026-08-20')
    expect(off.status).toBe('fresh')
  })
})

describe('truncation (BG-5)', () => {
  it('travels from the shape into the snapshot', () => {
    expect(buildPipelineSnapshot(shape({ truncated: true }), [], NOW).truncated).toBe(true)
    expect(buildPipelineSnapshot(shape({ truncated: false }), [], NOW).truncated).toBe(false)
  })
})

// ─── the ledger the importer now writes ──────────────────────────────────────
//
// Pure functions over a run row, not queries. Every number they return is a
// column the drawer already holds, so there is nothing left to fetch.

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    source: 'openfoodfacts',
    source_version: 'off-2026-08-20',
    scored_at: '2026-08-19T12:46:38.327Z',
    loaded_at: '2026-08-20T18:05:00.000Z',
    records_read: 43382,
    records_rejected: 12859,
    records_auto: 10833,
    records_review: 12255,
    records_dropped: 7435,
    records_capped: 0,
    inserted: 7683,
    updated_imported: 3012,
    updated_provenance_only: 0,
    skipped_invalid: 0,
    skipped_barcode_conflict: 4,
    deduped: 0,
    collapsed_scoped: 0,
    dry_run: false,
    reason_tallies: { rejected: { 'no-name': 12554 }, gate: {} },
    load_errors: [],
    outcomes_pruned: false,
    ...over,
  }
}

describe('runLedger', () => {
  it('reads the counts off a completed run', () => {
    const ledger = runLedger(runRow())
    expect(ledger.available).toBe(true)
    if (!ledger.available) return
    expect(ledger.value).toEqual({
      recordsRead: 43382,
      recordsRejected: 12859,
      duplicates: 0,
      barcodeConflicts: 4,
      updated: 3012,
      errors: 0,
    })
  })

  it('counts a failed chunk as an error', () => {
    const ledger = runLedger(
      runRow({ load_errors: [{ chunk: 1, message: 'boom' }, { chunk: 2, message: 'boom' }] }),
    )
    expect(ledger.available && ledger.value.errors).toBe(2)
  })

  // A run published from a load with no matching score. Half the history is
  // real and half was never recorded, and saying so beats showing zeros.
  it('is unavailable when the funnel was never recorded', () => {
    const ledger = runLedger(runRow({ records_read: null, records_rejected: null }))
    expect(ledger.available).toBe(false)
    if (ledger.available) return
    expect(ledger.reason).toMatch(/no matching score/i)
  })

  // Pruning removes the RECORDS, never the COUNTS. This is the distinction
  // outcomes_pruned exists to make, and getting it backwards would put a run's
  // real numbers behind an empty state.
  it('still reports the counts of a run whose records were pruned', () => {
    expect(runLedger(runRow({ outcomes_pruned: true })).available).toBe(true)
  })
})

describe('runFunnel', () => {
  it('carries every stage of the funnel', () => {
    const funnel = runFunnel(runRow({ records_capped: 1200 }))
    expect(funnel.available && funnel.value).toEqual({
      read: 43382,
      rejected: 12859,
      auto: 10833,
      review: 12255,
      dropped: 7435,
      capped: 1200,
    })
  })

  it('is unavailable for a run with no score half', () => {
    expect(runFunnel(runRow({ records_read: null })).available).toBe(false)
  })
})

describe('runs from the ledger', () => {
  it('lists a published run even when the catalog shape does not reach it', () => {
    // The point of reading the ledger: a run list computed from a prefix of
    // product_catalog could be missing whole runs. From the ledger it cannot.
    const snapshot = buildPipelineSnapshot(
      shape({ truncated: true, byVersion: [] }),
      [runRow({ source_version: 'off-2026-08-20', inserted: 7683 })],
      NOW,
    )

    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0].version).toBe('off-2026-08-20')
    expect(snapshot.runs[0].rowsCreated).toBe(7683)
  })

  it('joins a published run to its coverage in the shape', () => {
    const snapshot = buildPipelineSnapshot(
      shape({ byVersion: [version({ version: 'off-2026-08-20', rows: 100, withBarcode: 90 })] }),
      [runRow({ source_version: 'off-2026-08-20' })],
      NOW,
    )

    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0].rowsCreated).toBe(100)
    expect(snapshot.runs[0].withBarcode).toBe(90)
    expect(snapshot.runs[0].row).not.toBeNull()
  })

  it('keeps runs that predate the ledger, with no row attached', () => {
    const snapshot = buildPipelineSnapshot(
      shape({ byVersion: [version({ version: 'off-2026-01-01' })] }),
      [],
      NOW,
    )

    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0].row).toBeNull()
  })

  it('does not list a run twice when the ledger and the shape both know it', () => {
    const snapshot = buildPipelineSnapshot(
      shape({ byVersion: [version({ version: 'off-2026-08-20' })] }),
      [runRow({ source_version: 'off-2026-08-20' })],
      NOW,
    )

    expect(snapshot.runs).toHaveLength(1)
  })
})
