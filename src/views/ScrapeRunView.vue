<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import CountryCode from '../components/CountryCode.vue'
import LineChart from '../components/LineChart.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import DataTable from '../components/DataTable.vue'
import TablePager from '../components/TablePager.vue'
import RunLogPanel from '../components/RunLogPanel.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { crumbOf, useLeafCrumb } from '../lib/breadcrumb'
import { catalogConfigured } from '../lib/data/catalog'
import {
  countryName,
  fetchScrapeRun,
  fetchShopRuns,
  formatRunDuration,
  isRemovalJob,
  isStalled,
  quietFor,
  removedCount,
  removedProducts,
  runDurationMs,
  runMessage,
  runPill,
  runProgress,
} from '../lib/data/scrapers'
import { fetchRunListings, LISTING_PAGE, type ListingKind, type RunListing } from '../lib/data/runLogs'
import type { Column, Segment } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatDayMonth, formatRelative } from '../lib/format'

// One scrape run, everything about it: the numbers the card and the history
// row have no room for, when it started and last answered and ended, how it
// compares with the shop's other nights, what it changed in the catalog, and
// what it said while it ran.
//
// Polls every 30 seconds while the run is running, like Scrapers (see there for
// why 30). The log does not wait for the poll: RunLogPanel is live on its own.

const REFRESH_MS = 30_000

const route = useRoute()
const runId = computed(() => String(route.params.runId ?? ''))
const configured = catalogConfigured()

const detail = useQuery((signal) => fetchScrapeRun(runId.value, signal), {
  watch: [runId],
  enabled: () => configured,
})
const run = computed(() => detail.data.value ?? null)
const running = computed(() => run.value?.status === 'running')
// Asked and answered with nothing, as opposed to not asked yet.
const missing = computed(() => detail.state.value === 'success' && !run.value)

const shopRuns = useQuery(
  (signal) => (run.value ? fetchShopRuns(run.value.retailer_id, signal) : Promise.resolve([])),
  { watch: [() => run.value?.retailer_id], enabled: () => configured },
)

useLeafCrumb(() => crumbOf(runId.value, run.value, (r) => r.id, (r) => `${r.shopName} ${r.country}`))

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => {
    if (!running.value) return
    // A tab in the background has nobody reading it.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void detail.refetch()
  }, REFRESH_MS)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

// "Now" is when the row was read, so a running run's duration agrees with the
// counts beside it.
const now = computed(() => detail.fetchedAt.value ?? Date.now())
const pill = computed(() => (run.value ? runPill(run.value, now.value) : null))
const progress = computed(() => (run.value ? runProgress(run.value, shopRuns.data.value ?? []) : null))
const percent = computed(() =>
  progress.value && progress.value.max > 0 ? Math.min(100, (progress.value.value / progress.value.max) * 100) : 0,
)

// Every count on the row, grouped by the question it answers. The card shows
// four of these; this is the one place the rest are read.
const groups = computed(() => {
  const r = run.value
  if (!r) return []
  return [
    {
      title: 'What it read',
      facts: [
        { label: 'Pages', value: r.pages_read },
        { label: 'Found', value: r.products_found },
        { label: 'Valid', value: r.products_valid },
        { label: 'Rejected', value: r.products_rejected },
      ],
    },
    {
      title: 'What it wrote',
      facts: [
        { label: 'Inserted', value: r.inserted },
        { label: 'Updated', value: r.updated },
        { label: 'Unchanged', value: r.unchanged },
        { label: 'New products', value: r.products_created },
        { label: 'Identifiers added', value: r.identifiers_added },
        { label: 'Conflicts', value: r.conflicts },
      ],
    },
    {
      title: 'What it took away',
      facts: [
        { label: 'Marked gone', value: r.marked_unavailable },
        { label: 'Listings removed', value: removedCount(r) },
        { label: 'Products removed', value: removedProducts(r) },
      ],
    },
    { title: 'Errors', facts: [{ label: 'Errors', value: r.error_count }] },
  ]
})

// `stats` flattened one level, so a key the scraper adds tomorrow shows up here
// without anyone touching this page.
const statEntries = computed(() => {
  const stats = (run.value?.stats ?? {}) as Record<string, unknown>
  return Object.entries(stats).flatMap(([key, value]) =>
    value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).map(([k, v]) => ({ key: `${key}.${k}`, value: String(v) }))
      : [{ key, value: String(value) }],
  )
})

const timeline = computed(() => {
  const r = run.value
  if (!r) return []
  const quiet = running.value ? quietFor(r, now.value) : null
  const length = formatRunDuration(runDurationMs(r, now.value))
  return [
    { label: 'Started', at: r.started_at, note: '' },
    { label: 'Last heard from the shop', at: r.last_alive_at, note: quiet !== null ? `${formatRunDuration(quiet)} ago` : '' },
    running.value
      ? { label: 'Running for', at: null, note: length }
      : { label: 'Finished', at: r.finished_at, note: `took ${length}` },
  ]
})

// The shop's nights, oldest first so the line reads left to right.
const history = computed(() => [...(shopRuns.data.value ?? [])].reverse())
const historyLabels = computed(() => history.value.map((r) => formatDayMonth(r.started_at)))
const readSeries = computed(() => [
  { key: 'read', label: 'Products read', values: history.value.map((r) => r.products_found) },
])
const minutesSeries = computed(() => [
  {
    key: 'minutes',
    label: 'Minutes taken',
    values: history.value.map((r) => Math.round(runDurationMs(r, now.value) / 60_000)),
  },
])

// ─── what it touched ─────────────────────────────────────────────────────────
const kind = ref<ListingKind>('new')
const offset = ref(0)
watch(kind, () => (offset.value = 0))
const kinds: Segment[] = [
  { value: 'new', label: 'New' },
  { value: 'repriced', label: 'Price changed' },
  { value: 'gone', label: 'Marked gone' },
]
const listings = useQuery((signal) => fetchRunListings(runId.value, kind.value, offset.value, signal), {
  watch: [runId, kind, offset],
  enabled: () => configured && Boolean(run.value),
})
const listingColumns: Column<RunListing>[] = [
  { key: 'name', label: 'Product', width: '50%' },
  { key: 'external_id', label: 'Shop id', width: '15%' },
  { key: 'previous_price', label: 'Was', numeric: true, width: '12%' },
  { key: 'price', label: 'Price', numeric: true, width: '12%' },
  { key: 'available', label: 'In stock', width: '11%' },
]
const asListing = (row: unknown) => row as RunListing
const money = (value: number | null, currency: string | null) =>
  value === null ? '' : `${Number(value).toFixed(2)} ${currency ?? ''}`.trim()

const loadError = computed(() => (detail.error.value ? describeError(detail.error.value).detail : ''))
const listingsError = computed(() => (listings.error.value ? describeError(listings.error.value).detail : ''))
</script>

<template>
  <div class="page">
    <PageHeader
      :title="run ? run.shopName : 'Scrape run'"
      :description="run ? `${countryName(run.country)}, started ${formatDateTime(run.started_at)}` : ''"
      :fetched-at="detail.fetchedAt.value"
      :busy="detail.fetching.value"
      @refresh="detail.refetch()"
    >
      <template #tools>
        <RouterLink to="/scrapers" class="back">All runs</RouterLink>
      </template>
    </PageHeader>

    <StateBlock
      v-if="!configured"
      state="empty"
      title="The catalog is not connected"
      message="This dashboard has no catalog project URL and key, so there are no runs to read."
    />
    <StateBlock v-else-if="loadError" state="error" title="Could not read the run" :message="loadError" />
    <StateBlock
      v-else-if="missing"
      state="empty"
      title="No such run"
      message="Nothing in the catalog has this id. It may have been deleted with its shop."
    />
    <StateBlock v-else-if="!run" state="loading" title="Reading the run" />

    <template v-else>
      <PanelCard title="Result">
        <div class="head">
          <CountryCode :code="run.country" />
          <StatusPill v-if="pill" v-bind="pill" />
          <span v-if="isRemovalJob(run)" class="kind">Removal</span>
          <span v-if="isStalled(run, now)" class="kind kind--warn">No sign of life</span>
        </div>
        <!-- The whole sentence, which the card clamps to two lines. -->
        <p v-if="runMessage(run)" class="message">{{ runMessage(run) }}</p>
        <template v-if="progress">
          <div
            class="progress"
            role="progressbar"
            :aria-valuenow="progress.value"
            aria-valuemin="0"
            :aria-valuemax="progress.max"
            :aria-label="progress.label"
          >
            <span :style="{ width: `${percent}%` }"></span>
          </div>
          <p class="u-num note">{{ progress.label }}</p>
        </template>
        <ol class="timeline">
          <li v-for="step in timeline" :key="step.label">
            <span class="timeline__label">{{ step.label }}</span>
            <span v-if="step.at" :title="formatRelative(step.at, now)">{{ formatDateTime(step.at) }}</span>
            <span v-else-if="!step.note">--</span>
            <span v-if="step.note" class="note">{{ step.note }}</span>
          </li>
        </ol>
      </PanelCard>

      <div class="groups">
        <PanelCard v-for="group in groups" :key="group.title" :title="group.title">
          <dl class="facts">
            <div v-for="fact in group.facts" :key="fact.label">
              <dt>{{ fact.label }}</dt>
              <dd class="u-num">{{ formatCount(fact.value) }}</dd>
            </div>
          </dl>
        </PanelCard>
      </div>

      <PanelCard v-if="statEntries.length" title="What the scraper counted" note="The run's stats, as reported.">
        <dl class="facts">
          <div v-for="entry in statEntries" :key="entry.key">
            <dt><code>{{ entry.key }}</code></dt>
            <dd class="u-num">{{ entry.value }}</dd>
          </div>
        </dl>
      </PanelCard>

      <PanelCard title="This shop's nights" :note="`The last ${history.length} runs of ${run.shopName}.`">
        <div v-if="history.length > 1" class="charts">
          <LineChart :series="readSeries" :labels="historyLabels" :height="180" :format="formatCount" />
          <LineChart :series="minutesSeries" :labels="historyLabels" :height="180" />
        </div>
        <StateBlock v-else state="empty" title="First run" message="Nothing earlier to compare with." compact />
      </PanelCard>

      <PanelCard
        title="What it touched"
        note="What is still true today: a later run that changes a listing again takes it off this one's list."
        flush
      >
        <template #actions>
          <SegmentedControl v-model="kind" :segments="kinds" aria-label="Which listings" />
        </template>
        <DataTable
          :columns="listingColumns"
          :rows="listings.data.value?.rows ?? []"
          row-key="external_id"
          :loading="listings.loading.value"
          :error="listingsError"
          empty-title="None"
        >
          <template #cell-name="{ row }">
            <a :href="asListing(row).product_url" target="_blank" rel="noopener">{{ asListing(row).name }}</a>
          </template>
          <template #cell-previous_price="{ row }">
            {{ money(asListing(row).previous_price, asListing(row).currency) }}
          </template>
          <template #cell-price="{ row }">{{ money(asListing(row).price, asListing(row).currency) }}</template>
          <template #cell-available="{ row }">{{ asListing(row).available ? 'Yes' : 'No' }}</template>
        </DataTable>
        <!-- In the footer, like every paged table here: the body is flush for
             the table, and the footer is what carries the padding. -->
        <template #footer>
          <TablePager
            :total="listings.data.value?.total ?? 0"
            :offset="offset"
            :limit="LISTING_PAGE"
            :loading="listings.fetching.value"
            @go="(next: number) => (offset = next)"
          />
        </template>
      </PanelCard>

      <RunLogPanel :run-id="run.id" :live="running" />
    </template>
  </div>
</template>

<style scoped>
.back {
  font-size: var(--text-sm);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.kind {
  padding: 0 var(--space-1);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.kind--warn {
  color: var(--status-warn);
  border-color: var(--status-warn-edge);
}

.message {
  margin: var(--space-3) 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.progress {
  height: 6px;
  margin-top: var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--border-light);
  overflow: hidden;
}

.progress span {
  display: block;
  height: 100%;
  background: var(--status-live);
}

.note {
  margin: var(--space-1) 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.timeline {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
  display: grid;
  gap: var(--space-1);
}

.timeline li {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
  font-size: var(--text-sm);
}

.timeline li .note {
  margin: 0;
}

.timeline__label {
  min-width: 14rem;
  color: var(--text-secondary);
}

.groups {
  display: grid;
  /* auto-FIT: the four groups share the whole row. auto-fill kept an empty
     fifth track on a wide screen and left a quarter of the row blank. */
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
  gap: var(--space-3);
}

.facts {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
  gap: var(--space-3);
}

.facts dt {
  font-size: var(--text-2xs);
  color: var(--text-secondary);
}

/* The browser indents a <dd> by 40px. */
.facts dd {
  margin: 0;
  font-weight: var(--weight-semibold);
}

.charts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
  gap: var(--space-4);
}
</style>
