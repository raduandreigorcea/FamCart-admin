<script setup lang="ts">
import { computed, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import { useQuery, describeError } from '../lib/useQuery'
import {
  fetchSentryFeedback,
  fetchSentryIssues,
  serviceProblem,
  type SentryFeedback,
  type SentryIssue,
} from '../lib/data/services'
import type { Column, Segment, Tone } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

// Sentry: what broke in the app, and what people wrote in to say.
//
// Feedback is the reason this page exists more than errors are. Sentry archives
// feedback it takes for spam without telling anyone, and an archived report is
// invisible in its default inbox, so real reports were being lost there. This
// list asks for every status and marks the archived ones rather than hiding
// them.
//
// One Sentry project takes reports from every build, so this reads the same
// whichever app project the switcher is on.

type Scope = 'issues' | 'feedback'

const scope = ref<Scope>('issues')
const onIssues = computed(() => scope.value === 'issues')

function setScope(next: string) {
  scope.value = next === 'feedback' ? 'feedback' : 'issues'
}

const segments: Segment[] = [
  { value: 'issues', label: 'Errors', title: 'Unresolved errors seen in the last 14 days' },
  { value: 'feedback', label: 'Feedback', title: 'Reports sent from the app in the last 90 days, in any status' },
]

// Only the list on screen is fetched, the same rule as the Bans page.
const issues = useQuery((signal) => fetchSentryIssues(signal), { enabled: () => onIssues.value })
const feedback = useQuery((signal) => fetchSentryFeedback(signal), { enabled: () => !onIssues.value })
const current = computed(() => (onIssues.value ? issues : feedback))

const problem = computed(() => serviceProblem(current.value.error.value))
const loadError = computed(() => {
  const error = current.value.error.value
  return error && !problem.value ? describeError(error).detail : ''
})

const issueRows = computed(() => issues.data.value ?? [])
const feedbackRows = computed(() => feedback.data.value ?? [])
const archived = computed(() => feedbackRows.value.filter((row) => row.status === 'ignored').length)

const feedbackNote = computed(() => {
  const total = feedbackRows.value.length
  if (!total) return 'The last 90 days, newest first.'
  const base = `${formatCount(total)} in the last 90 days`
  return archived.value ? `${base}, ${formatCount(archived.value)} archived by Sentry.` : `${base}.`
})

function levelTone(level: string): Tone {
  if (level === 'fatal' || level === 'error') return 'bad'
  if (level === 'warning') return 'warn'
  return 'idle'
}

const STATUS: Record<string, { label: string; tone: Tone; title: string }> = {
  unresolved: { label: 'Open', tone: 'warn', title: 'Nobody has resolved this yet' },
  resolved: { label: 'Resolved', tone: 'good', title: 'Marked resolved in Sentry' },
  ignored: { label: 'Archived', tone: 'idle', title: 'Archived, possibly by Sentry itself as spam. Read it anyway.' },
}

function statusOf(status: string) {
  return STATUS[status] ?? { label: status, tone: 'idle' as Tone, title: status }
}

const issueColumns: Column<SentryIssue>[] = [
  { key: 'title', label: 'Error', width: '52%' },
  { key: 'level', label: 'Level', width: '10%', hideBelow: 1100 },
  { key: 'events', label: 'Events', numeric: true, width: '10%' },
  { key: 'users', label: 'People', numeric: true, width: '10%' },
  { key: 'lastSeen', label: 'Last seen', width: '18%' },
]

const feedbackColumns: Column<SentryFeedback>[] = [
  { key: 'message', label: 'What they wrote', width: '52%' },
  { key: 'name', label: 'From', width: '20%' },
  { key: 'status', label: 'Status', width: '12%' },
  { key: 'at', label: 'Sent', width: '16%' },
]

const asIssue = (row: unknown) => row as SentryIssue
const asFeedback = (row: unknown) => row as SentryFeedback

function refresh() {
  void current.value.refetch()
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Sentry"
      description="Errors the app reported and feedback people sent from it. Every link opens the issue in Sentry."
      :fetched-at="current.fetchedAt.value"
      :busy="current.fetching.value"
      @refresh="refresh"
    >
      <template #tools>
        <SegmentedControl
          :model-value="scope"
          :segments="segments"
          aria-label="Which list"
          @update:model-value="setScope"
        />
      </template>
    </PageHeader>

    <PanelCard v-if="problem" title="Sentry">
      <StateBlock state="empty" :title="problem.title" :message="problem.message" />
    </PanelCard>

    <PanelCard
      v-else-if="onIssues"
      title="Unresolved errors"
      note="Seen in the last 14 days, most recent first."
      :busy="issues.fetching.value && !issues.loading.value"
      flush
    >
      <DataTable
        :columns="issueColumns"
        :rows="issueRows"
        row-key="id"
        :loading="issues.loading.value"
        :error="loadError"
        empty-title="No unresolved errors"
        empty-message="Nothing unresolved has been reported in the last 14 days."
      >
        <template #cell-title="{ row }">
          <a class="svc__link" :href="asIssue(row).url" target="_blank" rel="noopener noreferrer">
            <span class="svc__title u-truncate">{{ asIssue(row).title }}</span>
            <span class="svc__sub u-mono u-truncate">
              {{ asIssue(row).shortId }}<template v-if="asIssue(row).culprit"> · {{ asIssue(row).culprit }}</template>
            </span>
          </a>
        </template>
        <template #cell-level="{ row }">
          <StatusPill :tone="levelTone(asIssue(row).level)" :label="asIssue(row).level" />
        </template>
        <template #cell-events="{ row }">{{ formatCount(asIssue(row).events) }}</template>
        <template #cell-users="{ row }">{{ formatCount(asIssue(row).users) }}</template>
        <template #cell-lastSeen="{ row }">
          <time :title="formatDateTime(asIssue(row).lastSeen)">{{ formatRelative(asIssue(row).lastSeen) }}</time>
        </template>
      </DataTable>
    </PanelCard>

    <PanelCard
      v-else
      title="Feedback"
      :note="feedbackNote"
      :busy="feedback.fetching.value && !feedback.loading.value"
      flush
    >
      <DataTable
        :columns="feedbackColumns"
        :rows="feedbackRows"
        row-key="id"
        :loading="feedback.loading.value"
        :error="loadError"
        empty-title="No feedback"
        empty-message="Nobody has sent feedback from the app in the last 90 days."
      >
        <template #cell-message="{ row }">
          <a class="svc__link" :href="asFeedback(row).url" target="_blank" rel="noopener noreferrer">
            <span class="svc__message">{{ asFeedback(row).message || '(empty)' }}</span>
          </a>
        </template>
        <template #cell-name="{ row }">
          <span class="svc__from">
            <span class="u-truncate">{{ asFeedback(row).name || 'Anonymous' }}</span>
            <span v-if="asFeedback(row).email" class="svc__sub u-truncate">{{ asFeedback(row).email }}</span>
          </span>
        </template>
        <template #cell-status="{ row }">
          <StatusPill
            :tone="statusOf(asFeedback(row).status).tone"
            :label="statusOf(asFeedback(row).status).label"
            :title="statusOf(asFeedback(row).status).title"
          />
        </template>
        <template #cell-at="{ row }">
          <time :title="formatDateTime(asFeedback(row).at)">{{ formatRelative(asFeedback(row).at) }}</time>
        </template>
      </DataTable>
    </PanelCard>
  </div>
</template>

<style scoped>
.svc__link {
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: inherit;
  text-decoration: none;
}

.svc__link:hover .svc__title,
.svc__link:hover .svc__message {
  color: var(--color-primary);
  text-decoration: underline;
}

.svc__title {
  color: var(--text-primary);
}

/* A report is read for its words, so it wraps rather than truncating. */
.svc__message {
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.svc__from {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.svc__sub {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
</style>
