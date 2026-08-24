<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import TablePager from '../components/TablePager.vue'
import FilterBar from '../components/FilterBar.vue'
import StatusPill from '../components/StatusPill.vue'
import CopyValue from '../components/CopyValue.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { useTableState } from '../lib/useTableState'
import { useDensity, type Density } from '../lib/useDensity'
import { fetchHouseholds, isHouseholdSort } from '../lib/data/households'
import type { AdminHouseholdRow } from '../lib/data/types'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

const { dense, density, setDensity, segments: densitySegments } = useDensity()

const router = useRouter()

const { query, sort, dir, offset, limit, params, onSort } = useTableState({
  isSort: isHouseholdSort,
  sort: 'last_active',
})

const households = useQuery((signal) => fetchHouseholds(params.value, signal), {
  watch: [params],
})

const columns: Column<AdminHouseholdRow>[] = [
  { key: 'name', label: 'Household', sortable: true, width: '24%' },
  { key: 'owner_name', label: 'Owner', width: '16%' },
  { key: 'invite_code', label: 'Invite', width: '11%', hideBelow: 1400 },
  { key: 'members', label: 'Members', numeric: true, sortable: true, width: '8%' },
  { key: 'items_open', label: 'Open', numeric: true, sortable: true, width: '7%', title: 'Unchecked items right now' },
  { key: 'items_total', label: 'Items', numeric: true, width: '7%', hideBelow: 1100, title: 'Items ever added' },
  { key: 'purchases', label: 'Bought', numeric: true, sortable: true, width: '8%' },
  { key: 'products_added', label: 'Products', numeric: true, width: '8%', hideBelow: 1400 },
  { key: 'last_active', label: 'Last active', sortable: true, width: '11%' },
]

const rows = computed(() => households.data.value?.rows ?? [])
const total = computed(() => households.data.value?.total ?? 0)
const countUnknown = computed(() => households.data.value === null)
const error = computed(() =>
  households.error.value ? describeError(households.error.value).detail : '',
)

function open(row: AdminHouseholdRow) {
  void router.push(`/households/${row.id}`)
}

const DORMANT_DAYS = 30

function activityTone(lastActive: string): 'good' | 'idle' {
  return (Date.now() - new Date(lastActive).getTime()) / 86_400_000 <= DORMANT_DAYS ? 'good' : 'idle'
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Households"
      description="Every group on this database, its roster and how much shopping actually happens in it."
      :fetched-at="households.fetchedAt.value"
      :busy="households.fetching.value"
      @refresh="households.refetch"
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

    <PanelCard flush>
      <div class="toolbar">
        <FilterBar
          v-model="query"
          placeholder="Search by name, owner or invite code"
          :busy="households.fetching.value"
        >
          <template #end>
            <!-- Withheld until it is known: see the note in TablePager. -->
            <span v-if="!countUnknown" class="toolbar__count u-num">
              {{ formatCount(total) }} households
            </span>
          </template>
        </FilterBar>
      </div>

      <DataTable
        :columns="columns"
        :rows="rows"
        row-key="id"
        :sort="sort"
        :dir="dir"
        :loading="households.loading.value"
        :error="error"
        :dense="dense"
        clickable
        empty-title="No households match"
        empty-message="Clear the search, or check which database the topbar says you are reading."
        @sort="onSort"
        @select="open"
      >
        <template #cell-name="{ row }">
          <span class="name">
            <span class="name__emoji" aria-hidden="true">{{ row.emoji || '🏠' }}</span>
            <span class="u-truncate">{{ row.name }}</span>
          </span>
        </template>

        <template #cell-owner_name="{ row }">
          <span class="u-truncate">{{ row.owner_name || '--' }}</span>
        </template>

        <template #cell-invite_code="{ row }">
          <CopyValue :value="String(row.invite_code)" label="invite code" />
        </template>

        <template #cell-last_active="{ row }">
          <StatusPill
            :tone="activityTone(String(row.last_active))"
            :label="formatRelative(String(row.last_active))"
            :title="formatDateTime(String(row.last_active))"
          />
        </template>
      </DataTable>

      <template #footer>
        <TablePager
          :total="total"
          :offset="offset"
          :limit="limit"
          :loading="households.fetching.value"
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

.name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-weight: var(--weight-medium);
}

.name__emoji {
  flex: none;
}
</style>
