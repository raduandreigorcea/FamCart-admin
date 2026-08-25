<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import PanelCard from './PanelCard.vue'
import StateBlock from './StateBlock.vue'
import StatusPill from './StatusPill.vue'
import DataTable from './DataTable.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { catalogConfigured } from '../lib/data/products'
import {
  cancelRun,
  enqueueRun,
  fetchRunRequest,
  fetchRunRequests,
  fetchWorkers,
  isActive,
  isStalled,
  runnerOnline,
  type RunKind,
  type RunRequest,
} from '../lib/data/runs'
import type { Column, Tone } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

// Starting a run, from something that cannot perform one.
//
// This replaced a panel that said runs could not be started from a browser and
// listed five npm commands instead. That panel was right about why -- the
// importer holds a service-role key that can rewrite every row in the catalog,
// needs ~15 GB of disk, and is a CLI with nothing listening -- and none of it
// changed. What changed is that the dashboard stopped trying: it writes a row to
// catalog_run_requests and a worker on the operator's machine claims it.
//
// Which makes the runner badge the most important thing on the panel. A button
// that queues into a void is worse than a disabled one, so this asks who is
// listening before it offers to start anything, and says the command when the
// answer is nobody.

const emit = defineEmits<{ (e: 'finished'): void }>()

const configured = catalogConfigured()
const POLL_MS = 2000

const SOURCES = ['openfoodfacts', 'openproductsfacts', 'openbeautyfacts'] as const
const source = ref<string>('openfoodfacts')

const KINDS: { kind: RunKind; label: string; hint: string; confirm: boolean }[] = [
  { kind: 'normalize', label: 'Normalize', hint: 'Market subset to staged.jsonl', confirm: false },
  { kind: 'score', label: 'Re-score', hint: 'Applies every recorded verdict', confirm: false },
  { kind: 'load', label: 'Load (dry run)', hint: 'Writes the diff, changes nothing', confirm: false },
  { kind: 'load-apply', label: 'Apply', hint: 'Writes the catalog', confirm: true },
]

const workers = useQuery((signal) => fetchWorkers(signal), { enabled: () => configured })
const requests = useQuery((signal) => fetchRunRequests(20, signal), { enabled: () => configured })

const runner = computed(() => runnerOnline(workers.data.value ?? []))
const rows = computed(() => requests.data.value ?? [])

// The newest request that has not finished. There is at most one per source and
// the worker takes one at a time, so this is the thing being watched.
const activeRequest = computed<RunRequest | null>(
  () => rows.value.find((r) => isActive(r.status)) ?? null,
)

const detail = useQuery(
  (signal) => fetchRunRequest(activeRequest.value?.id ?? '', signal),
  {
    watch: [activeRequest],
    enabled: () => configured && activeRequest.value !== null,
  },
)

const error = computed(() => {
  const first = workers.error.value ?? requests.error.value
  return first ? describeError(first) : null
})

// ─── polling ─────────────────────────────────────────────────────────────────
//
// Only while something is active. An idle Pipeline page must make no more
// requests than it did before this panel existed, which is the whole reason
// this is a timer that starts and stops rather than a permanent interval.
let timer: ReturnType<typeof setInterval> | null = null

function stopPolling() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

watch(
  () => activeRequest.value !== null,
  (active) => {
    if (active && !timer) {
      timer = setInterval(() => {
        void workers.refetch()
        void requests.refetch()
        void detail.refetch()
      }, POLL_MS)
    } else if (!active) {
      stopPolling()
      // One last look at the workers, so the badge does not sit stale after the
      // run that was keeping it fresh has finished.
      void workers.refetch()
    }
  },
  { immediate: true },
)

// A run that just finished leaves the rest of the page stale: the run list, the
// funnel and the Review banner all describe a database that has changed.
watch(
  () => activeRequest.value?.id ?? null,
  (now, before) => {
    if (before && !now) emit('finished')
  },
)

onBeforeUnmount(stopPolling)

// ─── acting ──────────────────────────────────────────────────────────────────
const busy = ref(false)
const actionError = ref('')
const pendingApply = ref<RunKind | null>(null)

const canStart = computed(() => runner.value !== null && activeRequest.value === null && !busy.value)

async function start(kind: RunKind) {
  if (busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    await enqueueRun(kind, source.value)
    pendingApply.value = null
    await requests.refetch()
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = false
  }
}

function press(kind: RunKind) {
  const spec = KINDS.find((k) => k.kind === kind)
  // Apply writes the catalog. The other three cost time and nothing else, and
  // confirming them would make the panel tiresome for no protection.
  if (spec?.confirm) pendingApply.value = kind
  else void start(kind)
}

async function cancel() {
  const target = activeRequest.value
  if (!target || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    await cancelRun(target.id)
    await requests.refetch()
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = false
  }
}

// ─── rendering ───────────────────────────────────────────────────────────────
const stalled = computed(
  () => activeRequest.value !== null && isStalled(activeRequest.value, runner.value),
)

const statusTone: Record<string, Tone> = {
  queued: 'idle',
  running: 'accent',
  cancelling: 'warn',
  done: 'good',
  failed: 'bad',
  cancelled: 'idle',
}

const progressText = computed(() => {
  const d = detail.data.value ?? activeRequest.value
  if (!d || d.progress_done === null) return ''
  return d.progress_total !== null
    ? `${formatCount(d.progress_done)} of ${formatCount(d.progress_total)}`
    : formatCount(d.progress_done)
})

/** Newest last, which is how a terminal reads. */
const logLines = computed(() => (detail.data.value?.log ?? []).slice(-12))

function duration(row: RunRequest): string {
  if (!row.finished_at) return ''
  const ms = new Date(row.finished_at).getTime() - new Date(row.requested_at).getTime()
  if (ms < 1000) return '<1s'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const columns: Column<RunRequest>[] = [
  { key: 'kind', label: 'Job', width: '16%' },
  { key: 'source', label: 'Source', width: '20%' },
  { key: 'status', label: 'Status', width: '14%' },
  { key: 'requested_at', label: 'Started', width: '20%' },
  { key: 'took', label: 'Took', width: '10%', numeric: true },
  { key: 'error', label: '', width: '20%' },
]
</script>

<template>
  <PanelCard v-if="!configured" flush>
    <StateBlock
      state="unrecorded"
      title="No catalog project configured"
      message="The run queue lives in the catalog project, and this dashboard has no URL or key for it."
      would-require="VITE_CATALOG_SUPABASE_URL and VITE_CATALOG_SUPABASE_ANON_KEY in .env."
    />
  </PanelCard>

  <template v-else-if="error?.forbidden">
    <StateBlock
      state="error"
      title="Not a catalog admin"
      message="Starting a run is a write to the catalog project, and your account is not in its admin list."
      would-require="npm run admins:add -- <your Clerk user id>, in catalog-importer."
    />
  </template>

  <template v-else>
    <!--
      The runner first, because everything below depends on it. A button that
      queues into a void is worse than a disabled one.
    -->
    <div class="runner" :class="{ 'runner--off': !runner }">
      <StatusPill :tone="runner ? 'good' : 'idle'" :label="runner ? 'Runner online' : 'Runner offline'" />
      <span v-if="runner" class="runner__text">
        <strong>{{ runner.hostname ?? runner.id }}</strong> is listening.
      </span>
      <span v-else class="runner__text">
        Nothing is listening. Run <code>npm run worker</code> in
        <code>catalog-importer</code> on the machine that holds the dump and the
        service-role key. The dashboard cannot do this part itself.
      </span>
    </div>

    <div class="controls">
      <label class="controls__label" for="run-source">Source</label>
      <select id="run-source" v-model="source" class="select" :disabled="!canStart">
        <option v-for="s in SOURCES" :key="s" :value="s">{{ s }}</option>
      </select>

      <button
        v-for="k in KINDS"
        :key="k.kind"
        type="button"
        class="go"
        :class="{ 'go--danger': k.confirm }"
        :data-test="`run-${k.kind}`"
        :disabled="!canStart"
        :title="k.hint"
        @click="press(k.kind)"
      >
        {{ k.label }}
      </button>
    </div>

    <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>

    <!-- The active run. -->
    <div v-if="activeRequest" class="active">
      <div class="active__head">
        <StatusPill
          :tone="stalled ? 'bad' : statusTone[activeRequest.status] ?? 'idle'"
          :label="stalled ? 'Stalled' : activeRequest.status"
        />
        <span class="active__what">
          {{ activeRequest.kind }} · {{ activeRequest.source }}
          <template v-if="activeRequest.stage"> · {{ activeRequest.stage }}</template>
        </span>
        <span v-if="progressText" class="active__progress">{{ progressText }}</span>
        <button type="button" class="go" data-test="cancel-run" :disabled="busy" @click="cancel">
          Cancel
        </button>
      </div>

      <p v-if="stalled" class="stalled">
        This says it is running, but no worker has checked in for
        {{ 30 }} seconds. The process was probably killed. Cancel it and start again.
      </p>

      <pre v-if="logLines.length" class="log"><span
        v-for="(line, i) in logLines"
        :key="i"
        :class="`log__line log__line--${line.level}`"
      >{{ line.text }}
</span></pre>
    </div>

    <!-- Recent requests. -->
    <DataTable
      :columns="columns"
      :rows="rows"
      row-key="id"
      dense
      :loading="requests.loading.value"
      :error="error?.detail ?? ''"
      empty-title="No runs yet"
      empty-message="Nothing has been started from here."
    >
      <template #cell-status="{ row }">
        <StatusPill :tone="statusTone[row.status] ?? 'idle'" :label="row.status" />
      </template>
      <template #cell-requested_at="{ row }">
        <span :title="formatDateTime(String(row.requested_at))">
          {{ formatRelative(String(row.requested_at)) }}
        </span>
      </template>
      <template #cell-took="{ row }">{{ duration(row) || '—' }}</template>
      <template #cell-error="{ row }">
        <span v-if="row.error" class="rowerror">{{ row.error }}</span>
      </template>
    </DataTable>

    <ConfirmDialog
      :open="pendingApply !== null"
      :title="`Apply the load to ${source}?`"
      message="This writes the catalog: new products are inserted and imported rows are refreshed. Curated rows are never touched. Read the dry run's diff first if you have not."
      confirm-label="Apply it"
      :busy="busy"
      :error="actionError"
      @confirm="start('load-apply')"
      @cancel="pendingApply = null"
    />
  </template>
</template>

<style scoped>
.runner {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  flex-wrap: wrap;
}

.runner--off {
  background: var(--bg-subtle);
}

.runner__text {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.runner__text code {
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
  background: var(--bg-subtle);
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-3);
}

.controls__label {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.select {
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  background: var(--bg-input);
  color: var(--text-primary);
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-sm);
  margin-right: var(--space-2);
}

.go {
  background: none;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-primary);
  cursor: pointer;
}

.go:hover:not(:disabled) {
  background: var(--bg-hover);
}

.go:disabled {
  opacity: 0.45;
  cursor: default;
}

.go--danger {
  border-color: var(--border-strong);
  font-weight: var(--weight-medium);
}

.active {
  border-top: var(--border-width-thin) solid var(--border-subtle);
  padding: var(--space-3) var(--space-4);
}

.active__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.active__what {
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.active__progress {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin-left: auto;
}

.stalled {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--text-danger);
}

.log {
  margin: var(--space-3) 0 0;
  padding: var(--space-2);
  max-height: 14rem;
  overflow: auto;
  background: var(--bg-subtle);
  border-radius: var(--radius-md);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
  line-height: 1.5;
  white-space: pre-wrap;
}

.log__line--warn {
  color: var(--text-warning, var(--text-secondary));
}

.log__line--error {
  color: var(--text-danger);
}

.error,
.rowerror {
  font-size: var(--text-sm);
  color: var(--text-danger);
}

.error {
  margin: 0;
  padding: 0 var(--space-4) var(--space-2);
}

.rowerror {
  font-size: var(--text-xs);
}
</style>
