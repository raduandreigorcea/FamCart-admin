<script setup lang="ts">
import { computed, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import StateBlock from '../components/StateBlock.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import { useQuery, useQueryGroup, describeError } from '../lib/useQuery'
import { useDensity, type Density } from '../lib/useDensity'
import {
  fetchDeletedHouseholds,
  restoreHousehold,
  type DeletedHouseholdRow,
} from '../lib/data/households'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

// What an admin deleted, and the only way back.
//
// This view is why soft delete was worth rewriting nine policies for. Without a
// place that lists what was removed and puts it back, a soft delete is
// indistinguishable from a hard one and "reversible" is a claim nobody can
// check.
//
// The member and item counts are of what is still INSIDE each household, which
// is the number that answers the question someone actually has here: is this
// safe to leave deleted?

const { dense, density, setDensity, segments: densitySegments } = useDensity()

const deleted = useQuery((signal) => fetchDeletedHouseholds(signal))
const page = useQueryGroup([deleted])

const rows = computed(() => deleted.data.value ?? [])

// Not `rows.length === 0`: that is also true before the first response, and an
// empty trash and an unanswered query are different answers. Same rule as
// TablePager's "Counting…".
const knownEmpty = computed(() => deleted.data.value !== null && rows.value.length === 0)

const error = computed(() =>
  deleted.error.value ? describeError(deleted.error.value).detail : '',
)

const columns: Column<DeletedHouseholdRow>[] = [
  { key: 'name', label: 'Household', width: '32%' },
  { key: 'deleted_at', label: 'Deleted', sortable: false, width: '20%' },
  { key: 'members', label: 'Members', numeric: true, width: '12%' },
  { key: 'items_total', label: 'Items', numeric: true, width: '12%', title: 'Still inside it' },
  { key: 'actions', label: '', align: 'right', width: '16%' },
]

const pending = ref<DeletedHouseholdRow | null>(null)
const busy = ref(false)
const actionError = ref('')

async function confirmRestore() {
  const target = pending.value
  if (!target || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    await restoreHousehold(target.id, new AbortController().signal)
    pending.value = null
    await deleted.refetch()
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Trash"
      description="Households an admin deleted. Nothing here has been destroyed — restoring one brings it back along with every item and purchase inside it."
      :fetched-at="page.fetchedAt.value"
      :busy="page.busy.value"
      @refresh="page.refresh"
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
      <StateBlock
        v-if="knownEmpty"
        state="empty"
        title="Nothing deleted"
        message="When an admin deletes a household it waits here until it is restored."
      />
      <DataTable
        v-else
        :columns="columns"
        :rows="rows"
        row-key="id"
        :dense="dense"
        :loading="deleted.loading.value"
        :error="error"
        empty-title="Nothing deleted"
      >
        <template #cell-name="{ row }">
          <span class="who">{{ row.emoji ? `${row.emoji} ` : '' }}{{ row.name }}</span>
        </template>

        <template #cell-deleted_at="{ row }">
          <span :title="formatDateTime(String(row.deleted_at))">
            {{ formatRelative(String(row.deleted_at)) }}
          </span>
        </template>

        <template #cell-members="{ row }">{{ formatCount(Number(row.members)) }}</template>
        <template #cell-items_total="{ row }">{{ formatCount(Number(row.items_total)) }}</template>

        <template #cell-actions="{ row }">
          <button type="button" class="restore" @click="pending = row">Restore</button>
        </template>
      </DataTable>
    </PanelCard>

    <ConfirmDialog
      :open="pending !== null"
      :title="`Restore ${pending?.name ?? 'this household'}?`"
      message="Its members get it back, along with every item and purchase inside it."
      confirm-label="Restore"
      :busy="busy"
      :error="actionError"
      @confirm="confirmRestore"
      @cancel="pending = null"
    />
  </div>
</template>

<style scoped>
.who {
  font-weight: var(--weight-medium);
}

.restore {
  background: none;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-primary);
  cursor: pointer;
}

.restore:hover {
  background: var(--bg-hover);
}
</style>
