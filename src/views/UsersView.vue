<script setup lang="ts">
import { computed, ref } from 'vue'
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
import { fetchUsers, isUserSort, type UserSort } from '../lib/data/users'
import type { AdminUserRow } from '../lib/data/types'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative, initialOf, shortUserId } from '../lib/format'

// Every account, and what each one has actually done.
//
// Sorting and paging are server-side: the RPC gets the sort and the offset, and
// the table only reports the click. Sorting 25 of 300 rows in the browser would
// look like sorting and be a lie.

const router = useRouter()

const query = ref('')
const sort = ref<UserSort>('last_active')
const dir = ref<'asc' | 'desc'>('desc')
const offset = ref(0)
const density = ref('comfortable')

const LIMIT = 25

const users = useQuery(
  (signal) =>
    fetchUsers(
      { query: query.value, sort: sort.value, dir: dir.value, limit: LIMIT, offset: offset.value },
      signal,
    ),
  { watch: [query, sort, dir, offset] },
)

// Any filter change returns to the first page. Staying on page 4 of a result set
// that now has one page shows an empty table that looks like "no matches".
function onQuery(value: string) {
  query.value = value
  offset.value = 0
}

function onSort(key: string) {
  // DataTable emits a bare string. This is the one place an unchecked key could
  // reach the RPC, so it is the one place it is checked -- USER_SORTS mirrors
  // the CASE arms in admin_list_users, and anything else would come back as a
  // PostgREST 400 naming no column.
  if (!isUserSort(key)) return

  if (sort.value === key) {
    dir.value = dir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sort.value = key
    // A new column starts descending, because every sortable column here is a
    // count or a date and "most" or "newest" is what is wanted first.
    dir.value = 'desc'
  }
  offset.value = 0
}

const columns: Column<AdminUserRow>[] = [
  { key: 'display_name', label: 'Account', sortable: true, width: '26%' },
  { key: 'user_id', label: 'Clerk id', width: '16%', hideBelow: 1400 },
  { key: 'households', label: 'Households', numeric: true, sortable: true, width: '9%' },
  { key: 'items_added', label: 'Items', numeric: true, sortable: true, width: '8%', title: 'Items ever added to any list' },
  { key: 'items_open', label: 'Open', numeric: true, width: '7%', hideBelow: 1100, title: 'Unchecked items on a list right now' },
  { key: 'purchases', label: 'Bought', numeric: true, sortable: true, width: '8%' },
  { key: 'products_added', label: 'Products', numeric: true, width: '9%', hideBelow: 1400, title: 'Catalog rows this account contributed' },
  { key: 'first_seen', label: 'First seen', sortable: true, width: '11%', hideBelow: 1100 },
  { key: 'last_active', label: 'Last active', sortable: true, width: '11%' },
]

const rows = computed(() => users.data.value?.rows ?? [])
const total = computed(() => users.data.value?.total ?? 0)
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
      <template #actions>
        <SegmentedControl
          v-model="density"
          :segments="[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]"
          aria-label="Row density"
        />
      </template>

      <div class="toolbar">
        <FilterBar
          :model-value="query"
          placeholder="Search by name or Clerk id"
          :busy="users.fetching.value"
          @update:model-value="onQuery"
        >
          <template #end>
            <span class="toolbar__count u-num">{{ formatCount(total) }} accounts</span>
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
        :dense="density === 'compact'"
        clickable
        empty-title="No accounts match"
        empty-message="Clear the search, or check that you are pointed at the database you meant."
        @sort="onSort"
        @select="open"
      >
        <template #cell-display_name="{ row }">
          <div class="who">
            <img v-if="row.image_url" class="who__avatar" :src="String(row.image_url)" alt="" loading="lazy" />
            <span v-else class="who__initial" aria-hidden="true">{{ initialOf(String(row.display_name)) }}</span>
            <span class="who__name u-truncate">{{ row.display_name }}</span>
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
          :limit="LIMIT"
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

.who__avatar,
.who__initial {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-pill);
  flex: none;
}

.who__avatar {
  object-fit: cover;
}

.who__initial {
  display: grid;
  place-items: center;
  background: var(--color-primary-bg);
  color: var(--color-primary-text);
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
}

.who__name {
  font-weight: var(--weight-medium);
  min-width: 0;
}

.last {
  display: inline-flex;
}
</style>
