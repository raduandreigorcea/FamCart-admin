<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import DataTable from '../components/DataTable.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { catalogConfigured, fetchCatalogStats } from '../lib/data/catalog'
import {
  RUN_HISTORY_LIMIT,
  expectedCount,
  fetchScrapeRuns,
  formatRunDuration,
  groupShops,
  latestPerShop,
  runDurationMs,
  runLabel,
  runMessage,
  runTone,
  type ScrapeRunRow,
  type ShopGroupKey,
} from '../lib/data/scrapers'
import type { Column } from '../lib/uiTypes'
import { formatCompact, formatCount, formatDateTime, formatRelative } from '../lib/format'

// Scrapers: is a shop being read right now, how far has it got, and how did the
// last runs end.
//
// The ONLY place the shops are drawn. Health used to carry a copy of these cards
// and now only names a shop in trouble in its banner, linking here. What a
// Health-style page could never say is whether a crawl that started two hours
// ago is still moving, because a dashboard that refreshes only on a button
// shows one moment. So this page asks
// again on its own, and it is the one page here that does -- the note on
// useQuery about not revalidating in the background is about panels whose
// numbers change daily, and a nightly crawl reports progress every few minutes.

// Twice a minute. The scraper reports progress every few hundred products,
// which is minutes apart on the slow shops; polling faster would show the same
// row and add load to a database that is already the bottleneck.
const REFRESH_MS = 30_000

/** Placeholder rows while the first read is out: enough to look like a table. */
const SKELETON_ROWS = 6

const GROUP_TITLES: Record<ShopGroupKey, string> = {
  attention: 'Needs attention',
  home: 'Romania',
  abroad: 'Abroad',
}

const configured = catalogConfigured()
const runs = useQuery((signal) => fetchScrapeRuns(signal), { enabled: () => catalogConfigured() })

// The catalog as a whole, under the cards; it moved here from Health with them.
// Counted by pg_cron every 15 minutes (catalog 020), so it is read once and on
// Refresh rather than on the 30 second poll: it cannot have changed in between.
const stats = useQuery((signal) => fetchCatalogStats(signal), { enabled: () => catalogConfigured() })

function refresh() {
  void runs.refetch()
  void stats.refetch()
}

const catalogTotals = computed(() => {
  const s = stats.data.value
  if (!s) return []
  return [
    { value: s.products, label: 'products' },
    { value: s.listings, label: 'listings' },
    { value: s.with_barcode, label: 'with a barcode' },
    { value: s.unavailable, label: 'out of stock' },
    { value: s.orphans, label: 'sold nowhere' },
  ]
})

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  if (!configured) return
  timer = setInterval(() => {
    // A tab in the background has nobody reading it.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void runs.refetch()
  }, REFRESH_MS)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

// "Now" is when the rows were read, not when the template renders: a running
// run's duration should agree with the count printed beside it.
const now = computed(() => runs.fetchedAt.value ?? Date.now())

const history = computed(() => runs.data.value ?? [])
const loadError = computed(() => (runs.error.value ? describeError(runs.error.value).detail : ''))

// The poll, as opposed to the first load: the cards stay, and a spinner beside
// the History title says the numbers are being asked for again.
const polling = computed(() => runs.fetching.value && !runs.loading.value)

// Everything a row needs, worked out once per refresh rather than per binding.
function shopRow(run: ScrapeRunRow) {
  const running = run.status === 'running'
  const expected = running ? expectedCount(run, history.value) : null
  const length = formatRunDuration(runDurationMs(run, now.value))
  return {
    id: run.id,
    name: run.shopName,
    country: run.country,
    tone: runTone(run.status),
    label: runLabel(run.status),
    running,
    count: formatCount(run.products_found),
    // Only a running shop has a "so far"; a finished count is the whole answer.
    of: expected ? `of about ${formatCount(expected)}` : '',
    progress: expected ? { value: run.products_found, max: expected } : null,
    percent: expected ? Math.min(100, Math.round((run.products_found / expected) * 100)) : null,
    created: formatCount(run.products_created),
    when: running ? `for ${length}` : `${formatRelative(run.started_at, now.value)}, ${length}`,
    whenTitle: formatDateTime(run.started_at),
    message: runMessage(run),
  }
}

// ONE TABLE, NOT A CARD PER SHOP. Four shops read well side by side; twenty-two
// were a wall in which the one that broke was a card among twenty-two, and nine
// of them were called "Lidl". Grouped, with what broke lifted to the top (see
// groupShops), the whole night fits on one screen.
const groups = computed(() =>
  groupShops(latestPerShop(history.value)).map((group) => ({
    key: group.key,
    title: GROUP_TITLES[group.key],
    rows: group.runs.map(shopRow),
  })),
)

// The message gets the room: it is the only column whose content is a sentence,
// and the one a failed row is read for.
const columns: Column<ScrapeRunRow>[] = [
  { key: 'shopName', label: 'Shop', width: '11%' },
  { key: 'status', label: 'Result', width: '11%' },
  { key: 'started_at', label: 'Started', width: '14%' },
  { key: 'duration', label: 'Took', numeric: true, width: '9%' },
  { key: 'products_found', label: 'Read', numeric: true, width: '8%' },
  { key: 'products_created', label: 'New', numeric: true, width: '6%' },
  { key: 'marked_unavailable', label: 'Marked gone', numeric: true, width: '9%' },
  { key: 'error', label: 'What it said', width: '32%' },
]

function asRun(row: unknown): ScrapeRunRow {
  return row as ScrapeRunRow
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Scrapers"
      description="The nightly runs that read each shop into the catalog. While this page is open it checks again every 30 seconds."
      :fetched-at="runs.fetchedAt.value"
      :busy="runs.fetching.value || stats.fetching.value"
      @refresh="refresh"
    />

    <PanelCard v-if="!configured" title="Scrapers">
      <StateBlock
        state="empty"
        title="The catalog is not connected"
        message="This dashboard has no catalog project URL and key, so there are no runs to read."
      />
    </PanelCard>

    <template v-else>
      <!-- The table's own shape while the first read is out, so the page does not
           jump from grey lines to rows of a different height. -->
      <div v-if="runs.loading.value" class="shops" aria-busy="true" aria-label="Loading the runs">
        <div v-for="n in SKELETON_ROWS" :key="n" class="shops__skeleton">
          <span class="u-skeleton sk sk--name"></span>
          <span class="u-skeleton sk sk--pill"></span>
          <span class="u-skeleton sk sk--line"></span>
        </div>
      </div>
      <StateBlock v-else-if="loadError" state="error" title="Could not read the runs" :message="loadError" />
      <StateBlock
        v-else-if="!groups.length"
        state="empty"
        title="No runs yet"
        message="No scraper has recorded a run. The nightly job writes one row per shop when it starts."
      />

      <!-- One row per shop, from its newest run. The count leads because it is the
           one number that answers both questions this page exists for: is it
           moving, and did it read the whole shop. -->
      <div v-else class="shops">
        <table class="shops__table" aria-label="Each shop's newest run">
          <thead>
            <tr>
              <th scope="col">Shop</th>
              <th scope="col">Result</th>
              <th scope="col" class="num">Read</th>
              <th scope="col" class="num">New</th>
              <th scope="col">When</th>
              <th scope="col">What it said</th>
            </tr>
          </thead>
          <tbody v-for="group in groups" :key="group.key" :class="`shops__body--${group.key}`">
            <tr>
              <th scope="colgroup" colspan="6" class="shop-group u-caption">{{ group.title }}</th>
            </tr>
            <tr v-for="row in group.rows" :key="row.id" class="shop-row">
              <th scope="row" class="shop-row__shop">
                <span class="shop-row__name">{{ row.name }}</span>
                <span class="shop-row__country">{{ row.country }}</span>
              </th>
              <td><StatusPill :tone="row.tone" :label="row.label" :busy="row.running" /></td>
              <td class="num">
                <span class="shop-row__count u-num">{{ row.count }}</span>
                <span v-if="row.of" class="shop-row__of u-num">{{ row.of }}</span>
                <div
                  v-if="row.progress && row.percent !== null"
                  class="shop-row__progress"
                  role="progressbar"
                  :aria-valuenow="row.progress.value"
                  aria-valuemin="0"
                  :aria-valuemax="row.progress.max"
                  :aria-label="`${row.name} ${row.country}: ${row.percent}% of what its last full run read`"
                >
                  <span class="shop-row__bar" :style="{ width: `${row.percent}%` }"></span>
                </div>
              </td>
              <td class="num u-num">{{ row.created }}</td>
              <td class="shop-row__when" :title="row.whenTitle">{{ row.when }}</td>
              <td class="shop-row__why" :title="row.message ?? ''">{{ row.message ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- One line of prose rather than five more big numbers: context for the
           shops, not a second headline. It says when it was counted, because
           unlike the rows above it is not live. -->
      <ul v-if="stats.data.value" class="totals" aria-label="The catalog as a whole">
        <li v-for="t in catalogTotals" :key="t.label" :title="formatCount(t.value)">
          <span class="totals__value u-num">{{ formatCompact(t.value) }}</span> {{ t.label }}
        </li>
        <li class="totals__when" :title="stats.data.value.counted_at ? formatDateTime(stats.data.value.counted_at) : ''">
          {{ stats.data.value.counted_at ? `Counted ${formatRelative(stats.data.value.counted_at)}` : 'Not counted yet' }}
        </li>
      </ul>

      <PanelCard title="History" :note="`The last ${RUN_HISTORY_LIMIT} runs, newest first.`" :busy="polling" flush>
        <DataTable
          :columns="columns"
          :rows="history"
          row-key="id"
          :loading="runs.loading.value"
          :error="loadError"
          empty-title="No runs yet"
        >
          <template #cell-shopName="{ row }">
            <span class="history__shop">{{ asRun(row).shopName }}</span>
          </template>
          <template #cell-status="{ row }">
            <StatusPill
              :tone="runTone(asRun(row).status)"
              :label="runLabel(asRun(row).status)"
              :busy="asRun(row).status === 'running'"
            />
          </template>
          <template #cell-started_at="{ row }">
            <span :title="formatRelative(asRun(row).started_at, now)">{{ formatDateTime(asRun(row).started_at) }}</span>
          </template>
          <template #cell-duration="{ row }">
            {{ formatRunDuration(runDurationMs(asRun(row), now)) }}
          </template>
          <template #cell-products_found="{ row }">
            {{ formatCount(asRun(row).products_found) }}
          </template>
          <template #cell-products_created="{ row }">
            {{ formatCount(asRun(row).products_created) }}
          </template>
          <template #cell-marked_unavailable="{ row }">
            {{ formatCount(asRun(row).marked_unavailable) }}
          </template>
          <template #cell-error="{ row }">
            <span class="history__why" :title="runMessage(asRun(row)) ?? ''">{{ runMessage(asRun(row)) ?? '' }}</span>
          </template>
        </DataTable>
      </PanelCard>
    </template>
  </div>
</template>

<style scoped>
.shops {
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  overflow-x: auto;
}

.shops__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.shops__table th,
.shops__table td {
  padding: var(--space-2) var(--space-3);
  text-align: left;
  vertical-align: middle;
  white-space: nowrap;
}

.shops__table thead th {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  border-bottom: var(--border-width-thin) solid var(--border-main);
}

.shops__table .num {
  text-align: right;
}

/* The caption itself is .u-caption; only the room above it is this page's. */
.shops__table .shop-group {
  padding-top: var(--space-4);
}

/* The one heading that should be seen from across the room. */
.shops__body--attention .shop-group {
  color: var(--status-bad);
}

.shop-row + .shop-row > * {
  border-top: var(--border-width-thin) solid var(--border-light);
}

.shops__body--attention .shop-row {
  background: color-mix(in srgb, var(--status-bad-bg) 45%, transparent);
}

.shop-row__shop {
  font-weight: var(--weight-semibold);
}

.shop-row__country {
  margin-left: var(--space-2);
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--border-light);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
}

.shop-row__count {
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.shop-row__of {
  margin-left: var(--space-1);
  color: var(--text-secondary);
}

.shop-row__progress {
  width: 7rem;
  height: 4px;
  margin: var(--space-1) 0 0 auto;
  border-radius: var(--radius-pill);
  background: var(--border-light);
  overflow: hidden;
}

.shop-row__bar {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--status-live);
  transition: width 0.6s ease;
}

.shop-row__when {
  color: var(--text-secondary);
}

/* The only column holding a sentence: it takes what is left, on one line, with
   the whole of it in the tooltip. */
.shop-row__why {
  width: 100%;
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-secondary);
}

.shops__skeleton {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3);
}

.shops__skeleton + .shops__skeleton {
  border-top: var(--border-width-thin) solid var(--border-light);
}

.sk--name { width: 7rem; height: 14px; }
.sk--pill { width: 4.5rem; height: 18px; border-radius: var(--radius-pill); }
.sk--line { flex: 1; height: 12px; }

.totals {
  list-style: none;
  margin: 0;
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-5);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
}

.totals__value {
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.totals__when {
  margin-left: auto;
  color: var(--text-disabled);
}

.history__shop {
  font-weight: var(--weight-semibold);
}

/* One line in the table, with the whole sentence in the tooltip. */
.history__why {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
</style>
