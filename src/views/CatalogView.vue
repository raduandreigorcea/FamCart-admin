<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import TablePager from '../components/TablePager.vue'
import FilterBar from '../components/FilterBar.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import CopyValue from '../components/CopyValue.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import CatalogFormDialog from '../components/CatalogFormDialog.vue'
import { useQuery, describeError } from '../lib/useQuery'
import {
  catalogConfigured,
  fetchCatalogProducts,
  createCatalogProduct,
  updateCatalogProduct,
  deleteCatalogProduct,
  type CatalogProductRow,
  type CatalogProductType,
  type CatalogDraft,
} from '../lib/data/catalog'
import { formatDateTime, formatRelative } from '../lib/format'
import type { Column } from '../lib/uiTypes'

// The reference catalog. Everything the app can suggest that no household typed.
//
// This is not the Catalog section that was removed. That one called thirteen
// RPCs the rebuilt project never had, and read a table under a name it no longer
// uses. This reads catalog_admin_products(), which exists, and writes through
// three functions that are gated on catalog_is_admin().

const configured = catalogConfigured()

const LIMIT = 25

const query = ref('')
const type = ref<CatalogProductType | null>(null)
const offset = ref(0)

// Any filter change returns to the first page: page 4 of a search is not page 4
// of the next one. Same rule as Contributed, and not useTableState for the same
// reason -- catalog_admin_products orders by popularity then name inside the
// function, so a sort control would report a change the server ignores.
watch([query, type], () => {
  offset.value = 0
})

const products = useQuery(
  (signal) =>
    fetchCatalogProducts(
      { query: query.value, type: type.value, limit: LIMIT, offset: offset.value },
      signal,
    ),
  { watch: [query, type, offset], enabled: () => configured },
)

const rows = computed(() => products.data.value?.rows ?? [])
const total = computed(() => products.data.value?.total ?? 0)
const error = computed(() => (products.error.value ? describeError(products.error.value).detail : ''))

// Brand is no longer a column of its own. On a catalog that is mostly generics
// -- a banana has no brand, and that is correct rather than missing -- it was a
// column of dashes wide enough to read as a fault. It rides under the name now,
// which is also how the app itself draws a product: name, then maker beneath.
//
// Aliases likewise. The count answered a question nobody was asking often enough
// to spend 7% of the width on; it is in the name cell's title, where it is one
// hover away from whoever wants it.
const columns: Column<CatalogProductRow>[] = [
  { key: 'canonical_name', label: 'Product', width: '28%' },
  { key: 'product_type', label: 'Type', width: '9%' },
  { key: 'quality_tier', label: 'Record', width: '7%', hideBelow: 1400 },
  { key: 'markets', label: 'Markets', width: '13%', hideBelow: 1100 },
  { key: 'sources', label: 'Source', width: '12%' },
  { key: 'popularity', label: 'Popularity', numeric: true, width: '12%' },
  { key: 'created_at', label: 'Added', width: '8%', hideBelow: 1100 },
  { key: 'actions', label: '', width: '11%', align: 'right' },
]

// ─── how popularity is drawn ─────────────────────────────────────────────────
// NOT a proportional bar, which is what this was first. The page is ordered by
// popularity descending, so every row on it sits within a few points of the
// page's own maximum: scaling to that maximum drew twenty-five bars at 98, 99
// and 100 per cent. A bar that promises a comparison and shows none is worse
// than the bare number it replaced, and no other denominator is available --
// the RPC returns a page, not the catalog's maximum, and a fixed ceiling would
// be wrong the first time a product passed it.
//
// So the split instead, which is self-contained per row and is the interesting
// part anyway: how much of this number was set by hand and how much was earned
// by households actually adding the thing.
function earned(row: CatalogProductRow): string {
  if (row.add_count === 0) return 'editorial only'
  if (row.base_weight === 0) return 'all earned'
  return `${row.add_count} earned`
}

// Provenance, shortened and toned. 'openfoodfacts' is thirteen lowercase
// characters that push every other column around, and the distinction that
// actually matters when reading down the column is not which upstream catalog it
// was but WHETHER A PERSON PUT IT THERE: admin rows are the ones written from
// this dashboard, curated ones come from the version-controlled seed, and the
// rest arrived on their own.
const SOURCE_LABELS: Record<string, string> = {
  admin: 'Admin',
  curated: 'Seed',
  user: 'User',
  openfoodfacts: 'OFF',
  openproductsfacts: 'OPF',
  openbeautyfacts: 'OBF',
}

const SOURCE_TONES: Record<string, 'good' | 'accent' | 'idle'> = {
  admin: 'accent',
  curated: 'good',
  user: 'good',
}

function sourceLabel(name: string): string {
  return SOURCE_LABELS[name] ?? name
}

function sourceTone(name: string): 'good' | 'accent' | 'idle' {
  return SOURCE_TONES[name] ?? 'idle'
}

// Three, then a count. A product sold in nine markets is not more informative
// for listing all nine in a 13% column; it is just a cell that wraps.
const MARKETS_SHOWN = 3

// What the name cell says on hover, which is where the two counts that lost
// their columns went.
function nameTitle(row: CatalogProductRow): string {
  const bits = [row.canonical_name]
  if (row.alias_count > 0) {
    bits.push(`${row.alias_count} alias${row.alias_count === 1 ? '' : 'es'}`)
  }
  if (row.barcodes.length > 1) bits.push(`${row.barcodes.length} barcodes`)
  bits.push(`named in ${row.name_lang}`)
  return bits.join(' · ')
}

// ─── writing ─────────────────────────────────────────────────────────────────
const editing = ref<CatalogProductRow | null>(null)
const formOpen = ref(false)
const removing = ref<CatalogProductRow | null>(null)
const writing = ref(false)
const writeError = ref('')

function add() {
  editing.value = null
  writeError.value = ''
  formOpen.value = true
}

function edit(row: CatalogProductRow) {
  editing.value = row
  writeError.value = ''
  formOpen.value = true
}

function closeForm() {
  if (writing.value) return
  formOpen.value = false
  editing.value = null
  writeError.value = ''
}

async function run(work: (signal: AbortSignal) => Promise<unknown>, done: () => void) {
  writing.value = true
  writeError.value = ''
  try {
    await work(new AbortController().signal)
    done()
    await products.refetch()
  } catch (err) {
    writeError.value = describeError(err as Error).detail
  } finally {
    writing.value = false
  }
}

function submitForm(draft: CatalogDraft) {
  const row = editing.value
  void run(
    (signal) =>
      row ? updateCatalogProduct(row.id, draft, signal) : createCatalogProduct(draft, signal),
    () => {
      formOpen.value = false
      editing.value = null
    },
  )
}

function confirmRemove() {
  const row = removing.value
  if (!row) return
  void run(
    (signal) => deleteCatalogProduct(row.id, signal),
    () => {
      removing.value = null
    },
  )
}

// Spelled out rather than summarised. This project is shared live by production
// and development, so the blast radius of one click here is every household of
// both, and the aliases are how the product is findable in five languages it is
// not named in.
const removalMessage = computed(() => {
  const row = removing.value
  if (!row) return ''
  const parts = [
    'This is the shared reference catalog, so it disappears for every household of production and development at once.',
  ]
  if (row.alias_count > 0) {
    parts.push(
      `Its ${row.alias_count} alias${row.alias_count === 1 ? '' : 'es'} go with it, which is how it is found in languages it is not named in.`,
    )
  }
  if (row.barcodes.length > 0) {
    parts.push('Scanning its barcode will stop resolving.')
  }
  if (row.add_count > 0) {
    parts.push(`It has been added ${row.add_count} time${row.add_count === 1 ? '' : 's'}.`)
  }
  return parts.join(' ')
})
</script>

<template>
  <div class="page">
    <PageHeader
      title="Catalog"
      description="The reference products the app ships and discovers. Shared live by production and development."
      :fetched-at="products.fetchedAt.value"
      :busy="products.fetching.value"
      @refresh="products.refetch()"
    >
      <template #tools>
        <button v-if="configured" type="button" class="u-btn" @click="add">Add product</button>
      </template>
    </PageHeader>

    <StateBlock
      v-if="!configured"
      state="empty"
      title="The catalog project is not configured"
      message="Set VITE_CATALOG_SUPABASE_URL and VITE_CATALOG_SUPABASE_ANON_KEY to read it. Every other section is unaffected."
    />

    <PanelCard v-else flush>
      <template #actions>
        <SegmentedControl
          :model-value="type ?? 'all'"
          :segments="[
            { value: 'all', label: 'All' },
            {
              value: 'generic',
              label: 'Generic',
              title: 'A shopping concept: Milk, Bananas. No brand and no barcode, and none of that makes it low quality.',
            },
            {
              value: 'commercial',
              label: 'Commercial',
              title: 'A product off a shelf: Nutella 350g. Identified by brand and barcode.',
            },
          ]"
          aria-label="Which products"
          @update:model-value="type = $event === 'all' ? null : ($event as CatalogProductType)"
        />
      </template>

      <div class="toolbar">
        <FilterBar
          v-model="query"
          placeholder="Search names and aliases, or paste a barcode"
          :busy="products.fetching.value"
        />
      </div>

      <DataTable
        :columns="columns"
        :rows="rows"
        row-key="id"
        :loading="products.loading.value"
        :error="error"
        empty-title="No products"
        empty-message="Nothing in the reference catalog matches that."
      >
        <!-- Name over brand, the way the app draws a product in its own
             suggestion list. The barcode sits with them rather than in the
             actions cell, because it identifies the product and does not act
             on it. -->
        <template #cell-canonical_name="{ row }">
          <span class="prod" :title="nameTitle(row)">
            <span class="prod__name u-truncate">{{ row.canonical_name }}</span>
            <span class="prod__meta">
              <span v-if="row.brand" class="prod__brand u-truncate">{{ row.brand }}</span>
              <CopyValue
                v-if="row.barcodes.length"
                :value="row.barcodes[0]"
                label="barcode"
                class="prod__code"
              />
              <span v-if="!row.brand && !row.barcodes.length && row.category" class="prod__brand u-truncate">
                {{ row.category }}
              </span>
            </span>
          </span>
        </template>
        <template #cell-product_type="{ row }">
          <StatusPill
            :tone="row.product_type === 'commercial' ? 'idle' : 'good'"
            :label="row.product_type === 'commercial' ? 'Commercial' : 'Generic'"
            :dot="false"
          />
        </template>
        <!-- The catalog's own judgement of how complete the record is, which it
             scores by different rules for the two types: a generic with no
             barcode is correct, a commercial one with neither barcode nor brand
             cannot be identified at all. -->
        <template #cell-quality_tier="{ row }">
          <span
            class="tier"
            :class="`tier--${row.quality_tier.toLowerCase()}`"
            :title="`Record completeness: tier ${row.quality_tier}`"
          >{{ row.quality_tier }}</span>
        </template>
        <!-- Empty is not "sold nowhere", it is unknown, and a great many honest
             records have no country metadata at all. -->
        <template #cell-markets="{ row }">
          <span v-if="row.markets.length" class="mk">
            <span v-for="code in row.markets.slice(0, MARKETS_SHOWN)" :key="code" class="mk__code">
              {{ code }}
            </span>
            <span
              v-if="row.markets.length > MARKETS_SHOWN"
              class="mk__more"
              :title="row.markets.join(' ')"
            >+{{ row.markets.length - MARKETS_SHOWN }}</span>
          </span>
          <span v-else class="u-muted" title="Unknown, which is not the same as sold nowhere">--</span>
        </template>
        <!-- Which writer put this row here. 'admin' is one written from this
             dashboard, and is the one the seed's prune will never remove. -->
        <template #cell-sources="{ row }">
          <span v-if="row.sources.length" class="src">
            <StatusPill
              v-for="name in row.sources"
              :key="name"
              :tone="sourceTone(name)"
              :label="sourceLabel(name)"
              :dot="false"
              :title="name"
            />
          </span>
          <span v-else class="u-muted">--</span>
        </template>
        <!-- The number, and where it came from. See `earned`. -->
        <template #cell-popularity="{ row }">
          <span class="pop" :title="`base weight ${row.base_weight} + ${row.add_count} adds`">
            <span class="pop__num u-num">{{ row.popularity }}</span>
            <span class="pop__split" :class="{ 'pop__split--earned': row.add_count > 0 }">
              {{ earned(row) }}
            </span>
          </span>
        </template>
        <template #cell-created_at="{ row }">
          <span class="u-muted" :title="formatDateTime(String(row.created_at))">
            {{ formatRelative(String(row.created_at)) }}
          </span>
        </template>
        <template #cell-actions="{ row }">
          <span class="row-actions">
            <button type="button" class="u-btn" @click="edit(row)">Edit</button>
            <button type="button" class="u-btn u-btn--danger" @click="removing = row">
              Remove
            </button>
          </span>
        </template>
      </DataTable>

      <template #footer>
        <TablePager
          :total="total"
          :offset="offset"
          :limit="LIMIT"
          :loading="products.fetching.value"
          @go="offset = $event"
        />
      </template>
    </PanelCard>

    <CatalogFormDialog
      :open="formOpen"
      :product="editing"
      :busy="writing"
      :error="writeError"
      @submit="submitForm"
      @cancel="closeForm"
    />

    <ConfirmDialog
      :open="removing !== null"
      :title="`Remove ${removing?.canonical_name ?? 'product'}?`"
      :message="removalMessage"
      confirm-label="Remove"
      tone="danger"
      :busy="writing"
      :error="writeError"
      @confirm="confirmRemove"
      @cancel="writing || ((removing = null), (writeError = ''))"
    />
  </div>
</template>

<style scoped>
.row-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  justify-content: flex-end;
}

/* ─── the product cell ───────────────────────────────────────────────────────
   Two lines, and the second only appears when there is something to put on it,
   so a bare generic is one line rather than a line and a gap. */
.prod {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.prod__name {
  color: var(--text-primary);
}

.prod__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.prod__meta:empty {
  display: none;
}

.prod__brand {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.prod__code {
  font-size: var(--text-xs);
  color: var(--text-disabled);
}

/* ─── the completeness tier ──────────────────────────────────────────────────
   A letter, not a word: three states in a 7% column, and the letter is what the
   catalog itself calls them. Tinted rather than told apart by colour alone --
   the glyph is the value. */
.tier {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.4rem;
  height: 1.4rem;
  border-radius: var(--radius-sm);
  border: var(--border-width-thin) solid var(--border-main);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  color: var(--text-secondary);
  background: var(--bg-surface);
}

.tier--a {
  border-color: color-mix(in srgb, var(--color-primary) 45%, transparent);
  background: color-mix(in srgb, var(--color-primary) 12%, var(--bg-surface));
  color: var(--color-primary);
}

.tier--c {
  color: var(--text-disabled);
}

/* ─── markets ────────────────────────────────────────────────────────────────
   Codes as chips rather than a space-joined string, which read as one long word
   and wrapped mid-country. Three, then a count: a ninth chip is not information
   at this width, it is a cell that grows. */
.mk {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: nowrap;
}

.mk__code,
.mk__more {
  padding: 0 var(--space-1-5);
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  line-height: 1.6;
}

.mk__more {
  background: none;
  color: var(--text-disabled);
}

/* ─── provenance ─────────────────────────────────────────────────────────────
   Usually one pill. Two means a row an upstream source and a person both
   asserted, which is worth seeing rather than collapsing. */
.src {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
}

/* ─── popularity ─────────────────────────────────────────────────────────────
   The number keeps the column's alignment; the bar underneath gives it a scale.
   Deliberately quiet -- it is a comparison aid, not the point of the row. */
.pop {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-1);
  width: 100%;
}

.pop__num {
  font-size: var(--text-sm);
  color: var(--text-primary);
}

/* Quiet by default: most rows are editorial and saying so twenty-five times is
   noise. A row with real adds is the one worth noticing, so only that one takes
   any colour. */
.pop__split {
  font-size: var(--text-xs);
  color: var(--text-disabled);
  white-space: nowrap;
}

.pop__split--earned {
  color: var(--color-primary);
}
</style>
