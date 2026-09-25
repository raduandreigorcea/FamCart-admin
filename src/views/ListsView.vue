<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import UserChip from '../components/UserChip.vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import TablePager from '../components/TablePager.vue'
import FilterBar from '../components/FilterBar.vue'
import StatusPill from '../components/StatusPill.vue'
import CopyValue from '../components/CopyValue.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { useTableState } from '../lib/useTableState'
import { fetchLists, isListSort } from '../lib/data/lists'
import type { AdminListRow } from '../lib/data/types'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'


const router = useRouter()

const { query, sort, dir, offset, limit, params, onSort } = useTableState({
  isSort: isListSort,
  sort: 'last_active',
})

const lists = useQuery((signal) => fetchLists(params.value, signal), {
  watch: [params],
})

const columns: Column<AdminListRow>[] = [
  { key: 'name', label: 'List', sortable: true, width: '23%' },
  { key: 'owner_name', label: 'Owner', width: '16%' },
  { key: 'invite_code', label: 'Invite', width: '11%', hideBelow: 1400 },
  // 9, not 8: "Members" with its sort caret needs a hair over 8% and the header
  // was overflowing its own column by a pixel. The name column gave it up --
  // that one truncates gracefully and this one cannot.
  { key: 'members', label: 'Members', numeric: true, sortable: true, width: '9%' },
  { key: 'items_open', label: 'Open', numeric: true, sortable: true, width: '7%', title: 'Unchecked items right now' },
  { key: 'items_total', label: 'Items', numeric: true, width: '7%', hideBelow: 1100, title: 'Items ever added' },
  { key: 'purchases', label: 'Bought', numeric: true, sortable: true, width: '8%' },
  { key: 'products_added', label: 'Products', numeric: true, width: '8%', hideBelow: 1400 },
  { key: 'last_active', label: 'Last active', sortable: true, width: '11%' },
]

const rows = computed(() => lists.data.value?.rows ?? [])
const total = computed(() => lists.data.value?.total ?? 0)
const countUnknown = computed(() => lists.data.value === null)
const error = computed(() =>
  lists.error.value ? describeError(lists.error.value).detail : '',
)

function open(row: AdminListRow) {
  void router.push(`/lists/${row.id}`)
}

const DORMANT_DAYS = 30

function activityTone(lastActive: string): 'good' | 'idle' {
  return (Date.now() - new Date(lastActive).getTime()) / 86_400_000 <= DORMANT_DAYS ? 'good' : 'idle'
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Lists"
      description="Every group on this database, its roster and how much shopping actually happens in it."
      :fetched-at="lists.fetchedAt.value"
      :busy="lists.fetching.value"
      @refresh="lists.refetch"
    />

    <PanelCard flush>
      <div class="u-toolbar">
        <FilterBar
          v-model="query"
          placeholder="Search by name, owner or invite code"
          :busy="lists.fetching.value"
        >
          <template #end>
            <!-- Withheld until it is known: see the note in TablePager. -->
            <span v-if="!countUnknown" class="u-toolbar__count u-num">
              {{ formatCount(total) }} lists
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
        :loading="lists.loading.value"
        :error="error"
        clickable
        empty-title="No lists match"
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

        <!-- Not linked: the row itself opens the list, which is where
             somebody scanning this column is going. -->
        <template #cell-owner_name="{ row }">
          <UserChip
            :id="String(row.created_by)"
            :name="row.owner_name ? String(row.owner_name) : null"
            :src="row.owner_image_url ? String(row.owner_image_url) : null"
            :size="20"
            :link="false"
          />
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
          :loading="lists.fetching.value"
          @go="offset = $event"
        />
      </template>
    </PanelCard>
  </div>
</template>

<style scoped>
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
