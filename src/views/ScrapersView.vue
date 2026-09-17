<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import ShopRunCard from '../components/ShopRunCard.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import DataTable from '../components/DataTable.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { catalogConfigured, fetchCatalogStats } from '../lib/data/catalog'
import {
  RUN_HISTORY_LIMIT,
  expectedCount,
  fetchScrapeRuns,
  countryName,
  formatRunDuration,
  groupByCountry,
  latestPerShop,
  needsAttention,
  runDurationMs,
  runLabel,
  runMessage,
  runTone,
  type ScrapeRunRow,
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

/** Roughly how many shops are live, so the loading row is the shape it will be. */
const SKELETON_SHOPS = 4

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

const latest = computed(() => latestPerShop(history.value))

/** Where a card sits on the page, so the list at the top can take you there. */
function cardId(run: ScrapeRunRow): string {
  return `shop-${run.id}`
}

// Everything a card needs, worked out once per refresh rather than per binding.
function cardFor(run: ScrapeRunRow) {
    const running = run.status === 'running'
    const expected = running ? expectedCount(run, history.value) : null
    const length = formatRunDuration(runDurationMs(run, now.value))
    const attention = run.status === 'failed' || run.status === 'partial'
    return {
      id: run.id,
      domId: cardId(run),
      props: {
        name: run.shopName,
        tone: runTone(run.status),
        label: runLabel(run.status),
        running,
        attention,
        count: formatCount(run.products_found),
        unit: running
          ? expected
            ? `of about ${formatCount(expected)} so far`
            : 'products read so far'
          : 'products read',
        progress: expected ? { value: run.products_found, max: expected } : null,
        when: running
          ? `Running for ${length}`
          : `Started ${formatRelative(run.started_at, now.value)}, took ${length}`,
        whenTitle: formatDateTime(run.started_at),
        facts: [
          { label: 'New', value: formatCount(run.products_created) },
          { label: 'Updated', value: formatCount(run.updated) },
          { label: 'Gone', value: formatCount(run.marked_unavailable), title: 'Listings this run marked as no longer sold' },
        ],
        message: runMessage(run),
      },
    }
}

// A SECTION PER COUNTRY, with no country treated as the main one. Twenty-two
// cards in one grid were a wall, and nine of them were titled "Lidl"; under a
// country heading each card is one of a handful, and "Lidl" needs no suffix.
const sections = computed(() =>
  groupByCountry(latest.value).map((section) => ({
    code: section.code,
    name: section.name,
    cards: section.runs.map(cardFor),
  })),
)

// What broke, named once at the top. The cards stay in their countries; this is
// only so that one failure is not a card somebody has to find among twenty-two.
const attention = computed(() =>
  needsAttention(latest.value).map((run) => ({
    id: cardId(run),
    label: `${run.shopName} (${countryName(run.country)})`,
  })),
)

// A button, not an anchor: the router's scrollBehavior sends every navigation
// to the top, and a hash change is a navigation to it.
function goTo(id: string) {
  const card = document.getElementById(id)
  if (!card) return
  card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  card.focus({ preventScroll: true })
}

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
      <!-- The cards' own shape while the first read is out, so the page does not
           jump from three grey lines to a row of cards. -->
      <ul v-if="runs.loading.value" class="shops" aria-busy="true" aria-label="Loading the runs">
        <ShopRunCard v-for="n in SKELETON_SHOPS" :key="n" loading />
      </ul>
      <StateBlock v-else-if="loadError" state="error" title="Could not read the runs" :message="loadError" />
      <StateBlock
        v-else-if="!sections.length"
        state="empty"
        title="No runs yet"
        message="No scraper has recorded a run. The nightly job writes one row per shop when it starts."
      />

      <template v-else>
        <p v-if="attention.length" class="attention" role="status">
          <span class="attention__count">
            {{ attention.length }} {{ attention.length === 1 ? 'needs' : 'need' }} attention:
          </span>
          <template v-for="(item, i) in attention" :key="item.id">
            <button type="button" class="attention__link" @click="goTo(item.id)">{{ item.label }}</button><span
              v-if="i < attention.length - 1"
              class="attention__sep"
              >, </span
            >
          </template>
        </p>

        <!-- One card per shop, from its newest run, under the country it sells in.
             The count is the headline because it is the one number that answers
             both questions this page exists for: is it moving, and did it read
             the whole shop. -->
        <section v-for="section in sections" :key="section.code" class="country">
          <h3 class="country__title">
            {{ section.name }}
            <span class="country__count">· {{ section.cards.length }}</span>
          </h3>
          <ul class="shops" :aria-label="`Each shop's newest run in ${section.name}`">
            <ShopRunCard
              v-for="card in section.cards"
              :id="card.domId"
              :key="card.id"
              tabindex="-1"
              v-bind="card.props"
            />
          </ul>
        </section>
      </template>

      <!-- One line of prose rather than five more big numbers: context for the
           cards, not a second headline. It says when it was counted, because
           unlike the cards it is not live. -->
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
.attention {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--status-bad-bg);
  color: var(--status-bad);
  font-size: var(--text-sm);
}

.attention__count {
  font-weight: var(--weight-semibold);
}

.attention__link {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.country {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.country__title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.country__count {
  font-weight: var(--weight-regular);
  color: var(--text-secondary);
}

/* Cards rather than full-width rows: a country's shops read side by side, so a
   count that is a tenth of its neighbour's is visible without reading a number.
   auto-fill, not auto-fit, so a country with one shop gets a card, not a
   banner: the cards line up in the same columns from one country to the next. */
.shops {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  gap: var(--space-3);
}

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
