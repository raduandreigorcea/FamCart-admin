<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import TablePager from '../components/TablePager.vue'
import FilterBar from '../components/FilterBar.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import StatusPill from '../components/StatusPill.vue'
import CopyValue from '../components/CopyValue.vue'
import UserChip from '../components/UserChip.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { fetchContributedProducts, type ContributedScope } from '../lib/data/contributed'
import { formatDateTime, formatRelative } from '../lib/format'
import type { LocalProductRow } from '../lib/data/types'
import type { Column } from '../lib/uiTypes'

// What households typed for themselves, and what got promoted out of it.
//
// This page replaced a four-tab Catalog section that read a Supabase project
// which no longer has any of the RPCs it called. See lib/data/contributed.ts for
// why what remains is worth a page of its own rather than a panel: it is the one
// route by which text one person wrote becomes a suggestion everybody sees.

// ─── paging ──────────────────────────────────────────────────────────────────
// Deliberately NOT useTableState, which exists to keep a sort, a direction and
// a pager in step. admin_local_products takes no sort argument -- it is ordered
// `popularity desc, created_at desc` inside the function and that is not
// negotiable from here -- so a sort state would be a control that reports a
// change the server ignores, which is the most misleading thing a table can do.
// No column is marked sortable for the same reason.
const LIMIT = 25

const query = ref('')
const scope = ref<ContributedScope>('all')
const offset = ref(0)

// The one rule useTableState would have given us: any filter change returns to
// the first page. Page 4 of a search is not page 4 of the next one.
watch([query, scope], () => {
  offset.value = 0
})

const products = useQuery(
  (signal) =>
    fetchContributedProducts(
      { query: query.value, limit: LIMIT, offset: offset.value, scope: scope.value },
      signal,
    ),
  { watch: [query, scope, offset] },
)

const rows = computed(() => products.data.value?.rows ?? [])
const total = computed(() => products.data.value?.total ?? 0)
const error = computed(() => (products.error.value ? describeError(products.error.value).detail : ''))

const columns: Column<LocalProductRow>[] = [
  { key: 'name', label: 'Product', width: '24%' },
  { key: 'maker', label: 'Brand', width: '12%' },
  { key: 'barcode', label: 'Barcode / GTIN', width: '12%', hideBelow: 1100 },
  { key: 'scope', label: 'Scope', width: '10%' },
  { key: 'household_name', label: 'Household', width: '13%' },
  { key: 'contributor_name', label: 'Contributed by', width: '13%', hideBelow: 1400 },
  { key: 'add_count', label: 'Adds', numeric: true, width: '7%' },
  { key: 'created_at', label: 'Added', width: '9%', hideBelow: 1100 },
]

const SEGMENTS = [
  { value: 'all', label: 'All' },
  {
    value: 'community',
    label: 'Household-scoped',
    title:
      'Contributed by one household and visible only to it. Still short of the three households and three accounts a promotion needs.',
  },
  {
    value: 'promoted',
    label: 'Promoted',
    title:
      'Global rows, visible to everyone. The scoped rows they were collapsed from no longer exist.',
  },
]
</script>

<template>
  <div class="page">
    <PageHeader
      title="Contributed"
      description="Products a household added itself, and the ones enough households asked for that everybody now sees them."
      :fetched-at="products.fetchedAt.value"
      :busy="products.fetching.value"
      @refresh="products.refetch()"
    />

    <PanelCard flush>
      <template #actions>
        <SegmentedControl
          :model-value="scope"
          :segments="SEGMENTS"
          aria-label="Which rows"
          @update:model-value="scope = $event as ContributedScope"
        />
      </template>

      <div class="toolbar">
        <FilterBar
          v-model="query"
          placeholder="Search name, brand or barcode"
          :busy="products.fetching.value"
        />
      </div>

      <DataTable
        :columns="columns"
        :rows="rows"
        row-key="id"
        :loading="products.loading.value"
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
        <!-- Household-scoped or global, which is the whole point of the page:
             a promoted row is one everybody can see. -->
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
          <RouterLink
            v-if="row.household_id"
            :to="`/households/${row.household_id}`"
            class="link u-truncate"
          >
            {{ row.household_name || 'Unknown' }}
          </RouterLink>
          <span v-else class="u-muted">--</span>
        </template>
        <!-- The trail back to an account. A row worth removing is usually a row
             whose author is worth looking at. -->
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
  </div>
</template>
