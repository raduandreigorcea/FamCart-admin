<script setup lang="ts">
import { computed, ref, watch, type Ref } from 'vue'
import UserChip from '../components/UserChip.vue'
import AppSpinner from '../components/AppSpinner.vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import StatTile from '../components/StatTile.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import DataTable from '../components/DataTable.vue'
import TablePager from '../components/TablePager.vue'
import SelectField from '../components/SelectField.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import CopyValue from '../components/CopyValue.vue'
import { useQuery, useQueryGroup, describeError } from '../lib/useQuery'
import {
  fetchEventDigest,
  fetchHealth,
  fetchRateLimits,
  fetchSecurityEvents,
  probeProjects,
  reachabilityOf,
  severityOf,
  type RateLimitRow,
  type TableHealth,
} from '../lib/data/health'
import { fetchCatalogStats, catalogConfigured, type RetailerHealth } from '../lib/data/catalog'
import {
  PIPELINES,
  SCRAPE_WINDOW_MS,
  checkPipelines,
  checkServices,
  checkSite,
  probeCheck,
  scrapersCheck,
  shopLabel,
  type Check,
} from '../lib/data/checks'
import { isDeliberate, isStalled } from '../lib/data/scrapers'
import { appTarget, catalogTarget, clerkIssuer } from '../lib/supabase'
import { DEFAULT_RANGE, TIME_RANGES, resolveRange, sinceIso } from '../lib/timeRange'
import type { AdminEventRow } from '../lib/data/types'
import type { Column } from '../lib/uiTypes'
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatRelative,
  humanizeKind,
} from '../lib/format'

// System Health, read top down: first whether anything needs a look, then the
// connection and the database behind that answer, then the audit trail and the
// tables for whoever wants to dig.
//
// The scrapers are NOT drawn here. They were, before the Scrapers page existed,
// because a dead scraper reports nothing and this was the only place to see it.
// That page now carries the cards, the progress and the history, so a second
// copy here was noise. What stays is the part only this page can do: a shop in
// trouble is named in the banner, with a link to where the detail is.
//
// The page used to open on four equal tiles and a wall of panels, which put
// "Auchan failed" three screens down beneath a Postgres version string. The
// banner at the top is the answer; everything under it is the evidence.

const rangeKey = ref<string>(DEFAULT_RANGE)
const range = computed(() => resolveRange(rangeKey.value))
const eventKind = ref<string | null>(null)
const eventOffset = ref(0)

const LIMIT = 25

const probes = useQuery((signal) => probeProjects(signal))
const health = useQuery((signal) => fetchHealth(signal))
const digest = useQuery((signal) => fetchEventDigest(range.value, signal), { watch: [range] })
const events = useQuery(
  (signal) =>
    fetchSecurityEvents(
      {
        kind: eventKind.value,
        since: sinceIso(range.value),
        limit: LIMIT,
        offset: eventOffset.value,
      },
      signal,
    ),
  { watch: [range, eventKind, eventOffset] },
)
const limits = useQuery((signal) => fetchRateLimits(signal))

// Everything outside the two databases that must be working: the live site,
// the services, the pipelines. Each check reports its own failure as a line, so
// none of these queries is expected to throw; if one does, its lines say so.
const site = useQuery((signal) => checkSite(signal))
const services = useQuery((signal) => checkServices(signal))
const pipelines = useQuery((signal) => checkPipelines(signal))

/** Fetching again over data already on screen: a spinner in the panel head,
 *  where a first load gets a skeleton in the body instead. */
function refreshing(query: { fetching: Ref<boolean>; loading: Ref<boolean> }): boolean {
  return query.fetching.value && !query.loading.value
}

// ─── the scrapers, for the banner only ───────────────────────────────────────
// THE FAILURE THIS EXISTS FOR REPORTS NOTHING. A shop changes its markup or
// moves an endpoint, the scraper keeps completing, and the catalog quietly stops
// growing. There is no error anywhere -- the run is green and the number is
// smaller. So a shop that went backwards is named like one that failed.
const catalogOn = catalogConfigured()
const scrapes = useQuery((signal) => fetchCatalogStats(signal), { enabled: () => catalogConfigured() })

/**
 * A sentence in the banner, and where its detail is -- as close to the thing as
 * there is a place for. `to` is a page of this dashboard, `href` somewhere else
 * (a GitHub run), `anchor` a panel further down this page.
 */
type Issue = { tone: 'bad' | 'warn'; text: string; to?: string; href?: string; anchor?: string }

/** The panels a sentence can point at, further down this page. */
const CONNECTION_PANEL = 'health-connection'
const EVENTS_PANEL = 'health-events'

/**
 * Scroll to a panel on this page. A button rather than an anchor: the router's
 * scrollBehavior sends every navigation to the top, a hash change included.
 */
function goTo(id: string) {
  const panel = document.getElementById(id)
  if (!panel) return
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** The Scrapers page on this shop's country, with its run marked when known. */
function scrapersLink(shop: RetailerHealth): string {
  const query = new URLSearchParams({ country: shop.country.toUpperCase() })
  if (shop.last_run?.id) query.set('run', shop.last_run.id)
  return `/scrapers?${query.toString()}`
}


/**
 * What is wrong with a shop, in one sentence, or null when nothing is.
 *
 * A RUNNING shop is never flagged for its count: it is compared against a
 * finished run while it is still reading, so every crawl in progress would show
 * as a collapse. A disabled shop that never ran is the expected state of a shop
 * nobody switched on.
 */
function shopIssue(shop: RetailerHealth): Issue | null {
  // "Lidl BE": nine shops are Lidl, so the country is part of the name.
  const name = shopLabel(shop)
  const to = scrapersLink(shop)
  const run = shop.last_run
  if (!run) return shop.enabled ? { tone: 'warn', text: `${name} has never been scraped`, to } : null
  if (run.status === 'failed') return { tone: 'bad', text: `${name} failed its last run`, to }
  // Partial on purpose -- Carrefour's nightly groceries-only pass -- is fine.
  if (run.status === 'partial' && isDeliberate(run)) return null
  if (run.status === 'partial') return { tone: 'warn', text: `${name} refused to sweep`, to }
  // A crawl that stopped hearing back from its shop (catalog 022) is as dead as
  // a failed one, and says nothing on its own.
  if (isStalled({ status: run.status, last_alive_at: run.last_alive_at ?? null, started_at: run.started_at })) {
    return { tone: 'bad', text: `${name} has gone quiet`, to }
  }
  if (run.status === 'running') return null
  // The nightly job never reached it. Quiet, like every failure this banner is for.
  if (Date.now() - Date.parse(run.started_at) > SCRAPE_WINDOW_MS) {
    return { tone: 'bad', text: `${name} has not run in over a day`, to }
  }
  // A small shop's count swings with nothing wrong: Lidl's few hundred online
  // groceries move by a third from one night to the next (CH 405 -> 256). So a
  // drop counts once it is 500 products, or half of what the shop had.
  const drop = -(shop.delta ?? 0)
  if (drop > 0 && (drop >= 500 || drop * 2 >= (shop.previous_valid ?? 0))) {
    return { tone: 'warn', text: `${name} found ${formatCount(drop)} fewer products than last time`, to }
  }
  return null
}

const shopIssues = computed(() =>
  (scrapes.data.value?.retailers ?? []).map(shopIssue).filter((issue): issue is Issue => issue !== null),
)

const target = appTarget
const catalog = catalogTarget()
const issuer = clerkIssuer()

const rangeSegments = TIME_RANGES.map((r) => ({ value: r.key, label: r.label, title: r.description }))

// All of them, so the spinner runs until the last one lands and the header
// reports the stalest panel rather than the freshest.
const page = useQueryGroup([probes, health, digest, events, limits, scrapes, site, services, pipelines])

// ─── the checks ──────────────────────────────────────────────────────────────
// One line for each thing that must be working. A line still out is "Checking",
// and a check that could not be made says so in amber: silence is never a pass.

function pending(key: string, label: string): Check {
  return { key, label, tone: 'idle', detail: 'Checking' }
}

function notChecked(key: string, label: string, error: Error): Check {
  return { key, label, tone: 'warn', detail: `Not checked: ${describeError(error).detail}` }
}

const SERVICE_LINES: [string, string][] = [
  ['service-sentry', 'Sentry'],
  ['service-onesignal', 'OneSignal'],
  ['service-clerk', 'Clerk'],
]

const checks = computed<Check[]>(() => {
  const out: Check[] = []

  if (probes.loading.value) {
    out.push(pending('probe-app', 'App database'))
    if (catalogOn) out.push(pending('probe-catalog', 'Catalog project'))
  } else if (reachability.value === 'unknown') {
    out.push({ key: 'probes', label: 'Databases', tone: 'warn', detail: 'Not measured' })
  } else {
    out.push(...(probes.data.value ?? []).map(probeCheck))
  }

  if (site.error.value) out.push(notChecked('site', 'Live site', site.error.value))
  else out.push(site.data.value ?? pending('site', 'Live site'))

  const servicesError = services.error.value
  if (servicesError) out.push(...SERVICE_LINES.map(([k, l]) => notChecked(k, l, servicesError)))
  else out.push(...(services.data.value ?? SERVICE_LINES.map(([k, l]) => pending(k, l))))

  if (catalogOn) {
    if (scrapes.error.value) out.push(notChecked('scrapers', 'Scrapers', scrapes.error.value))
    else if (scrapes.loading.value) out.push(pending('scrapers', 'Scrapers'))
    else out.push(scrapersCheck(scrapes.data.value?.retailers ?? null))
  }

  const pipelinesError = pipelines.error.value
  if (pipelinesError) out.push(...PIPELINES.map((p) => notChecked(p.key, p.label, pipelinesError)))
  else out.push(...(pipelines.data.value ?? PIPELINES.map((p) => pending(p.key, p.label))))

  return out
})

/** An external link, as opposed to a page of this dashboard. */
function isExternal(href: string | undefined): boolean {
  return !!href && /^https?:/.test(href)
}

const kindOptions = computed(() => [
  { value: null, label: 'Every kind' },
  ...(digest.data.value ?? []).map((row) => ({
    value: row.kind,
    label: `${humanizeKind(row.kind)} (${row.events})`,
  })),
])

const tableColumns: Column<TableHealth>[] = [
  { key: 'table_name', label: 'Table', width: '22%' },
  { key: 'live_rows', label: 'Rows', numeric: true, width: '11%', title: 'Planner estimate, not an exact count' },
  { key: 'dead_rows', label: 'Dead', numeric: true, width: '10%', title: 'Rows awaiting vacuum' },
  { key: 'total_bytes', label: 'Total', numeric: true, width: '11%' },
  { key: 'index_bytes', label: 'Indexes', numeric: true, width: '11%', hideBelow: 1100 },
  { key: 'seq_scan', label: 'Seq scans', numeric: true, width: '11%', hideBelow: 1400 },
  { key: 'idx_scan', label: 'Index scans', numeric: true, width: '11%', hideBelow: 1400 },
  { key: 'last_vacuum', label: 'Vacuumed', width: '13%', hideBelow: 1100 },
]

const eventColumns: Column<AdminEventRow>[] = [
  { key: 'kind', label: 'Event', width: '20%' },
  { key: 'actor_name', label: 'Account', width: '20%' },
  { key: 'list_name', label: 'List', width: '18%', hideBelow: 1100 },
  { key: 'detail', label: 'Detail', width: '26%' },
  { key: 'created_at', label: 'When', width: '16%' },
]

/** A rate-limit row plus the composite key that identifies it in the table. */
type RateLimitRowWithId = RateLimitRow & { id: string }

const limitColumns: Column<RateLimitRowWithId>[] = [
  { key: 'kind', label: 'Limiter', width: '30%' },
  { key: 'actor_name', label: 'Account', width: '34%' },
  { key: 'hits', label: 'Hits', numeric: true, width: '12%' },
  { key: 'window_start', label: 'Window opened', width: '24%' },
]

const tableRows = computed(() => health.data.value?.tables ?? [])
const eventRows = computed(() => events.data.value?.rows ?? [])
// admin_rate_limits hands back up to 100 counters in one read, which drew the
// panel several screens tall beside a two-line migrations card. They are paged
// here rather than asked for a page at a time: the read is already bounded and
// cheap, and paging it server-side would be a new RPC signature for nothing.
const LIMIT_PAGE = 10
const limitOffset = ref(0)
const limitPage = computed(() => limitRows.value.slice(limitOffset.value, limitOffset.value + LIMIT_PAGE))

const limitRows = computed<RateLimitRowWithId[]>(() =>
  (limits.data.value ?? []).map((row) => ({
    ...row,
    // The table's real primary key, which is what makes each row identifiable
    // without inventing an index-based one that shifts as rows age out.
    id: `${row.actor}:${row.kind}:${row.window_start}`,
  })),
)

// A refresh can leave fewer counters than the page being shown starts at,
// which drew a short or empty page. Step back to the last page that exists.
watch(
  () => limitRows.value.length,
  (total) => {
    if (limitOffset.value >= total) {
      limitOffset.value = Math.max(0, Math.floor((total - 1) / LIMIT_PAGE) * LIMIT_PAGE)
    }
  },
)

const errorEvents = computed(
  () => (digest.data.value ?? []).filter((row) => severityOf(row.kind) === 'error').reduce((sum, r) => sum + r.events, 0),
)
const warnEvents = computed(
  () => (digest.data.value ?? []).filter((row) => severityOf(row.kind) === 'warn').reduce((sum, r) => sum + r.events, 0),
)

const slowest = computed(() => {
  const list = (probes.data.value ?? []).filter((p) => p.latencyMs !== null)
  return list.length ? Math.max(...list.map((p) => p.latencyMs ?? 0)) : null
})

// Three states, not a boolean. See reachabilityOf() in data/health.ts for why
// an empty result set must never read as "everything is answering".
const reachability = computed(() => reachabilityOf(probes.data.value))

const probesError = computed(() =>
  probes.error.value
    ? describeError(probes.error.value).detail
    : 'The probe returned no results, so nothing here has been checked.',
)

const reachabilityHint = computed(() => {
  if (probes.loading.value) return 'Measuring'
  if (reachability.value === 'unknown') {
    return probes.error.value ? 'Could not run the probe' : 'Not measured yet'
  }
  return reachability.value === 'ok' ? 'Slowest round trip, ms' : 'A project is not answering'
})

const connectionsHint = computed(() => {
  const c = health.data.value?.connections
  return c ? `of ${c.max} allowed, ${formatCount(c.active)} active` : ''
})

// Newest first, so a table that stopped receiving rows sinks to the bottom
// where it stands out against the ones that are still moving.
const freshness = computed(() =>
  Object.entries(health.data.value?.freshness ?? {}).sort(([, a], [, b]) => {
    if (a === b) return 0
    if (!a) return 1
    if (!b) return -1
    return b.localeCompare(a)
  }),
)

const migrations = computed(() => health.data.value?.migrations ?? [])
const newestMigration = computed(() =>
  migrations.value.reduce<string | null>((max, m) => (max === null || m.version > max ? m.version : max), null),
)

// ─── the banner ──────────────────────────────────────────────────────────────
// Everything above the fold reduces to this: a list of sentences, each naming a
// thing that is wrong. Silence while the checks are still out is reported as
// "checking", never as health -- the same rule reachabilityOf() enforces.

const checking = computed(
  () =>
    probes.loading.value ||
    health.loading.value ||
    digest.loading.value ||
    (catalogOn && scrapes.loading.value) ||
    site.loading.value ||
    services.loading.value ||
    pipelines.loading.value,
)

const issues = computed<Issue[]>(() => {
  const out: Issue[] = []
  for (const probe of probes.data.value ?? []) {
    if (!probe.ok) out.push({ tone: 'bad', text: `${probe.label} is not answering`, anchor: CONNECTION_PANEL })
  }
  if (!probes.loading.value && reachability.value === 'unknown') {
    out.push({ tone: 'warn', text: 'Reachability could not be measured', anchor: CONNECTION_PANEL })
  }
  if (health.error.value) {
    out.push({ tone: 'bad', text: 'The database did not report on itself', anchor: CONNECTION_PANEL })
  }
  if (scrapes.error.value) out.push({ tone: 'warn', text: 'The scrapers could not be read' })
  out.push(...shopIssues.value)
  // The checks the lines above do not already cover: the databases and the
  // scrapers each have their own sentences, so only the rest is added here.
  for (const check of checks.value) {
    if (check.key.startsWith('probe') || check.key === 'scrapers') continue
    if (check.tone !== 'bad' && check.tone !== 'warn') continue
    out.push({
      tone: check.tone,
      text: `${check.label}: ${check.detail}`,
      to: check.href && !isExternal(check.href) ? check.href : undefined,
      href: isExternal(check.href) ? check.href : undefined,
    })
  }
  if (errorEvents.value > 0) {
    const n = errorEvents.value
    out.push({
      tone: 'warn',
      text: `${formatCount(n)} failed or denied ${n === 1 ? 'event' : 'events'} in the last ${range.value.label}`,
      anchor: EVENTS_PANEL,
    })
  }
  return out
})

const statusTone = computed<'idle' | 'good' | 'warn' | 'bad'>(() => {
  if (issues.value.some((i) => i.tone === 'bad')) return 'bad'
  if (issues.value.length) return 'warn'
  return checking.value ? 'idle' : 'good'
})

const headline = computed(() => {
  const n = issues.value.length
  if (n) return n === 1 ? 'One thing needs a look' : `${n} things need a look`
  return checking.value ? 'Checking everything' : 'Everything is working'
})

const allClear = computed(() =>
  catalogOn
    ? `Both projects, the site, the services and the pipelines answer, every shop's last run held up, and nothing was denied in the last ${range.value.label}.`
    : `The database answers, and nothing was denied in the last ${range.value.label}.`,
)
</script>

<template>
  <div class="page">
    <PageHeader
      title="System Health"
      description="Whether anything needs a look, and the detail behind the answer."
      :fetched-at="page.fetchedAt.value"
      :busy="page.busy.value"
      @refresh="page.refresh"
    >
      <template #tools>
        <SegmentedControl v-model="rangeKey" :segments="rangeSegments" aria-label="Time range" />
      </template>
    </PageHeader>

    <!-- The one loud thing on the page. Everything under it is quiet on purpose,
         so that when this turns red there is nothing else competing with it. -->
    <section
      class="status"
      :class="`status--${statusTone}`"
      role="status"
      aria-live="polite"
      :aria-busy="checking"
    >
      <AppSpinner v-if="statusTone === 'idle'" :size="18" class="status__spinner" />
      <span v-else class="status__mark" aria-hidden="true"></span>
      <div class="status__body">
        <p class="status__headline">
          {{ headline }}
          <!-- Problems already found while the rest is still out: say both. -->
          <AppSpinner v-if="checking && statusTone !== 'idle'" :size="13" class="status__more" />
        </p>
        <ul v-if="issues.length" class="status__issues">
          <li v-for="issue in issues" :key="issue.text" :class="`status__issue--${issue.tone}`">
            <RouterLink v-if="issue.to" :to="issue.to" class="status__link">{{ issue.text }}</RouterLink>
            <a v-else-if="issue.href" :href="issue.href" target="_blank" rel="noopener" class="status__link">{{ issue.text }}</a>
            <button v-else-if="issue.anchor" type="button" class="status__link status__jump" @click="goTo(issue.anchor)">
              {{ issue.text }}
            </button>
            <template v-else>{{ issue.text }}</template>
          </li>
        </ul>
        <span v-else-if="checking" class="status__skeleton u-skeleton" aria-hidden="true"></span>
        <p v-else class="status__detail">{{ allClear }}</p>
      </div>
    </section>

    <!-- Five tiles, so their own row of five rather than the twelve-column grid,
         which does not divide by five. -->
    <div class="tiles">
      <div>
        <StatTile
          label="API"
          :value="slowest === null ? null : Math.round(slowest)"
          :hint="reachabilityHint"
          :loading="probes.loading.value"
          polarity="down-good"
        />
      </div>
      <!-- Two databases, two sizes. It was one tile, and it was the app's: the
           catalog, by far the larger, was not measured anywhere. -->
      <div>
        <StatTile
          label="App database"
          :value="health.data.value?.database_size ?? null"
          format="bytes"
          :hint="health.data.value ? `Across ${formatCount(tableRows.length)} tables` : ''"
          :loading="health.loading.value"
        />
      </div>
      <div>
        <StatTile
          label="Catalog database"
          :value="scrapes.data.value?.database_size ?? null"
          format="bytes"
          :hint="catalogOn ? 'Products, listings and runs' : 'Not configured'"
          :loading="catalogOn && scrapes.loading.value"
        />
      </div>
      <div>
        <StatTile
          label="Connections"
          :value="health.data.value?.connections.total ?? null"
          :hint="connectionsHint"
          :loading="health.loading.value"
        />
      </div>
      <div>
        <StatTile
          label="Errors logged"
          :value="errorEvents"
          :hint="`Failed or denied, last ${range.label}`"
          :loading="digest.loading.value"
          polarity="down-good"
        />
      </div>
    </div>

    <PanelCard title="Checks" note="Each thing that must be working, checked when the page opened." :busy="page.busy.value">
      <ul class="checks">
        <li v-for="check in checks" :key="check.key" class="check">
          <StatusPill
            :tone="check.tone"
            :label="check.tone === 'good' ? 'OK' : check.tone === 'live' ? 'Running' : check.tone === 'idle' ? 'Checking' : check.tone === 'warn' ? 'Look' : 'Failing'"
            :busy="check.tone === 'idle' || check.tone === 'live'"
          />
          <span class="check__label">{{ check.label }}</span>
          <a v-if="isExternal(check.href)" class="check__detail" :href="check.href" target="_blank" rel="noopener">{{ check.detail }}</a>
          <RouterLink v-else-if="check.href" class="check__detail" :to="check.href">{{ check.detail }}</RouterLink>
          <span v-else class="check__detail">{{ check.detail }}</span>
        </li>
      </ul>
    </PanelCard>

    <div class="grid">
      <div class="span-6">
        <PanelCard
          :id="CONNECTION_PANEL"
          title="Connection"
          note="Measured from this browser, the way the app reaches the projects."
          :busy="refreshing(probes)"
          fill
        >
          <!-- Whether each project answers is a line in Checks above. What stays
               here is what only the database can say about itself. -->
          <StateBlock
            v-if="!probes.loading.value && reachability === 'unknown'"
            state="error"
            title="Reachability was not measured"
            :message="probesError"
            compact
          />

          <p v-if="health.data.value" class="conn">
            {{ formatCount(health.data.value.connections.active) }} active and
            {{ formatCount(health.data.value.connections.idle_in_transaction) }} idle in a transaction,
            of {{ formatCount(health.data.value.connections.total) }} open.
          </p>

          <!-- Static configuration, so it stays useful even when the probe could
               not run -- that is precisely when you want to check which project
               and issuer the failing request was aimed at. -->
          <dl class="config">
            <div>
              <dt>App database</dt>
              <dd class="u-mono">{{ target.label }}</dd>
            </div>
            <div>
              <dt>Catalog project</dt>
              <dd class="u-mono">{{ catalog.configured ? catalog.label : 'not configured' }}</dd>
            </div>
            <div>
              <dt>Clerk issuer</dt>
              <dd class="u-mono">{{ issuer || 'unknown' }}</dd>
            </div>
            <div>
              <dt>Postgres</dt>
              <dd class="u-mono">{{ health.data.value?.server_version || '--' }}</dd>
            </div>
            <div>
              <dt>Server time</dt>
              <dd>{{ health.data.value ? formatDateTime(health.data.value.server_time) : '--' }}</dd>
            </div>
          </dl>
        </PanelCard>
      </div>

      <div class="span-6">
        <PanelCard
          title="Newest row per table"
          note="When each table last received a row. One that stopped sinks to the bottom."
          :busy="refreshing(health)"
          fill
        >
          <StateBlock v-if="health.loading.value" state="loading" :lines="5" compact />
          <StateBlock
            v-else-if="health.error.value"
            state="error"
            :title="describeError(health.error.value).title"
            :message="describeError(health.error.value).detail"
          />
          <ul v-else class="fresh">
            <li v-for="[name, value] in freshness" :key="name" class="fresh__row">
              <span class="fresh__name u-mono">{{ name }}</span>
              <span class="fresh__when" :class="{ 'fresh__when--empty': !value }" :title="value ? formatDateTime(value) : ''">
                {{ value ? formatRelative(value) : 'empty' }}
              </span>
            </li>
          </ul>
        </PanelCard>
      </div>
    </div>

    <PanelCard
      :id="EVENTS_PANEL"
      title="Recent events"
      :note="`The audit trail: ${formatCount(errorEvents)} errors and ${formatCount(warnEvents)} warnings in the last ${range.label}.`"
      :busy="refreshing(events)"
      flush
    >
      <template #actions>
        <SelectField
          v-model="eventKind"
          label="Kind"
          :options="kindOptions"
          @update:model-value="eventOffset = 0"
        />
      </template>

      <DataTable
        :columns="eventColumns"
        :rows="eventRows"
        row-key="id"
        :loading="events.loading.value"
        :error="events.error.value ? describeError(events.error.value).detail : ''"
        empty-title="Nothing logged"
        empty-message="No invite code has failed, no rate limit has been hit and no role has changed in this window. That is the normal state."
      >
        <template #cell-kind="{ row }">
          <StatusPill
            :tone="severityOf(String(row.kind)) === 'error' ? 'bad' : severityOf(String(row.kind)) === 'warn' ? 'warn' : 'idle'"
            :label="humanizeKind(String(row.kind))"
          />
        </template>
        <template #cell-actor_name="{ row }">
          <UserChip
            v-if="row.actor"
            :id="String(row.actor)"
            :name="row.actor_name ? String(row.actor_name) : null"
            :src="row.actor_image_url ? String(row.actor_image_url) : null"
            :size="20"
          />
          <span v-else class="u-muted">unauthenticated</span>
        </template>
        <template #cell-list_name="{ row }">
          <RouterLink v-if="row.list_id" :to="`/lists/${row.list_id}`" class="link u-truncate">
            {{ row.list_name || 'Deleted list' }}
          </RouterLink>
          <span v-else class="u-muted">--</span>
        </template>
        <template #cell-detail="{ row }">
          <code class="detail u-mono u-truncate">{{ JSON.stringify(row.detail) }}</code>
        </template>
        <template #cell-created_at="{ row }">
          <span :title="formatDateTime(String(row.created_at))">
            {{ formatRelative(String(row.created_at)) }}
          </span>
        </template>
      </DataTable>

      <template #footer>
        <TablePager
          :total="events.data.value?.total ?? 0"
          :offset="eventOffset"
          :limit="LIMIT"
          :loading="events.fetching.value"
          @go="eventOffset = $event"
        />
      </template>
    </PanelCard>

    <PanelCard
      title="Tables"
      note="Row counts are planner estimates, so this stays cheap however large the tables get. Exact counts are on the Overview."
      :busy="refreshing(health)"
      flush
    >
      <DataTable
        :columns="tableColumns"
        :rows="tableRows"
        row-key="table_name"
        :loading="health.loading.value"
        empty-title="No table statistics"
        empty-message="The server reported no user tables in the public schema."
      >
        <template #cell-table_name="{ row }">
          <span class="u-mono">{{ row.table_name }}</span>
        </template>
        <template #cell-live_rows="{ row }">{{ formatCount(Number(row.live_rows)) }}</template>
        <template #cell-dead_rows="{ row }">
          <span :class="{ 'dead--high': Number(row.dead_rows) > Number(row.live_rows) * 0.2 }">
            {{ formatCount(Number(row.dead_rows)) }}
          </span>
        </template>
        <template #cell-total_bytes="{ row }">{{ formatBytes(Number(row.total_bytes)) }}</template>
        <template #cell-index_bytes="{ row }">{{ formatBytes(Number(row.index_bytes)) }}</template>
        <template #cell-seq_scan="{ row }">{{ formatCount(Number(row.seq_scan)) }}</template>
        <template #cell-idx_scan="{ row }">
          {{ row.idx_scan === null ? '--' : formatCount(Number(row.idx_scan)) }}
        </template>
        <template #cell-last_vacuum="{ row }">
          <span v-if="row.last_vacuum" :title="formatDateTime(String(row.last_vacuum))">
            {{ formatRelative(String(row.last_vacuum)) }}
          </span>
          <span v-else class="u-muted">never</span>
        </template>
      </DataTable>
    </PanelCard>

    <div class="grid">
      <div class="span-7">
        <PanelCard
          title="Rate limit counters"
          note="Buckets currently filling. Anything near its ceiling is someone being throttled, or a limit set too low."
          :busy="refreshing(limits)"
          flush
          fill
        >
          <DataTable
            :columns="limitColumns"
            :rows="limitPage"
            row-key="id"
            :loading="limits.loading.value"
            :error="limits.error.value ? describeError(limits.error.value).detail : ''"
            empty-title="No counters"
            empty-message="Nothing has been throttled recently, or the counters have aged out."
          >
            <template #cell-kind="{ row }">
              <StatusPill tone="idle" :label="humanizeKind(String(row.kind))" :dot="false" />
            </template>
            <!-- rate_limit_hit() also runs on paths with no session, where the
                 actor is a throttling key and not an account at all. Those keep
                 the copyable raw value: there is no profile to link to and no
                 face to show, and dressing one up as a person would be a lie. -->
            <template #cell-actor_name="{ row }">
              <UserChip
                v-if="row.actor_name"
                :id="String(row.actor)"
                :name="String(row.actor_name)"
                :src="row.actor_image_url ? String(row.actor_image_url) : null"
                :size="20"
              />
              <CopyValue v-else :value="String(row.actor)" label="actor" />
            </template>
            <template #cell-window_start="{ row }">
              <span :title="formatDateTime(String(row.window_start))">
                {{ formatRelative(String(row.window_start)) }}
              </span>
            </template>
          </DataTable>

          <!-- Always drawn, like Recent events: "1–1 of 1" says this is the whole
               table, where a lone row with no foot reads as something cut off. -->
          <template #footer>
            <TablePager
              :total="limitRows.length"
              :offset="limitOffset"
              :limit="LIMIT_PAGE"
              :loading="limits.fetching.value"
              @go="limitOffset = $event"
            />
          </template>
        </PanelCard>
      </div>

      <div class="span-5">
        <PanelCard
          title="Applied migrations"
          :note="migrations.length ? `${formatCount(migrations.length)} applied, the newest is ${newestMigration}.` : 'What this database believes it has run.'"
          fill
        >
          <StateBlock v-if="health.loading.value" state="loading" :lines="2" compact />
          <ul v-else-if="migrations.length" class="migrations">
            <li v-for="m in migrations" :key="m.version" class="migrations__row">
              <span class="u-mono migrations__version">{{ m.version }}</span>
              <span class="migrations__name u-truncate">{{ m.name }}</span>
            </li>
          </ul>
        </PanelCard>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tiles {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-4);
}

@media (max-width: 1100px) {
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* Two columns of lines: ten checks in one column is a scroll for no reason. */
.checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2) var(--space-6);
}

@media (max-width: 1100px) {
  .checks {
    grid-template-columns: minmax(0, 1fr);
  }
}

.check {
  display: grid;
  grid-template-columns: 6.5rem 9rem minmax(0, 1fr);
  align-items: center;
  gap: var(--space-3);
  font-size: var(--text-sm);
}

.check__label {
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.check__detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

a.check__detail:hover {
  color: var(--color-primary);
}

/* ── the banner ───────────────────────────────────────────────────────────── */

.status {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6);
  border-radius: var(--radius-lg);
  border: var(--border-width-thin) solid var(--border-main);
  background: var(--bg-surface);
  box-shadow: var(--elevation-soft);
}

/* The mark is a dot sitting in a halo of its own colour, so the state reads
   from across the room and not only from the words. The words are always there
   too: colour never carries the meaning alone. */
.status__mark {
  --mark: var(--status-idle);
  --halo: var(--status-idle-bg);
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 0.45rem;
  border-radius: 50%;
  background: var(--mark);
  box-shadow: 0 0 0 5px var(--halo);
}

.status--good .status__mark { --mark: var(--status-good); --halo: var(--status-good-bg); }
.status--warn .status__mark { --mark: var(--status-warn); --halo: var(--status-warn-bg); }
.status--bad .status__mark { --mark: var(--status-bad); --halo: var(--status-bad-bg); }

/* Sits where the mark will land, in the same box, so nothing moves when the
   checks come back. */
.status__spinner {
  margin-top: 0.3rem;
  color: var(--text-secondary);
}

/* A problem tints the whole band, not just the dot: it should be impossible to
   scroll past. A healthy page keeps the ordinary surface. */
.status--warn { background: var(--status-warn-bg); border-color: transparent; }
.status--bad { background: var(--status-bad-bg); border-color: transparent; }

.status__body {
  min-width: 0;
  flex: 1;
}

.status__headline {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xl);
  font-weight: var(--weight-bold);
  line-height: var(--leading-tight);
  color: var(--text-primary);
}

.status__more {
  color: var(--text-secondary);
}

.status__detail {
  margin: var(--space-1-5) 0 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.status__skeleton {
  width: min(28rem, 100%);
  height: 12px;
  margin-top: var(--space-2);
}

.status__issues {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-5);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.status__issues li::first-letter {
  text-transform: uppercase;
}

.status__issue--bad { color: var(--status-bad); }

/* The sentence is the link, in its own colour: a link-blue phrase in a red list
   would read as a different kind of thing. The underline is what says "go". */
.status__link {
  color: inherit;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

/* A jump to a panel on this page, dressed as the links beside it. */
.status__jump {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.status__link:hover {
  text-decoration-thickness: 2px;
}
.status__issue--warn { color: var(--status-warn); }

/* ── connection ───────────────────────────────────────────────────────────── */

.conn {
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.config {
  margin: var(--space-4) 0 0;
  padding-top: var(--space-3);
  border-top: var(--border-width-thin) solid var(--border-light);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--space-3);
}

.config dt {
  font-size: var(--text-2xs);
  color: var(--text-secondary);
}

.config dd {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-primary);
  word-break: break-all;
}

/* ── freshness ────────────────────────────────────────────────────────────── */

.fresh {
  list-style: none;
  margin: 0;
  padding: 0;
}

.fresh__row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-1-5) 0;
  font-size: var(--text-sm);
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

.fresh__row:last-child {
  border-bottom: 0;
}

.fresh__name {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.fresh__when {
  color: var(--text-primary);
  white-space: nowrap;
}

.fresh__when--empty {
  color: var(--text-disabled);
}

/* ── tables, events, migrations ───────────────────────────────────────────── */

.dead--high {
  color: var(--warning-text);
  font-weight: var(--weight-semibold);
}

.detail {
  font-size: var(--text-2xs);
  color: var(--text-secondary);
  display: block;
}

.link {
  color: var(--color-primary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  text-decoration: none;
  display: inline-block;
  max-width: 100%;
}

.link:hover {
  text-decoration: underline;
}

.migrations {
  list-style: none;
  margin: 0;
  padding: 0;
}

.migrations__row {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-1) 0;
  font-size: var(--text-xs);
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

.migrations__row:last-child {
  border-bottom: none;
}

.migrations__version {
  color: var(--text-disabled);
  flex: none;
}

.migrations__name {
  color: var(--text-primary);
  min-width: 0;
}

@media (max-width: 700px) {
  .status {
    padding: var(--space-4);
  }
}
</style>
