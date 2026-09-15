<script setup lang="ts">
import { computed, ref, type Ref } from 'vue'
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
import { appTarget, catalogTarget, clerkIssuer } from '../lib/supabase'
import { DEFAULT_RANGE, TIME_RANGES, resolveRange, sinceIso } from '../lib/timeRange'
import type { AdminEventRow } from '../lib/data/types'
import type { Column } from '../lib/uiTypes'
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
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

/** A sentence in the banner. `to` is where its detail lives, when that is
 *  another page. */
type Issue = { tone: 'bad' | 'warn'; text: string; to?: string }

/** catalog_stats carries only the slug. Good enough for a name: "mega-image"
 *  reads as "mega image", and the banner capitalises the sentence. */
function shopName(slug: string): string {
  return slug.replace(/-/g, ' ')
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
  const name = shopName(shop.slug)
  const run = shop.last_run
  if (!run) return shop.enabled ? { tone: 'warn', text: `${name} has never been scraped`, to: '/scrapers' } : null
  if (run.status === 'failed') return { tone: 'bad', text: `${name} failed its last run`, to: '/scrapers' }
  if (run.status === 'partial') return { tone: 'warn', text: `${name} refused to sweep`, to: '/scrapers' }
  if (run.status === 'running') return null
  if ((shop.delta ?? 0) < 0) {
    return { tone: 'warn', text: `${name} found ${formatCount(-(shop.delta ?? 0))} fewer products than last time`, to: '/scrapers' }
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
const page = useQueryGroup([probes, health, digest, events, limits, scrapes])

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
  { key: 'household_name', label: 'Household', width: '18%', hideBelow: 1100 },
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
  () => probes.loading.value || health.loading.value || digest.loading.value || (catalogOn && scrapes.loading.value),
)

const issues = computed<Issue[]>(() => {
  const out: Issue[] = []
  for (const probe of probes.data.value ?? []) {
    if (!probe.ok) out.push({ tone: 'bad', text: `${probe.label} is not answering` })
  }
  if (!probes.loading.value && reachability.value === 'unknown') {
    out.push({ tone: 'warn', text: 'Reachability could not be measured' })
  }
  if (health.error.value) out.push({ tone: 'bad', text: 'The database did not report on itself' })
  if (scrapes.error.value) out.push({ tone: 'warn', text: 'The scrapers could not be read' })
  out.push(...shopIssues.value)
  if (errorEvents.value > 0) {
    const n = errorEvents.value
    out.push({ tone: 'warn', text: `${formatCount(n)} failed or denied ${n === 1 ? 'event' : 'events'} in the last ${range.value.label}` })
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
    ? `Both projects answer, every shop's last run held up, and nothing was denied in the last ${range.value.label}.`
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
            <template v-else>{{ issue.text }}</template>
          </li>
        </ul>
        <span v-else-if="checking" class="status__skeleton u-skeleton" aria-hidden="true"></span>
        <p v-else class="status__detail">{{ allClear }}</p>
      </div>
    </section>

    <div class="grid">
      <div class="span-3">
        <StatTile
          label="API"
          :value="slowest === null ? null : Math.round(slowest)"
          :hint="reachabilityHint"
          :loading="probes.loading.value"
          polarity="down-good"
        />
      </div>
      <div class="span-3">
        <StatTile
          label="Database size"
          :value="health.data.value?.database_size ?? null"
          format="bytes"
          :hint="health.data.value ? `Across ${formatCount(tableRows.length)} tables` : ''"
          :loading="health.loading.value"
        />
      </div>
      <div class="span-3">
        <StatTile
          label="Connections"
          :value="health.data.value?.connections.total ?? null"
          :hint="connectionsHint"
          :loading="health.loading.value"
        />
      </div>
      <div class="span-3">
        <StatTile
          label="Errors logged"
          :value="errorEvents"
          :hint="`Failed or denied, last ${range.label}`"
          :loading="digest.loading.value"
          polarity="down-good"
        />
      </div>
    </div>

    <div class="grid">
      <div class="span-6">
        <PanelCard
          title="Connection"
          note="Measured from this browser, the way the app reaches the projects."
          :busy="refreshing(probes)"
          fill
        >
          <StateBlock v-if="probes.loading.value" state="loading" :lines="2" compact />
          <!-- The probe itself failed, so nothing was measured. Saying so beats
               rendering an empty list, which reads as "no problems found". -->
          <StateBlock
            v-else-if="reachability === 'unknown'"
            state="error"
            title="Reachability was not measured"
            :message="probesError"
            compact
          />
          <ul v-else class="probes">
            <li v-for="probe in probes.data.value ?? []" :key="probe.target" class="probe">
              <StatusPill :tone="probe.ok ? 'good' : 'bad'" :label="probe.ok ? 'Answering' : 'Failing'" />
              <span class="probe__name">{{ probe.label }}</span>
              <span class="probe__ms u-num">{{ formatDuration(probe.latencyMs) }}</span>
              <span v-if="!probe.ok" class="probe__detail">{{ probe.detail }}</span>
            </li>
          </ul>

          <p v-if="health.data.value" class="conn">
            {{ formatCount(health.data.value.connections.active) }} active and
            {{ formatCount(health.data.value.connections.idle_in_transaction) }} idle in a transaction,
            of {{ formatCount(health.data.value.connections.total) }} open.
          </p>

          <!-- Static configuration, so it stays useful even when the probe could
               not run -- that is precisely when you want to check which project
               and issuer the failing request was aimed at. Closed by default
               because it is only ever read then. -->
          <details class="more">
            <summary class="more__summary">Configuration</summary>
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
          </details>
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
        <template #cell-household_name="{ row }">
          <RouterLink v-if="row.household_id" :to="`/households/${row.household_id}`" class="link u-truncate">
            {{ row.household_name || 'Deleted household' }}
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
          <details v-else-if="migrations.length" class="more more--flat">
            <summary class="more__summary">Show all</summary>
            <ul class="migrations">
              <li v-for="m in migrations" :key="m.version" class="migrations__row">
                <span class="u-mono migrations__version">{{ m.version }}</span>
                <span class="migrations__name u-truncate">{{ m.name }}</span>
              </li>
            </ul>
          </details>
        </PanelCard>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

.status__link:hover {
  text-decoration-thickness: 2px;
}
.status__issue--warn { color: var(--status-warn); }

/* ── connection ───────────────────────────────────────────────────────────── */

.probes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.probe {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  column-gap: var(--space-3);
}

.probe__name {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

.probe__ms {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
}

.probe__detail {
  grid-column: 2 / -1;
  font-size: var(--text-xs);
  color: var(--status-bad);
}

.conn {
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.more {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: var(--border-width-thin) solid var(--border-light);
}

.more--flat {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}

.more__summary {
  cursor: pointer;
  width: fit-content;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-primary);
  border-radius: var(--radius-xs);
}

.more__summary:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.config {
  margin: var(--space-3) 0 0;
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
  margin: var(--space-3) 0 0;
  padding: 0;
  max-height: 220px;
  overflow-y: auto;
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
