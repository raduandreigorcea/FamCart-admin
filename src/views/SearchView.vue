<script setup lang="ts">
import { computed, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import StatTile from '../components/StatTile.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import BarChart from '../components/BarChart.vue'
import DataTable from '../components/DataTable.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import TruncationNotice from '../components/TruncationNotice.vue'
import { useQuery, useQueryGroup, describeError } from '../lib/useQuery'
import {
  fetchAutocompletePerformance,
  fetchCatalogAdoption,
  fetchCatalogMisses,
  fetchPopularQueries,
  fetchSearchVolume,
  fetchTopAddedProducts,
  fetchZeroResultQueries,
  type CatalogMiss,
} from '../lib/data/search'
import { catalogConfigured, refreshCatalogShape } from '../lib/data/products'
import { DEFAULT_RANGE, TIME_RANGES, resolveRange } from '../lib/timeRange'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatPercent, formatRelative, formatShare } from '../lib/format'

// Search Analytics, built around an honest admission.
//
// FamCart records no searches. The page leads with that rather than burying it,
// then shows the two things downstream of search that ARE recorded: what the
// catalog successfully served, and what it failed to serve. The second is the
// contributed-products table, which is literally a list of searches that came
// back empty and mattered enough for someone to fix by hand.


const rangeKey = ref<string>(DEFAULT_RANGE)
const range = computed(() => resolveRange(rangeKey.value))
const configured = catalogConfigured()

const topAdded = useQuery((signal) => fetchTopAddedProducts(range.value, 25, signal), {
  watch: [range],
})
const misses = useQuery((signal) => fetchCatalogMisses(30, signal))
const adoption = useQuery(() => fetchCatalogAdoption(), { enabled: () => configured })

// The four with no source. Computed rather than fetched: they are constants
// today, and the shape is the contract for when they are not.
const popularQueries = computed(() => fetchPopularQueries(range.value))
const zeroResults = computed(() => fetchZeroResultQueries(range.value))
const volume = computed(() => fetchSearchVolume(range.value))
const autocomplete = computed(() => fetchAutocompletePerformance(range.value))

const rangeSegments = TIME_RANGES.map((r) => ({ value: r.key, label: r.label, title: r.description }))

const addedBars = computed(() =>
  (topAdded.data.value ?? []).map((p) => ({
    key: `${p.name}-${p.maker ?? ''}`,
    label: p.name,
    meta: [p.maker, `${p.households} household${p.households === 1 ? '' : 's'}`]
      .filter(Boolean)
      .join(' · '),
    value: p.times,
  })),
)

const missColumns: Column<MissRow>[] = [
  { key: 'name', label: 'Product typed in', width: '34%' },
  { key: 'maker', label: 'Brand', width: '16%' },
  { key: 'households', label: 'Households', numeric: true, width: '12%', title: 'Distinct households that asked for it. Three promotes it.' },
  { key: 'addCount', label: 'Adds', numeric: true, width: '10%' },
  { key: 'promoted', label: 'Status', width: '13%' },
  { key: 'lastSeen', label: 'Last asked', width: '15%' },
]

/** A catalog miss plus the identity the table keys rows by. */
type MissRow = CatalogMiss & { id: string }

// Keyed on what actually identifies a product -- its name and maker -- rather
// than on its position in the list. An index-based key re-keys every row
// whenever the ordering shifts, which is exactly what a refetch does here since
// the list is ordered by how many households have asked for each product.
const missRows = computed<MissRow[]>(() =>
  (misses.data.value ?? []).map((m) => ({ ...m, id: `${m.name}::${m.maker ?? ''}` })),
)

const adoptionRate = computed(() => {
  const a = adoption.data.value
  if (!a || !a.total) return null
  return a.adopted / a.total
})

const page = useQueryGroup([topAdded, misses, adoption])

function refreshAll() {
  // Adoption is derived from the session-cached catalog shape. Refetching the
  // query alone would re-await the same cached promise and change nothing,
  // while PageHeader stamped a fresh "as of" time next to it. The adoption
  // query itself is `enabled` on the catalog being configured, so the group
  // refresh below is a no-op for it when there is no catalog to read.
  if (configured) void refreshCatalogShape()
  page.refresh()
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Search Analytics"
      description="What the catalog served, and what it missed. Search itself is not instrumented, so this page is careful about which is which."
      :fetched-at="page.fetchedAt.value"
      :busy="page.busy.value"
      @refresh="refreshAll"
    >
      <template #tools>
        <SegmentedControl v-model="rangeKey" :segments="rangeSegments" aria-label="Time range" />
      </template>
    </PageHeader>

    <TruncationNotice
      :truncated="adoption.data.value?.truncated ?? false"
      subject="The catalog adoption figures"
    />

    <!-- Said once, at the top, rather than repeated on four panels. -->
    <div class="notice">
      <StatusPill tone="warn" label="Not instrumented" />
      <p class="notice__body">
        <code class="u-mono">search_catalog()</code> is a stable function: it selects rows and writes
        nothing. No query string, result count or timing reaches any database, so query volume,
        popular queries, zero-result rates and autocomplete latency have no source. Everything below
        that shows a number is measured from what people <em>added</em> and <em>bought</em>, which is
        downstream of search rather than search itself.
      </p>
    </div>

    <div class="grid">
      <div class="span-3">
        <StatTile
          label="Search volume"
          unrecorded
          :unrecorded-reason="volume.available ? '' : 'No search is logged'"
        />
      </div>
      <div class="span-3">
        <StatTile
          label="Zero-result rate"
          unrecorded
          :unrecorded-reason="zeroResults.available ? '' : 'No search is logged'"
        />
      </div>
      <div class="span-3">
        <StatTile
          label="Catalog adoption"
          :value="adoption.data.value?.adopted ?? null"
          :hint="
            adoptionRate === null
              ? 'Rows ever picked from a suggestion'
              : `${formatPercent(adoptionRate)} of ${formatCount(adoption.data.value?.total ?? 0)} rows ever picked`
          "
          spark-color="var(--chart-2)"
        />
      </div>
      <div class="span-3">
        <StatTile
          label="Catalog misses"
          :value="misses.data.value?.length ?? null"
          hint="Distinct products typed in by hand"
          polarity="down-good"
          spark-color="var(--chart-3)"
        />
      </div>
    </div>

    <div class="grid">
      <div class="span-7">
        <PanelCard
          title="What the catalog served"
          note="Products actually bought in the window, across every household. Demand that search satisfied."
          fill
        >
          <StateBlock v-if="topAdded.loading.value" state="loading" :lines="6" />
          <StateBlock
            v-else-if="topAdded.error.value"
            state="error"
            title="Could not load purchases"
            :message="describeError(topAdded.error.value).detail"
          />
          <StateBlock
            v-else-if="!addedBars.length"
            state="empty"
            title="Nothing bought in this window"
            message="Widen the time range, or check that any household has completed a checkout."
          />
          <BarChart v-else :bars="addedBars" :format="formatCount" dense :limit="12" />
        </PanelCard>
      </div>

      <div class="span-5">
        <PanelCard title="Popular queries" fill>
          <StateBlock
            v-if="!popularQueries.available"
            state="unrecorded"
            title="No query log exists"
            :message="popularQueries.reason"
            :would-require="popularQueries.wouldRequire"
          />
        </PanelCard>

        <PanelCard title="Autocomplete performance" class="stacked" fill>
          <StateBlock
            v-if="!autocomplete.available"
            state="unrecorded"
            title="No timing is captured"
            :message="autocomplete.reason"
            :would-require="autocomplete.wouldRequire"
          />
        </PanelCard>
      </div>
    </div>

    <PanelCard
      title="Searches that came back empty"
      note="Every product a household typed in by hand is a search the catalog could not answer. Three distinct households asking for the same one promotes it automatically."
      flush
    >
      <DataTable
        :columns="missColumns"
        :rows="missRows"
        row-key="id"
        :loading="misses.loading.value"
        :error="misses.error.value ? describeError(misses.error.value).detail : ''"
        empty-title="The catalog answered everything"
        empty-message="No household has needed to add a product by hand on this database."
      >
        <template #cell-name="{ row }">
          <span class="u-truncate miss__name">{{ row.name }}</span>
        </template>
        <template #cell-maker="{ row }">
          <span class="u-truncate">{{ row.maker || '--' }}</span>
        </template>
        <template #cell-households="{ row }">
          <span class="u-num" :class="{ 'miss__close': Number(row.households) === 2 }">
            {{ formatCount(Number(row.households)) }}
          </span>
        </template>
        <template #cell-promoted="{ row }">
          <StatusPill
            :tone="row.promoted ? 'good' : Number(row.households) >= 2 ? 'warn' : 'idle'"
            :label="row.promoted ? 'Promoted' : Number(row.households) >= 2 ? 'One short' : 'Scoped'"
            :dot="false"
            :title="
              row.promoted
                ? 'A global row exists: the gap has closed'
                : 'Promotion happens at three distinct households'
            "
          />
        </template>
        <template #cell-lastSeen="{ row }">
          <span :title="formatDateTime(String(row.lastSeen))">
            {{ formatRelative(String(row.lastSeen)) }}
          </span>
        </template>
      </DataTable>

      <template #footer>
        <span class="foot-note">
          Ordered by how many distinct households asked. Anything at two is one household away from
          becoming a global row on its own.
        </span>
      </template>
    </PanelCard>

    <PanelCard
      title="Catalog reach"
      note="How much of what was imported has ever been used."
      v-if="configured"
    >
      <StateBlock v-if="adoption.loading.value" state="loading" :lines="3" />
      <StateBlock
        v-else-if="adoption.error.value"
        state="error"
        title="Could not read the catalog"
        :message="describeError(adoption.error.value).detail"
      />
      <dl v-else-if="adoption.data.value" class="reach u-facts">
        <div>
          <dt>Rows in the catalog</dt>
          <dd class="u-num">{{ formatCount(adoption.data.value.total) }}</dd>
        </div>
        <div>
          <dt>Ever picked from a suggestion</dt>
          <dd class="u-num">
            {{ formatCount(adoption.data.value.adopted) }}
            <span class="reach__share">
              {{ formatShare(adoption.data.value.adopted, adoption.data.value.total) }}
            </span>
          </dd>
        </div>
        <div>
          <dt>Total adds recorded</dt>
          <dd class="u-num">{{ formatCount(adoption.data.value.totalAddCount) }}</dd>
        </div>
        <div>
          <dt>Most-added single product</dt>
          <dd class="u-num">{{ formatCount(adoption.data.value.topAddCount) }} adds</dd>
        </div>
      </dl>
    </PanelCard>
  </div>
</template>

<style scoped>
.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  background: var(--warning-bg);
  border: var(--border-width-thin) solid var(--warning-border);
  border-radius: var(--radius-lg);
  padding: var(--space-3) var(--space-4);
}

.notice__body {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--warning-text);
}

.notice__body code {
  font-size: 0.92em;
}

.stacked {
  margin-top: var(--space-4);
}

.miss__name {
  font-weight: var(--weight-medium);
  display: block;
}

.miss__close {
  color: var(--warning-text);
  font-weight: var(--weight-bold);
}

.foot-note {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}

.reach {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: var(--space-4);
}

.reach dd {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.reach__share {
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  color: var(--text-disabled);
  margin-left: var(--space-1);
}
</style>
