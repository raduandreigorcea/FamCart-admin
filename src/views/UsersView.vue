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
import { fetchUsers, isUserSort } from '../lib/data/users'
import type { AdminUserRow } from '../lib/data/types'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative, shortUserId } from '../lib/format'

// Every account, and what each one has actually done.
//
// Sorting and paging are server-side: the RPC gets the sort and the offset, and
// the table only reports the click. Sorting 25 of 300 rows in the browser would
// look like sorting and be a lie.


const router = useRouter()

// The query, sort, direction and page, and the rules that keep them coherent --
// including the one that matters most here, that USER_SORTS is checked before a
// header click can reach admin_list_users. See useTableState.ts.
const { query, sort, dir, offset, limit, params, onSort } = useTableState({
  isSort: isUserSort,
  sort: 'last_active',
})

const users = useQuery((signal) => fetchUsers(params.value, signal), { watch: [params] })

const columns: Column<AdminUserRow>[] = [
  // Nine columns, and the widest header is over the narrowest column, so these
  // were measured rather than guessed: each one is comfortably above what its
  // header needs at --text-2xs with its sort caret (Households, the tight one,
  // needs 10.1%). They sum to 100 because fixed layout scales the whole set
  // down when they do not, which is how Households came to overflow by 7px
  // while claiming 9% of a set that added up to 105.
  { key: 'display_name', label: 'Account', sortable: true, width: '26%' },
  { key: 'user_id', label: 'Clerk id', width: '12%', hideBelow: 1400 },
  { key: 'households', label: 'Households', numeric: true, sortable: true, width: '11%' },
  { key: 'items_added', label: 'Items', numeric: true, sortable: true, width: '7%', title: 'Items ever added to any list' },
  { key: 'items_open', label: 'Open', numeric: true, width: '6%', hideBelow: 1100, title: 'Unchecked items on a list right now' },
  { key: 'purchases', label: 'Bought', numeric: true, sortable: true, width: '8%' },
  { key: 'products_added', label: 'Products', numeric: true, width: '8%', hideBelow: 1400, title: 'Catalog rows this account contributed' },
  { key: 'first_seen', label: 'First seen', sortable: true, width: '10%', hideBelow: 1100 },
  { key: 'last_active', label: 'Last active', sortable: true, width: '12%' },
]

const rows = computed(() => users.data.value?.rows ?? [])
const total = computed(() => users.data.value?.total ?? 0)
/** Nothing has answered yet, so `total` is a placeholder rather than a count. */
const countUnknown = computed(() => users.data.value === null)
const error = computed(() => (users.error.value ? describeError(users.error.value).detail : ''))

function open(row: AdminUserRow) {
  void router.push(`/users/${encodeURIComponent(row.user_id)}`)
}

/** Inactive for longer than this reads as dormant rather than quiet. */
const DORMANT_DAYS = 30

function activityTone(lastActive: string): 'good' | 'idle' {
  const days = (Date.now() - new Date(lastActive).getTime()) / 86_400_000
  return days <= DORMANT_DAYS ? 'good' : 'idle'
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Users"
      description="Every profile on this database, with what it belongs to and what it has done. First seen and last active are derived rather than recorded: nothing logs a signup or a session."
      :fetched-at="users.fetchedAt.value"
      :busy="users.fetching.value"
      @refresh="users.refetch"
    />

    <PanelCard flush>
      <div class="toolbar">
        <FilterBar
          v-model="query"
          placeholder="Search by name or Clerk id"
          :busy="users.fetching.value"
        >
          <template #end>
            <!-- Withheld until it is known: see the note in TablePager. -->
            <span v-if="!countUnknown" class="toolbar__count u-num">
              {{ formatCount(total) }} accounts
            </span>
          </template>
        </FilterBar>
      </div>

      <DataTable
        :columns="columns"
        :rows="rows"
        row-key="user_id"
        :sort="sort"
        :dir="dir"
        :loading="users.loading.value"
        :error="error"
        clickable
        empty-title="No accounts match"
        empty-message="Clear the search, or check that you are pointed at the database you meant."
        @sort="onSort"
        @select="open"
      >
        <template #cell-display_name="{ row }">
          <div class="who">
            <!-- Not linked: the whole row is already the way in, and a link
                 inside a row that navigates on click is one target too many. -->
            <UserChip
              :id="String(row.user_id)"
              :name="row.display_name ? String(row.display_name) : null"
              :src="row.image_url ? String(row.image_url) : null"
              :link="false"
            />
            <StatusPill v-if="row.is_admin" tone="accent" label="Admin" :dot="false" />
            <StatusPill v-if="Number(row.owned_households) > 0" tone="idle" label="Owner" :dot="false" />
          </div>
        </template>

        <template #cell-user_id="{ row }">
          <CopyValue :value="String(row.user_id)" :display="shortUserId(String(row.user_id))" label="Clerk id" />
        </template>

        <template #cell-first_seen="{ row }">
          <span :title="formatDateTime(String(row.first_seen))">{{ formatRelative(String(row.first_seen)) }}</span>
        </template>

        <template #cell-last_active="{ row }">
          <span class="last" :title="formatDateTime(String(row.last_active))">
            <StatusPill
              :tone="activityTone(String(row.last_active))"
              :label="formatRelative(String(row.last_active))"
            />
          </span>
        </template>
      </DataTable>

      <template #footer>
        <TablePager
          :total="total"
          :offset="offset"
          :limit="limit"
          :loading="users.fetching.value"
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

.who {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.last {
  display: inline-flex;
}
</style>
