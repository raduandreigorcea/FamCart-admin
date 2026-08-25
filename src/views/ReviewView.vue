<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import SideDrawer from '../components/SideDrawer.vue'
import TablePager from '../components/TablePager.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { useQuery, useQueryGroup, describeError } from '../lib/useQuery'
import { useDensity, type Density } from '../lib/useDensity'
import { catalogConfigured } from '../lib/data/products'
import {
  approveAbove,
  clearDecision,
  fetchReviewCandidates,
  fetchReviewDecisions,
  recordDecision,
  reviewSignal,
  type ReviewCandidate,
  type ReviewDecision,
  type Verdict,
} from '../lib/data/review'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

// The review band, and the one screen in this dashboard whose job is a decision
// rather than a number.
//
// The importer's gate is hybrid: the clearly-good load themselves, the
// clearly-bad are dropped with a logged reason, and the ambiguous middle waits
// for a human. Last run that middle was 12,255 records, and the only way to rule
// on one was appending a line of JSON to a file on the operator's machine.
//
// ─── WHAT A VERDICT DOES, AND WHEN ───────────────────────────────────────────
//
// Nothing, immediately. It writes a row to catalog_review_decisions, which the
// importer reads at the start of its NEXT score run, before the gate. Approving
// fifty products here and going to look for them in the catalog would find
// nothing, so the banner above the table says so and stays there while you work.
// When the dashboard can start a run itself, that sentence grows a button.
//
// ─── WHY THERE IS NO CONFIRMATION DIALOG PER DECISION ────────────────────────
//
// Deliberate, and a break from the pattern TrashView and the detail views use
// for delete and ban. Confirming four hundred approvals one at a time makes the
// screen useless, and unlike a deletion a verdict is an upsert: Undo is one
// click, on the row, and the Decided tab is where one gets revisited. The bulk
// action is confirmed, because that one is not row-by-row reversible.

const route = useRoute()
const { dense, density, setDensity, segments: densitySegments } = useDensity()

const configured = catalogConfigured()

const LIMIT = 25

type Tab = 'pending' | 'decided'
const tab = ref<Tab>('pending')
const tabs = [
  { value: 'pending', label: 'Pending', title: 'Records the gate could not decide on its own' },
  { value: 'decided', label: 'Decided', title: 'Verdicts already recorded, and how to change them' },
]

// The Pipeline run drawer links straight here. Read once on setup, like
// ProductsView reads its scope, so a later filter change is not fighting the URL.
const runFilter = ref<string | null>(
  typeof route.query.run === 'string' ? route.query.run : null,
)
const reasonFilter = ref<string | null>(null)
const search = ref('')
const verdictFilter = ref<Verdict | null>(null)
const offset = ref(0)

const pendingFilters = computed(() => ({
  runId: runFilter.value,
  reason: reasonFilter.value,
  query: search.value,
}))

// Any filter change puts you back on page one. Without this, narrowing a
// 12,000-row band while on page 40 lands you past the end of the new result and
// the table looks empty.
watch([runFilter, reasonFilter, search, verdictFilter, tab], () => {
  offset.value = 0
})

const candidates = useQuery(
  (signal) =>
    fetchReviewCandidates(pendingFilters.value, { limit: LIMIT, offset: offset.value }, signal),
  {
    watch: [pendingFilters, offset],
    enabled: () => configured && tab.value === 'pending',
  },
)

const decisions = useQuery(
  (signal) =>
    fetchReviewDecisions(
      { verdict: verdictFilter.value, query: search.value },
      { limit: LIMIT, offset: offset.value },
      signal,
    ),
  {
    watch: [verdictFilter, search, offset],
    enabled: () => configured && tab.value === 'decided',
  },
)

// Deliberately not scoped to the visible tab: the banner has to be able to say
// how many verdicts are waiting for a run while you are on the Pending tab,
// which is exactly when it matters.
const waiting = useQuery(
  (signal) => fetchReviewDecisions({}, { limit: 1, offset: 0 }, signal),
  { enabled: () => configured },
)

const page = useQueryGroup([candidates, decisions, waiting])

const active = computed(() => (tab.value === 'pending' ? candidates : decisions))
const rows = computed(() => active.value.data.value?.rows ?? [])
const total = computed(() => active.value.data.value?.total ?? 0)

const error = computed(() =>
  active.value.error.value ? describeError(active.value.error.value) : null,
)

// Not `rows.length === 0`: that is also true before the first response, and an
// empty band and an unanswered query are different answers. Same rule TrashView
// and TablePager follow.
const knownEmpty = computed(
  () => active.value.data.value !== null && rows.value.length === 0,
)

const waitingCount = computed(() => waiting.data.value?.total ?? null)

// Populated from what is on screen rather than from a lookup: the gate owns the
// reason vocabulary and is free to change it, so a hardcoded list here would go
// stale silently. The cost is that the options only cover the current page,
// which is the honest scope for a filter built from the answer.
const reasons = computed(() => {
  const seen = new Set<string>()
  for (const row of candidates.data.value?.rows ?? []) seen.add(row.reason)
  return [...seen].sort()
})

const candidateColumns: Column<ReviewCandidate>[] = [
  { key: 'name', label: 'Product', width: '26%' },
  { key: 'score', label: 'Score', numeric: true, width: '8%', title: 'Higher is closer to auto-loading' },
  { key: 'reason', label: 'Why it is here', width: '16%' },
  { key: 'lang', label: 'Name lang', width: '9%', hideBelow: 1100 },
  { key: 'scans', label: 'Scans', numeric: true, width: '8%', title: 'Unique scans upstream. A dash means it was never recorded.' },
  { key: 'markets', label: 'Markets', width: '15%', hideBelow: 1400 },
  { key: 'actions', label: '', align: 'right', width: '18%' },
]

const decisionColumns: Column<ReviewDecision>[] = [
  { key: 'name', label: 'Product', width: '28%' },
  { key: 'verdict', label: 'Verdict', width: '12%' },
  { key: 'decided_at', label: 'Decided', width: '18%' },
  { key: 'decided_by', label: 'By', width: '18%', hideBelow: 1100 },
  { key: 'actions', label: '', align: 'right', width: '16%' },
]

const openRow = ref<ReviewCandidate | ReviewDecision | null>(null)
const busyBarcode = ref<string | null>(null)
const actionError = ref('')

/** A dash, not a zero: an unrecorded signal is not a measured absence. */
function signalText(signals: Record<string, unknown>, key: 'lang' | 'scans' | 'markets'): string {
  const value = reviewSignal(signals ?? {}, key)
  if (value === null) return '—'
  if (Array.isArray(value)) {
    if (!value.length) return '—'
    return value.map((m) => String(m).replace(/^en:/, '')).join(', ')
  }
  if (typeof value === 'number') return formatCount(value)
  return String(value)
}

async function decide(barcode: string, verdict: Verdict) {
  if (busyBarcode.value) return
  busyBarcode.value = barcode
  actionError.value = ''
  try {
    await recordDecision(barcode, verdict)
    await Promise.all([active.value.refetch(), waiting.refetch()])
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busyBarcode.value = null
  }
}

async function undo(barcode: string) {
  if (busyBarcode.value) return
  busyBarcode.value = barcode
  actionError.value = ''
  try {
    await clearDecision(barcode)
    await Promise.all([active.value.refetch(), waiting.refetch()])
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busyBarcode.value = null
  }
}

// ─── bulk ────────────────────────────────────────────────────────────────────
const bulkScore = ref(55)
const bulkOpen = ref(false)
const bulkBusy = ref(false)
const bulkResult = ref('')

async function confirmBulk() {
  if (bulkBusy.value) return
  bulkBusy.value = true
  actionError.value = ''
  try {
    const written = await approveAbove(bulkScore.value, pendingFilters.value)
    bulkResult.value = `Approved ${formatCount(written)} products.`
    bulkOpen.value = false
    await Promise.all([candidates.refetch(), waiting.refetch()])
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    bulkBusy.value = false
  }
}

// ─── keyboard ────────────────────────────────────────────────────────────────
//
// Bound to the table container rather than to window, so typing "approve" into
// the search box does not approve anything. A 12,000-row band needs a way
// through it that is not four hundred round trips of the mouse.
const focused = ref(0)

function onKey(event: KeyboardEvent) {
  if (tab.value !== 'pending' || !rows.value.length) return
  const row = rows.value[focused.value] as ReviewCandidate | undefined

  if (event.key === 'j') focused.value = Math.min(focused.value + 1, rows.value.length - 1)
  else if (event.key === 'k') focused.value = Math.max(focused.value - 1, 0)
  else if (event.key === 'a' && row) void decide(row.barcode, 'approve')
  else if (event.key === 'r' && row) void decide(row.barcode, 'reject')
  else return

  event.preventDefault()
}

watch(rows, () => {
  focused.value = 0
})
</script>

<template>
  <div class="page">
    <PageHeader
      title="Review"
      description="What the importer could not decide on its own. A verdict is recorded against the barcode, so it survives a new dump, a re-score, and a normalizer change that renames the product entirely."
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

    <StateBlock
      v-if="!configured"
      state="unrecorded"
      title="No catalog project configured"
      message="The review band lives in the catalog project, and this dashboard has no URL or key for it."
      would-require="VITE_CATALOG_SUPABASE_URL and VITE_CATALOG_SUPABASE_ANON_KEY in .env."
    />

    <template v-else>
      <!--
        The banner, and it is not decoration. A verdict changes nothing about the
        catalog until the importer next scores; without this line you approve
        fifty products and go looking for them.
      -->
      <PanelCard class="banner">
        <p class="banner__text">
          Approved products enter the catalog on the next score and load run.
          <template v-if="waitingCount !== null">
            <strong>{{ formatCount(waitingCount) }}</strong>
            {{ waitingCount === 1 ? 'verdict is' : 'verdicts are' }} waiting for one.
          </template>
        </p>
      </PanelCard>

      <PanelCard flush>
        <div class="toolbar">
          <SegmentedControl
            :model-value="tab"
            :segments="tabs"
            label="Show"
            @update:model-value="tab = $event as Tab"
          />

          <input
            v-model="search"
            type="search"
            class="search"
            placeholder="Find a product by name"
            aria-label="Find a product by name"
          />

          <select
            v-if="tab === 'pending'"
            v-model="reasonFilter"
            class="select"
            aria-label="Filter by reason"
          >
            <option :value="null">Every reason</option>
            <option v-for="reason in reasons" :key="reason" :value="reason">{{ reason }}</option>
          </select>

          <select
            v-else
            v-model="verdictFilter"
            class="select"
            aria-label="Filter by verdict"
          >
            <option :value="null">Both verdicts</option>
            <option value="approve">Approved</option>
            <option value="reject">Rejected</option>
          </select>

          <button
            v-if="runFilter"
            type="button"
            class="chip"
            title="Showing one run only"
            @click="runFilter = null"
          >
            One run &times;
          </button>

          <div v-if="tab === 'pending'" class="bulk">
            <label class="bulk__label" for="bulk-score">Approve all at or above</label>
            <input id="bulk-score" v-model.number="bulkScore" type="number" class="bulk__input" min="0" max="100" />
            <button type="button" class="bulk__go" @click="bulkOpen = true">Approve</button>
          </div>
        </div>

        <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>
        <p v-else-if="bulkResult" class="note">{{ bulkResult }}</p>

        <StateBlock
          v-if="error?.forbidden"
          state="error"
          title="Not a catalog admin"
          message="Your account can read the catalog, like every FamCart account, but recording a verdict needs to be in the catalog project's own admin list."
          would-require="npm run admins:add -- <your Clerk user id>, in catalog-importer."
        />

        <StateBlock
          v-else-if="knownEmpty && tab === 'pending'"
          state="empty"
          title="Nothing waiting"
          message="Every record the gate was unsure about has a verdict. The next score run will apply them."
        />

        <StateBlock
          v-else-if="knownEmpty"
          state="empty"
          title="No verdicts yet"
          message="Approve or reject something on the Pending tab and it appears here."
        />

        <template v-else>
          <div class="table" tabindex="0" @keydown="onKey">
            <DataTable
              v-if="tab === 'pending'"
              :columns="candidateColumns"
              :rows="(rows as ReviewCandidate[])"
              row-key="barcode"
              clickable
              :dense="dense"
              :loading="candidates.loading.value"
              :error="error?.detail ?? ''"
              @row-click="openRow = $event"
            >
              <template #cell-name="{ row }">
                <span class="product">{{ row.name ?? row.barcode }}</span>
                <span v-if="row.maker" class="maker">{{ row.maker }}</span>
              </template>

              <template #cell-score="{ row }">{{ row.score ?? '—' }}</template>

              <template #cell-reason="{ row }">
                <StatusPill :tone="row.flags?.length ? 'warn' : 'idle'" :label="row.reason" />
              </template>

              <template #cell-lang="{ row }">{{ signalText(row.signals, 'lang') }}</template>

              <template #cell-scans="{ row }">
                <span data-test="scans">{{ signalText(row.signals, 'scans') }}</span>
              </template>

              <template #cell-markets="{ row }">{{ signalText(row.signals, 'markets') }}</template>

              <template #cell-actions="{ row }">
                <button
                  type="button"
                  class="verdict verdict--approve"
                  data-test="approve"
                  :disabled="busyBarcode === row.barcode"
                  @click.stop="decide(row.barcode, 'approve')"
                >
                  Approve
                </button>
                <button
                  type="button"
                  class="verdict"
                  data-test="reject"
                  :disabled="busyBarcode === row.barcode"
                  @click.stop="decide(row.barcode, 'reject')"
                >
                  Reject
                </button>
              </template>
            </DataTable>

            <DataTable
              v-else
              :columns="decisionColumns"
              :rows="(rows as ReviewDecision[])"
              row-key="barcode"
              clickable
              :dense="dense"
              :loading="decisions.loading.value"
              :error="error?.detail ?? ''"
              @row-click="openRow = $event"
            >
              <template #cell-name="{ row }">
                <span class="product">{{ row.name ?? row.barcode }}</span>
                <span v-if="row.maker" class="maker">{{ row.maker }}</span>
              </template>

              <template #cell-verdict="{ row }">
                <StatusPill
                  :tone="row.verdict === 'approve' ? 'good' : 'idle'"
                  :label="row.verdict === 'approve' ? 'Approved' : 'Rejected'"
                />
              </template>

              <template #cell-decided_at="{ row }">
                <span :title="formatDateTime(String(row.decided_at))">
                  {{ formatRelative(String(row.decided_at)) }}
                </span>
              </template>

              <template #cell-decided_by="{ row }">{{ row.decided_by ?? 'imported' }}</template>

              <template #cell-actions="{ row }">
                <button
                  type="button"
                  class="verdict"
                  data-test="undo"
                  :disabled="busyBarcode === row.barcode"
                  @click.stop="undo(row.barcode)"
                >
                  Undo
                </button>
              </template>
            </DataTable>
          </div>

          <TablePager
            :total="total"
            :offset="offset"
            :limit="LIMIT"
            :loading="active.fetching.value"
            @go="offset = $event"
          />
        </template>
      </PanelCard>
    </template>

    <SideDrawer :open="openRow !== null" :title="openRow?.name ?? 'Record'" @close="openRow = null">
      <dl v-if="openRow" class="drawer-facts u-facts">
        <dt>Barcode</dt>
        <dd>{{ openRow.barcode }}</dd>
        <dt>Maker</dt>
        <dd>{{ openRow.maker ?? '—' }}</dd>
        <dt>Score</dt>
        <dd>{{ openRow.score ?? '—' }}</dd>
        <dt>Reason</dt>
        <dd>{{ openRow.reason ?? '—' }}</dd>
        <dt>Flags</dt>
        <dd>{{ openRow.flags?.length ? openRow.flags.join(', ') : '—' }}</dd>
        <dt>Name language</dt>
        <dd>{{ signalText(openRow.signals, 'lang') }}</dd>
        <dt>Unique scans</dt>
        <dd>{{ signalText(openRow.signals, 'scans') }}</dd>
        <dt>Markets</dt>
        <dd>{{ signalText(openRow.signals, 'markets') }}</dd>
      </dl>
    </SideDrawer>

    <ConfirmDialog
      :open="bulkOpen"
      :title="`Approve everything scoring ${bulkScore} or above?`"
      message="This applies the filters currently on screen, and writes a verdict for every matching record at once. Each one can still be undone individually afterwards."
      confirm-label="Approve them"
      :busy="bulkBusy"
      :error="actionError"
      @confirm="confirmBulk"
      @cancel="bulkOpen = false"
    />
  </div>
</template>

<style scoped>
.banner {
  margin-bottom: var(--space-4);
}

.banner__text {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--border-width-thin) solid var(--border-subtle);
}

.search,
.select,
.bulk__input {
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  background: var(--bg-input);
  color: var(--text-primary);
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-sm);
}

.search {
  min-width: 14rem;
  flex: 1 1 14rem;
}

.bulk {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.bulk__label {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.bulk__input {
  width: 4.5rem;
}

.chip,
.bulk__go,
.verdict {
  background: none;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-primary);
  cursor: pointer;
}

.chip:hover,
.bulk__go:hover,
.verdict:hover:not(:disabled) {
  background: var(--bg-hover);
}

.verdict:disabled {
  opacity: 0.5;
  cursor: default;
}

.verdict + .verdict {
  margin-left: var(--space-2);
}

.verdict--approve {
  border-color: var(--border-strong);
  font-weight: var(--weight-medium);
}

.table:focus-visible {
  outline: var(--border-width-thick) solid var(--focus-ring);
  outline-offset: calc(-1 * var(--border-width-thick));
}

.product {
  display: block;
  font-weight: var(--weight-medium);
}

.maker {
  display: block;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.error,
.note {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
}

.error {
  color: var(--text-danger);
}

.note {
  color: var(--text-secondary);
}

.drawer-facts {
  margin: 0;
}
</style>
