import { loadCatalogShape, type CatalogShape } from './products'
import { unavailable, type Metric, type Unavailable } from './types'

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

export interface IngestionRun {
  source: string
  version: string | null
  rowsCreated: number
  firstSeen: string
  lastSeen: string
  withBarcode: number
  withAliases: number
  withMarkets: number
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

export function buildPipelineSnapshot(shape: CatalogShape, now = Date.now()): PipelineSnapshot {
  const runs: IngestionRun[] = shape.byVersion
    // The curated seed is not an import run. It has no source_version and it was
    // written by hand, so listing it as ingestion history would put an event in
    // the timeline that never happened.
    .filter((v) => v.source !== 'curated')
    .map((v) => ({
      source: v.source,
      version: v.version,
      rowsCreated: v.rows,
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
      withBarcode: v.withBarcode,
      withAliases: v.withAliases,
      withMarkets: v.withMarkets,
    }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))

  const sources: SourceHealth[] = IMPORT_SOURCES.map((source) => {
    const totals = shape.bySource.find((s) => s.source === source)
    const latest = runs.filter((r) => r.source === source).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0]
    const lastRunAt = latest?.lastSeen ?? null
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

export async function fetchPipeline(now = Date.now()): Promise<PipelineSnapshot> {
  const shape = await loadCatalogShape()
  return buildPipelineSnapshot(shape, now)
}

// ─── the tier that is not recorded ───────────────────────────────────────────

export interface RunLedger {
  recordsRead: number
  recordsRejected: number
  duplicates: number
  barcodeConflicts: number
  updated: number
  errors: number
}

const LEDGER_REASON =
  'A run is not recorded. import_catalog_products() computes these counts and returns them to the CLI, ' +
  'which writes them to catalog-importer/out/load-plan.json on the machine that ran it. ' +
  'The database keeps the rows a run created and no memory of the run itself.'

const LEDGER_FIX =
  'A catalog_import_runs table in the catalog project, written by import_catalog_products() ' +
  'from the jsonb report it already builds. One insert per run.'

/**
 * Per-run counts of everything that did NOT become a row.
 *
 * Always unavailable today. The signature is the contract: when the run table
 * exists, this becomes a query and every caller already renders the result.
 */
export function fetchRunLedger(_version: string | null): Metric<RunLedger> {
  return unavailable(LEDGER_REASON, LEDGER_FIX)
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
