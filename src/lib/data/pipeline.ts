import { getCatalogSupabase } from '../supabase'
import { queryError } from './errors'
import { CatalogNotConfigured, loadCatalogShape, type CatalogShape } from './products'
import { available, unavailable, type Metric, type Unavailable } from './types'

// The Product Pipeline section, and the sharpest example in this codebase of the
// line between what is recorded and what is merely computed.
//
// ─── WHAT THE PIPELINE ACTUALLY IS ───────────────────────────────────────────
//
// catalog-importer is a local CLI, not a service. A run is a person typing six
// commands on a machine with 15GB free:
//
//   acquire:taxonomy -> acquire[:search|:filter|:delta] -> normalize -> score
//   -> review -> load -> load:apply
//
// Each step writes a file the next one reads, and the last one calls
// import_catalog_products() over PostgREST with a service-role key. That RPC
// returns a jsonb report -- inserted, updated_imported, updated_provenance_only,
// skipped_invalid, skipped_barcode_conflict, deduped -- which the CLI writes to
// out/load-plan.json and prints. Nothing persists it. The database keeps the
// ROWS a run produced and no memory of the run itself.
//
// ─── SO WHAT IS REAL HERE ────────────────────────────────────────────────────
//
// Every row carries `source` and `source_version` (e.g. off-2026-08-20) and a
// created_at. That is enough to reconstruct, exactly and from the database:
//
//   * which runs happened, and in what order
//   * how many rows each one created, and when the first and last landed
//   * how complete each run's output was (barcode, alias and market coverage)
//   * per-source totals, freshness, and whether a source has gone quiet
//
// That is genuine ingestion history and this module returns it as such.
//
// ─── AND WHAT IS NOT ─────────────────────────────────────────────────────────
//
// Records READ from the dump, records REJECTED before scoring, rows DEDUPED,
// barcode CONFLICTS, per-run ERRORS and the run LOG cannot be reconstructed from
// the rows, because a rejected record leaves no row. Those numbers exist -- they
// are sitting in out/report.md and out/load-plan.json on the operator's disk --
// but they are not in any database this dashboard can reach.
//
// They are returned as Unavailable, with the reason and the fix, rather than
// guessed at. See src/lib/data/types.ts for why that is a type and not a null.

/**
 * A row of the catalog project's catalog_import_runs.
 *
 * Written by catalog-importer: opened by `npm run score`, completed by
 * `npm run load:apply`. Every load-side column is nullable because those are two
 * commands that can be days apart, and every score-side column is nullable
 * because a load can happen against a scored.jsonl whose run was never
 * published.
 */
export interface RunRow {
  id: string
  source: string
  source_version: string | null
  scored_at: string | null
  loaded_at: string | null
  records_read: number | null
  records_rejected: number | null
  records_auto: number | null
  records_review: number | null
  records_dropped: number | null
  records_capped: number | null
  inserted: number | null
  updated_imported: number | null
  updated_provenance_only: number | null
  skipped_invalid: number | null
  skipped_barcode_conflict: number | null
  deduped: number | null
  collapsed_scoped: number | null
  dry_run: boolean | null
  reason_tallies: { rejected?: Record<string, number>; gate?: Record<string, number> }
  load_errors: { chunk: number; message: string }[]
  outcomes_pruned: boolean
}

/** Where everything a run read ended up. */
export interface Funnel {
  read: number
  rejected: number
  auto: number
  review: number
  dropped: number
  capped: number
}

export interface IngestionRun {
  id: string
  source: string
  version: string | null
  rowsCreated: number
  firstSeen: string
  lastSeen: string
  withBarcode: number
  withAliases: number
  withMarkets: number
  /**
   * The ledger row, when the importer published one. Null for runs that predate
   * the ledger, which are still reconstructed from the rows they created.
   */
  row: RunRow | null
}

export interface SourceHealth {
  source: string
  rows: number
  withBarcode: number
  withMarkets: number
  latestVersion: string | null
  lastRunAt: string | null
  /** Days since this source last produced a row. */
  ageDays: number | null
  status: 'fresh' | 'ageing' | 'stale' | 'never'
}

export interface PipelineSnapshot {
  runs: IngestionRun[]
  sources: SourceHealth[]
  totalRows: number
  lastRunAt: string | null
  lastRunVersion: string | null
  /** Rows created per day, for the ingestion chart. */
  byDay: { day: string; rows: number }[]
  /**
   * The aggregate behind this ran out of headroom and describes only part of
   * the catalog. Carried through from CatalogShape because a run list computed
   * from a prefix can be missing whole runs, not just undercounting rows.
   */
  truncated: boolean
}

// The importer is run by hand, in waves, not on a schedule. "Stale" here means
// "nothing new in a long time", which for a reference catalog is a prompt to run
// a delta rather than an incident. The thresholds say that rather than borrowing
// an uptime monitor's vocabulary.
const FRESH_DAYS = 14
const AGEING_DAYS = 60

function statusFor(ageDays: number | null): SourceHealth['status'] {
  if (ageDays === null) return 'never'
  if (ageDays <= FRESH_DAYS) return 'fresh'
  if (ageDays <= AGEING_DAYS) return 'ageing'
  return 'stale'
}

/** All three import sources, so one that has never run still appears as a row. */
export const IMPORT_SOURCES = ['openfoodfacts', 'openproductsfacts', 'openbeautyfacts'] as const

export function buildPipelineSnapshot(
  shape: CatalogShape,
  rows: RunRow[],
  now = Date.now(),
): PipelineSnapshot {
  // Two sources, joined on (source, version), and the join is the whole point.
  //
  // The ledger says which runs happened -- authoritatively, because the importer
  // wrote a row per run. The catalog shape says how complete each run's output
  // was, which only the product rows can answer.
  //
  // So the run LIST no longer depends on paging the whole catalog under
  // SHAPE_ROW_CEILING: a run computed from a prefix could be missing entirely,
  // and now it cannot be. The coverage SHARES still come from that prefix and
  // still carry `truncated` with them.
  const shapeByKey = new Map(
    shape.byVersion
      // The curated seed is not an import run. It has no source_version and it
      // was written by hand, so listing it as ingestion history would put an
      // event in the timeline that never happened.
      .filter((v) => v.source !== 'curated')
      .map((v) => [`${v.source}::${v.version ?? ''}`, v]),
  )

  const runs: IngestionRun[] = []
  const claimed = new Set<string>()

  for (const row of rows) {
    const key = `${row.source}::${row.source_version ?? ''}`
    claimed.add(key)
    const coverage = shapeByKey.get(key)
    // A run whose rows fall outside the shape's prefix still reports what the
    // ledger says it inserted, rather than a zero the catalog merely could not
    // see.
    const stamp = coverage?.lastSeen ?? row.loaded_at ?? row.scored_at ?? ''
    runs.push({
      id: row.id,
      source: row.source,
      version: row.source_version,
      rowsCreated: coverage?.rows ?? row.inserted ?? 0,
      firstSeen: coverage?.firstSeen ?? row.scored_at ?? stamp,
      lastSeen: stamp,
      withBarcode: coverage?.withBarcode ?? 0,
      withAliases: coverage?.withAliases ?? 0,
      withMarkets: coverage?.withMarkets ?? 0,
      row,
    })
  }

  // Then the runs that predate the ledger, reconstructed the old way. They keep
  // working, and their drawer says the counts were never recorded rather than
  // showing zeros.
  for (const [key, v] of shapeByKey) {
    if (claimed.has(key)) continue
    runs.push({
      id: key,
      source: v.source,
      version: v.version,
      rowsCreated: v.rows,
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
      withBarcode: v.withBarcode,
      withAliases: v.withAliases,
      withMarkets: v.withMarkets,
      row: null,
    })
  }

  runs.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))

  const sources: SourceHealth[] = IMPORT_SOURCES.map((source) => {
    const totals = shape.bySource.find((s) => s.source === source)
    const latest = runs.filter((r) => r.source === source)[0]
    const lastRunAt = latest?.lastSeen || null
    const ageDays = lastRunAt
      ? Math.floor((now - new Date(lastRunAt).getTime()) / 86_400_000)
      : null

    return {
      source,
      rows: totals?.rows ?? 0,
      withBarcode: totals?.withBarcode ?? 0,
      withMarkets: totals?.withMarkets ?? 0,
      latestVersion: latest?.version ?? null,
      lastRunAt,
      ageDays,
      status: statusFor(ageDays),
    }
  })

  const newest = runs[0] ?? null

  return {
    runs,
    sources,
    totalRows: shape.total,
    lastRunAt: newest?.lastSeen ?? null,
    lastRunVersion: newest?.version ?? null,
    byDay: shape.byCreatedDay,
    truncated: shape.truncated,
  }
}

export async function fetchRunRows(signal: AbortSignal): Promise<RunRow[]> {
  const client = getCatalogSupabase()
  if (!client) throw new CatalogNotConfigured()

  const { data, error } = await client
    .from('catalog_import_runs')
    .select('*')
    .order('scored_at', { ascending: false, nullsFirst: false })
    .abortSignal(signal)

  if (error) {
    queryError('catalog_import_runs', error)
  }
  return (data ?? []) as RunRow[]
}

export async function fetchPipeline(
  signal: AbortSignal,
  now = Date.now(),
): Promise<PipelineSnapshot> {
  // Concurrent, and independent: the ledger is a few dozen small rows and the
  // shape is a paged crawl. Waiting for one to start the other doubles the
  // slowest page load on the dashboard for no reason.
  const [shape, rows] = await Promise.all([loadCatalogShape(), fetchRunRows(signal)])
  return buildPipelineSnapshot(shape, rows, now)
}

// ─── the tier that used to be unrecorded ─────────────────────────────────────
//
// This block was the module's clearest example of a metric that could not be
// answered. It said so in its type, and it said what would have to change: "a
// catalog_import_runs table in the catalog project, written from the jsonb
// report it already builds".
//
// That table now exists, so the tier has moved rather than disappeared.
// Unavailable no longer means "nothing records this"; it means THIS run has no
// score half -- published from a load with no matching scored.jsonl -- which is
// a fact about one run and not about the system.

export interface RunLedger {
  recordsRead: number
  recordsRejected: number
  duplicates: number
  barcodeConflicts: number
  updated: number
  errors: number
}

const NO_SCORE_REASON =
  'This run was published from a load with no matching score, so the funnel was never recorded. ' +
  'The load half is real; the stage counts are not missing, they never existed for this run.'

const NO_SCORE_FIX =
  'Run `npm run publish` in catalog-importer while out/run.json and out/scored.jsonl belong to this run.'

/**
 * Per-run counts of everything that did NOT become a row.
 *
 * Pure, and reading a row the caller already holds, because every one of these
 * numbers is a column on the run -- there is nothing left to fetch. Which is
 * why this replaced a fetch: the drawer opens on a run it already has.
 */
export function runLedger(row: RunRow): Metric<RunLedger> {
  if (row.records_read === null) return unavailable(NO_SCORE_REASON, NO_SCORE_FIX)

  return available({
    recordsRead: row.records_read,
    recordsRejected: row.records_rejected ?? 0,
    duplicates: row.deduped ?? 0,
    barcodeConflicts: row.skipped_barcode_conflict ?? 0,
    updated: row.updated_imported ?? 0,
    errors: row.load_errors.length,
  })
}

/**
 * Where everything the run read ended up.
 *
 * Note what does NOT make this unavailable: `outcomes_pruned`. Retention
 * deletes a run's individual RECORDS and never its COUNTS, so a pruned run
 * still answers this exactly. Conflating the two would hide a run's real
 * numbers behind an empty state.
 */
export function runFunnel(row: RunRow): Metric<Funnel> {
  if (row.records_read === null) return unavailable(NO_SCORE_REASON, NO_SCORE_FIX)

  return available({
    read: row.records_read,
    rejected: row.records_rejected ?? 0,
    auto: row.records_auto ?? 0,
    review: row.records_review ?? 0,
    dropped: row.records_dropped ?? 0,
    capped: row.records_capped ?? 0,
  })
}

export interface PipelineLogEntry {
  at: string
  level: 'info' | 'warn' | 'error'
  step: string
  message: string
}

export function fetchPipelineLogs(): Metric<PipelineLogEntry[]> {
  return unavailable(
    'Pipeline logs are written to the operator’s terminal and to catalog-importer/out/, not to a database.',
    'The same catalog_import_runs table, with a jsonb log column, or a log drain the importer writes to.',
  )
}

// ─── triggering a run ────────────────────────────────────────────────────────
//
// Asked for, and deliberately not built, because a button that cannot work is
// worse than no button. The reasons are structural rather than a matter of
// effort:
//
//   * The importer needs CATALOG_SUPABASE_SERVICE_ROLE_KEY, which can write every
//     row in the catalog. It exists in .env.scripts on one machine and must never
//     reach a browser.
//   * A full acquire downloads a ~12GB dump and needs ~15GB of free disk.
//   * It is a Node CLI on a filesystem. There is no service listening, and adding
//     one would be exactly the backend infrastructure this tool was scoped not to
//     build.
//
// The UI shows the control as unavailable with this explanation and the command
// to run instead, which is the honest version of the feature.
export interface TriggerCapability {
  supported: false
  reason: string
  runInstead: string[]
}

export function triggerCapability(): TriggerCapability {
  return {
    supported: false,
    reason:
      'The importer is a local CLI holding a service-role key, not a service. Nothing is listening for a request to start a run.',
    runInstead: [
      'cd catalog-importer',
      'npm run acquire:delta      # fold in what changed upstream',
      'npm run normalize && npm run score',
      'npm run load               # dry run, then read out/load-diff.md',
      'npm run load:apply',
    ],
  }
}

export type { Unavailable }
