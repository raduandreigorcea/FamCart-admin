<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import StatTile from '../components/StatTile.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import DataTable from '../components/DataTable.vue'
import BarChart from '../components/BarChart.vue'
import LineChart from '../components/LineChart.vue'
import SideDrawer from '../components/SideDrawer.vue'
import CopyValue from '../components/CopyValue.vue'
import StageLadder from '../components/StageLadder.vue'
import RunControl from '../components/RunControl.vue'
import TruncationNotice from '../components/TruncationNotice.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import { useQuery, describeError } from '../lib/useQuery'
import {
  fetchPipeline,
  runFunnel,
  runLedger,
  type IngestionRun,
} from '../lib/data/pipeline'
import { catalogConfigured, refreshCatalogShape } from '../lib/data/products'
import { unavailable } from '../lib/data/types'
import type { Column, Series } from '../lib/uiTypes'
import { formatCount, formatDate, formatDateTime, formatRelative, formatShare } from '../lib/format'
import { useDensity, type Density } from '../lib/useDensity'

// The Product Pipeline.
//
// This page used to be built around a line between what the database recorded
// and what it could not: runs were reconstructed from the rows they created,
// and everything the importer DISCARDED left no row and so was not here at all.
//
// catalog-importer now publishes a ledger -- catalog_import_runs and
// catalog_import_outcomes -- so the second tier is real. What remains
// unavailable is narrower and more specific: a run with no score half, a run
// whose records retention has pruned, and per-step logs, which are still
// written to a terminal and nowhere else.
//
// See src/lib/data/pipeline.ts for the full account of why.

const { dense, density, setDensity, segments: densitySegments } = useDensity()

const configured = catalogConfigured()

const pipeline = useQuery((signal) => fetchPipeline(signal), { manual: !configured })

function refresh() {
  // Everything on this page is derived from the catalog shape, which is cached
  // for the session. refreshCatalogShape() swaps in a fresh build synchronously,
  // so the refetch below reads that rather than the cached one.
  void refreshCatalogShape()
  void pipeline.refetch()
}


const openRun = ref<IngestionRun | null>(null)
// Pure now, over a row the drawer already holds. A run with no ledger row
// predates the importer's publish step, which is a different fact from a run
// whose score half was never recorded -- so it gets its own sentence.
const ledger = computed(() =>
  openRun.value?.row
    ? runLedger(openRun.value.row)
    : unavailable(
        'This run predates the import ledger, so only what its rows imply is known.',
        'Nothing -- runs published from now on carry their own counts.',
      ),
)

const snapshot = computed(() => pipeline.data.value)

// The newest run that recorded a funnel. Not simply runs[0]: a run published
// from a load with no matching score has no stage counts, and falling back to
// the one behind it beats showing an empty tile.
const latestFunnel = computed(() => {
  for (const run of snapshot.value?.runs ?? []) {
    if (!run.row) continue
    const funnel = runFunnel(run.row)
    if (funnel.available) return funnel.value
  }
  return null
})



const runColumns: Column<RunRow>[] = [
  { key: 'version', label: 'Run', width: '20%' },
  { key: 'source', label: 'Source', width: '18%' },
  { key: 'rowsCreated', label: 'Rows created', numeric: true, width: '13%' },
  { key: 'barcodeShare', label: 'Scannable', numeric: true, width: '11%', title: 'Share of the run’s rows carrying a barcode' },
  { key: 'aliasShare', label: 'Aliased', numeric: true, width: '10%', hideBelow: 1100, title: 'Share findable by category' },
  { key: 'marketShare', label: 'Placed', numeric: true, width: '10%', hideBelow: 1400, title: 'Share with at least one market' },
  { key: 'lastSeen', label: 'Landed', width: '18%' },
]

/**
 * A run, plus the identity and the three completeness shares the table renders.
 * The shares are derived here rather than in pipeline.ts because they are a
 * presentation choice: the snapshot carries counts, this carries ratios.
 */
type RunRow = IngestionRun & {
  id: string
  barcodeShare: number
  aliasShare: number
  marketShare: number
}

const runRows = computed<RunRow[]>(() =>
  (snapshot.value?.runs ?? []).map((run) => ({
    ...run,
    id: `${run.source}-${run.version ?? 'none'}`,
    barcodeShare: run.withBarcode / (run.rowsCreated || 1),
    aliasShare: run.withAliases / (run.rowsCreated || 1),
    marketShare: run.withMarkets / (run.rowsCreated || 1),
  })),
)

const sourceBars = computed(() =>
  (snapshot.value?.sources ?? []).map((s) => ({
    key: s.source,
    label: s.source,
    value: s.rows,
    meta: s.latestVersion ?? 'never run',
  })),
)

// Rows created per day, over the whole life of the catalog. Not range-filtered:
// an import is an event, not a rate, and there are only a handful of them.
const ingestionSeries = computed<Series[]>(() => [
  {
    key: 'rows',
    label: 'Rows created',
    values: (snapshot.value?.byDay ?? []).map((d) => d.rows),
  },
])

const ingestionLabels = computed(() =>
  (snapshot.value?.byDay ?? []).map((d) => formatDate(d.day)),
)

const errorInfo = computed(() => describeError(pipeline.error.value))

function statusTone(status: string): 'good' | 'warn' | 'bad' | 'idle' {
  if (status === 'fresh') return 'good'
  if (status === 'ageing') return 'warn'
  if (status === 'stale') return 'bad'
  return 'idle'
}

function statusLabel(status: string, ageDays: number | null): string {
  if (status === 'never') return 'Never run'
  if (ageDays === null) return status
  return `${status} · ${ageDays}d`
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Product Pipeline"
      description="Where the catalog comes from, and what it cost to get there."
      :fetched-at="pipeline.fetchedAt.value"
      :busy="pipeline.fetching.value"
      @refresh="refresh"
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

    <TruncationNotice :truncated="snapshot?.truncated ?? false" subject="This ingestion history" />

    <StateBlock
      v-if="!configured"
      state="empty"
      title="The catalog project is not configured"
      message="Set VITE_CATALOG_SUPABASE_URL and VITE_CATALOG_SUPABASE_ANON_KEY to read ingestion history."
    />

    <StateBlock
      v-else-if="pipeline.error.value"
      state="error"
      :title="errorInfo.title"
      :message="errorInfo.detail"
    />

    <StateBlock v-else-if="pipeline.loading.value" state="loading" :lines="6" />

    <template v-else>
      <div class="grid">
        <div class="span-6">
          <StatTile
            label="Catalog rows"
            :value="snapshot?.totalRows ?? null"
            hint="Every row in the catalog project"
          />
        </div>
        <div class="span-6">
          <StatTile
            label="Import runs"
            :value="snapshot?.runs.length ?? null"
            hint="Distinct source versions"
          />
        </div>
      </div>

      <!-- The answer first: what the last run did. Full width, because the
           shape of it is the point, and it had been squeezed into two thirds of
           a row while a box explaining terminology took the other third. -->
      <PanelCard
        title="What the last run did"
        note="Every record it read, and where each one ended up."
        flush
      >
        <StageLadder v-if="latestFunnel" :funnel="latestFunnel" />
        <StateBlock
          v-else
          state="unrecorded"
          title="No run has recorded its stages yet"
          message="Runs from before the import ledger existed kept only the rows they created, not the account of what they threw away."
          would-require="Start a re-score below and this fills in when it finishes."
        />
      </PanelCard>

      <!-- Then the action, directly under the answer. It was three panels down,
           below two charts and a box of terminology.

           "Start a run" assumed you knew what a run was and what starting one
           would do to the catalog. The title now says what it is for and the
           note says how to use it, because the sequence is the part that was
           hard to learn. -->
      <PanelCard
        title="Update the catalog"
        note="Pick a source and work left to right. Each step reads what the one before it wrote."
        flush
      >
        <RunControl @finished="refresh" />
      </PanelCard>

      <PanelCard
        title="Runs"
        note="One row per source version. Click a run for what the database can and cannot say about it."
        flush
      >
        <DataTable
          :dense="dense"
          :columns="runColumns"
          :rows="runRows"
          row-key="id"
          clickable
          empty-title="No import runs"
          empty-message="Nothing in the catalog carries a source_version, so nothing was loaded by the importer."
          @select="openRun = $event"
        >
          <template #cell-version="{ row }">
            <CopyValue
              v-if="row.version"
              :value="String(row.version)"
              label="source version"
            />
            <span v-else class="u-muted">no version</span>
          </template>
          <template #cell-source="{ row }">
            <StatusPill tone="idle" :label="String(row.source)" :dot="false" />
          </template>
          <template #cell-rowsCreated="{ row }">
            {{ formatCount(Number(row.rowsCreated)) }}
          </template>
          <template #cell-barcodeShare="{ row }">
            {{ formatShare(Number(row.withBarcode), Number(row.rowsCreated)) }}
          </template>
          <template #cell-aliasShare="{ row }">
            {{ formatShare(Number(row.withAliases), Number(row.rowsCreated)) }}
          </template>
          <template #cell-marketShare="{ row }">
            {{ formatShare(Number(row.withMarkets), Number(row.rowsCreated)) }}
          </template>
          <template #cell-lastSeen="{ row }">
            <span :title="formatDateTime(String(row.lastSeen))">
              {{ formatRelative(String(row.lastSeen)) }}
            </span>
          </template>
        </DataTable>
      </PanelCard>

      <!-- Context last. Both answer "how has this gone over time", which is a
           question you ask after the two above, not before. -->
      <div class="grid">
        <div class="span-6">
          <PanelCard title="Ingestion history" note="Rows created per day. Imports are events, not a rate." fill>
            <StateBlock
              v-if="!snapshot?.byDay.length"
              state="empty"
              title="Nothing imported"
              message="The catalog holds no rows with a creation date."
            />
            <LineChart
              v-else
              :series="ingestionSeries"
              :labels="ingestionLabels"
              :height="200"
              :format="formatCount"
            />
          </PanelCard>
        </div>
        <div class="span-6">
          <PanelCard title="Source health" note="Rows per source, and how long since each last produced one." fill>
            <BarChart :bars="sourceBars" :format="formatCount" dense />
            <ul class="sources">
              <li v-for="source in snapshot?.sources ?? []" :key="source.source" class="sources__row">
                <StatusPill
                  :tone="statusTone(source.status)"
                  :label="statusLabel(source.status, source.ageDays)"
                />
                <span class="sources__name">{{ source.source }}</span>
                <span class="sources__meta u-num">
                  {{ source.rows ? formatShare(source.withBarcode, source.rows) : '--' }} scannable
                </span>
              </li>
            </ul>
          </PanelCard>
        </div>
      </div>

      <SideDrawer
        :open="openRun !== null"
        :title="openRun?.version || 'Run'"
        :subtitle="openRun?.source"
        width="560px"
        @close="openRun = null"
      >
        <template v-if="openRun">
          <dl class="drawer-facts u-facts">
            <div>
              <dt>Rows created</dt>
              <dd class="u-num">{{ formatCount(openRun.rowsCreated) }}</dd>
            </div>
            <div>
              <dt>First row landed</dt>
              <dd :title="formatDateTime(openRun.firstSeen)">{{ formatRelative(openRun.firstSeen) }}</dd>
            </div>
            <div>
              <dt>Last row landed</dt>
              <dd :title="formatDateTime(openRun.lastSeen)">{{ formatRelative(openRun.lastSeen) }}</dd>
            </div>
            <div>
              <dt>Scannable</dt>
              <dd class="u-num">
                {{ formatCount(openRun.withBarcode) }}
                <span class="drawer-share">{{ formatShare(openRun.withBarcode, openRun.rowsCreated) }}</span>
              </dd>
            </div>
            <div>
              <dt>With aliases</dt>
              <dd class="u-num">
                {{ formatCount(openRun.withAliases) }}
                <span class="drawer-share">{{ formatShare(openRun.withAliases, openRun.rowsCreated) }}</span>
              </dd>
            </div>
            <div>
              <dt>Placed in a market</dt>
              <dd class="u-num">
                {{ formatCount(openRun.withMarkets) }}
                <span class="drawer-share">{{ formatShare(openRun.withMarkets, openRun.rowsCreated) }}</span>
              </dd>
            </div>
          </dl>

          <StateBlock
            v-if="!ledger.available"
            state="unrecorded"
            title="What this run discarded"
            :message="ledger.reason"
            :would-require="ledger.wouldRequire"
          />
          <dl v-else class="drawer-facts u-facts">
            <div>
              <dt>Records read</dt>
              <dd class="u-num">{{ formatCount(ledger.value.recordsRead) }}</dd>
            </div>
            <div>
              <dt>Rejected before scoring</dt>
              <dd class="u-num">{{ formatCount(ledger.value.recordsRejected) }}</dd>
            </div>
            <div>
              <dt>Rows refreshed</dt>
              <dd class="u-num">{{ formatCount(ledger.value.updated) }}</dd>
            </div>
            <div>
              <dt>Barcode conflicts</dt>
              <dd class="u-num">{{ formatCount(ledger.value.barcodeConflicts) }}</dd>
            </div>
            <div>
              <dt>Deduped</dt>
              <dd class="u-num">{{ formatCount(ledger.value.duplicates) }}</dd>
            </div>
            <div>
              <dt>Failed chunks</dt>
              <dd class="u-num">{{ formatCount(ledger.value.errors) }}</dd>
            </div>
          </dl>

          <StateBlock
            v-if="openRun.row?.outcomes_pruned"
            state="unrecorded"
            title="The records themselves are gone"
            message="Retention keeps the discarded records of the 5 most recent runs per source. This run's counts above are exact; its individual records have been pruned."
            would-require="Nothing -- this is the retention rule working. Re-publish from catalog-importer if you still have this run's out/ directory."
            compact
          />
          <RouterLink
            v-else-if="openRun.row"
            :to="`/products?scope=outcomes&run=${encodeURIComponent(openRun.row.id)}`"
            class="drawer-link"
          >Browse what this run discarded</RouterLink>

          <RouterLink
            v-if="openRun.row"
            :to="`/review?run=${encodeURIComponent(openRun.row.id)}`"
            class="drawer-link"
          >Decide this run's review band</RouterLink>

          <RouterLink
            v-if="openRun.version"
            :to="`/products?version=${encodeURIComponent(openRun.version)}`"
            class="drawer-link"
          >Browse this run's products</RouterLink>
        </template>
      </SideDrawer>
    </template>
  </div>
</template>

<style scoped>
.last {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: flex-start;
}

.last__version {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.last__when {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.last__note {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--text-disabled);
  line-height: var(--leading-normal);
}

.sources {
  list-style: none;
  margin: var(--space-4) 0 0;
  padding: var(--space-3) 0 0;
  border-top: var(--border-width-thin) solid var(--border-light);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sources__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--space-2);
}

.sources__name {
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.sources__meta {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}

.runbook {
  margin-top: var(--space-3);
}

.runbook__label {
  margin: 0 0 var(--space-2);
}

.runbook__code {
  margin: 0;
  background: var(--bg-main);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--text-primary);
}

.drawer-facts {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-3);
}

.drawer-facts dd {
  margin: 2px 0 0;
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.drawer-share {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  margin-left: var(--space-1);
}

.drawer-link {
  font-size: var(--text-sm);
  color: var(--color-primary);
  text-decoration: none;
  font-weight: var(--weight-semibold);
}

.drawer-link:hover {
  text-decoration: underline;
}
</style>
