<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import TablePager from '../components/TablePager.vue'
import FilterBar from '../components/FilterBar.vue'
import StateBlock from '../components/StateBlock.vue'
import CopyValue from '../components/CopyValue.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import CatalogFormDialog from '../components/CatalogFormDialog.vue'
import CatalogFilterDrawer from '../components/CatalogFilterDrawer.vue'
import AppIcon from '../components/AppIcon.vue'
import { useQuery, describeError } from '../lib/useQuery'
import {
  catalogConfigured,
  fetchCatalogProducts,
  createCatalogProduct,
  updateCatalogProduct,
  deleteCatalogProduct,
  activeFilterCount,
  type CatalogProductRow,
  type CatalogDraft,
  type CatalogFilters,
} from '../lib/data/catalog'
import { retailerLabel } from '../lib/catalogVocab'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'
import type { Column } from '../lib/uiTypes'

// The reference catalog. Everything the app can suggest that no household typed.
//
// This is not the Catalog section that was removed. That one called thirteen
// RPCs the rebuilt project never had, and read a table under a name it no longer
// uses. This reads catalog_admin_products(), which exists, and writes through
// three functions that are gated on catalog_is_admin().

const configured = catalogConfigured()

const LIMIT = 25

const query = ref('')
const offset = ref(0)

// Every filter in one object rather than a ref each. It is what gets spread into
// the request, counted for the button, drawn as chips and cleared as a unit, so
// splitting it apart would mean writing all four of those out longhand.
//
// TYPE IS ONE OF THEM. It used to be a segmented control above the table with no
// chip, no place in the count and no response to Clear all, so "2 filters" could
// sit over a table narrowed by three things. It is a select in the drawer beside
// Market and Category now, and it is not special in any way here.
const filters = ref<CatalogFilters>({})
const filtersOpen = ref(false)

// Any filter change returns to the first page: page 4 of a search is not page 4
// of the next one. Same rule as Contributed, and not useTableState for the same
// reason -- catalog_admin_products orders by popularity then name inside the
// function, so a sort control would report a change the server ignores.
//
// `filters` is deep-watched because the drawer replaces the object, and the
// pager has to reset for a narrowing exactly as it does for a search -- filter
// to eleven rows while sitting on page 4 and every one of them is off the end.
watch([query, filters], () => {
  offset.value = 0
}, { deep: true })

const products = useQuery(
  (signal) =>
    fetchCatalogProducts(
      { ...filters.value, query: query.value, limit: LIMIT, offset: offset.value },
      signal,
    ),
  { watch: [query, filters, offset], enabled: () => configured },
)

const activeCount = computed(() => activeFilterCount(filters.value))

// ─── the chips ───────────────────────────────────────────────────────────────
// What is set, said in words, outside the drawer that set it.
//
// The drawer is the only place a filter can be CHOSEN and it is closed most of
// the time, so without these the page would be narrowed with nothing on screen
// saying so -- and a filtered table looks exactly like a thin catalog. The count
// on the button says how many; these say which, and each one removes itself.
const ADDED_LABELS: Record<number, string> = {
  1: 'last 24 hours',
  7: 'last 7 days',
  30: 'last 30 days',
  90: 'last 90 days',
  365: 'last year',
}

/** A tri-state reads as a phrase, not as "hasBrand: false". */
function has(label: string, value: boolean): string {
  return value ? `Has ${label}` : `No ${label}`
}

const chips = computed<{ key: keyof CatalogFilters; label: string }[]>(() => {
  const f = filters.value
  const out: { key: keyof CatalogFilters; label: string }[] = []

  if (f.retailer) out.push({ key: 'retailer', label: `Shop: ${retailerLabel(f.retailer)}` })
  if (f.category) out.push({ key: 'category', label: `Category: ${f.category}` })
  if (f.hasBarcode != null) out.push({ key: 'hasBarcode', label: has('barcode', f.hasBarcode) })
  if (f.hasBrand != null) out.push({ key: 'hasBrand', label: has('brand', f.hasBrand) })
  if (f.hasListing != null) {
    out.push({ key: 'hasListing', label: f.hasListing ? 'Listed somewhere' : 'Listed nowhere' })
  }
  if (f.available != null) {
    out.push({ key: 'available', label: f.available ? 'In stock' : 'Out of stock everywhere' })
  }
  if (f.hasImage != null) out.push({ key: 'hasImage', label: has('image', f.hasImage) })
  if (f.hasQuantity != null) out.push({ key: 'hasQuantity', label: has('size', f.hasQuantity) })
  if (f.earned != null) {
    out.push({ key: 'earned', label: f.earned ? 'Added by households' : 'Never added' })
  }
  if (f.addedWithinDays != null) {
    out.push({
      key: 'addedWithinDays',
      label: `Added: ${ADDED_LABELS[f.addedWithinDays] ?? `last ${f.addedWithinDays} days`}`,
    })
  }

  return out
})

// Deleted rather than set to null. Both read as "not asked" everywhere that
// matters -- the request sends null either way and activeFilterCount ignores
// both -- so this is only to keep the object saying what it means when it is
// logged or compared.
function clearFilter(key: keyof CatalogFilters) {
  const next = { ...filters.value }
  delete next[key]
  filters.value = next
}

function clearFilters() {
  filters.value = {}
}

const rows = computed(() => products.data.value?.rows ?? [])
const total = computed(() => products.data.value?.total ?? 0)
/** Nothing has answered yet, so `total` is a placeholder rather than a count. */
const countUnknown = computed(() => products.data.value === null)
const error = computed(() => (products.error.value ? describeError(products.error.value).detail : ''))

// Brand is no longer a column of its own. On a catalog that is mostly generics
// -- a banana has no brand, and that is correct rather than missing -- it was a
// column of dashes wide enough to read as a fault. It rides under the name now,
// which is also how the app itself draws a product: name, then maker beneath.
//
// Aliases likewise. The count answered a question nobody was asking often enough
// to spend 7% of the width on; it is in the name cell's title, where it is one
// hover away from whoever wants it.
//
// The actions column is 14% and not the 11% it started at. Two buttons need
// 142px between them and 11% was handing the cell 135 at a 1536px window and
// less as it narrowed, so `Remove` was clipped by the panel edge on a full
// desktop -- fixed layout will not let a cell grow, so the content simply spilled
// and the wrapper picked up a few pixels of scroll. The three per cent comes off
// Product, which had the most to spare.
const columns: Column<CatalogProductRow>[] = [
  { key: 'canonical_name', label: 'Product', width: '32%' },
  // Which shops carry it. This one column replaced Type, Record and Source at
  // once, because all three described a catalog of imported concepts: there is
  // no generic/commercial split any more, no completeness grade, and provenance
  // IS the shop.
  //
  // Three pills and a +N measure 142px with the cell's padding and no longer
  // shrink (see .mk__code), so the floor stays.
  { key: 'retailers', label: 'Shops', width: '18%', minPx: 142 },
  { key: 'min_price', label: 'From', numeric: true, width: '10%', hideBelow: 1400 },
  { key: 'popularity', label: 'Popularity', numeric: true, width: '12%' },
  // 9%, because at 8 the column is 63px inside its padding and "4 days ago"
  // needs 66 -- so it wrapped to two lines in the 1400 to 1450 band and nowhere
  // else, which is the most confusing kind of layout bug to be told about.
  { key: 'first_seen_at', label: 'First seen', width: '10%', hideBelow: 1100 },
  // 15%, and a floor of 80.
  //
  // The floor is the ICON pair (72px plus the cell's own padding), because below
  // 1400 the labels are hidden and that is the only state a narrow table has to
  // hold. Sizing it for the labels instead is what made this table wider than
  // its panel between 1100 and 1260.
  //
  // The 15% is for the other state. Labelled, the pair needs 155px with padding,
  // and 14% of the narrowest panel that ever shows labels (1099px at a 1401px
  // window) is 154 -- one pixel short, which is how `Remove` gets clipped again.
  // The point came off Product, which had the most to spare.
  { key: 'actions', label: '', width: '18%', align: 'right', minPx: 80 },
]

// ─── how popularity is drawn ─────────────────────────────────────────────────
// NOT a proportional bar, which is what this was first. The page is ordered by
// popularity descending, so every row on it sits within a few points of the
// page's own maximum: scaling to that maximum drew twenty-five bars at 98, 99
// and 100 per cent. A bar that promises a comparison and shows none is worse
// than the bare number it replaced, and no other denominator is available --
// the RPC returns a page, not the catalog's maximum, and a fixed ceiling would
// be wrong the first time a product passed it.
//
// So the split instead, which is self-contained per row and is the interesting
// part anyway: how much of this number was set by hand and how much was earned
// by households actually adding the thing.
function earned(row: CatalogProductRow): string {
  if (row.add_count === 0) return `${row.listing_count} shop${row.listing_count === 1 ? '' : 's'}`
  return `${row.add_count} earned`
}

// Three, then a count. There are only three shops today, so the overflow never
// fires -- it is here because a fourth is one line in a registry, and a cell
// that wraps the day somebody adds one is a worse discovery than a +1.
const RETAILERS_SHOWN = 3

// What the name cell says on hover, which is where the two counts that lost
// their columns went.
function nameTitle(row: CatalogProductRow): string {
  const bits = [row.canonical_name]
  if (row.barcodes.length > 1) bits.push(`${row.barcodes.length} barcodes`)
  if (row.listing_count > 0) {
    bits.push(`${row.listing_count} listing${row.listing_count === 1 ? '' : 's'}`)
  }
  // The identity the dedupe rule actually used. Two rows that look like the same
  // product are only ever explicable by comparing these.
  bits.push(row.merge_key)
  return bits.join(' · ')
}

// ─── writing ─────────────────────────────────────────────────────────────────
const editing = ref<CatalogProductRow | null>(null)
const formOpen = ref(false)
const removing = ref<CatalogProductRow | null>(null)
const writing = ref(false)
const writeError = ref('')

function add() {
  editing.value = null
  writeError.value = ''
  formOpen.value = true
}

function edit(row: CatalogProductRow) {
  editing.value = row
  writeError.value = ''
  formOpen.value = true
}

function closeForm() {
  if (writing.value) return
  formOpen.value = false
  editing.value = null
  writeError.value = ''
}

async function run(work: (signal: AbortSignal) => Promise<unknown>, done: () => void) {
  writing.value = true
  writeError.value = ''
  try {
    await work(new AbortController().signal)
    done()
    await products.refetch()
  } catch (err) {
    writeError.value = describeError(err as Error).detail
  } finally {
    writing.value = false
  }
}

function submitForm(draft: CatalogDraft) {
  const row = editing.value
  void run(
    (signal) =>
      row ? updateCatalogProduct(row.id, draft, signal) : createCatalogProduct(draft, signal),
    () => {
      formOpen.value = false
      editing.value = null
    },
  )
}

function confirmRemove() {
  const row = removing.value
  if (!row) return
  void run(
    (signal) => deleteCatalogProduct(row.id, signal),
    () => {
      removing.value = null
    },
  )
}

// Spelled out rather than summarised. This project is shared live by production
// and development, so the blast radius of one click here is every household of
// both, and the aliases are how the product is findable in five languages it is
// not named in.
const removalMessage = computed(() => {
  const row = removing.value
  if (!row) return ''
  const parts = [
    'This is the shared reference catalog, so it disappears for every household of production and development at once.',
  ]
  if (row.listing_count > 0) {
    parts.push(
      `Every shop's listing of it goes too -- ${row.listing_count} of them, with their prices. The next scrape will simply create it again, which is usually the right answer to a wrong row.`,
    )
  }
  if (row.barcodes.length > 0) {
    parts.push('Scanning its barcode will stop resolving.')
  }
  if (row.add_count > 0) {
    parts.push(`It has been added ${row.add_count} time${row.add_count === 1 ? '' : 's'}.`)
  }
  return parts.join(' ')
})
</script>

<template>
  <div class="page">
    <PageHeader
      title="Catalog"
      description="The reference products the app ships and discovers. Shared live by production and development."
      :fetched-at="products.fetchedAt.value"
      :busy="products.fetching.value"
      @refresh="products.refetch()"
    >
      <template #tools>
        <button v-if="configured" type="button" class="u-btn" @click="add">Add product</button>
      </template>
    </PageHeader>

    <StateBlock
      v-if="!configured"
      state="empty"
      title="The catalog project is not configured"
      message="Set VITE_CATALOG_SUPABASE_URL and VITE_CATALOG_SUPABASE_ANON_KEY to read it. Every other section is unaffected."
    />

    <PanelCard v-else flush>
      <div class="u-toolbar">
        <FilterBar
          v-model="query"
          placeholder="Search names and aliases, or paste a barcode"
          :busy="products.fetching.value"
        >
          <button
            type="button"
            class="u-btn u-btn--ghost filters-btn"
            :class="{ 'filters-btn--on': activeCount > 0 }"
            :aria-expanded="filtersOpen"
            @click="filtersOpen = true"
          >
            <AppIcon name="list-filter" :size="13" />
            Filters
            <span v-if="activeCount > 0" class="filters-btn__count u-num">{{ activeCount }}</span>
          </button>

          <template #end>
            <!-- Withheld until it is known rather than shown as a zero, which
                 would read as "nothing matched" during the first fetch. See the
                 note in TablePager. -->
            <span v-if="!countUnknown" class="u-toolbar__count u-num">
              {{ formatCount(total) }} products
            </span>
          </template>
        </FilterBar>

        <!-- What is narrowing the table, said outside the drawer that set it. A
             filtered catalog and a thin one look identical otherwise. -->
        <div v-if="chips.length" class="chips">
          <button
            v-for="chip in chips"
            :key="chip.key"
            type="button"
            class="chips__item"
            :title="`Remove this filter`"
            @click="clearFilter(chip.key)"
          >
            {{ chip.label }}
            <AppIcon name="x" :size="11" />
            <span class="u-sr">Remove filter</span>
          </button>
          <button type="button" class="chips__clear" @click="clearFilters">Clear all</button>
        </div>
      </div>

      <DataTable
        :columns="columns"
        :rows="rows"
        row-key="id"
        :loading="products.loading.value"
        :error="error"
        empty-title="No products"
        empty-message="Nothing in the reference catalog matches that."
      >
        <!-- Name over brand, the way the app draws a product in its own
             suggestion list. The barcode sits with them rather than in the
             actions cell, because it identifies the product and does not act
             on it. -->
        <template #cell-canonical_name="{ row }">
          <span class="prod" :title="nameTitle(row)">
            <span class="prod__name u-truncate">{{ row.canonical_name }}</span>
            <span class="prod__meta">
              <span v-if="row.brand" class="prod__brand u-truncate">{{ row.brand }}</span>
              <CopyValue
                v-if="row.barcodes.length"
                :value="row.barcodes[0]"
                label="barcode"
                class="prod__code"
              />
              <span v-if="!row.brand && !row.barcodes.length && row.category" class="prod__brand u-truncate">
                {{ row.category }}
              </span>
            </span>
          </span>
        </template>
        <!-- Empty means no shop currently lists it: created here by hand, or
             dropped by every shop. Neither is deleted, and the next scrape may
             put it back. -->
        <template #cell-retailers="{ row }">
          <span v-if="row.retailers.length" class="mk">
            <span v-for="code in row.retailers.slice(0, RETAILERS_SHOWN)" :key="code" class="mk__code">
              {{ code }}
            </span>
            <span
              v-if="row.retailers.length > RETAILERS_SHOWN"
              class="mk__more"
              :title="row.retailers.join(' ')"
            >+{{ row.retailers.length - RETAILERS_SHOWN }}</span>
          </span>
          <span
            v-else
            class="u-muted"
            title="No shop currently lists it. Not deleted -- the next scrape may bring it back."
          >--</span>
        </template>
        <!-- Cheapest across the shops that have it IN STOCK. Empty when nobody
             does, or when the shops carrying it publish no price: Lidl does
             exactly that for anything out of stock. -->
        <template #cell-min_price="{ row }">
          <span v-if="row.min_price != null">{{ row.min_price }} {{ row.currency }}</span>
          <span v-else class="u-muted">--</span>
        </template>
        <!-- The number, and where it came from. See `earned`. -->
        <template #cell-popularity="{ row }">
          <span
            class="pop"
            :title="`${row.listing_count} shop listing(s) x 5 + ${row.add_count} adds`"
          >
            <span class="pop__num u-num">{{ row.popularity }}</span>
            <span class="pop__split" :class="{ 'pop__split--earned': row.add_count > 0 }">
              {{ earned(row) }}
            </span>
          </span>
        </template>
        <template #cell-first_seen_at="{ row }">
          <span class="u-muted" :title="formatDateTime(String(row.first_seen_at))">
            {{ formatRelative(String(row.first_seen_at)) }}
          </span>
        </template>
        <template #cell-actions="{ row }">
          <!-- The labels are hidden rather than dropped below 1400: see
               .u-row-actions. `title` says the same word on hover, so nobody
               loses it. -->
          <span class="u-row-actions">
            <button type="button" class="u-btn" title="Edit" @click="edit(row)">
              <span class="u-btn__icon"><AppIcon name="square-pen" :size="14" /></span>
              <span class="u-btn__label">Edit</span>
            </button>
            <button
              type="button"
              class="u-btn u-btn--danger"
              title="Remove"
              @click="removing = row"
            >
              <span class="u-btn__icon"><AppIcon name="trash-2" :size="14" /></span>
              <span class="u-btn__label">Remove</span>
            </button>
          </span>
        </template>
      </DataTable>

      <template #footer>
        <TablePager
          :total="total"
          :offset="offset"
          :limit="LIMIT"
          :loading="products.fetching.value"
          @go="offset = $event"
        />
      </template>
    </PanelCard>

    <CatalogFilterDrawer
      v-model="filters"
      :open="filtersOpen"
      @close="filtersOpen = false"
    />

    <CatalogFormDialog
      :open="formOpen"
      :product="editing"
      :busy="writing"
      :error="writeError"
      @submit="submitForm"
      @cancel="closeForm"
    />

    <ConfirmDialog
      :open="removing !== null"
      :title="`Remove ${removing?.canonical_name ?? 'product'}?`"
      :message="removalMessage"
      confirm-label="Remove"
      tone="danger"
      :busy="writing"
      :error="writeError"
      @confirm="confirmRemove"
      @cancel="writing || ((removing = null), (writeError = ''))"
    />
  </div>
</template>

<style scoped>
/* ─── the filter button and its chips ────────────────────────────────────────
   The button carries a count rather than only a highlight, because "some
   filters are on" is not the useful fact -- "three are on and here they are" is,
   and the chips below say which. */
.filters-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.filters-btn--on {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.filters-btn__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 var(--space-1);
  border-radius: var(--radius-pill);
  background: var(--color-primary);
  color: var(--text-inverse);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  line-height: 1;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

/* The whole chip removes its filter, rather than a small × inside it. There is
   nothing else a chip could do, so a target the size of the label is right and
   a 11px hit area beside it would be wrong. */
.chips__item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 24px;
  padding: 0 var(--space-2);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-pill);
  background: var(--bg-surface-alt);
  color: var(--text-secondary);
  font-size: var(--text-2xs);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-standard),
    border-color var(--transition-fast) var(--ease-standard);
}

.chips__item:hover {
  color: var(--danger-text);
  border-color: var(--danger-border);
}

.chips__clear {
  border: none;
  background: none;
  padding: 0 var(--space-1);
  color: var(--text-disabled);
  font-size: var(--text-2xs);
  cursor: pointer;
}

.chips__clear:hover {
  color: var(--text-primary);
  text-decoration: underline;
}

/* ─── the product cell ───────────────────────────────────────────────────────
   Two lines, and the second only appears when there is something to put on it,
   so a bare generic is one line rather than a line and a gap. */
.prod {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.prod__name {
  color: var(--text-primary);
}

.prod__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.prod__meta:empty {
  display: none;
}

.prod__brand {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.prod__code {
  font-size: var(--text-xs);
  color: var(--text-disabled);
}

/* ─── the completeness tier ──────────────────────────────────────────────────
   A letter, not a word: three states in a 7% column, and the letter is what the
   catalog itself calls them. Tinted rather than told apart by colour alone --
   the glyph is the value. */
.tier {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.4rem;
  height: 1.4rem;
  border-radius: var(--radius-sm);
  border: var(--border-width-thin) solid var(--border-main);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  color: var(--text-secondary);
  background: var(--bg-surface);
}

.tier--a {
  border-color: color-mix(in srgb, var(--color-primary) 45%, transparent);
  background: color-mix(in srgb, var(--color-primary) 12%, var(--bg-surface));
  color: var(--color-primary);
}

.tier--c {
  color: var(--text-disabled);
}

/* ─── markets ────────────────────────────────────────────────────────────────
   Codes as chips rather than a space-joined string, which read as one long word
   and wrapped mid-country. Three, then a count: a ninth chip is not information
   at this width, it is a cell that grows. */
.mk {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: nowrap;
}

/* A market code is two letters and must stay two letters on one line.
 *
 * `.table td` sets `overflow-wrap: anywhere`, which exists for the barcodes and
 * Clerk ids that would otherwise paint across the next column -- and it also
 * changes the automatic minimum size of every flex item inside the cell to ONE
 * CHARACTER. So when the column got tight these pills did not stop shrinking at
 * their own width; they shrank to a letter and stacked R over O. Saying `normal`
 * here puts their minimum back to the whole token, and the column's minPx is
 * what keeps the room for them. */
.mk__code,
.mk__more {
  overflow-wrap: normal;
  white-space: nowrap;
  padding: 0 var(--space-1-5);
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  line-height: 1.6;
}

.mk__more {
  background: none;
  color: var(--text-disabled);
}

/* ─── provenance ─────────────────────────────────────────────────────────────
   Usually one pill. Two means a row an upstream source and a person both
   asserted, which is worth seeing rather than collapsing. */
.src {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-wrap: wrap;
}

/* ─── popularity ─────────────────────────────────────────────────────────────
   The number keeps the column's alignment; the bar underneath gives it a scale.
   Deliberately quiet -- it is a comparison aid, not the point of the row. */
.pop {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-1);
  width: 100%;
}

.pop__num {
  font-size: var(--text-sm);
  color: var(--text-primary);
}

/* Quiet by default: most rows are editorial and saying so twenty-five times is
   noise. A row with real adds is the one worth noticing, so only that one takes
   any colour. */
.pop__split {
  font-size: var(--text-xs);
  color: var(--text-disabled);
  white-space: nowrap;
}

.pop__split--earned {
  color: var(--color-primary);
}
</style>
