<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import TablePager from '../components/TablePager.vue'
import FilterBar from '../components/FilterBar.vue'
import SelectField from '../components/SelectField.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import StatusPill from '../components/StatusPill.vue'
import StateBlock from '../components/StateBlock.vue'
import CopyValue from '../components/CopyValue.vue'
import TruncationNotice from '../components/TruncationNotice.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { useTableState } from '../lib/useTableState'
import {
  catalogConfigured,
  fetchCatalogProducts,
  fetchLocalProducts,
  loadCatalogShape,
  qualityLabel,
  qualityScore,
  refreshCatalogShape,
  isCatalogSort,
} from '../lib/data/products'
import type { CatalogProductRow, LocalProductRow } from '../lib/data/types'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'
import { useDensity, type Density } from '../lib/useDensity'

// Products, and the split that makes them confusing.
//
// The two tabs are two DIFFERENT TABLES in two different databases, and the page
// says so rather than blending them into one list. The catalog project holds
// imported and curated rows that belong to nobody; the app database holds what
// households contributed and what has been promoted out of those. The same
// product can be in both, and that is the thing an operator opens this page to
// find out.

const { dense, density, setDensity, segments: densitySegments } = useDensity()

const router = useRouter()

const scope = ref<'catalog' | 'local'>('catalog')
const source = ref<string | null>(null)
const market = ref<string | null>(null)
const barcode = ref<'any' | 'with' | 'without'>('any')
const localScope = ref<'all' | 'community' | 'promoted'>('all')

const configured = catalogConfigured()

// One state for both tabs -- they share a search box and a pager -- with every
// filter on the page declared as one, so changing any of them returns to the
// first page without each control having to remember to say so.
const { query, sort, dir, offset, limit, params, onSort } = useTableState({
  isSort: isCatalogSort,
  sort: 'popularity',
  filters: [scope, source, market, barcode, localScope],
})

// The catalog's shape, fetched once and cached, for the market and version
// filters. See products.ts for why this is aggregated client-side.
const shape = useQuery(() => loadCatalogShape(), { enabled: () => configured })

// Each tab fetches only while it is the one on screen. Both used to fetch on
// every keystroke, so a search cost two round trips to two databases and one of
// them was always for a table nobody could see.
const catalog = useQuery(
  (signal) =>
    fetchCatalogProducts(
      { ...params.value, source: source.value, market: market.value, barcode: barcode.value },
      signal,
    ),
  {
    watch: [params, source, market, barcode],
    enabled: () => configured && scope.value === 'catalog',
  },
)

const local = useQuery(
  (signal) =>
    fetchLocalProducts(
      { query: params.value.query, limit, offset: params.value.offset, scope: localScope.value },
      signal,
    ),
  { watch: [params, localScope], enabled: () => scope.value === 'local' },
)

function onScope(value: string) {
  scope.value = value as 'catalog' | 'local'
  // The two tabs search two different tables; carrying a catalog query over to
  // the app database's rows usually means an empty table and a puzzle.
  query.value = ''
}

const sourceOptions = computed(() => [
  { value: null, label: 'Every source' },
  ...(shape.data.value?.bySource ?? []).map((s) => ({
    value: s.source,
    label: `${s.source} (${formatCount(s.rows)})`,
  })),
])

const marketOptions = computed(() => [
  { value: null, label: 'Every market' },
  ...(shape.data.value?.byMarket ?? []).slice(0, 30).map((m) => ({
    value: m.market,
    label: `${m.market} (${formatCount(m.rows)})`,
  })),
])

const catalogColumns: Column<CatalogProductRow>[] = [
  { key: 'name', label: 'Product', sortable: true, width: '28%' },
  { key: 'maker', label: 'Brand', width: '13%' },
  { key: 'barcode', label: 'Barcode / GTIN', width: '13%', hideBelow: 1100 },
  { key: 'markets', label: 'Markets', width: '11%', hideBelow: 1400 },
  { key: 'source', label: 'Source', width: '12%' },
  { key: 'quality', label: 'Quality', numeric: true, width: '9%', title: 'Derived from completeness, not the importer’s own scorer' },
  { key: 'add_count', label: 'Adds', numeric: true, sortable: true, width: '7%', title: 'Times a household picked this suggestion' },
  { key: 'popularity', label: 'Rank', numeric: true, sortable: true, width: '7%', title: 'base_weight + add_count' },
]

const localColumns: Column<LocalProductRow>[] = [
  { key: 'name', label: 'Product', width: '26%' },
  { key: 'maker', label: 'Brand', width: '13%' },
  { key: 'barcode', label: 'Barcode / GTIN', width: '13%', hideBelow: 1100 },
  { key: 'scope', label: 'Scope', width: '12%' },
  { key: 'household_name', label: 'Household', width: '15%' },
  { key: 'contributor_name', label: 'Contributed by', width: '13%', hideBelow: 1400 },
  { key: 'add_count', label: 'Adds', numeric: true, width: '7%' },
  { key: 'created_at', label: 'Added', width: '10%', hideBelow: 1100 },
]

// One per tab rather than a union, because the two tabs are two different
// tables in two different databases -- the page's whole point -- and a single
// `rows` typed as the union of both would let a catalog column be rendered
// against a local row without complaint.
const catalogRows = computed(() => catalog.data.value?.rows ?? [])
const localRows = computed(() => local.data.value?.rows ?? [])

const total = computed(() =>
  scope.value === 'catalog' ? (catalog.data.value?.total ?? 0) : (local.data.value?.total ?? 0),
)

// Also true after a failed request, which is the case this page actually shows:
// the catalog tab reported "0 products" beneath "Could not load this table".
const countUnknown = computed(() => active.value.data.value === null)

const active = computed(() => (scope.value === 'catalog' ? catalog : local))
const error = computed(() => {
  const err = active.value.error.value
  return err ? describeError(err).detail : ''
})

/**
 * Refresh both halves of the page, not just the table.
 *
 * The source and market dropdowns are built from the session-cached catalog
 * shape. Refetching only the visible table left those filter counts frozen for
 * the life of the tab while the header claimed a fresh read.
 */
function refresh() {
  if (configured) {
    void refreshCatalogShape()
    void shape.refetch()
  }
  void active.value.refetch()
}

function open(row: CatalogProductRow) {
  void router.push(`/products/${row.id}`)
}

function quality(row: CatalogProductRow) {
  return qualityScore(row)
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Products"
      description="Two tables in two databases. The catalog project holds imported and curated rows that belong to nobody; the app database holds what households contributed and what was promoted out of it. A product can be in both."
      :fetched-at="active.fetchedAt.value"
      :busy="active.fetching.value"
      @refresh="refresh"
    >
      <template #tools>
        <SegmentedControl
          :model-value="density"
          :segments="densitySegments"
          label="Rows"
          @update:model-value="setDensity($event as Density)"
        />
      </template>
    </PageHeader>

    <!-- Only the catalog tab's filter counts come from the aggregate; the app
         database table is paged server-side and is unaffected. -->
    <TruncationNotice
      v-if="scope === 'catalog'"
      :truncated="shape.data.value?.truncated ?? false"
      subject="The source and market filter counts"
    />

    <PanelCard flush>
      <template #actions>
        <SegmentedControl
          :model-value="scope"
          :segments="[
            { value: 'catalog', label: 'Catalog project', title: 'Imported and curated reference rows' },
            { value: 'local', label: 'App database', title: 'Household-contributed and promoted rows' },
          ]"
          aria-label="Which table"
          @update:model-value="onScope"
        />
      </template>

      <div class="toolbar">
        <!-- No control here resets the pager. Every one of them is declared as
             a filter in useTableState above, which does it for all of them. -->
        <FilterBar
          v-model="query"
          :placeholder="
            scope === 'catalog'
              ? 'Search name, brand and aliases, or paste a barcode'
              : 'Search name, brand or barcode'
          "
          :busy="active.fetching.value"
        >
          <template v-if="scope === 'catalog'">
            <SelectField v-model="source" label="Source" :options="sourceOptions" />
            <SelectField v-model="market" label="Market" :options="marketOptions" />
            <SegmentedControl
              :model-value="barcode"
              :segments="[
                { value: 'any', label: 'Any' },
                { value: 'with', label: 'Scannable' },
                { value: 'without', label: 'No barcode' },
              ]"
              label="Barcode"
              @update:model-value="barcode = $event as 'any' | 'with' | 'without'"
            />
          </template>

          <template v-else>
            <SegmentedControl
              :model-value="localScope"
              :segments="[
                { value: 'all', label: 'All' },
                { value: 'community', label: 'Household-scoped' },
                { value: 'promoted', label: 'Promoted' },
              ]"
              label="Scope"
              @update:model-value="localScope = $event as 'all' | 'community' | 'promoted'"
            />
          </template>

          <template #end>
            <!-- Withheld until it is known: see the note in TablePager. -->
            <span v-if="!countUnknown" class="toolbar__count u-num">
              {{ formatCount(total) }} products
            </span>
          </template>
        </FilterBar>
      </div>

      <StateBlock
        v-if="scope === 'catalog' && !configured"
        state="empty"
        title="The catalog project is not configured"
        message="Set VITE_CATALOG_SUPABASE_URL and VITE_CATALOG_SUPABASE_ANON_KEY to read it. Everything else in this dashboard works without them."
      />

      <DataTable
        :dense="dense"
        v-else-if="scope === 'catalog'"
        :columns="catalogColumns"
        :rows="catalogRows"
        row-key="id"
        :sort="sort"
        :dir="dir"
        :loading="catalog.loading.value"
        :error="error"
        clickable
        empty-title="No products match"
        empty-message="Try a shorter query, or clear the source and market filters."
        @sort="onSort"
        @select="open"
      >
        <template #cell-name="{ row }">
          <span class="u-truncate product__name">{{ row.name }}</span>
        </template>
        <template #cell-maker="{ row }">
          <span class="u-truncate">{{ row.maker || '--' }}</span>
        </template>
        <template #cell-barcode="{ row }">
          <CopyValue v-if="row.barcode" :value="String(row.barcode)" label="barcode" />
          <span v-else class="u-muted">--</span>
        </template>
        <template #cell-markets="{ row }">
          <span v-if="(row.markets as string[])?.length" class="markets">
            <span v-for="m in (row.markets as string[]).slice(0, 3)" :key="m" class="markets__code">{{ m }}</span>
            <span v-if="(row.markets as string[]).length > 3" class="markets__more">
              +{{ (row.markets as string[]).length - 3 }}
            </span>
          </span>
          <span v-else class="u-muted" title="An empty array means universal, not unknown">universal</span>
        </template>
        <template #cell-source="{ row }">
          <StatusPill
            :tone="row.source === 'curated' ? 'accent' : 'idle'"
            :label="String(row.source)"
            :dot="false"
          />
        </template>
        <template #cell-quality="{ row }">
          <span class="quality" :class="`quality--${qualityLabel(quality(row).score)}`">
            {{ quality(row).score }}
          </span>
        </template>
      </DataTable>

      <DataTable
        :dense="dense"
        v-else
        :columns="localColumns"
        :rows="localRows"
        row-key="id"
        :loading="local.loading.value"
        :error="error"
        empty-title="No contributed products"
        empty-message="Nothing has been added through add_custom_product() on this database yet."
      >
        <template #cell-name="{ row }">
          <span class="u-truncate product__name">{{ row.name }}</span>
        </template>
        <template #cell-maker="{ row }">
          <span class="u-truncate">{{ row.maker || '--' }}</span>
        </template>
        <template #cell-barcode="{ row }">
          <CopyValue v-if="row.barcode" :value="String(row.barcode)" label="barcode" />
          <span v-else class="u-muted">--</span>
        </template>
        <template #cell-scope="{ row }">
          <StatusPill
            :tone="row.household_id ? 'idle' : 'good'"
            :label="row.household_id ? 'Household' : 'Promoted'"
            :dot="false"
            :title="
              row.household_id
                ? 'Visible only to the contributing household'
                : 'Global in this database: three distinct households asked for it'
            "
          />
        </template>
        <template #cell-household_name="{ row }">
          <RouterLink v-if="row.household_id" :to="`/households/${row.household_id}`" class="link u-truncate">
            {{ row.household_name || 'Unknown' }}
          </RouterLink>
          <span v-else class="u-muted">--</span>
        </template>
        <template #cell-contributor_name="{ row }">
          <RouterLink
            v-if="row.contributed_by"
            :to="`/users/${encodeURIComponent(String(row.contributed_by))}`"
            class="link u-truncate"
          >
            {{ row.contributor_name || 'Unknown' }}
          </RouterLink>
          <span v-else class="u-muted">--</span>
        </template>
        <template #cell-created_at="{ row }">
          <span :title="formatDateTime(String(row.created_at))">
            {{ formatRelative(String(row.created_at)) }}
          </span>
        </template>
      </DataTable>

      <template #footer>
        <TablePager
          :total="total"
          :offset="offset"
          :limit="limit"
          :loading="active.fetching.value"
          @go="offset = $event"
        />
      </template>
    </PanelCard>
  </div>
</template>

<style scoped>
.toolbar {
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

.toolbar__count {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.product__name {
  font-weight: var(--weight-medium);
  display: block;
}

.markets {
  display: inline-flex;
  gap: 3px;
  align-items: center;
}

.markets__code {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  background: var(--bg-hover);
  border-radius: var(--radius-xs);
  padding: 1px var(--space-1);
  color: var(--text-secondary);
}

.markets__more {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}

/* The quality figure is coloured AND numeric, so the number carries the meaning
   even where the tint does not read. */
.quality {
  font-weight: var(--weight-bold);
  font-variant-numeric: tabular-nums;
}

.quality--strong { color: var(--status-good); }
.quality--fair { color: var(--warning-text); }
.quality--thin { color: var(--text-disabled); }

.link {
  color: var(--color-primary);
  text-decoration: none;
  display: inline-block;
  max-width: 100%;
}

.link:hover {
  text-decoration: underline;
}
</style>
