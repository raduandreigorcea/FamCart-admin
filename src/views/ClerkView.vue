<script setup lang="ts">
import { computed } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import StateBlock from '../components/StateBlock.vue'
import StatTile from '../components/StatTile.vue'
import StatusPill from '../components/StatusPill.vue'
import UserChip from '../components/UserChip.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { fetchClerkSummary, methodsLabel, serviceProblem, type ClerkUser } from '../lib/data/services'
import type { Column } from '../lib/uiTypes'
import { formatDateTime, formatRelative } from '../lib/format'

// Clerk: the accounts as the sign-in service knows them.
//
// Read-only on purpose. FamCart already refuses an account through its own ban
// (the Bans page), and a second ban in Clerk would be a second switch for the
// same decision, with two places to look when somebody cannot get in.
//
// There is one Clerk instance for both app projects, so the accounts here are
// the same on either. A row links to the person's page on the project being
// read, which says so when that project has never seen them.

const summary = useQuery((signal) => fetchClerkSummary(signal))

const problem = computed(() => serviceProblem(summary.error.value))
const loadError = computed(() => {
  const error = summary.error.value
  return error && !problem.value ? describeError(error).detail : ''
})

const rows = computed(() => summary.data.value?.recent ?? [])

const columns: Column<ClerkUser>[] = [
  { key: 'name', label: 'Account', width: '26%' },
  { key: 'email', label: 'Email', width: '24%', hideBelow: 1100 },
  { key: 'methods', label: 'Signs in with', width: '18%' },
  { key: 'lastSignInAt', label: 'Last sign-in', width: '16%' },
  { key: 'createdAt', label: 'Created', width: '16%', hideBelow: 1400 },
]

const asUser = (row: unknown) => row as ClerkUser
</script>

<template>
  <div class="page">
    <PageHeader
      title="Clerk"
      description="Accounts in the sign-in service, which both app projects share."
      :fetched-at="summary.fetchedAt.value"
      :busy="summary.fetching.value"
      @refresh="summary.refetch"
    />

    <PanelCard v-if="problem" title="Clerk">
      <StateBlock state="empty" :title="problem.title" :message="problem.message" />
    </PanelCard>

    <template v-else>
      <div class="grid">
        <div class="span-4">
          <StatTile
            label="Accounts"
            :value="summary.data.value?.total ?? null"
            hint="Everyone who ever signed up, on either project"
            :loading="summary.loading.value"
          />
        </div>
      </div>

      <PanelCard title="Latest sign-ins" note="The 25 accounts that signed in most recently." flush>
        <DataTable
          :columns="columns"
          :rows="rows"
          row-key="id"
          :loading="summary.loading.value"
          :error="loadError"
          empty-title="No accounts"
          empty-message="Nobody has signed up to this Clerk instance yet."
        >
          <template #cell-name="{ row }">
            <span class="clerk__who">
              <UserChip :id="asUser(row).id" :name="asUser(row).name" :src="asUser(row).imageUrl" />
              <StatusPill v-if="asUser(row).banned" tone="bad" label="Banned in Clerk" />
              <StatusPill v-else-if="asUser(row).locked" tone="warn" label="Locked" />
            </span>
          </template>
          <template #cell-email="{ row }">
            <span class="u-truncate">{{ asUser(row).email ?? '' }}</span>
          </template>
          <template #cell-methods="{ row }">{{ methodsLabel(asUser(row).methods) }}</template>
          <template #cell-lastSignInAt="{ row }">
            <time v-if="asUser(row).lastSignInAt" :title="formatDateTime(asUser(row).lastSignInAt)">
              {{ formatRelative(asUser(row).lastSignInAt) }}
            </time>
            <span v-else class="u-muted">Never</span>
          </template>
          <template #cell-createdAt="{ row }">
            <time v-if="asUser(row).createdAt" :title="formatDateTime(asUser(row).createdAt)">
              {{ formatRelative(asUser(row).createdAt) }}
            </time>
          </template>
        </DataTable>
      </PanelCard>
    </template>
  </div>
</template>

<style scoped>
.clerk__who {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
</style>
