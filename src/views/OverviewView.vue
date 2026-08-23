<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import StatTile from '../components/StatTile.vue'
import LineChart from '../components/LineChart.vue'
import type { Series } from '../lib/uiTypes'
import BarChart from '../components/BarChart.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import { useQuery, describeError } from '../lib/useQuery'
import {
  deltaOf,
  fetchActivitySeries,
  fetchOverview,
  fetchPreviousWindow,
  fetchRecentActivity,
  searchVolume,
} from '../lib/data/overview'
import { probeProjects } from '../lib/data/health'
import { DEFAULT_RANGE, TIME_RANGES, bucketLabel, resolveRange } from '../lib/timeRange'
import { formatCompact, formatCount, formatDateTime, formatRelative, humanizeKind } from '../lib/format'

// The landing screen. Totals that ignore the range, a window that respects it,
// the shape of activity over time, and what just happened.

const rangeKey = ref<string>(DEFAULT_RANGE)
const range = computed(() => resolveRange(rangeKey.value))

const overview = useQuery((signal) => fetchOverview(range.value, signal), { watch: [range] })
const previous = useQuery((signal) => fetchPreviousWindow(range.value, signal), { watch: [range] })
const series = useQuery((signal) => fetchActivitySeries(range.value, signal), { watch: [range] })
const activity = useQuery((signal) => fetchRecentActivity(25, signal))
const probes = useQuery(() => probeProjects())

const busy = computed(
  () => overview.fetching.value || series.fetching.value || activity.fetching.value,
)

function refreshAll() {
  void overview.refetch()
  void previous.refetch()
  void series.refetch()
  void activity.refetch()
  void probes.refetch()
}

const rangeSegments = TIME_RANGES.map((r) => ({
  value: r.key,
  label: r.label,
  title: r.description,
}))

/** A window delta, or null when the previous window has not loaded yet. */
function delta(field: keyof NonNullable<typeof overview.data.value>['window']) {
  const current = overview.data.value?.window[field]
  const cumulative = previous.data.value?.[field]
  if (current === undefined || cumulative === undefined) return null
  return deltaOf(current, cumulative)
}

const buckets = computed(() => series.data.value ?? [])
const chartLabels = computed(() => buckets.value.map((b) => bucketLabel(b.bucket, range.value.bucket)))

const activitySeries = computed<Series[]>(() => [
  { key: 'items_added', label: 'Items added', values: buckets.value.map((b) => b.items_added) },
  { key: 'purchases', label: 'Items bought', values: buckets.value.map((b) => b.purchases) },
  { key: 'active_users', label: 'Active users', values: buckets.value.map((b) => b.active_users) },
  { key: 'members_joined', label: 'Members joined', values: buckets.value.map((b) => b.members_joined) },
])

/** Sparkline data for the tiles, from the same buckets the chart uses. */
const sparks = computed(() => ({
  items: buckets.value.map((b) => b.items_added),
  purchases: buckets.value.map((b) => b.purchases),
  actives: buckets.value.map((b) => b.active_users),
  joins: buckets.value.map((b) => b.members_joined),
}))

const householdSizes = computed(() =>
  (overview.data.value?.distribution.household_sizes ?? []).map((row) => ({
    key: `size-${row.members}`,
    label: row.members === 1 ? '1 member' : `${row.members} members`,
    value: row.households,
  })),
)

const membershipSpread = computed(() =>
  (overview.data.value?.distribution.members_per_user ?? []).map((row) => ({
    key: `hh-${row.households}`,
    label:
      row.households === 0
        ? 'In no household'
        : row.households === 1
          ? 'In 1 household'
          : `In ${row.households} households`,
    value: row.users,
  })),
)

const searches = searchVolume(DEFAULT_RANGE)

const overviewError = computed(() => describeError(overview.error.value))

/** Recent-activity rows get a tone so the feed can be scanned rather than read. */
function toneOf(kind: string): 'good' | 'warn' | 'bad' | 'idle' | 'accent' {
  if (kind === 'security_event') return 'warn'
  if (kind === 'checkout') return 'good'
  if (kind === 'household_created' || kind === 'member_joined') return 'accent'
  return 'idle'
}

function describeRow(row: { kind: string; subject: string | null; detail: Record<string, unknown> }): string {
  switch (row.kind) {
    case 'checkout':
      return `Bought ${row.detail.items ?? '?'} item${row.detail.items === 1 ? '' : 's'}`
    case 'member_joined':
      return `Joined as ${row.detail.role ?? 'member'}`
    case 'household_created':
      return `Created ${row.subject ?? 'a household'}`
    case 'item_added':
      return `Added ${row.subject ?? 'an item'}`
    case 'item_checked':
      return `Checked off ${row.subject ?? 'an item'}`
    case 'product_contributed':
      return `Contributed ${row.subject ?? 'a product'}`
    case 'security_event':
      return humanizeKind(row.subject)
    default:
      return humanizeKind(row.kind)
  }
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Overview"
      description="Totals as they stand now, and what moved inside the chosen window. Every number is read live from the app database."
      :fetched-at="overview.fetchedAt.value"
      :busy="busy"
      @refresh="refreshAll"
    >
      <template #tools>
        <SegmentedControl v-model="rangeKey" :segments="rangeSegments" aria-label="Time range" />
      </template>
    </PageHeader>

    <StateBlock
      v-if="overview.error.value"
      state="error"
      :title="overviewError.title"
      :message="overviewError.detail"
    />

    <template v-else>
      <!-- Totals. These ignore the range on purpose: a 24h view should not make
           it look as though there are three households in the world. -->
      <div class="grid">
        <div class="span-2">
          <StatTile
            label="Users"
            :value="overview.data.value?.totals.users ?? null"
            :delta="delta('new_users')"
            :spark="sparks.actives"
            hint="Profiles that exist"
          />
        </div>
        <div class="span-2">
          <StatTile
            label="Active users"
            :value="overview.data.value?.window.active_users ?? null"
            :delta="delta('active_users')"
            :spark="sparks.actives"
            spark-color="var(--chart-3)"
            hint="Wrote something in the window"
          />
        </div>
        <div class="span-2">
          <StatTile
            label="Households"
            :value="overview.data.value?.totals.households ?? null"
            :delta="delta('new_households')"
            :spark="sparks.joins"
            spark-color="var(--chart-2)"
            hint="Groups that exist"
          />
        </div>
        <div class="span-2">
          <StatTile
            label="Open list items"
            :value="overview.data.value?.totals.list_items_open ?? null"
            :delta="delta('items_added')"
            :spark="sparks.items"
            hint="Unchecked, right now"
          />
        </div>
        <div class="span-2">
          <StatTile
            label="Items bought"
            :value="overview.data.value?.totals.purchases ?? null"
            :delta="delta('purchases')"
            :spark="sparks.purchases"
            spark-color="var(--chart-2)"
            hint="Rows in purchase history"
          />
        </div>
        <div class="span-2">
          <StatTile
            label="Searches"
            :unrecorded="!searches.available"
            :unrecorded-reason="searches.available ? '' : 'search_catalog() writes nothing'"
          />
        </div>
      </div>

      <div class="grid">
        <div class="span-8">
          <PanelCard
            title="Activity"
            :note="`Counted per ${range.bucket}. Empty buckets are drawn, not skipped.`"
            fill
          >
            <StateBlock v-if="series.loading.value" state="loading" :lines="5" />
            <StateBlock
              v-else-if="series.error.value"
              state="error"
              title="Could not load the series"
              :message="series.error.value.message"
            />
            <LineChart
              v-else
              :series="activitySeries"
              :labels="chartLabels"
              :height="260"
              :format="formatCompact"
            />
          </PanelCard>
        </div>

        <div class="span-4">
          <PanelCard title="Recent activity" note="Across every household, newest first." fill flush>
            <StateBlock v-if="activity.loading.value" state="loading" :lines="6" />
            <StateBlock
              v-else-if="activity.error.value"
              state="error"
              title="Could not load activity"
              :message="activity.error.value.message"
            />
            <StateBlock
              v-else-if="!activity.data.value?.length"
              state="empty"
              title="Nothing yet"
              message="No households have been created and no lists have been touched on this database."
            />
            <ul v-else class="feed">
              <li v-for="(row, index) in activity.data.value" :key="`${row.kind}-${row.occurred_at}-${index}`" class="feed__row">
                <StatusPill :tone="toneOf(row.kind)" :label="humanizeKind(row.kind)" />
                <div class="feed__body">
                  <span class="feed__what u-truncate">{{ describeRow(row) }}</span>
                  <span class="feed__who u-truncate">
                    {{ row.actor_name || 'Unknown' }}
                    <template v-if="row.household_name"> · {{ row.household_name }}</template>
                  </span>
                </div>
                <time class="feed__when" :title="formatDateTime(row.occurred_at)">
                  {{ formatRelative(row.occurred_at) }}
                </time>
              </li>
            </ul>
          </PanelCard>
        </div>
      </div>

      <div class="grid">
        <div class="span-4">
          <PanelCard title="Household sizes" note="How many households have how many members." fill>
            <StateBlock v-if="overview.loading.value" state="loading" :lines="4" />
            <StateBlock
              v-else-if="!householdSizes.length"
              state="empty"
              title="No households"
              message="Nothing to distribute yet."
            />
            <BarChart v-else :bars="householdSizes" :format="formatCount" dense />
          </PanelCard>
        </div>

        <div class="span-4">
          <PanelCard title="Membership spread" note="How many households each account belongs to." fill>
            <StateBlock v-if="overview.loading.value" state="loading" :lines="4" />
            <StateBlock
              v-else-if="!membershipSpread.length"
              state="empty"
              title="No accounts"
              message="Nothing to distribute yet."
            />
            <BarChart v-else :bars="membershipSpread" :format="formatCount" dense />
          </PanelCard>
        </div>

        <div class="span-4">
          <PanelCard title="System" note="Reachability measured from this browser." fill>
            <StateBlock v-if="probes.loading.value" state="loading" :lines="3" />
            <div v-else class="system">
              <div v-for="probe in probes.data.value ?? []" :key="probe.target" class="system__row">
                <StatusPill :tone="probe.ok ? 'good' : 'bad'" :label="probe.ok ? 'Reachable' : 'Failing'" />
                <span class="system__name">{{ probe.label }}</span>
                <span class="system__value u-num">
                  {{ probe.latencyMs === null ? '--' : `${Math.round(probe.latencyMs)} ms` }}
                </span>
              </div>

              <dl class="system__facts">
                <div>
                  <dt>Memberships</dt>
                  <dd class="u-num">{{ formatCount(overview.data.value?.totals.memberships ?? 0) }}</dd>
                </div>
                <div>
                  <dt>Checkouts</dt>
                  <dd class="u-num">{{ formatCount(overview.data.value?.totals.checkouts ?? 0) }}</dd>
                </div>
                <div>
                  <dt>Contributed products</dt>
                  <dd class="u-num">{{ formatCount(overview.data.value?.totals.community_products ?? 0) }}</dd>
                </div>
                <div>
                  <dt>Audit events</dt>
                  <dd class="u-num">{{ formatCount(overview.data.value?.totals.security_events ?? 0) }}</dd>
                </div>
              </dl>

              <RouterLink to="/health" class="system__link">Open System Health</RouterLink>
            </div>
          </PanelCard>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.feed {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 330px;
  overflow-y: auto;
}

.feed__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

.feed__row:last-child {
  border-bottom: none;
}

.feed__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: var(--leading-snug);
}

.feed__what {
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.feed__who {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}

.feed__when {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  white-space: nowrap;
}

.system {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.system__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.system__name {
  color: var(--text-primary);
}

.system__value {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.system__facts {
  margin: 0;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-1) var(--space-3);
  padding-top: var(--space-3);
  border-top: var(--border-width-thin) solid var(--border-light);
}

.system__facts > div {
  display: contents;
}

.system__facts dt {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.system__facts dd {
  margin: 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  text-align: right;
}

.system__link {
  font-size: var(--text-xs);
  color: var(--color-primary);
  text-decoration: none;
  font-weight: var(--weight-semibold);
}

.system__link:hover {
  text-decoration: underline;
}
</style>
