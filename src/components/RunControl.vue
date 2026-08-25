<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
  forceClearRun,
  isStalled,
  runnerOnline,
  sourceReady,
  stepBlockedReason,
  stepReady,
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

onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  stopPolling()
  if (clock) clearInterval(clock)
})

// ─── acting ──────────────────────────────────────────────────────────────────
const busy = ref(false)
const actionError = ref('')
const pendingApply = ref<RunKind | null>(null)

/**
 * The active request is running but the worker that claimed it is gone.
 *
 * Declared before canStart because canStart depends on it: a stalled request is
 * never going to finish, and letting it disable the panel is how one killed
 * process locks the page until somebody edits the database.
 */
const stalled = computed(
  () => activeRequest.value !== null && isStalled(activeRequest.value, workers.data.value ?? []),
)

const ready = computed(() => sourceReady(runner.value, source.value))

/** Per step, because they are not equally available. */
function available(kind: RunKind): boolean {
  return canAct.value && stepReady(runner.value, kind, source.value)
}

function blocked(kind: RunKind): string {
  return canAct.value ? stepBlockedReason(runner.value, kind, source.value) : ''
}

const canAct = computed(
  () =>
    runner.value !== null &&
    // A stalled request is never going to finish, so it must not hold the panel
    // hostage. Cancel is offered beside it; starting something else is fine too.
    (activeRequest.value === null || stalled.value) &&
    !busy.value,
)

/** Kept for the source-level notice, which is about the source, not a step. */
const canStart = computed(() => canAct.value && ready.value)

/** The acquire command for the selected source, which the dashboard cannot run. */
const acquireHint = computed(() => {
  const suffix =
    source.value === 'openproductsfacts' ? ':opf' : source.value === 'openbeautyfacts' ? ':obf' : ''
  return `npm run acquire${suffix} && npm run acquire${suffix}:filter`
})

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

async function forceClear() {
  const target = activeRequest.value
  if (!target || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    await forceClearRun(target.id)
    await requests.refetch()
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = false
  }
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
const statusTone: Record<string, Tone> = {
  queued: 'idle',
  running: 'accent',
  cancelling: 'warn',
  done: 'good',
  failed: 'bad',
  cancelled: 'idle',
}

/** Elapsed, ticking, so a run that has hung looks hung. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

const elapsed = computed(() => {
  const r = activeRequest.value
  if (!r) return ''
  const secs = Math.max(0, Math.round((now.value - new Date(r.requested_at).getTime()) / 1000))
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  return `${m}m ${String(secs % 60).padStart(2, '0')}s`
})

/** 0-100, or null when the stage cannot count ahead and a bar would be a lie. */
const progressPct = computed(() => {
  const d = detail.data.value ?? activeRequest.value
  if (!d || d.progress_done === null || !d.progress_total) return null
  return Math.min(100, Math.round((d.progress_done / d.progress_total) * 100))
})

/**
 * Progress, with the noun it is counting.
 *
 * It read "1,215,000" on its own, which is not a fact about anything. Load is
 * the only stage that knows its denominator before it starts -- it chunks a
 * known number of rows -- so a total means chunks and its absence means records
 * streamed. Stated here rather than carried through the stage contract because
 * it is a presentation choice, and adding a unit to every progress call in the
 * importer to serve one label would be the tail wagging the dog.
 */
const progressText = computed(() => {
  const d = detail.data.value ?? activeRequest.value
  if (!d || d.progress_done === null) return ''
  return d.progress_total
    ? `chunk ${formatCount(d.progress_done)} of ${formatCount(d.progress_total)}`
    : `${formatCount(d.progress_done)} records`
})

/** Newest last, which is how a terminal reads. */
const logLines = computed(() => (detail.data.value?.log ?? []).slice(-40))

/** 12:20:31. The date is always today for a run you are watching. */
function logTime(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

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
    <!-- Loud when something is wrong, nearly silent when nothing is.
         "Runner online / radu is listening" spent a full line saying everything
         was normal, and personified a hostname while doing it. The normal state
         is the one that needs the least room. -->
    <p v-if="!runner" class="runner runner--off">
      <StatusPill tone="bad" label="No runner" />
      Nothing is listening. Run <code>npm run worker</code> in
      <code>catalog-importer</code> on the machine that holds the dump and the
      service-role key. The dashboard cannot do this part itself.
    </p>

    <!-- A source with no subset on the runner cannot run any step, so this is
         said once here rather than four times on four buttons. acquire is the
         one thing the dashboard genuinely cannot do for you. -->
    <p v-if="runner && !ready" class="runner" data-test="not-acquired">
      <StatusPill tone="warn" :label="source" />
      Not acquired on {{ runner.hostname ?? runner.id }}. Run
      <code>{{ acquireHint }}</code> there first. It is a large download, which
      is why it is not a button here.
    </p>

    <!-- The four stages, drawn as the sequence they are.
         normalize feeds score feeds load feeds apply, each reading the file the
         one before it wrote. Drawn as four equal buttons it was four unrelated
         things to guess between; drawn as a line it teaches the order, which is
         the part that was hard to learn. Apply is the only one set apart,
         because it is the only one that writes. -->
    <div class="controls">
      <span
        v-if="runner"
        class="ready"
        :title="`Ready on ${runner.hostname ?? runner.id}`"
        aria-label="Runner ready"
      ></span>
      <label class="controls__label" for="run-source">Source</label>
      <select id="run-source" v-model="source" class="select" :disabled="!canStart">
        <option v-for="s in SOURCES" :key="s" :value="s">{{ s }}</option>
      </select>

      <ol class="stages">
        <li v-for="(k, i) in KINDS" :key="k.kind" class="stages__item">
          <span v-if="i > 0" class="stages__arrow" aria-hidden="true">&rsaquo;</span>
          <button
            type="button"
            class="stage"
            :class="{ 'stage--writes': k.confirm }"
            :data-test="`run-${k.kind}`"
            :disabled="!available(k.kind)"
            :title="blocked(k.kind) || k.hint"
            @click="press(k.kind)"
          >
            <span class="stage__label">{{ k.label }}</span>
            <span class="stage__hint">{{ blocked(k.kind) || k.hint }}</span>
          </button>
        </li>
      </ol>
    </div>

    <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>

    <!-- The active run. -->
    <div v-if="activeRequest" class="active" :class="{ 'active--stalled': stalled }">
      <div class="active__head">
        <StatusPill
          :tone="stalled ? 'bad' : statusTone[activeRequest.status] ?? 'idle'"
          :label="stalled ? 'Stalled' : activeRequest.status"
        />
        <span class="active__what">
          {{ activeRequest.kind }} · {{ activeRequest.source }}
        </span>
        <span v-if="activeRequest.stage" class="active__stage">{{ activeRequest.stage }}</span>
        <span class="active__elapsed u-num">{{ elapsed }}</span>
        <button
          v-if="stalled"
          type="button"
          class="stage stage--writes"
          data-test="force-clear"
          :disabled="busy"
          @click="forceClear"
        >
          <span class="stage__label">Clear it</span>
        </button>
        <button v-else type="button" class="stage" data-test="cancel-run" :disabled="busy" @click="cancel">
          <span class="stage__label">Cancel</span>
        </button>
      </div>

      <p v-if="stalled" class="stalled">
        Nothing has claimed this for over thirty seconds, so the worker that took
        it is gone. Clearing it ends the row; the work itself never happened.
      </p>

      <!-- Progress. A bar only when the stage can count ahead: normalize streams
           a file of unknown length, and a bar that invents a denominator is a
           bar that lies. -->
      <div v-if="progressText" class="progress">
        <div v-if="progressPct !== null" class="progress__track">
          <span class="progress__fill" :style="{ width: `${progressPct}%` }"></span>
        </div>
        <div v-else class="progress__track progress__track--unknown">
          <span class="progress__drift"></span>
        </div>
        <span class="progress__text u-num">{{ progressText }}</span>
      </div>

      <pre v-if="logLines.length" class="log" tabindex="0"><span
        v-for="(line, i) in logLines"
        :key="i"
        :class="`log__line log__line--${line.level}`"
      ><span class="log__at">{{ logTime(line.at) }}</span>{{ line.text }}
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
        <span v-if="row.error" class="rowerror" :title="row.error">{{ row.error }}</span>
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
/* Only rendered when something needs saying, so it can afford to say it
   properly rather than compressing an explanation into a badge. */
.runner {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.runner--off {
  background: var(--danger-bg);
}

.runner code {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--bg-subtle);
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
}

/* Ready is a dot beside the source, not a sentence of its own. It is the state
   the panel is in almost always, and it should cost almost nothing. */
.ready {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-pill);
  background: var(--status-good, var(--color-primary));
  flex: none;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-4) var(--space-4);
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
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
}

/* The sequence. The chevrons carry the order, which is real information here:
   each stage reads the file the one before it wrote, and running them out of
   order is the mistake this panel makes easiest to make. */
.stages {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: stretch;
  flex-wrap: wrap;
  gap: var(--space-1);
  flex: 1;
}

.stages__item {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.stages__arrow {
  color: var(--text-disabled);
  font-size: var(--text-lg);
  line-height: 1;
}

.stage {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  text-align: left;
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color var(--transition-fast) var(--ease-standard);
}

.stage:hover:not(:disabled) {
  border-color: var(--border-dark);
  background: var(--bg-hover);
}

.stage:disabled {
  opacity: 0.45;
  cursor: default;
}

/* The only one that writes to the catalog, and the only one set apart. */
.stage--writes {
  border-color: var(--color-primary);
  color: var(--color-primary-text);
  background: var(--color-primary-bg);
}

.stage--writes:hover:not(:disabled) {
  border-color: var(--color-primary);
  background: var(--color-primary-bg);
}

.stage__label {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  line-height: 1.2;
}

.stage__hint {
  font-size: var(--text-2xs);
  color: var(--text-secondary);
  line-height: 1.2;
}

.stage--writes .stage__hint {
  color: var(--color-primary-text);
  opacity: 0.75;
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
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.active__stage {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.active__elapsed {
  margin-left: auto;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  font-variant-numeric: var(--value-figures);
}

/* Progress, and only a real bar when the stage knows its own denominator. */
.progress {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.progress__track {
  flex: 1;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--rule-empty);
  overflow: hidden;
}

.progress__fill {
  display: block;
  height: 100%;
  background: var(--chart-seq-4);
  border-radius: inherit;
  transition: width var(--transition-base) var(--ease-standard);
}

/* Cannot count ahead, so it shows motion rather than a fraction it does not
   have. A bar that invents a denominator is a bar that lies. */
.progress__drift {
  display: block;
  height: 100%;
  width: 28%;
  border-radius: inherit;
  background: var(--chart-seq-3);
  animation: drift 1.8s var(--ease-standard) infinite;
}

@keyframes drift {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}

@media (prefers-reduced-motion: reduce) {
  .progress__drift {
    animation: none;
    width: 100%;
    opacity: 0.5;
  }
}

.progress__text {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  white-space: nowrap;
}

.stalled {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--text-danger);
}

/* The log.
 *
 * It was a bare block of wrapped text that showed one line and looked like an
 * afterthought. A run is the one thing on this page that happens over time, and
 * watching it is most of why the panel exists, so it gets the treatment a
 * terminal gets: fixed width, a time on every line, newest at the bottom, and
 * enough height to see a run progress rather than a single sentence.
 */
.log {
  margin: var(--space-3) 0 0;
  padding: var(--space-3);
  height: 11rem;
  overflow: auto;
  background: var(--admin-thead);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}

.log:focus-visible {
  outline: var(--border-width-thick) solid var(--focus-ring);
  outline-offset: -2px;
}

/* The timestamp is a gutter, not part of the sentence: fixed width so the
   messages start on one column and can be read down. */
.log__at {
  display: inline-block;
  width: 4.75rem;
  color: var(--text-disabled);
  user-select: none;
}

.log__line--warn { color: var(--warning-text); }
.log__line--error { color: var(--danger-text); }

.active--stalled {
  background: var(--danger-bg);
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

/* Errors here are file paths and shell commands and run long. In a table cell
   they wrapped to four lines and pushed their neighbours around; the full text
   is on the title, and the run drawer has it in full. */
.rowerror {
  font-size: var(--text-2xs);
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
