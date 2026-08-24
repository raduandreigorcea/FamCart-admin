import { getAppSupabase, getCatalogSupabase } from '../supabase'
import { sinceIso, type TimeRange } from '../timeRange'
import { unavailable, type AdminEventRow, type Metric, type Page } from './types'

// System Health.
//
// Three things are genuinely observable from a browser holding a Clerk token,
// and this module measures all three:
//
//   1. Whether each Supabase project answers, and how quickly. Measured here,
//      from the client, because that is where the app talks to them from -- a
//      server-side probe would be measuring a path no user takes.
//   2. What the database says about itself: sizes, row estimates, connections,
//      vacuum times, and which migrations it believes are applied.
//   3. The audit trail, which is the nearest thing FamCart has to an error
//      stream, since the browser talks to PostgREST directly and Sentry only
//      ever sees the browser.
//
// One thing is not: a job queue. There isn't one. See failedJobs() at the foot.

export interface ProbeResult {
  target: string
  label: string
  ok: boolean
  latencyMs: number | null
  detail: string
}

/**
 * Round-trip time to a project, measured as a real authenticated request.
 *
 * `head: true` with an exact count on the smallest table asks PostgREST to do
 * the auth, the RLS evaluation and the plan without sending rows back, so what
 * is measured is the path rather than the payload.
 */
async function probe(
  label: string,
  target: string,
  run: () => Promise<{ error: { message: string } | null }>,
): Promise<ProbeResult> {
  const started = performance.now()
  try {
    const { error } = await run()
    const latencyMs = performance.now() - started
    return {
      target,
      label,
      ok: !error,
      latencyMs,
      detail: error ? error.message : 'Responded',
    }
  } catch (caught) {
    return {
      target,
      label,
      ok: false,
      latencyMs: performance.now() - started,
      detail: caught instanceof Error ? caught.message : String(caught),
    }
  }
}

/**
 * Both projects, concurrently, with allSettled semantics.
 *
 * Deliberately mirrors how src/lib/productSuggestions.ts queries them in the app
 * itself: an unreachable catalog must cost only its own tile. A health page that
 * goes blank because one of the things it monitors is down is not a health page.
 *
 * The signal matters more here than anywhere else in the data layer. These are
 * the only requests the dashboard makes whose PURPOSE is to sit and wait for a
 * project that may never answer, so without it, leaving the Health page left two
 * hanging requests behind per visit.
 *
 * An aborted probe resolves as `ok: false` like any other failure, which sounds
 * alarming and is not: useQuery drops the whole result when its signal aborted,
 * so a cancelled probe never reaches the screen. What must never happen is the
 * opposite -- a cancellation rendered as "this project is down" -- and the check
 * that prevents it lives in useQuery, not here.
 */
export async function probeProjects(signal: AbortSignal): Promise<ProbeResult[]> {
  const catalog = getCatalogSupabase()

  const probes: Promise<ProbeResult>[] = [
    probe('App database', 'app', async () => {
      const { error } = await getAppSupabase().rpc('is_admin').abortSignal(signal)
      return { error }
    }),
  ]

  if (catalog) {
    probes.push(
      probe('Catalog project', 'catalog', async () => {
        const { error } = await catalog
          .from('product_catalog')
          .select('id', { count: 'exact', head: true })
          .limit(1)
          .abortSignal(signal)
        return { error }
      }),
    )
  }

  const settled = await Promise.allSettled(probes)
  return settled.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : {
          target: index === 0 ? 'app' : 'catalog',
          label: index === 0 ? 'App database' : 'Catalog project',
          ok: false,
          latencyMs: null,
          detail: String(result.reason),
        },
  )
}

/**
 * What the probe results add up to — three states, never a boolean.
 *
 * This was `results.every(p => p.ok)` in the view, and `Array.every` on an
 * empty array is `true`. So the page reported "everything is answering" in the
 * two situations where nothing had answered at all: before the first probe
 * resolved, and after the probe query itself failed and left the data null.
 *
 * On the one page whose entire job is to say when something is wrong, silence
 * must not be reported as health. `unknown` is a first-class answer here for
 * the same reason Unavailable is a type in ./types.ts: "not measured" and
 * "measured and fine" are different claims, and only one is good news.
 */
export type Reachability = 'unknown' | 'ok' | 'degraded'

export function reachabilityOf(results: ProbeResult[] | null | undefined): Reachability {
  if (!results || results.length === 0) return 'unknown'
  return results.every((p) => p.ok) ? 'ok' : 'degraded'
}

export interface TableHealth {
  table_name: string
  live_rows: number
  dead_rows: number
  total_bytes: number
  heap_bytes: number
  index_bytes: number
  last_vacuum: string | null
  last_analyze: string | null
  seq_scan: number
  idx_scan: number | null
}

export interface HealthPayload {
  server_time: string
  server_version: string
  database: string
  database_size: number
  connections: { total: number; active: number; idle_in_transaction: number; max: string }
  tables: TableHealth[]
  migrations: { version: string; name: string }[]
  freshness: Record<string, string | null>
}

export async function fetchHealth(signal: AbortSignal): Promise<HealthPayload> {
  const { data, error } = await getAppSupabase().rpc('admin_health').abortSignal(signal)
  if (error) throw Object.assign(new Error(`admin_health: ${error.message}`), { code: error.code })
  return data as HealthPayload
}

export interface EventDigestRow {
  kind: string
  events: number
  distinct_actors: number
  first_seen: string
  last_seen: string
}

export async function fetchEventDigest(
  range: TimeRange,
  signal: AbortSignal,
): Promise<EventDigestRow[]> {
  const { data, error } = await getAppSupabase()
    .rpc('admin_event_digest', { p_since: sinceIso(range) })
    .abortSignal(signal)
  if (error) throw Object.assign(new Error(`admin_event_digest: ${error.message}`), { code: error.code })
  return (data ?? []) as EventDigestRow[]
}

export async function fetchSecurityEvents(
  params: { kind?: string | null; actor?: string | null; since?: string | null; limit?: number; offset?: number },
  signal: AbortSignal,
): Promise<Page<AdminEventRow>> {
  const limit = params.limit ?? 50
  const offset = params.offset ?? 0

  const { data, error } = await getAppSupabase()
    .rpc('admin_security_events', {
      p_kind: params.kind || null,
      p_since: params.since || null,
      p_actor: params.actor || null,
      p_limit: limit,
      p_offset: offset,
    })
    .abortSignal(signal)

  if (error) {
    throw Object.assign(new Error(`admin_security_events: ${error.message}`), { code: error.code })
  }

  const rows = (data ?? []) as AdminEventRow[]
  return { rows, total: rows[0]?.total_count ?? 0, offset }
}

export interface RateLimitRow {
  /** The Clerk user id, or whatever else rate_limit_hit() counted against. */
  actor: string
  /** Which limiter: item inserts, profile writes, invite attempts, catalog bumps. */
  kind: string
  window_start: string
  hits: number
  /** Null where the actor is not an account with a profile. Normal, not missing. */
  actor_name: string | null
}

export async function fetchRateLimits(signal: AbortSignal): Promise<RateLimitRow[]> {
  const { data, error } = await getAppSupabase()
    .rpc('admin_rate_limits', { p_limit: 100 })
    .abortSignal(signal)
  if (error) throw Object.assign(new Error(`admin_rate_limits: ${error.message}`), { code: error.code })
  return (data ?? []) as RateLimitRow[]
}

/**
 * Which security event kinds mean something went wrong, as opposed to something
 * routine happening. The digest colours rows by this.
 *
 * `invite_join_succeeded` is a success and `admin_granted` is a deliberate act;
 * neither belongs in an error count. Anything rate-limited or failed does.
 */
export function severityOf(kind: string): 'error' | 'warn' | 'info' {
  if (/failed|denied|rejected|blocked/.test(kind)) return 'error'
  if (/rate_limit|limit_exceeded|throttled|removed|revoked/.test(kind)) return 'warn'
  return 'info'
}

// ─── the one health metric with nothing behind it ────────────────────────────
//
// There is no job queue in FamCart. Nothing is enqueued, nothing is retried and
// nothing can therefore fail and sit in a dead-letter table. The asynchronous
// work that does exist is a database webhook firing a Supabase edge function on
// item insert (007_realtime.sql), and its failures land in the edge function's
// own logs in the Supabase dashboard, not in a table this can query.
//
// So "failed jobs" is not zero. It is unmeasured, and those are different.
export interface FailedJob {
  id: string
  queue: string
  failedAt: string
  attempts: number
  error: string
}

export function failedJobs(): Metric<FailedJob[]> {
  return unavailable(
    'There is no job queue. The only asynchronous work is the push webhook in 007_realtime.sql, whose failures go to the edge function’s logs rather than to a table.',
    'A jobs table with a status column, or reading the Supabase Edge Function logs through the Management API from a server that holds a key.',
  )
}
