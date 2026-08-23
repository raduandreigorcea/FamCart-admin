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
import TruncationNotice from '../components/TruncationNotice.vue'
import { useQuery, describeError } from '../lib/useQuery'
import {
  fetchPipeline,
  fetchPipelineLogs,
  fetchRunLedger,
  triggerCapability,
  type IngestionRun,
} from '../lib/data/pipeline'
import { catalogConfigured, refreshCatalogShape } from '../lib/data/products'
import type { Column, Series } from '../lib/uiTypes'
import { formatCount, formatDate, formatDateTime, formatRelative, formatShare } from '../lib/format'

// The Product Pipeline.
//
// Two tiers, and the page is built around the line between them. Everything
// above the fold is reconstructed exactly from the rows the importer created:
// which runs happened, what each produced, how complete it was, and whether a
// source has gone quiet. Everything the importer discarded -- records read,
// rejected, deduped, errored -- left no row and is therefore not here.
//
// See src/lib/data/pipeline.ts for the full account of why.

const configured = catalogConfigured()

const pipeline = useQuery(() => fetchPipeline(), { manual: !configured })

function refresh() {
  // Everything on this page is derived from the catalog shape, which is cached
  // for the session. refreshCatalogShape() swaps in a fresh build synchronously,
  // so the refetch below reads that rather than the cached one.
  void refreshCatalogShape()
  void pipeline.refetch()
}

const trigger = triggerCapability()
const logs = fetchPipelineLogs()

const openRun = ref<IngestionRun | null>(null)
const ledger = computed(() => fetchRunLedger(openRun.value?.version ?? null))

const snapshot = computed(() => pipeline.data.value)

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
      description="Ingestion reconstructed from the rows each run created. The importer is a local CLI; the database keeps its output and no record of the run itself."
      :fetched-at="pipeline.fetchedAt.value"
      :busy="pipeline.fetching.value"
      @refresh="refresh"
    />

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
        <div class="span-3">
          <StatTile
            label="Catalog rows"
            :value="snapshot?.totalRows ?? null"
            hint="Every row in the catalog project"
          />
        </div>
        <div class="span-3">
          <StatTile
            label="Import runs"
            :value="snapshot?.runs.length ?? null"
            hint="Distinct source versions"
          />
        </div>
        <div class="span-3">
          <StatTile
            label="Records processed"
            unrecorded
            unrecorded-reason="Not persisted by import_catalog_products()"
          />
        </div>
        <div class="span-3">
          <StatTile
            label="Rejected records"
            unrecorded
            unrecorded-reason="A rejected record leaves no row"
          />
        </div>
      </div>

      <div class="grid">
        <div class="span-8">
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
              :height="220"
              :format="formatCount"
            />
          </PanelCard>
        </div>

        <div class="span-4">
          <PanelCard title="Last successful run" fill>
            <div v-if="snapshot?.lastRunVersion" class="last">
              <StatusPill tone="good" label="Completed" />
              <p class="last__version u-mono">{{ snapshot.lastRunVersion }}</p>
              <p class="last__when" :title="formatDateTime(snapshot.lastRunAt)">
                Last row landed {{ formatRelative(snapshot.lastRunAt) }}
              </p>
              <p class="last__note">
                A run is "successful" here because its rows exist. The importer's own report, with
                what it rejected and why, is written to
                <code class="u-mono">catalog-importer/out/</code> on the machine that ran it.
              </p>
            </div>
            <StateBlock
              v-else
              state="empty"
              title="No import has run"
              message="Every row in the catalog is curated rather than imported."
              compact
            />
          </PanelCard>
        </div>
      </div>

      <div class="grid">
        <div class="span-5">
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

        <div class="span-7">
          <PanelCard
            title="Trigger a run"
            note="Not available, and this is structural rather than missing work."
            fill
          >
            <StateBlock
              state="unrecorded"
              title="Runs cannot be started from a browser"
              :message="trigger.reason"
              would-require="A service that holds the service-role key and the disk to work on. That is backend infrastructure this tool was scoped not to build."
            />
            <div class="runbook">
              <p class="runbook__label">Run it here instead</p>
              <pre class="runbook__code"><code>{{ trigger.runInstead.join('\n') }}</code></pre>
            </div>
          </PanelCard>
        </div>
      </div>

      <PanelCard
        title="Runs"
        note="One row per source version. Click a run for what the database can and cannot say about it."
        flush
      >
        <DataTable
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

      <PanelCard title="Pipeline logs" flush>
        <StateBlock
          v-if="!logs.available"
          state="unrecorded"
          title="No log is kept"
          :message="logs.reason"
          :would-require="logs.wouldRequire"
        />
      </PanelCard>

      <SideDrawer
        :open="openRun !== null"
        :title="openRun?.version || 'Run'"
        :subtitle="openRun?.source"
        width="560px"
        @close="openRun = null"
      >
        <template v-if="openRun">
          <dl class="drawer-facts">
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
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-disabled);
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

.drawer-facts dt {
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-disabled);
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
