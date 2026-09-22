<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import ShopRunCard from '../components/ShopRunCard.vue'
import CountryCode from '../components/CountryCode.vue'
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
  fetchScrapeRuns,
  formatRunDuration,
  inCountry,
  runProgress,
  isRemovalJob,
  removedCount,
  removedProducts,
  splitCards,
  runDurationMs,
  runMessage,
  runPill,
  type ScrapeRunRow,
} from '../lib/data/scrapers'
import type { Column, Segment } from '../lib/uiTypes'
import { formatClock, formatCompact, formatCount, formatDateTime, formatRelative } from '../lib/format'

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
//
// A link can name the country and a run -- the Health banner's "Lidl BE failed"
// is /scrapers?country=BE&run=<id> -- and the page opens there with that run
// marked. A country with no runs is dropped by the watch below, like any other.
const route = useRoute()
const queryText = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const country = ref<string>(queryText(route.query.country)?.toUpperCase() ?? ALL_COUNTRIES)
const focusRun = computed(() => queryText(route.query.run))

// Only the countries that have a run, so no button empties the page. Codes
// rather than names, because eleven country names do not fit in one control.
// The name is a hover card on the code (see the template), not a native title:
// one tooltip per code, not two.
const segments = computed<Segment[]>(() => [
  { value: ALL_COUNTRIES, label: 'All', title: 'Every country' },
  ...countriesIn(history.value).map((code) => ({ value: code, label: code })),
])

// A refresh can take away the country on show -- its runs aged out of the rows.
// Fall back to every shop rather than draw an empty page with a live filter.
watch(segments, (list) => {
  if (!list.some((segment) => segment.value === country.value)) country.value = ALL_COUNTRIES
})

const shown = computed(() => inCountry(history.value, country.value))

// "2 shops read" under a country's name on hover, counted from the runs at hand.
const shopsByCountry = computed(() => {
  const counts = new Map<string, Set<string>>()
  for (const run of history.value) {
    const set = counts.get(run.country) ?? new Set<string>()
    set.add(run.shop)
    counts.set(run.country, set)
  }
  return counts
})

function countryNote(code: string): string {
  const n = shopsByCountry.value.get(code)?.size ?? 0
  return `${n} ${n === 1 ? 'shop' : 'shops'} read`
}

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

// THE FIVE NEWEST RUNS ARE CARDS; EVERYTHING OLDER IS THE HISTORY. A run is in
// one or the other, never both, and one card per shop (see splitCards). This
// replaced a row sized by measuring the grid with a "+N more" line under it:
// with the history right below, "more" was already on the page.
const split = computed(() => splitCards(shown.value))

// Everything a card needs, worked out once per refresh rather than per binding.
const shops = computed(() =>
  split.value.cards.map((run) => {
    const running = run.status === 'running'
    const progress = runProgress(run, history.value)
    const length = formatRunDuration(runDurationMs(run, now.value))
    // Is it doing anything? Pages move while the imported count cannot, and the
    // last answer from the shop says whether it is still being answered at all.
    const quiet = running ? quietFor(run, now.value) : null
    const stalled = isStalled(run, now.value)
    const alive = quiet === null ? '' : ` · alive ${formatRunDuration(quiet)} ago`
    const pill = runPill(run, now.value)
    const removal = isRemovalJob(run)
    // The hour it started, which is how a nightly run is read; the relative
    // time is in the tooltip with the full date.
    const started = `Started ${formatClock(run.started_at, now.value)}`
    return {
      id: run.id,
      props: {
        name: run.shopName,
        country: run.country,
        countryNote: countryNote(run.country),
        tone: pill.tone,
        label: pill.label,
        // The kind of job, beside the name; the pill keeps the outcome.
        kind: removal ? 'Removal' : '',
        running: pill.busy,
        done: pill.tone === 'good',
        failed: pill.tone === 'bad',
        attention: stalled,
        // A removal job imports nothing, so its headline is what it deleted.
        count: formatCount(removal ? removedCount(run) : run.products_found),
        unit: removal
          ? running ? 'listings removed so far' : 'listings removed'
          : running ? 'products read so far' : 'products read',
        progress: progress ? { value: progress.value, max: progress.max } : null,
        progressLabel: progress?.label ?? '',
        // Moving, with nothing to measure it by. Not for a run gone quiet: that
        // one must not look busy.
        indeterminate: running && !progress && !stalled,
        when: running
          ? `${started} · running for ${length}${alive}`
          : `${started} · took ${length}`,
        whenTitle: `${formatDateTime(run.started_at)}, ${formatRelative(run.started_at, now.value)}`,
        facts: removal
          ? [
              { label: 'Pages', value: formatCount(run.pages_read), title: 'Pages read, products or not' },
              // NOT `products_found`, which a removal job leaves at zero by
              // construction, because it imports nothing: the slot held a
              // constant. The products the purge took with the listings is a
              // second real number, and smaller -- an article another shop still
              // sells as groceries keeps its product row.
              { label: 'Products', value: formatCount(removedProducts(run)), title: 'Products deleted, once no listing was left' },
            ]
          : [
              // On a finished run too, so both kinds of card lead with the
              // effort and then say what it produced. `pages_read` is the
              // liveness beat's tally (catalog 022), so a run shorter than the
              // first beat finishes honestly reporting none.
              {
                label: 'Pages',
                value: formatCount(run.pages_read),
                title: running ? 'Pages read so far, products or not' : 'Pages read, products or not',
              },
              { label: 'New', value: formatCount(run.products_created) },
              { label: 'Updated', value: formatCount(run.updated) },
              // NO `marked_unavailable` HERE, deliberately. The sweep only sets
              // `available = false`, and nothing the app asks for filters on it:
              // search gives an in-stock listing +5 and hides nothing, so a
              // product swept tonight is still suggested tomorrow and comes back
              // by itself when the shop lists it again. The number cannot be
              // acted on, and a run that swept implausibly much is refused by
              // the 50% floor and arrives here as `partial` instead. It stays a
              // column in the history table, where one run is read in detail.
            ],
        message: !stalled
          ? runMessage(run)
          : quiet !== null
            ? `Nothing heard from the shop for ${formatRunDuration(quiet)}. The job may have been killed, or the shop stopped answering.`
            : 'No sign of life since it started. The job most likely died.',
      },
    }
  }),
)

// Bring the linked run into view once the rows have arrived, and once only: the
// page polls, and pulling the reader back every thirty seconds would be worse
// than not scrolling at all.
let scrolledTo: string | null = null
watch(
  [() => runs.data.value, focusRun],
  async () => {
    const id = focusRun.value
    if (!id || id === scrolledTo || !runs.data.value) return
    await nextTick()
    const target =
      document.getElementById(`run-${id}`) ?? document.querySelector<HTMLElement>('.table__row--selected')
    if (!target) return
    scrolledTo = id
    target.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  },
  { immediate: true },
)

// The message gets the room: it is the only column whose content is a sentence,
// and the one a failed row is read for.
//
// NARROWER, THE DELTAS GO FIRST. What a row is read for is whether the run
// finished and how much of the shop it saw: Result, Read and the sentence. What
// it changed (gone, removed, new) and how long it took are the detail behind
// that, and they were holding ten columns at every width -- the only table in
// the tool that did -- so below 1100px the sentence had 80px and said nothing.
// `minPx` on the sentence is what stops the survivors crushing it in turn: past
// that the panel scrolls, it does not squeeze.
const columns: Column<ScrapeRunRow>[] = [
  { key: 'shopName', label: 'Shop', width: '11%' },
  { key: 'country', label: 'Country', width: '6%' },
  { key: 'status', label: 'Result', width: '11%' },
  { key: 'started_at', label: 'Started', width: '14%' },
  { key: 'duration', label: 'Took', numeric: true, width: '9%', hideBelow: 1100 },
  { key: 'products_found', label: 'Read', numeric: true, width: '8%' },
  { key: 'products_created', label: 'New', numeric: true, width: '6%', hideBelow: 1100 },
  { key: 'marked_unavailable', label: 'Marked gone', numeric: true, width: '9%', hideBelow: 1400 },
  { key: 'removed', label: 'Removed', numeric: true, width: '8%', hideBelow: 1400 },
  { key: 'error', label: 'What it said', width: '18%', minPx: 160 },
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
        >
          <template #segment="{ segment }">
            <CountryCode
              v-if="segment.value !== ALL_COUNTRIES"
              :code="segment.value"
              :note="countryNote(segment.value)"
              :focusable="false"
            />
            <template v-else>{{ segment.label }}</template>
          </template>
        </SegmentedControl>
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
      <!-- One line of prose rather than five more big numbers: context for the
           runs, not a second headline. It says when it was counted, because
           unlike the runs it is not live.

           ABOVE THE CARDS, not between them and the history. There it cut the
           page in two, and the cards read as a separate thing from the table
           when they are its newest five rows. -->
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
      <ul v-else class="shops" aria-label="The newest runs">
        <ShopRunCard
          v-for="shop in shops"
          :id="`run-${shop.id}`"
          :key="shop.id"
          :class="{ 'shop--focus': shop.id === focusRun }"
          v-bind="shop.props"
        />
      </ul>

      <PanelCard title="History" :note="`Older runs, newest first, from the last ${RUN_HISTORY_LIMIT}.`" :busy="polling" flush>
        <DataTable
          :columns="columns"
          :rows="split.history"
          :selected-key="focusRun"
          row-key="id"
          :loading="runs.loading.value"
          :error="loadError"
          empty-title="Nothing older than the cards"
        >
          <template #cell-shopName="{ row }">
            <span class="history__shop">{{ asRun(row).shopName }}</span>
          </template>
          <template #cell-country="{ row }">
            <CountryCode :code="asRun(row).country" :note="countryNote(asRun(row).country)" />
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
          <template #cell-removed="{ row }">
            {{ formatCount(removedCount(asRun(row))) }}
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

   AT MOST FIVE, NEVER UNDER 14rem. As many 14rem columns as fit made narrow
   cards on a wide screen -- seven or eight to a row, the facts crowded. Five is
   wide enough to read and still a row of shops at a glance, and it is
   CARD_COUNT, so on a wide screen they fill the row exactly. The inner max() is
   the cap: no track may be thinner than a fifth of the row, so a sixth never
   fits.

   The five used to be fixed down to a 1100px window, so a 1280px laptop drew
   the narrowest cards on the page (184px, every unit ellipsised) while a 1099px
   one jumped back to 254px. Now the count steps down as the room does, worked
   out from the grid's own width rather than the window's, because the sidebar
   changes that width by 180px and no media query can see it.

   Auto-FILL, not auto-fit: auto-fit hands empty tracks' room to the cards, and
   one shop -- a country chosen in the selector -- became a banner the width of
   the page. Auto-fill keeps the empty tracks, so a lone card is one wide. */
/* The run a link came for. An outline, not a new tint: the card's own state
   colour still has to read. */
.shop--focus {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.shops {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(
    auto-fill,
    minmax(min(100%, max(14rem, (100% - 4 * var(--space-3)) / 5)), 1fr)
  );
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
