<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import DataTable from '../components/DataTable.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { catalogConfigured } from '../lib/data/catalog'
import {
  RUN_HISTORY_LIMIT,
  expectedCount,
  fetchScrapeRuns,
  formatRunDuration,
  latestPerShop,
  runDurationMs,
  runLabel,
  runMessage,
  runTone,
  type ScrapeRunRow,
} from '../lib/data/scrapers'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

// Scrapers: is a shop being read right now, how far has it got, and how did the
// last runs end.
//
// The Health page already carries each shop's LAST verdict. What it cannot say
// is whether a crawl that started two hours ago is still moving, because a
// dashboard that refreshes only on a button shows one moment. So this page asks
// again on its own, and it is the one page here that does -- the note on
// useQuery about not revalidating in the background is about panels whose
// numbers change daily, and a nightly crawl reports progress every few minutes.

// Twice a minute. The scraper reports progress every few hundred products,
// which is minutes apart on the slow shops; polling faster would show the same
// row and add load to a database that is already the bottleneck.
const REFRESH_MS = 30_000

const configured = catalogConfigured()
const runs = useQuery((signal) => fetchScrapeRuns(signal), { enabled: () => catalogConfigured() })

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

// Everything a tile needs, worked out once per refresh rather than per binding.
const shops = computed(() =>
  latestPerShop(history.value).map((run) => {
    const running = run.status === 'running'
    const expected = running ? expectedCount(run, history.value) : null
    const length = formatRunDuration(runDurationMs(run, now.value))
    return {
      run,
      expected,
      percent: expected ? Math.min(100, Math.round((run.products_found / expected) * 100)) : null,
      unit: running
        ? expected
          ? `of about ${formatCount(expected)} so far`
          : 'products read so far'
        : 'products read',
      when: running
        ? `Running for ${length}`
        : `Started ${formatRelative(run.started_at, now.value)}, took ${length}`,
      message: runMessage(run),
    }
  }),
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
      :busy="runs.fetching.value"
      @refresh="runs.refetch"
    />

    <PanelCard v-if="!configured" title="Scrapers">
      <StateBlock
        state="empty"
        title="The catalog is not connected"
        message="This dashboard has no catalog project URL and key, so there are no runs to read."
      />
    </PanelCard>

    <template v-else>
      <StateBlock v-if="runs.loading.value" state="loading" :lines="3" />
      <StateBlock v-else-if="loadError" state="error" title="Could not read the runs" :message="loadError" />
      <StateBlock
        v-else-if="!shops.length"
        state="empty"
        title="No runs yet"
        message="No scraper has recorded a run. The nightly job writes one row per shop when it starts."
      />

      <!-- One tile per shop, from its newest run. The count is the headline
           because it is the one number that answers both questions this page
           exists for: is it moving, and did it read the whole shop. -->
      <ul v-else class="shops" aria-label="Each shop's newest run">
        <li v-for="tile in shops" :key="tile.run.id" class="shop" :class="`shop--${tile.run.status}`">
          <div class="shop__head">
            <h2 class="shop__name">{{ tile.run.shopName }}</h2>
            <StatusPill :tone="runTone(tile.run.status)" :label="runLabel(tile.run.status)" />
          </div>

          <p class="shop__count">
            <span class="shop__number u-num">{{ formatCount(tile.run.products_found) }}</span>
            <span class="shop__unit">{{ tile.unit }}</span>
          </p>

          <div
            v-if="tile.percent !== null"
            class="shop__progress"
            role="progressbar"
            :aria-valuenow="tile.run.products_found"
            aria-valuemin="0"
            :aria-valuemax="tile.expected ?? undefined"
            :aria-label="`${tile.run.shopName}: ${tile.percent}% of what its last full run read`"
          >
            <span class="shop__bar" :style="{ width: `${tile.percent}%` }"></span>
          </div>

          <p class="shop__when" :title="formatDateTime(tile.run.started_at)">{{ tile.when }}</p>

          <dl class="shop__facts">
            <div>
              <dt class="u-caption">New</dt>
              <dd class="u-num">{{ formatCount(tile.run.products_created) }}</dd>
            </div>
            <div>
              <dt class="u-caption">Updated</dt>
              <dd class="u-num">{{ formatCount(tile.run.updated) }}</dd>
            </div>
            <div>
              <dt class="u-caption" title="Listings this run marked as no longer sold">Gone</dt>
              <dd class="u-num">{{ formatCount(tile.run.marked_unavailable) }}</dd>
            </div>
          </dl>

          <p v-if="tile.message" class="shop__why" :title="tile.message">{{ tile.message }}</p>
        </li>
      </ul>

      <PanelCard title="History" :note="`The last ${RUN_HISTORY_LIMIT} runs, newest first.`" flush>
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
            <StatusPill :tone="runTone(asRun(row).status)" :label="runLabel(asRun(row).status)" />
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
/* Tiles rather than full-width rows: four shops read side by side, so a count
   that is a tenth of its neighbour's is visible without reading a number.
   auto-fit, not auto-fill, so four shops stretch across the page. */
.shops {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: var(--space-3);
}

.shop {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
}

/* An edge only for the states somebody has to act on. A running shop is shown
   by its bar and its pulsing dot instead, and a finished one needs nothing. */
.shop--failed { box-shadow: inset 3px 0 0 var(--status-bad); }
.shop--partial { box-shadow: inset 3px 0 0 var(--status-warn); }

.shop__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.shop__name {
  margin: 0;
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
}

/* The one piece of motion on the page, and it means something: this is live. */
.shop--running :deep(.pill__dot) {
  animation: shop-live 1.6s ease-in-out infinite;
}

@keyframes shop-live {
  50% { opacity: 0.25; }
}

.shop__count {
  margin: 0;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  column-gap: var(--space-1-5);
}

.shop__number {
  font-size: var(--text-2xl);
  font-weight: var(--weight-bold);
  line-height: var(--leading-tight);
  color: var(--text-primary);
}

.shop__unit,
.shop__when {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.shop__when {
  margin: 0;
}

.shop__progress {
  height: 6px;
  margin: var(--space-1) 0;
  border-radius: var(--radius-pill);
  background: var(--border-light);
  overflow: hidden;
}

.shop__bar {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
  transition: width 0.6s ease;
}

.shop__facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
  margin: var(--space-3) 0;
  padding-top: var(--space-3);
  border-top: var(--border-width-thin) solid var(--border-light);
}

.shop__facts dd {
  /* The browser indents a <dd> by 40px, which is what pushed every value off
     its label in the first version of this page. */
  margin: 0;
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

/* Pinned to the bottom, so the messages of a row of failed shops line up
   whatever the tiles above them hold. */
.shop__why {
  margin: auto 0 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--status-bad-bg);
  color: var(--status-bad);
  font-size: var(--text-xs);
  line-height: var(--leading-snug);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.shop--partial .shop__why {
  background: var(--status-warn-bg);
  color: var(--status-warn);
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

@media (prefers-reduced-motion: reduce) {
  .shop--running :deep(.pill__dot) { animation: none; }
  .shop__bar { transition: none; }
}
</style>
