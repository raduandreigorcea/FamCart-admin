<script setup lang="ts">
import { computed, ref } from 'vue'
import UserChip from '../components/UserChip.vue'
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
  failedJobs,
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
import { fetchCatalogStats, catalogConfigured } from '../lib/data/catalog'
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

// System Health: what answers, what the database says about itself, and the
// audit trail -- which is the closest thing FamCart has to an error stream,
// because the browser talks to PostgREST directly and Sentry only sees the
// browser.


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

// ─── the scrapers ────────────────────────────────────────────────────────────
// THE FAILURE THIS PANEL EXISTS FOR REPORTS NOTHING. A shop changes its markup
// or moves an endpoint, the scraper keeps completing, and the catalog quietly
// stops growing. There is no error anywhere -- the run is green and the number
// is smaller.
//
// So the number is shown next to the one before it. A delta is the only thing
// that distinguishes "read the whole shop" from "read a tenth of it and said it
// was fine".
const scrapes = useQuery((signal) => fetchCatalogStats(signal), { enabled: () => catalogConfigured() })

/** How a run's verdict should read. `partial` is not a failure and not a success:
 *  it imported what it saw and refused to conclude anything about the rest. */
function runTone(status: string | undefined): 'good' | 'warn' | 'bad' | 'idle' {
  if (status === 'completed') return 'good'
  if (status === 'partial') return 'warn'
  if (status === 'failed') return 'bad'
  if (status === 'running') return 'idle'
  return 'idle'
}

function runLabel(status: string | undefined): string {
  if (status === 'completed') return 'Completed'
  if (status === 'partial') return 'Refused to sweep'
  if (status === 'failed') return 'Failed'
  if (status === 'running') return 'Running'
  return 'Never run'
}

/** A shop whose last run found nothing, or far less than the run before it, is
 *  the thing somebody has to look at today rather than next month. */
function needsAttention(r: { last_run?: { status?: string; products_valid?: number } | null; delta?: number | null }): boolean {
  const status = r.last_run?.status
  if (!r.last_run) return true
  if (status === 'failed' || status === 'partial') return true
  return (r.delta ?? 0) < 0
}

const jobs = failedJobs()
const target = appTarget
const catalog = catalogTarget()
const issuer = clerkIssuer()

const rangeSegments = TIME_RANGES.map((r) => ({ value: r.key, label: r.label, title: r.description }))

// All five, so the spinner runs until the last of them lands and the header
// reports the stalest panel rather than the freshest. It used to watch two.
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

// The tile says the size; the only thing worth adding is what it is spread
// over, which is the table list further down this page.
const databaseSizeHint = computed(() =>
  health.data.value ? `Across ${formatCount(tableRows.value.length)} tables` : '',
)
const eventRows = computed(() => events.data.value?.rows ?? [])
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
  if (reachability.value === 'unknown') {
    return probes.error.value ? 'Could not run the probe' : 'Not measured yet'
  }
  return reachability.value === 'ok' ? 'Slowest round trip, ms' : 'A project is not answering'
})
</script>

<template>
  <div class="page">
    <PageHeader
      title="System Health"
      description="Reachability measured from this browser, what the database reports about itself, and the audit trail."
      :fetched-at="page.fetchedAt.value"
      :busy="page.busy.value"
      @refresh="page.refresh"
    >
      <template #tools>
        <SegmentedControl v-model="rangeKey" :segments="rangeSegments" aria-label="Time range" />
      </template>
    </PageHeader>

    <div class="grid">
      <div class="span-3">
        <StatTile
          label="API"
          :value="slowest === null ? null : Math.round(slowest)"
          :hint="reachabilityHint"
          polarity="down-good"
        />
      </div>
      <div class="span-3">
        <StatTile
          label="Database size"
          :value="health.data.value?.database_size ?? null"
          format="bytes"
          :hint="databaseSizeHint"
        />
      </div>
      <div class="span-3">
        <StatTile
          label="Errors logged"
          :value="errorEvents"
          :hint="`Failed or denied events, ${range.label}`"
          polarity="down-good"
          spark-color="var(--chart-3)"
        />
      </div>
      <div class="span-3">
        <StatTile
          label="Failed jobs"
          unrecorded
          unrecorded-reason="There is no job queue to fail"
        />
      </div>
    </div>

    <div class="grid">
      <div class="span-5">
        <PanelCard title="Reachability" note="Measured from this browser, the way the app reaches them." fill>
          <StateBlock v-if="probes.loading.value" state="loading" :lines="3" />
          <!-- The probe itself failed, so nothing was measured. Saying so beats
               rendering an empty list, which reads as "no problems found". -->
          <StateBlock
            v-else-if="reachability === 'unknown'"
            state="error"
            title="Reachability was not measured"
            :message="probesError"
            compact
          />
          <div class="probes">
            <div
              v-for="probe in reachability === 'unknown' ? [] : (probes.data.value ?? [])"
              :key="probe.target"
              class="probes__row"
            >
              <StatusPill :tone="probe.ok ? 'good' : 'bad'" :label="probe.ok ? 'Answering' : 'Failing'" />
              <div class="probes__body">
                <span class="probes__name">{{ probe.label }}</span>
                <span class="probes__detail u-truncate">{{ probe.detail }}</span>
              </div>
              <span class="probes__ms u-num">{{ formatDuration(probe.latencyMs) }}</span>
            </div>

            <!-- Static configuration, so it stays useful even when the probe
                 could not run -- that is precisely when you want to check which
                 project and issuer the failing request was aimed at. -->
            <dl class="probes__config u-facts">
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
            </dl>
          </div>
        </PanelCard>
      </div>

      <div class="span-7">
        <PanelCard title="Connections and freshness" note="What the server reports right now." fill>
          <StateBlock v-if="health.loading.value" state="loading" :lines="4" />
          <StateBlock
            v-else-if="health.error.value"
            state="error"
            :title="describeError(health.error.value).title"
            :message="describeError(health.error.value).detail"
          />
          <template v-else-if="health.data.value">
            <dl class="conn u-facts">
              <div>
                <dt>Connections</dt>
                <dd class="u-num">
                  {{ formatCount(health.data.value.connections.total) }}
                  <span class="conn__of">of {{ health.data.value.connections.max }}</span>
                </dd>
              </div>
              <div>
                <dt>Active</dt>
                <dd class="u-num">{{ formatCount(health.data.value.connections.active) }}</dd>
              </div>
              <div>
                <dt>Idle in transaction</dt>
                <dd class="u-num">{{ formatCount(health.data.value.connections.idle_in_transaction) }}</dd>
              </div>
              <div>
                <dt>Server time</dt>
                <dd>{{ formatDateTime(health.data.value.server_time) }}</dd>
              </div>
            </dl>

            <h4 class="sub u-caption">Newest row per table</h4>
            <ul class="fresh">
              <li v-for="(value, key) in health.data.value.freshness" :key="key" class="fresh__row">
                <span class="fresh__name u-mono">{{ key }}</span>
                <span class="fresh__when" :title="value ? formatDateTime(value) : 'empty table'">
                  {{ value ? formatRelative(value) : 'empty' }}
                </span>
              </li>
            </ul>
          </template>
        </PanelCard>
      </div>
    </div>

    <!-- The scrapers, and specifically the failure that reports nothing: a shop
         changes its markup, the scraper keeps completing, and the catalog
         quietly stops growing. Nothing errors. The run is green and the number
         is smaller, which is why the number before it is on the same row. -->
    <PanelCard
      v-if="catalogConfigured()"
      title="Scrapers"
      note="Each shop's last run, against the one before it. A catalog can rot without anything erroring."
      flush
    >
      <StateBlock v-if="scrapes.loading.value" state="loading" :lines="3" />
      <StateBlock
        v-else-if="scrapes.error.value"
        state="error"
        :title="describeError(scrapes.error.value).title"
        :message="describeError(scrapes.error.value).detail"
      />
      <template v-else-if="scrapes.data.value">
        <div class="u-tiles">
          <StatTile label="Products" :value="scrapes.data.value.products" />
          <StatTile label="Listings" :value="scrapes.data.value.listings" hint="One per shop that carries a product." />
          <StatTile
            label="With a barcode"
            :value="scrapes.data.value.with_barcode"
            hint="The only match anyone should fully trust. Carrefour publishes none."
          />
          <StatTile
            label="Out of stock"
            :value="scrapes.data.value.unavailable"
            polarity="down-good"
            hint="Reported by the shop. Nothing is ever deleted for being absent."
          />
          <StatTile
            label="Sold nowhere"
            :value="scrapes.data.value.orphans"
            polarity="down-good"
            hint="No shop lists it: made by hand here, or dropped everywhere."
          />
        </div>

        <ul class="shops">
          <li
            v-for="shop in scrapes.data.value.retailers"
            :key="shop.slug"
            class="shop"
            :class="{ 'shop--attention': needsAttention(shop) }"
          >
            <div class="shop__head">
              <span class="shop__name">{{ shop.slug }}</span>
              <StatusPill :tone="runTone(shop.last_run?.status)" :label="runLabel(shop.last_run?.status)" />
              <StatusPill v-if="!shop.enabled" tone="idle" label="Disabled" :dot="false" />
            </div>

            <dl class="shop__facts u-facts">
              <div>
                <dt>Found</dt>
                <dd class="u-num">
                  {{ shop.last_run ? formatCount(shop.last_run.products_valid) : '--' }}
                  <!-- The whole point of the panel. A run that read a tenth of a
                       shop and finished cleanly looks identical to a good one
                       until you put the previous number beside it. -->
                  <span
                    v-if="shop.delta !== null && shop.delta !== undefined && shop.delta !== 0"
                    class="shop__delta"
                    :class="shop.delta > 0 ? 'shop__delta--up' : 'shop__delta--down'"
                  >{{ shop.delta > 0 ? '+' : '' }}{{ formatCount(shop.delta) }}</span>
                </dd>
              </div>
              <div>
                <dt>Listings</dt>
                <dd class="u-num">{{ formatCount(shop.listings) }}</dd>
              </div>
              <div>
                <dt>In stock</dt>
                <dd class="u-num">{{ formatCount(shop.available) }}</dd>
              </div>
              <div>
                <dt>Marked gone</dt>
                <dd class="u-num">{{ shop.last_run ? formatCount(shop.last_run.marked_unavailable) : '--' }}</dd>
              </div>
              <div>
                <dt>Last run</dt>
                <dd>{{ shop.last_run ? formatDateTime(shop.last_run.started_at) : 'Never' }}</dd>
              </div>
            </dl>

            <!-- A run that refused to sweep says why, and that sentence is the
                 most useful thing on this panel when it appears. -->
            <p v-if="shop.last_run?.error" class="shop__why">{{ shop.last_run.error }}</p>
            <p v-else-if="!shop.last_run" class="shop__why">
              No scrape has ever run for this shop.
            </p>
          </li>
        </ul>
      </template>
    </PanelCard>

    <PanelCard
      title="Tables"
      note="Row counts are planner estimates, so this panel stays cheap however large the tables get. Exact counts are on the Overview."
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

    <PanelCard
      title="Recent events"
      :note="`The audit trail. ${formatCount(errorEvents)} error and ${formatCount(warnEvents)} warning events in the last ${range.label}.`"
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

    <div class="grid">
      <div class="span-7">
        <PanelCard
          title="Rate limit counters"
          note="Buckets currently filling. Anything near its ceiling is someone being throttled, or a limit set too low."
          flush
          fill
        >
          <DataTable
            :columns="limitColumns"
            :rows="limitRows"
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
        </PanelCard>
      </div>

      <div class="span-5">
        <PanelCard title="Failed jobs" fill>
          <StateBlock
            state="unrecorded"
            title="There is no job queue"
            :message="jobs.available ? '' : jobs.reason"
            :would-require="jobs.available ? '' : jobs.wouldRequire"
          />
        </PanelCard>

        <PanelCard title="Applied migrations" class="stacked" note="What this database believes it has run." flush fill>
          <StateBlock v-if="health.loading.value" state="loading" :lines="4" compact />
          <ul v-else class="migrations">
            <li v-for="m in health.data.value?.migrations ?? []" :key="m.version" class="migrations__row">
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
.shops {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-3);
}

.shop {
  padding: var(--space-3) var(--space-4);
  border-top: var(--border-width-thin) solid var(--border-light);
}

/* A left edge rather than a background wash: the panel already alternates
   surfaces and a second fill would fight it, where an edge reads as a margin
   note. */
.shop--attention {
  box-shadow: inset 3px 0 0 var(--status-warn);
}

.shop__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.shop__name {
  font-weight: var(--weight-semibold);
  text-transform: capitalize;
}

.shop__facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}

.shop__delta {
  margin-left: 0.35rem;
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
}

.shop__delta--up { color: var(--status-good); }
.shop__delta--down { color: var(--status-bad); }

.shop__why {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.probes {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.probes__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--space-3);
}

.probes__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: var(--leading-snug);
}

.probes__name {
  font-size: var(--text-sm);
  color: var(--text-primary);
  font-weight: var(--weight-medium);
}

.probes__detail {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}

.probes__ms {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
}

.probes__config,
.conn {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-3);
  padding-top: var(--space-3);
  border-top: var(--border-width-thin) solid var(--border-light);
}

.conn {
  padding-top: 0;
  border-top: none;
}

.probes__config dd,
.conn dd {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-primary);
  word-break: break-all;
}

.conn dd {
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
}

.conn__of {
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  color: var(--text-disabled);
}

.sub {
  margin: var(--space-4) 0 var(--space-2);
  padding-top: var(--space-3);
  border-top: var(--border-width-thin) solid var(--border-light);
}

.fresh {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: var(--space-1) var(--space-4);
}

.fresh__row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--text-xs);
  padding: 2px 0;
}

.fresh__name {
  color: var(--text-secondary);
}

.fresh__when {
  color: var(--text-primary);
  white-space: nowrap;
}

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
  text-decoration: none;
  display: inline-block;
  max-width: 100%;
}

.link:hover {
  text-decoration: underline;
}

.stacked {
  margin-top: var(--space-4);
}

.migrations {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 220px;
  overflow-y: auto;
}

.migrations__row {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-4);
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
</style>
