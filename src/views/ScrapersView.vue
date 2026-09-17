<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import ShopRunCard from '../components/ShopRunCard.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import DataTable from '../components/DataTable.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { catalogConfigured, fetchCatalogStats } from '../lib/data/catalog'
import {
  ALL_COUNTRIES,
  RUN_HISTORY_LIMIT,
  isStalled,
  quietFor,
  countriesIn,
  countryName,
  expectedCount,
  fetchScrapeRuns,
  formatRunDuration,
  inCountry,
  latestPerShop,
  runDurationMs,
  runMessage,
  runPill,
  type ScrapeRunRow,
} from '../lib/data/scrapers'
import type { Column, Segment } from '../lib/uiTypes'
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

// WHICH COUNTRY. Twenty-two shops in one grid is a wall; the selector cuts it to
// one country's handful, the way the time range does on Health. Kept for as long
// as the page is open, like that one, and not remembered: the page should open
// on every shop, since "nothing is wrong" is a claim about all of them.
const country = ref<string>(ALL_COUNTRIES)

// Only the countries that have a run, so no button empties the page. Codes
// rather than names, because eleven country names do not fit in one control;
// the name is in the tooltip.
const segments = computed<Segment[]>(() => [
  { value: ALL_COUNTRIES, label: 'All', title: 'Every country' },
  ...countriesIn(history.value).map((code) => ({ value: code, label: code, title: countryName(code) })),
])

// A refresh can take away the country on show -- its runs aged out of the rows.
// Fall back to every shop rather than draw an empty page with a live filter.
watch(segments, (list) => {
  if (!list.some((segment) => segment.value === country.value)) country.value = ALL_COUNTRIES
})

const shown = computed(() => inCountry(history.value, country.value))

// The totals follow the selector. A country's numbers come from the cache's own
// per-country count (catalog 020), not from adding shops up: a product two shops
// in one country both sell is one product there. "Sold nowhere" belongs to no
// country, so it is only said for all of them. A catalog that predates the
// per-country count sends none, and then the line says nothing rather than show
// the whole catalog's numbers under a country's name.
const catalogTotals = computed(() => {
  const s = stats.data.value
  if (!s) return []
  if (country.value === ALL_COUNTRIES) {
    return [
      { value: s.products, label: 'products' },
      { value: s.listings, label: 'listings' },
      { value: s.with_barcode, label: 'with a barcode' },
      { value: s.unavailable, label: 'out of stock' },
      { value: s.orphans, label: 'sold nowhere' },
    ]
  }
  if (!s.countries) return []
  const c = s.countries[country.value] ?? { products: 0, listings: 0, with_barcode: 0, unavailable: 0 }
  return [
    { value: c.products, label: 'products' },
    { value: c.listings, label: 'listings' },
    { value: c.with_barcode, label: 'with a barcode' },
    { value: c.unavailable, label: 'out of stock' },
  ]
})
const loadError = computed(() => (runs.error.value ? describeError(runs.error.value).detail : ''))

// The poll, as opposed to the first load: the cards stay, and a spinner beside
// the History title says the numbers are being asked for again.
const polling = computed(() => runs.fetching.value && !runs.loading.value)

// Everything a card needs, worked out once per refresh rather than per binding.
const shops = computed(() =>
  latestPerShop(shown.value).map((run) => {
    const running = run.status === 'running'
    const expected = running ? expectedCount(run, history.value) : null
    const length = formatRunDuration(runDurationMs(run, now.value))
    // Is it doing anything? Pages move while the imported count cannot, and the
    // last answer from the shop says whether it is still being answered at all.
    const quiet = running ? quietFor(run, now.value) : null
    const stalled = isStalled(run, now.value)
    const alive = quiet === null ? '' : ` · alive ${formatRunDuration(quiet)} ago`
    const pill = runPill(run, now.value)
    return {
      id: run.id,
      props: {
        name: run.shopName,
        tone: pill.tone,
        label: pill.label,
        running: pill.busy,
        attention: stalled,
        count: formatCount(run.products_found),
        unit: running
          ? expected
            ? `of about ${formatCount(expected)} so far`
            : 'products read so far'
          : 'products read',
        progress: expected ? { value: run.products_found, max: expected } : null,
        when: running
          ? `Running for ${length}${alive}`
          : `Started ${formatRelative(run.started_at, now.value)}, took ${length}`,
        whenTitle: formatDateTime(run.started_at),
        facts: [
          ...(running
            ? [{ label: 'Pages', value: formatCount(run.pages_read), title: 'Pages read so far, products or not' }]
            : []),
          { label: 'New', value: formatCount(run.products_created) },
          { label: 'Updated', value: formatCount(run.updated) },
          { label: 'Gone', value: formatCount(run.marked_unavailable), title: 'Listings this run marked as no longer sold' },
        ],
        message: stalled && quiet !== null
          ? `Nothing heard from the shop for ${formatRunDuration(quiet)}. The job may have been killed, or the shop stopped answering.`
          : runMessage(run),
      },
    }
  }),
)

// ONE ROW WHEN EVERY COUNTRY IS ON SHOW. Twenty-two cards is a wall; the row
// holds as many as fit at their normal size, in the order they started, newest
// first, and says how many it left out. No shop is lost by it: every run is in
// the history under the cards, with the same pill (runPill). A chosen country
// shows all of its shops.
//
// "As many as fit" is read off the grid itself: with auto-fill, the browser
// resolves grid-template-columns to one length per track, so counting them is
// counting the columns at the cards' real size, whatever the window.
const FALLBACK_COLUMNS = 4
const grid = ref<HTMLElement | null>(null)
const columnCount = ref(FALLBACK_COLUMNS)

function measure() {
  const el = grid.value
  if (!el || typeof getComputedStyle !== 'function') return
  // A resolved template is lengths only ("224px 224px ..."). Anything else --
  // the unresolved repeat() a DOM without layout returns -- is not a count.
  const tracks = getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/)
  const resolved = tracks.length > 0 && tracks.every((t) => /^\d+(\.\d+)?px$/.test(t))
  columnCount.value = resolved ? tracks.length : FALLBACK_COLUMNS
}

let resizer: ResizeObserver | null = null
watch(grid, (el) => {
  resizer?.disconnect()
  if (!el) return
  measure()
  if (typeof ResizeObserver === 'function') {
    resizer = new ResizeObserver(measure)
    resizer.observe(el)
  }
})
onBeforeUnmount(() => resizer?.disconnect())

const oneRow = computed(() => country.value === ALL_COUNTRIES)
const visibleShops = computed(() => (oneRow.value ? shops.value.slice(0, columnCount.value) : shops.value))
const hiddenCount = computed(() => shops.value.length - visibleShops.value.length)

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
    >
      <template #tools>
        <!-- One country is no choice at all, so the control waits for a second. -->
        <SegmentedControl
          v-if="segments.length > 2"
          v-model="country"
          :segments="segments"
          aria-label="Country"
        />
      </template>
    </PageHeader>

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
        v-else-if="!shops.length"
        state="empty"
        title="No runs yet"
        message="No scraper has recorded a run. The nightly job writes one row per shop when it starts."
      />

      <!-- One card per shop, from its newest run. The count is the headline
           because it is the one number that answers both questions this page
           exists for: is it moving, and did it read the whole shop. -->
      <template v-else>
        <ul ref="grid" class="shops" aria-label="Each shop's newest run">
          <ShopRunCard v-for="shop in visibleShops" :key="shop.id" v-bind="shop.props" />
        </ul>
        <p v-if="hiddenCount > 0" class="shops__more">
          +{{ hiddenCount }} more, choose a country
        </p>
      </template>

      <!-- One line of prose rather than five more big numbers: context for the
           cards, not a second headline. It says when it was counted, because
           unlike the cards it is not live. -->
      <ul
        v-if="stats.data.value && catalogTotals.length"
        class="totals"
        :aria-label="country === ALL_COUNTRIES ? 'The catalog as a whole' : `The catalog in ${countryName(country)}`"
      >
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
          :rows="shown"
          row-key="id"
          :loading="runs.loading.value"
          :error="loadError"
          empty-title="No runs yet"
        >
          <template #cell-shopName="{ row }">
            <span class="history__shop">{{ asRun(row).shopName }}</span>
          </template>
          <template #cell-status="{ row }">
            <StatusPill v-bind="runPill(asRun(row), now)" />
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
/* Cards rather than full-width rows: shops read side by side, so a count that is
   a tenth of its neighbour's is visible without reading a number.

   auto-fill, not auto-fit. auto-fit collapses the empty tracks and hands their
   room to the cards, which was fine for four shops and turns one shop -- a
   country chosen in the selector -- into a banner the width of the page. With
   auto-fill the empty tracks keep their room, so a card is the same size whether
   it has twenty-one neighbours or none. */
.shops {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  gap: var(--space-3);
}

.shops__more {
  margin: calc(var(--space-2) * -1) 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  text-align: right;
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
