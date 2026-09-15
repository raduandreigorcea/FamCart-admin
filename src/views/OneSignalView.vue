<script setup lang="ts">
import { computed } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import StateBlock from '../components/StateBlock.vue'
import StatTile from '../components/StatTile.vue'
import StatusPill from '../components/StatusPill.vue'
import { useQuery, describeError } from '../lib/useQuery'
import {
  fetchPushNotifications,
  pushTotals,
  serviceProblem,
  type PushNotification,
} from '../lib/data/services'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

// OneSignal: the push notifications this project sent, and whether they arrived.
//
// Before this page a failed push was invisible. push-on-item-insert writes
// nothing to a table, and its failures only reach the edge function's logs, so
// Health can say nothing about push. OneSignal keeps the count per notification.
//
// Follows the project switcher. famcart-dev has no push on purpose (its webhook
// is unset and it holds no OneSignal secrets), so there this page says it is
// not connected, which is the true answer.

const notifications = useQuery((signal) => fetchPushNotifications(signal))

const problem = computed(() => serviceProblem(notifications.error.value))
const loadError = computed(() => {
  const error = notifications.error.value
  return error && !problem.value ? describeError(error).detail : ''
})

const rows = computed(() => notifications.data.value ?? [])
const totals = computed(() => (notifications.data.value ? pushTotals(rows.value) : null))
const tileHint = computed(() => `Across the last ${formatCount(rows.value.length)} sent`)

const columns: Column<PushNotification>[] = [
  { key: 'text', label: 'Notification', width: '46%' },
  { key: 'at', label: 'Sent', width: '16%' },
  { key: 'delivered', label: 'Delivered', numeric: true, width: '12%' },
  { key: 'unsubscribed', label: 'Unsubscribed', numeric: true, width: '13%', title: 'Devices that had turned notifications off' },
  { key: 'errored', label: 'Errors', numeric: true, width: '13%', title: 'Deliveries OneSignal could not make' },
]

const asRow = (row: unknown) => row as PushNotification
</script>

<template>
  <div class="page">
    <PageHeader
      title="OneSignal"
      description="Push notifications this project sent, newest first, and how many reached a phone."
      :fetched-at="notifications.fetchedAt.value"
      :busy="notifications.fetching.value"
      @refresh="notifications.refetch"
    />

    <PanelCard v-if="problem" title="OneSignal">
      <StateBlock state="empty" :title="problem.title" :message="problem.message" />
    </PanelCard>

    <template v-else>
      <div class="grid">
        <div class="span-4">
          <StatTile label="Delivered" :value="totals?.delivered ?? null" :hint="tileHint" :loading="notifications.loading.value" />
        </div>
        <div class="span-4">
          <StatTile
            label="Unsubscribed"
            :value="totals?.unsubscribed ?? null"
            hint="Phones that turned notifications off"
            polarity="down-good"
            :loading="notifications.loading.value"
          />
        </div>
        <div class="span-4">
          <StatTile
            label="Errors"
            :value="totals?.errored ?? null"
            hint="Deliveries OneSignal could not make"
            polarity="down-good"
            :loading="notifications.loading.value"
          />
        </div>
      </div>

      <PanelCard
        title="Sent"
        note="The last 50 notifications. One is sent per item added and one per checkout."
        :busy="notifications.fetching.value && !notifications.loading.value"
        flush
      >
        <DataTable
          :columns="columns"
          :rows="rows"
          row-key="id"
          :loading="notifications.loading.value"
          :error="loadError"
          empty-title="Nothing sent yet"
          empty-message="OneSignal has no notifications for this app."
        >
          <template #cell-text="{ row }">
            <span class="push__text">
              <span class="u-truncate">{{ asRow(row).text || '(no text)' }}</span>
              <StatusPill v-if="asRow(row).canceled" tone="idle" label="Canceled" />
              <StatusPill v-else-if="asRow(row).remaining > 0" tone="live" label="Sending" busy />
            </span>
          </template>
          <template #cell-at="{ row }">
            <time v-if="asRow(row).at" :title="formatDateTime(asRow(row).at)">{{ formatRelative(asRow(row).at) }}</time>
          </template>
          <template #cell-delivered="{ row }">{{ formatCount(asRow(row).delivered) }}</template>
          <template #cell-unsubscribed="{ row }">{{ formatCount(asRow(row).unsubscribed) }}</template>
          <template #cell-errored="{ row }">
            <span :class="{ 'push__bad': asRow(row).errored > 0 }">{{ formatCount(asRow(row).errored) }}</span>
          </template>
        </DataTable>
      </PanelCard>
    </template>
  </div>
</template>

<style scoped>
.push__text {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--text-primary);
}

.push__bad {
  color: var(--danger-text);
  font-weight: var(--weight-bold);
}
</style>
