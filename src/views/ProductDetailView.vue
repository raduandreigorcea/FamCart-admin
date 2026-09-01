<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import StatTile from '../components/StatTile.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import CopyValue from '../components/CopyValue.vue'
import AppIcon from '../components/AppIcon.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { crumbOf, useLeafCrumb } from '../lib/breadcrumb'
import { fetchCatalogProduct, fetchLocalProducts, qualityLabel, qualityScore } from '../lib/data/products'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

// One catalog row, in full, plus the source record it came from and whether the
// app database has its own copy of the same product.
//
// That last panel is the point of this page. A product existing in both
// databases is normal and invisible everywhere else -- FamCart's own search
// dedupes the two before anyone sees them.

const route = useRoute()
const router = useRouter()

const productId = computed(() => String(route.params.productId ?? ''))

const product = useQuery((signal) => fetchCatalogProduct(productId.value, signal), {
  watch: [productId],
})

// The same product, looked for in the app database by name. Deliberately a
// separate query with its own failure: an app database that cannot answer must
// not take the catalog page down with it.
const twin = useQuery(
  (signal) =>
    product.data.value
      ? fetchLocalProducts({ query: product.data.value.name, limit: 10 }, signal)
      : Promise.resolve({ rows: [], total: 0, offset: 0 }),
  { watch: [() => product.data.value?.name] },
)

useLeafCrumb(() => crumbOf(productId.value, product.data.value, (p) => p.id, (p) => p.name))

const quality = computed(() => (product.data.value ? qualityScore(product.data.value) : null))
const errorInfo = computed(() => describeError(product.error.value))
</script>

<template>
  <div class="page">
    <StateBlock v-if="product.loading.value" state="loading" :lines="4" />

    <StateBlock
      v-else-if="product.error.value"
      state="error"
      :title="errorInfo.title"
      :message="errorInfo.detail"
    />

    <StateBlock
      v-else-if="!product.data.value"
      state="empty"
      title="No such product"
      message="Nothing in the catalog project has this id. It may have been removed by a re-import that reverted its run."
    >
      <template #action>
        <RouterLink to="/products" class="back">Back to products</RouterLink>
      </template>
    </StateBlock>

    <template v-else>
      <PageHeader
        :title="product.data.value.name"
        :description="product.data.value.maker || 'No brand recorded'"
        :fetched-at="product.fetchedAt.value"
        :busy="product.fetching.value"
        @refresh="product.refetch"
      >
        <template #tools>
          <StatusPill
            :tone="product.data.value.source === 'curated' ? 'accent' : 'idle'"
            :label="product.data.value.source"
          />
        </template>
      </PageHeader>

      <div class="grid">
        <div class="span-3">
          <StatTile
            label="Rank"
            :value="product.data.value.popularity"
            hint="base_weight + add_count"
          />
        </div>
        <div class="span-3">
          <StatTile
            label="Times added"
            :value="product.data.value.add_count"
            hint="Households that picked it"
          />
        </div>
        <div class="span-3">
          <StatTile
            label="Editorial weight"
            :value="product.data.value.base_weight"
            hint="Cold-start weight from the import"
          />
        </div>
        <div class="span-3">
          <StatTile
            label="Quality"
            :value="quality?.score ?? null"
            hint="Derived from completeness"
          />
        </div>
      </div>

      <div class="grid">
        <div class="span-7">
          <PanelCard title="Source record" note="Provenance, exactly as the importer wrote it." fill>
            <dl class="facts u-facts">
              <div>
                <dt>Source catalog</dt>
                <dd>{{ product.data.value.source }}</dd>
              </div>
              <div>
                <dt>Import run</dt>
                <dd>
                  <RouterLink
                    v-if="product.data.value.source_version"
                    :to="`/pipeline?version=${encodeURIComponent(product.data.value.source_version)}`"
                    class="link u-mono"
                  >{{ product.data.value.source_version }}</RouterLink>
                  <span v-else class="u-muted">Not from an import run</span>
                </dd>
              </div>
              <div>
                <dt>Upstream id</dt>
                <dd>
                  <CopyValue
                    v-if="product.data.value.source_ref"
                    :value="product.data.value.source_ref"
                    label="upstream id"
                  />
                  <span v-else class="u-muted">--</span>
                </dd>
              </div>
              <div>
                <dt>Barcode / GTIN</dt>
                <dd>
                  <CopyValue
                    v-if="product.data.value.barcode"
                    :value="product.data.value.barcode"
                    label="barcode"
                  />
                  <span v-else class="u-muted">None. This product cannot be scanned.</span>
                </dd>
              </div>
              <div>
                <dt>Markets</dt>
                <dd>
                  <span v-if="product.data.value.markets.length" class="markets">
                    <span v-for="m in product.data.value.markets" :key="m" class="markets__code">{{ m }}</span>
                  </span>
                  <span v-else class="u-muted">
                    Universal. An empty array means sold everywhere, not unknown.
                  </span>
                </dd>
              </div>
              <div>
                <dt>Row created</dt>
                <dd :title="formatDateTime(product.data.value.created_at)">
                  {{ formatRelative(product.data.value.created_at) }}
                </dd>
              </div>
              <div class="facts__wide">
                <dt>Search aliases</dt>
                <dd>
                  <span v-if="product.data.value.search_aliases" class="aliases">
                    {{ product.data.value.search_aliases }}
                  </span>
                  <span v-else class="u-muted">
                    None. This product is findable by its own name only, not by category.
                  </span>
                </dd>
              </div>
              <div class="facts__wide">
                <dt>Catalog row id</dt>
                <dd><CopyValue :value="product.data.value.id" label="row id" /></dd>
              </div>
            </dl>
          </PanelCard>
        </div>

        <div class="span-5">
          <PanelCard
            title="Quality breakdown"
            note="Derived from what the row contains. The importer's own scorer runs before the load and never reaches the database."
            fill
          >
            <ul class="bands">
              <li v-for="band in quality?.bands ?? []" :key="band.label" class="bands__row">
                <AppIcon
                  class="bands__icon"
                  :class="{ 'bands__icon--met': band.met }"
                  :name="band.met ? 'check' : 'circle'"
                  :size="13"
                />
                <span class="bands__label">{{ band.label }}</span>
                <span class="bands__score u-num">{{ band.earned }} / {{ band.possible }}</span>
              </li>
            </ul>
            <p class="bands__total">
              <span
                class="bands__figure"
                :class="`quality--${qualityLabel(quality?.score ?? 0)}`"
              >{{ quality?.score ?? 0 }}</span>
              <span class="bands__of">out of 100</span>
            </p>
          </PanelCard>
        </div>
      </div>

      <PanelCard
        title="The same product in the app database"
        note="One product can exist as an imported row here and a contributed or promoted row there. FamCart's search merges them; this does not."
        flush
      >
        <StateBlock
          v-if="twin.loading.value"
          state="loading"
          :lines="2"
          compact
        />
        <StateBlock
          v-else-if="twin.error.value"
          state="error"
          title="Could not check the app database"
          :message="twin.error.value.message"
          compact
        />
        <StateBlock
          v-else-if="!twin.data.value?.rows.length"
          state="empty"
          title="No matching row"
          message="No household has contributed this product, and it has not been promoted. The catalog row above is the only one."
          compact
        />
        <ul v-else class="twins">
          <li v-for="row in twin.data.value.rows" :key="row.id" class="twins__row">
            <span class="twins__name u-truncate">
              {{ row.name }}
              <span v-if="row.maker" class="twins__maker">{{ row.maker }}</span>
            </span>
            <StatusPill
              :tone="row.household_id ? 'idle' : 'good'"
              :label="row.household_id ? 'Household-scoped' : 'Promoted'"
              :dot="false"
            />
            <RouterLink v-if="row.household_id" :to="`/households/${row.household_id}`" class="link">
              {{ row.household_name || 'Household' }}
            </RouterLink>
            <span class="twins__meta u-num">
              {{ formatCount(row.add_count) }} add{{ row.add_count === 1 ? '' : 's' }}
            </span>
            <time class="twins__meta" :title="formatDateTime(row.created_at)">
              {{ formatRelative(row.created_at) }}
            </time>
          </li>
        </ul>
      </PanelCard>

      <p class="foot">
        <button type="button" class="foot__back" @click="router.back()">Back</button>
      </p>
    </template>
  </div>
</template>

<style scoped>
.facts {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-4);
}

.facts__wide {
  grid-column: 1 / -1;
}

.facts dd {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-primary);
  line-height: var(--leading-snug);
}

.aliases {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: var(--leading-normal);
  display: block;
  max-height: 6.5em;
  overflow-y: auto;
}

.markets {
  display: inline-flex;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.markets__code {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  background: var(--bg-hover);
  border-radius: var(--radius-xs);
  padding: 2px 5px;
  color: var(--text-secondary);
}

.bands {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.bands__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.bands__icon {
  color: var(--text-disabled);
}

.bands__icon--met {
  color: var(--status-good);
}

.bands__label {
  color: var(--text-secondary);
}

.bands__score {
  font-size: var(--text-xs);
  color: var(--text-disabled);
}

.bands__total {
  margin: var(--space-4) 0 0;
  padding-top: var(--space-3);
  border-top: var(--border-width-thin) solid var(--border-light);
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.bands__figure {
  font-size: var(--text-2xl);
  font-weight: var(--weight-bold);
  font-variant-numeric: tabular-nums;
}

.bands__of {
  font-size: var(--text-xs);
  color: var(--text-disabled);
}

.quality--strong { color: var(--status-good); }
.quality--fair { color: var(--warning-text); }
.quality--thin { color: var(--text-disabled); }

.twins {
  list-style: none;
  margin: 0;
  padding: 0;
}

.twins__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

.twins__row:last-child {
  border-bottom: none;
}

.twins__name {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.twins__maker,
.twins__meta {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  white-space: nowrap;
}

.link {
  color: var(--color-primary);
  text-decoration: none;
  font-size: var(--text-xs);
}

.link:hover {
  text-decoration: underline;
}

.foot {
  margin: 0;
}

.foot__back,
.back {
  background: none;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-sm);
  padding: 0.35rem var(--space-4);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
}

.foot__back:hover,
.back:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
