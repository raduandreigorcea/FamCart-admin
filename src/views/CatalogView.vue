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

const columns: Column<CatalogProductRow>[] = [
  { key: 'canonical_name', label: 'Product', width: '22%' },
  { key: 'brand', label: 'Brand', width: '11%' },
  { key: 'product_type', label: 'Type', width: '9%' },
  { key: 'markets', label: 'Markets', width: '12%', hideBelow: 1100 },
  { key: 'sources', label: 'Source', width: '11%' },
  { key: 'popularity', label: 'Popularity', numeric: true, width: '8%' },
  { key: 'alias_count', label: 'Aliases', numeric: true, width: '7%', hideBelow: 1400 },
  { key: 'created_at', label: 'Added', width: '8%', hideBelow: 1100 },
  { key: 'actions', label: '', width: '12%', align: 'right' },
]

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
        <template #cell-canonical_name="{ row }">
          <span class="u-truncate">{{ row.canonical_name }}</span>
        </template>
        <template #cell-brand="{ row }">
          <span class="u-truncate">{{ row.brand || '--' }}</span>
        </template>
        <template #cell-product_type="{ row }">
          <StatusPill
            :tone="row.product_type === 'commercial' ? 'idle' : 'good'"
            :label="row.product_type === 'commercial' ? 'Commercial' : 'Generic'"
            :dot="false"
          />
        </template>
        <!-- Empty is not "sold nowhere", it is unknown, and a great many honest
             records have no country metadata at all. -->
        <template #cell-markets="{ row }">
          <span v-if="row.markets.length" class="u-truncate">{{ row.markets.join(' ') }}</span>
          <span v-else class="u-muted" title="Unknown, which is not the same as sold nowhere">--</span>
        </template>
        <!-- Which writer put this row here. 'admin' is one written from this
             dashboard, and is the one the seed's prune will never remove. -->
        <template #cell-sources="{ row }">
          <span class="u-truncate">{{ row.sources.join(', ') || '--' }}</span>
        </template>
        <template #cell-alias_count="{ row }">
          <span>{{ row.alias_count }}</span>
        </template>
        <template #cell-created_at="{ row }">
          <span :title="formatDateTime(String(row.created_at))">
            {{ formatRelative(String(row.created_at)) }}
          </span>
        </template>
        <template #cell-actions="{ row }">
          <span class="row-actions">
            <CopyValue
              v-if="row.barcodes.length"
              :value="row.barcodes[0]"
              label="barcode"
              class="row-actions__code"
            />
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

/* Present but quiet: the code is context for the two buttons beside it, not a
   control of its own. */
.row-actions__code {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
</style>
