<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UserChip from '../components/UserChip.vue'
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
import {
  OUTCOME_STAGES,
  fetchOutcomes,
  type OutcomeRow,
  type OutcomeStage,
} from '../lib/data/outcomes'
import type { CatalogProductRow, LocalProductRow } from '../lib/data/types'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

// Products, and the split that makes them confusing.
//
// The two tabs are two DIFFERENT TABLES in two different databases, and the page
// says so rather than blending them into one list. The catalog project holds
// imported and curated rows that belong to nobody; the app database holds what
// households contributed and the global rows those contributions were promoted
// into. The same product can be in both, and that is the thing an operator opens
// this page to find out.
//
// ─── TWO DELETIONS THAT SOUND LIKE ONE ───────────────────────────────────────
//
// The page description used to say the app database holds "what was promoted
// out of it", which reads as promoted OUT OF the app database -- the opposite of
// what happens -- and it cost a reader an afternoon.
//
// Promotion works on one axis only, inside the app database:
// promote_product_from_scoped() in 006_product_catalog.sql waits for three
// distinct contributors across three distinct households on one search_text,
// then DELETES every scoped row for that key in the same statement that inserts
// the single global one. Its own comment says why -- "leaving the scoped rows
// would show their households the same product twice". So within this database
// a product is household-scoped or global and never both, which is exactly what
// the Scope filter's three segments assume.
//
// Nothing crosses the database boundary. Promotion never touches the catalog
// project and the importer never touches this one, so a product genuinely can be
// an imported row over there AND a promoted global here. FamCart's own search
// hides that from users -- rankSuggestions() dedupes first-wins on productKey()
// with catalog rows first -- which is precisely why this page does not.


const router = useRouter()
const route = useRoute()

const scope = ref<'catalog' | 'local' | 'outcomes'>('catalog')

// The Pipeline run drawer links straight into this scope. Read once on setup
// rather than watched: this is an entry point, not a filter that changes under
// you while you are using the page.
const outcomeRun = ref<string | null>((route.query.run as string) ?? null)
const outcomeStage = ref<OutcomeStage | null>(null)
if (route.query.scope === 'outcomes') scope.value = 'outcomes'
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
  filters: [scope, source, market, barcode, localScope, outcomeRun, outcomeStage],
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

// The records the importer decided not to write. A third database read on a
// page that already talks to two, and the only one that can be empty for a
// reason worth saying out loud: retention prunes the records of older runs.
const outcomes = useQuery(
  (signal) =>
    fetchOutcomes(
      { runId: outcomeRun.value, stage: outcomeStage.value, reason: null },
      { query: params.value.query, limit, offset: params.value.offset },
      signal,
    ),
  {
    watch: [params, outcomeRun, outcomeStage],
    enabled: () => configured && scope.value === 'outcomes',
  },
)

function onScope(value: string) {
  scope.value = value as 'catalog' | 'local' | 'outcomes'
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
  { key: 'name', label: 'Product', sortable: true, width: '42%' },
  { key: 'maker', label: 'Brand', width: '17%' },
  { key: 'barcode', label: 'Barcode', width: '14%', hideBelow: 1100 },
  // Markets and Source were columns here and carried nothing: every one of the
  // 13,975 imported rows reads `universal` and `openfoodfacts`, and both are
  // already filters six inches above the table. A column whose every cell is
  // identical is width spent on nothing.
  //
  // Rank went for a different reason. Its own tooltip described it as
  // `base_weight + add_count`, which is a sort key rather than a fact: it moved
  // with Adds, sat beside Adds, and answered the same question twice.
  { key: 'add_count', label: 'Times added', numeric: true, sortable: true, width: '14%', title: 'How many times a household picked this out of the suggestions. The only number here that comes from somebody using FamCart.' },
  { key: 'quality', label: 'Detail', numeric: true, width: '13%', title: 'How complete the imported record is: name, brand, quantity, barcode, categories. Not a judgement of the product.' },
]

const localColumns: Column<LocalProductRow>[] = [
  { key: 'name', label: 'Product', width: '24%' },
  { key: 'maker', label: 'Brand', width: '12%' },
  { key: 'barcode', label: 'Barcode / GTIN', width: '12%', hideBelow: 1100 },
  { key: 'scope', label: 'Scope', width: '10%' },
  { key: 'household_name', label: 'Household', width: '13%' },
  // Holds a face and a name now, so it keeps its share.
  { key: 'contributor_name', label: 'Contributed by', width: '13%', hideBelow: 1400 },
  { key: 'add_count', label: 'Adds', numeric: true, width: '7%' },
  { key: 'created_at', label: 'Added', width: '9%', hideBelow: 1100 },
]

// Built from OUTCOME_STAGES rather than written out, so a stage added to the
// check constraint in 004_import_runs.sql shows up here as an unlabelled
// segment instead of silently having no filter at all.
const STAGE_TITLES: Record<OutcomeStage, string> = {
  rejected: 'Thrown out before scoring — almost always for having no usable name',
  dropped: 'Scored, and the gate said no',
  review: 'In the middle band, waiting on a human verdict',
}

const STAGE_LABELS: Record<OutcomeStage, string> = {
  rejected: 'Rejected',
  dropped: 'Dropped',
  review: 'In review',
}

const stageSegments = [
  { value: 'all', label: 'All', title: 'Everything this run did not write' },
  ...OUTCOME_STAGES.map((stage) => ({
    value: stage,
    label: STAGE_LABELS[stage] ?? stage,
    title: STAGE_TITLES[stage] ?? '',
  })),
]

const outcomeColumns: Column<OutcomeRow>[] = [
  { key: 'name', label: 'Product', width: '32%' },
  { key: 'maker', label: 'Brand', width: '15%', hideBelow: 1100 },
  { key: 'stage', label: 'Stage', width: '11%' },
  { key: 'reason', label: 'Why', width: '21%' },
  { key: 'score', label: 'Score', numeric: true, width: '8%', title: 'The importer’s own scorer, 0-100' },
  { key: 'barcode', label: 'Barcode / GTIN', width: '13%', hideBelow: 1400 },
]

// One per tab rather than a union, because the two tabs are two different
// tables in two different databases -- the page's whole point -- and a single
// `rows` typed as the union of both would let a catalog column be rendered
// against a local row without complaint.
const catalogRows = computed(() => catalog.data.value?.rows ?? [])
const localRows = computed(() => local.data.value?.rows ?? [])
const outcomeRows = computed(() => outcomes.data.value?.rows ?? [])

const total = computed(() => active.value.data.value?.total ?? 0)

// Also true after a failed request, which is the case this page actually shows:
// the catalog tab reported "0 products" beneath "Could not load this table".
const countUnknown = computed(() => active.value.data.value === null)

const active = computed(() =>
  scope.value === 'catalog' ? catalog : scope.value === 'local' ? local : outcomes,
)
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
      description="Every product FamCart can suggest, and everything it decided not to keep."
      :fetched-at="active.fetchedAt.value"
      :busy="active.fetching.value"
      @refresh="refresh"
    />

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
            { value: 'catalog', label: 'Imported', title: 'Reference products pulled from Open Food Facts and its siblings, in the shared catalog project' },
            { value: 'local', label: 'From households', title: 'Products a household added itself, and the ones promoted out of them, in this app database' },
            { value: 'outcomes', label: 'Rejected', title: 'Records the importer read and decided not to write: rejected before scoring, dropped by the gate, or still awaiting a verdict' },
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
              : scope === 'outcomes'
                ? 'Search a name to find out why it is not in the catalog'
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

          <template v-else-if="scope === 'local'">
            <SegmentedControl
              :model-value="localScope"
              :segments="[
                { value: 'all', label: 'All' },
                {
                  value: 'community',
                  label: 'Household-scoped',
                  title: 'Contributed by one household and visible only to it. Still short of the three households and three accounts a promotion needs.',
                },
                {
                  value: 'promoted',
                  label: 'Promoted',
                  title: 'Global rows, visible to everyone. The scoped rows they were collapsed from no longer exist.',
                },
              ]"
              label="Scope"
              @update:model-value="localScope = $event as 'all' | 'community' | 'promoted'"
            />
          </template>

          <template v-else>
            <SegmentedControl
              :model-value="outcomeStage ?? 'all'"
              :segments="stageSegments"
              label="Stage"
              @update:model-value="outcomeStage = $event === 'all' ? null : ($event as OutcomeStage)"
            />
          </template>

          <template #end>
            <!-- Withheld until it is known: see the note in TablePager. -->
            <span v-if="!countUnknown" class="toolbar__count u-num">
              {{ formatCount(total) }} {{ scope === 'outcomes' ? 'records' : 'products' }}
            </span>
          </template>
        </FilterBar>
      </div>

      <StateBlock
        v-if="scope !== 'local' && !configured"
        state="empty"
        title="The catalog project is not configured"
        message="Set VITE_CATALOG_SUPABASE_URL and VITE_CATALOG_SUPABASE_ANON_KEY to read it. Everything else in this dashboard works without them."
      />

      <DataTable
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
        <!-- A bare "50" answered nothing: no scale, no direction, and every row
             within a point of every other. Shown as a proportion of a record
             that is either filled in or not, which is what it measures. -->
        <template #cell-quality="{ row }">
          <span class="quality" :class="`quality--${qualityLabel(quality(row).score)}`">
            <span class="quality__bar" :style="{ '--fill': `${quality(row).score}%` }"></span>
            <span class="quality__num u-num">{{ quality(row).score }}%</span>
          </span>
        </template>
      </DataTable>

      <DataTable
        v-else-if="scope === 'local'"
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
          <UserChip
            v-if="row.contributed_by"
            :id="String(row.contributed_by)"
            :name="row.contributor_name ? String(row.contributor_name) : null"
            :src="row.contributor_image_url ? String(row.contributor_image_url) : null"
            :size="20"
          />
          <span v-else class="u-muted">--</span>
        </template>
        <template #cell-created_at="{ row }">
          <span :title="formatDateTime(String(row.created_at))">
            {{ formatRelative(String(row.created_at)) }}
          </span>
        </template>
      </DataTable>

      <DataTable
        v-else
        :columns="outcomeColumns"
        :rows="outcomeRows"
        row-key="id"
        :loading="outcomes.loading.value"
        :error="error"
        empty-title="Nothing recorded"
        empty-message="No run has published its discarded records yet, or retention has pruned this run's. The Pipeline page says which."
      >
        <template #cell-name="{ row }">
          <span v-if="row.name" class="u-truncate product__name">{{ row.name }}</span>
          <!-- 12,554 of the last run's 12,859 rejects were rejected FOR having
               no name. An em dash is the honest cell; "Unknown" would imply we
               looked it up and failed. -->
          <span v-else class="u-muted">— no name</span>
        </template>
        <template #cell-maker="{ row }">
          <span class="u-truncate">{{ row.maker || '--' }}</span>
        </template>
        <template #cell-stage="{ row }">
          <StatusPill
            :tone="row.stage === 'review' ? 'warn' : 'idle'"
            :label="String(row.stage)"
            :dot="false"
            :title="
              row.stage === 'review'
                ? 'Scored into the middle band, waiting on a human verdict'
                : row.stage === 'dropped'
                  ? 'Scored, and the gate said no'
                  : 'Thrown out before it ever reached the scorer'
            "
          />
        </template>
        <template #cell-reason="{ row }">
          <span class="u-mono u-truncate">{{ row.reason }}</span>
        </template>
        <template #cell-score="{ row }">
          <span v-if="row.score !== null" class="u-num">{{ row.score }}</span>
          <!-- A pre-scoring reject was never scored. A zero would read as "we
               scored it and it was terrible", which is a different fact. -->
          <span v-else class="u-muted">--</span>
        </template>
        <template #cell-barcode="{ row }">
          <CopyValue v-if="row.barcode" :value="String(row.barcode)" label="barcode" />
          <span v-else class="u-muted">--</span>
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
/* Completeness, shown as a proportion rather than a bare integer.
 *
 * It read "50" against 13,975 rows that are all within a point of each other,
 * with the scale living in a tooltip. A number nobody can place on a scale is
 * not information, so the bar carries the magnitude and the figure confirms it. */
.quality {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}

.quality__bar {
  flex: 1;
  min-width: 28px;
  max-width: 64px;
  height: 5px;
  border-radius: var(--radius-pill);
  background: var(--rule-empty);
  overflow: hidden;
}

.quality__bar::after {
  content: '';
  display: block;
  height: 100%;
  width: var(--fill);
  background: currentColor;
  border-radius: inherit;
}

.quality__num {
  font-weight: var(--weight-semibold);
  font-size: var(--text-xs);
  min-width: 3ch;
  text-align: right;
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
