import { formatDuration, formatRelative } from '../format'
import type { RetailerHealth } from './catalog'
import type { ProbeResult } from './health'
import { isDeliberate, isStalled } from './scrapers'
import {
  fetchClerkSummary,
  fetchPushNotifications,
  fetchSentryIssues,
  ServiceUnavailable,
  serviceProblem,
  type Service,
} from './services'

// The checks on Health: one line for each thing that must be working, green or
// not. The database probes were already here; what this adds is everything
// outside the two databases -- the live site, the pipelines that build and ship
// the app, the services the app leans on, and whether every shop was read.
//
// THE RULE EVERY CHECK KEEPS: a check that could not be made is never a pass.
// GitHub running out of unauthenticated requests, a service that cannot be
// asked, a catalog that did not answer -- each says so, in a tone of its own,
// rather than falling silent and letting silence read as health.

export type CheckTone = 'good' | 'warn' | 'bad' | 'live' | 'idle'

export interface Check {
  key: string
  label: string
  tone: CheckTone
  detail: string
  /** Where the evidence is, when it lives somewhere else. */
  href?: string
}

// ─── the live site ───────────────────────────────────────────────────────────

export const SITE_URL = 'https://famcart-app.vercel.app/'

/**
 * Does the deployed app answer?
 *
 * `no-cors`, because the site sends no CORS headers for this dashboard and
 * should not have to: an opaque response cannot say its status, but it can only
 * exist if the site answered, and a site that is down, or a DNS name that no
 * longer resolves, fails the fetch outright. That is the question.
 */
export async function checkSite(signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Check> {
  const started = performance.now()
  try {
    await fetchImpl(SITE_URL, { mode: 'no-cors', cache: 'no-store', signal })
    return {
      key: 'site',
      label: 'Live site',
      tone: 'good',
      detail: `Answering, ${formatDuration(performance.now() - started)}`,
      href: SITE_URL,
    }
  } catch (error) {
    if (signal.aborted) throw error
    return { key: 'site', label: 'Live site', tone: 'bad', detail: `Not answering: ${messageOf(error)}`, href: SITE_URL }
  }
}

// ─── the pipelines ───────────────────────────────────────────────────────────

export interface Pipeline {
  key: string
  label: string
  repo: string
  workflow: string
  branch: string
}

/**
 * The workflows whose failure means something is broken.
 *
 * NOT the catalog's Scrape workflow, deliberately: Carrefour needs longer than a
 * job may run, so that workflow ends `cancelled` every night by design, and a
 * line that is always amber stops being read. Whether the shops were read is
 * judged from the catalog itself, by scrapersCheck below.
 */
export const PIPELINES: Pipeline[] = [
  { key: 'app-ci', label: 'App CI', repo: 'raduandreigorcea/FamCart', workflow: 'ci.yml', branch: 'master' },
  { key: 'release', label: 'Release APK', repo: 'raduandreigorcea/FamCart', workflow: 'release-apk.yml', branch: 'master' },
  { key: 'catalog-ci', label: 'Catalog CI', repo: 'raduandreigorcea/FamCart-catalog', workflow: 'ci.yml', branch: 'master' },
]

interface WorkflowRun {
  status: string
  conclusion: string | null
  html_url: string
  updated_at: string
}

/**
 * How long an answer from GitHub is reused without asking at all.
 *
 * GitHub allows sixty unauthenticated requests an hour per ADDRESS, and that
 * budget is shared with everything else on the network -- on 2026-09-17 it was
 * already spent before this page asked once. Three pipelines every five minutes
 * is at most thirty-six an hour however often the page is opened or refreshed,
 * and a CI run takes longer than five minutes to change its mind anyway.
 */
export const PIPELINE_CACHE_MS = 5 * 60_000

/** The part of Storage this uses, so a test can hand it a map. */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface Remembered {
  etag: string | null
  run: WorkflowRun | null
  /** When GitHub last confirmed this answer, by a 200 or a 304. */
  at: number
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

// Every read and write is guarded: a private window, blocked site data or a
// full quota must cost the memory, never the check.
function recall(store: KeyValueStore | null, key: string): Remembered | null {
  try {
    const raw = store?.getItem(key)
    return raw ? (JSON.parse(raw) as Remembered) : null
  } catch {
    return null
  }
}

function remember(store: KeyValueStore | null, key: string, value: Remembered): void {
  try {
    store?.setItem(key, JSON.stringify(value))
  } catch {
    // Nothing to do: the next check simply asks again.
  }
}

/** A run as a check line. `asOf` is said when the answer could not be refreshed. */
function runCheck(pipeline: Pipeline, run: WorkflowRun | null, now: number, asOf?: number): Check {
  const base = { key: pipeline.key, label: pipeline.label }
  const actions = `https://github.com/${pipeline.repo}/actions/workflows/${pipeline.workflow}`
  if (!run) return { ...base, tone: 'warn', detail: 'Not checked: no run on record', href: actions }

  const suffix = asOf === undefined ? '' : ` (as of ${formatRelative(new Date(asOf), now)}, GitHub rate limit)`
  const when = formatRelative(run.updated_at, now)
  const href = run.html_url
  if (run.status !== 'completed') return { ...base, tone: 'live', detail: `Running, started ${when}${suffix}`, href }
  if (run.conclusion === 'success') return { ...base, tone: 'good', detail: `Passed ${when}${suffix}`, href }
  if (run.conclusion === 'cancelled' || run.conclusion === 'skipped' || run.conclusion === 'neutral') {
    return { ...base, tone: 'warn', detail: `${capitalise(run.conclusion)} ${when}${suffix}`, href }
  }
  return { ...base, tone: 'bad', detail: `Failed ${when}${suffix}`, href }
}

/**
 * The last run of one workflow, from GitHub's public API.
 *
 * No token: the repositories are public, and a token in a browser bundle would
 * be a token anybody could read. The price is GitHub's per-address limit, which
 * is why the answer is remembered (PIPELINE_CACHE_MS), re-asked conditionally
 * with its ETag so an unchanged answer comes back as a 304, and -- when GitHub
 * refuses anyway -- shown as the last known answer with its age. Only with
 * nothing remembered does a refusal read "not checked"; it never reads "passed".
 */
export async function checkPipeline(
  pipeline: Pipeline,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
  store: KeyValueStore | null = defaultStore(),
): Promise<Check> {
  const base = { key: pipeline.key, label: pipeline.label }
  const actions = `https://github.com/${pipeline.repo}/actions/workflows/${pipeline.workflow}`
  const cacheKey = `famcart-admin:pipeline:${pipeline.repo}/${pipeline.workflow}@${pipeline.branch}`
  const known = recall(store, cacheKey)

  if (known && now - known.at < PIPELINE_CACHE_MS) return runCheck(pipeline, known.run, now)

  const url =
    `https://api.github.com/repos/${pipeline.repo}/actions/workflows/${pipeline.workflow}/runs` +
    `?branch=${encodeURIComponent(pipeline.branch)}&per_page=1`
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  if (known?.etag) headers['if-none-match'] = known.etag

  let response: Response
  try {
    response = await fetchImpl(url, { headers, signal })
  } catch (error) {
    if (signal.aborted) throw error
    if (known) return runCheck(pipeline, known.run, now, known.at)
    return { ...base, tone: 'warn', detail: `Not checked: ${messageOf(error)}`, href: actions }
  }

  if (response.status === 304 && known) {
    remember(store, cacheKey, { ...known, at: now })
    return runCheck(pipeline, known.run, now)
  }

  if (!response.ok) {
    if (known) return runCheck(pipeline, known.run, now, known.at)
    const reason = response.status === 403 || response.status === 429 ? 'GitHub rate limit' : `GitHub answered ${response.status}`
    return { ...base, tone: 'warn', detail: `Not checked: ${reason}`, href: actions }
  }

  const body = (await response.json().catch(() => null)) as { workflow_runs?: WorkflowRun[] } | null
  const run = body?.workflow_runs?.[0] ?? null
  remember(store, cacheKey, { etag: response.headers.get('etag'), run, at: now })
  return runCheck(pipeline, run, now)
}

export function checkPipelines(signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Check[]> {
  return Promise.all(PIPELINES.map((pipeline) => checkPipeline(pipeline, signal, fetchImpl)))
}

// ─── the services ────────────────────────────────────────────────────────────

const SERVICE_LABELS: Record<Service, string> = { sentry: 'Sentry', onesignal: 'OneSignal', clerk: 'Clerk' }

export type ServiceFetchers = Record<Service, (signal: AbortSignal) => Promise<unknown>>

const DEFAULT_FETCHERS: ServiceFetchers = {
  sentry: fetchSentryIssues,
  onesignal: fetchPushNotifications,
  clerk: fetchClerkSummary,
}

/**
 * Each service the app leans on, asked through admin-services the way its own
 * page asks. There is no cheaper question to put to the function, and one read
 * of each is what a person opening those pages would cost anyway.
 */
export async function checkServices(
  signal: AbortSignal,
  fetchers: ServiceFetchers = DEFAULT_FETCHERS,
): Promise<Check[]> {
  const services: Service[] = ['sentry', 'onesignal', 'clerk']
  const settled = await Promise.allSettled(services.map((service) => fetchers[service](signal)))
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  return settled.map((result, index) => {
    const service = services[index]
    const base = { key: `service-${service}`, label: SERVICE_LABELS[service], href: `/services/${service}` }
    if (result.status === 'fulfilled') return { ...base, tone: 'good' as const, detail: 'Connected' }
    const problem = result.reason instanceof ServiceUnavailable ? serviceProblem(result.reason) : null
    const detail =
      result.reason instanceof ServiceUnavailable && result.reason.missing.length
        ? `Not connected: missing ${result.reason.missing.join(', ')}`
        : problem?.title ?? messageOf(result.reason)
    return { ...base, tone: 'bad' as const, detail }
  })
}

// ─── the scrapers ────────────────────────────────────────────────────────────

/**
 * How recent a shop's last run must be. The job is nightly and starts at
 * GitHub's convenience -- 01:20 scheduled, 06:10 in practice -- so a day plus
 * the drift, not a day on the dot.
 */
export const SCRAPE_WINDOW_MS = 26 * 3_600_000

/** "Lidl BE": the shop's own name, and the country in capitals, since nine are Lidl. */
export function shopLabel(shop: Pick<RetailerHealth, 'slug' | 'country'> & { name?: string | null }): string {
  const name = shop.name?.trim() || capitalise(shop.slug.replace(/-[a-z]{2}$/, '').replace(/-/g, ' '))
  return `${name} ${shop.country.toUpperCase()}`
}

/**
 * Were the shops read? One line for all of them, naming each one that was not.
 *
 * Bad: a last run that failed, a running one that went quiet (see isStalled),
 * a shop never scraped, or one whose last run is older than SCRAPE_WINDOW_MS --
 * the nightly job did not reach it. Amber: a run that refused to sweep, which
 * imported what it read and wants a look rather than a fix.
 */
export function scrapersCheck(retailers: RetailerHealth[] | null | undefined, now = Date.now()): Check {
  const base = { key: 'scrapers', label: 'Scrapers', href: '/scrapers' }
  if (!retailers) return { ...base, tone: 'idle', detail: 'Not read' }

  const shops = retailers.filter((shop) => shop.enabled)
  const broken: string[] = []
  const refused: string[] = []
  for (const shop of shops) {
    const name = shopLabel(shop)
    const run = shop.last_run
    if (!run) broken.push(`${name} never ran`)
    else if (run.status === 'failed') broken.push(`${name} failed`)
    else if (isStalled({ status: run.status, last_alive_at: run.last_alive_at ?? null, started_at: run.started_at }, now)) {
      broken.push(`${name} has gone quiet`)
    } else if (now - Date.parse(run.started_at) > SCRAPE_WINDOW_MS) {
      broken.push(`${name} last ran ${formatRelative(run.started_at, now)}`)
    } else if (run.status === 'partial' && !isDeliberate(run)) refused.push(`${name} refused to sweep`)
  }

  if (broken.length) return { ...base, tone: 'bad', detail: [...broken, ...refused].join(', ') }
  if (refused.length) return { ...base, tone: 'warn', detail: refused.join(', ') }
  return { ...base, tone: 'good', detail: `All ${shops.length} shops ran in the last 26 h` }
}

// ─── the databases ───────────────────────────────────────────────────────────

/** A reachability probe as a check line. */
export function probeCheck(probe: ProbeResult): Check {
  return probe.ok
    ? { key: `probe-${probe.target}`, label: probe.label, tone: 'good', detail: `Answering, ${formatDuration(probe.latencyMs)}` }
    : { key: `probe-${probe.target}`, label: probe.label, tone: 'bad', detail: probe.detail }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
