<script setup lang="ts">
import type { PropType } from 'vue'
import SideDrawer from './SideDrawer.vue'
import SelectField from './SelectField.vue'
import SegmentedControl from './SegmentedControl.vue'
import type { CatalogFilters, CatalogProductType } from '../lib/data/catalog'
import {
  MARKETS, MARKET_NAMES, CATEGORIES, LANGS, LANG_NAMES, SOURCES, TIERS, sourceLabel,
} from '../lib/catalogVocab'

// Every way to narrow the reference catalog, in a drawer rather than in the
// filter row.
//
// WHY A DRAWER. Twelve controls do not fit on one line, and the versions that
// try are worse than either extreme: wrapped onto three rows they push the table
// below the fold on the page whose whole job is the table, and split between
// "some inline, the rest behind a button" they make finding one control a
// question of remembering which half it was in. So all of them are here -- the
// product type included, which used to be a segmented control above the table
// answering to nothing else on the page -- and the filter row keeps a button, a
// count, and the chips for whatever is set.
//
// WHY IT APPLIES LIVE. There is no Apply button and no local draft. A draft
// would need Cancel to mean "put back what was there", which is a second copy of
// the filter state maintained for the benefit of a button nobody asked for. The
// table is behind the scrim and its count is visible above it, so a change shows
// its own result; closing the drawer is not a commit and Escape is not an undo.
//
// WHY THE TRI-STATES ARE THREE BUTTONS RATHER THAN A CHECKBOX. A checkbox has
// two states and these questions have three. "Products with a barcode" and
// "products without one" are both things somebody comes here to find -- the
// second more often, since it is how you find the rows discovery admitted before
// the gate required both a brand and a code -- and a checkbox can only offer one
// of them.

const props = defineProps({
  open: { type: Boolean, default: false },
  modelValue: { type: Object as PropType<CatalogFilters>, required: true },
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: CatalogFilters): void
  (e: 'close'): void
}>()

function set<K extends keyof CatalogFilters>(key: K, value: CatalogFilters[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

// ─── the tri-states ──────────────────────────────────────────────────────────
// null is the wire value for "do not ask" and the empty string is what a
// SegmentedControl carries, so the two are converted at this boundary and
// nowhere else. Same distinction SelectField draws for its own "no filter".
const TRI = [
  { value: 'any', label: 'Any' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
]

function triValue(v: boolean | null | undefined): string {
  return v == null ? 'any' : v ? 'yes' : 'no'
}

function triSet(key: keyof CatalogFilters, raw: string) {
  set(key, (raw === 'any' ? null : raw === 'yes') as CatalogFilters[keyof CatalogFilters])
}

/**
 * The tri-states, and what each one is actually asking. The titles matter more
 * than usual here: "Brand: No" over a catalog that is mostly generics reads as
 * a fault unless you know a brandless banana is correct.
 */
const FLAGS: { key: keyof CatalogFilters; label: string; title: string }[] = [
  {
    key: 'hasBarcode',
    label: 'Barcode',
    title: 'A GTIN in catalog_identifiers. A generic has none and that is correct; a commercial product without one cannot be merged on anything but its name.',
  },
  {
    key: 'hasBrand',
    label: 'Brand',
    title: 'A maker. No is ordinary for a generic and is the shape worth finding among commercial products.',
  },
  {
    key: 'hasMarket',
    label: 'Market',
    title: 'Whether anywhere is recorded as selling it. An empty market list means unknown, not sold nowhere, which is why this is not a twelfth country.',
  },
  {
    key: 'hasImage',
    label: 'Image',
    title: 'A picture the source published.',
  },
  {
    key: 'hasQuantity',
    label: 'Size',
    title: 'A package size the source stated. Never inferred from the name, so its absence is honest rather than lazy.',
  },
]

// ─── the value selects ───────────────────────────────────────────────────────
// Each list is a check constraint in the catalog project restated in
// TypeScript; catalogVocab.ts holds all of them and says why.
// A generic is a shopping concept -- Milk, Bananas -- with no brand and no
// barcode, none of which makes it incomplete; a commercial product is one off a
// shelf, identified by both. The distinction is why the tri-states below cannot
// be read as quality on their own, which is what the hint under them says.
const typeOptions = [
  { value: null, label: 'Any type' },
  { value: 'generic', label: 'Generic' },
  { value: 'commercial', label: 'Commercial' },
]

const marketOptions = [
  { value: null, label: 'Any market' },
  ...MARKETS.map((code) => ({ value: code, label: `${MARKET_NAMES[code] ?? code} (${code})` })),
]

const tierOptions = [
  { value: null, label: 'Any record' },
  ...TIERS.map((t) => ({ value: t, label: `Tier ${t}` })),
]

const categoryOptions = [
  { value: null, label: 'Any category' },
  ...CATEGORIES.map((c) => ({ value: c, label: c })),
]

const sourceOptions = [
  { value: null, label: 'Any source' },
  ...SOURCES.map((s) => ({ value: s, label: sourceLabel(s) })),
]

const langOptions = [
  { value: null, label: 'Any language' },
  ...LANGS.map((l) => ({ value: l, label: `${LANG_NAMES[l] ?? l} (${l})` })),
]

// Relative rather than a date picker. Every question anybody actually has of
// this column is "what has arrived lately", and a picker would ask for two
// dates to answer it.
const ADDED_OPTIONS = [
  { value: null, label: 'Any time' },
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
]

const EARNED_OPTIONS = [
  { value: null, label: 'Any popularity' },
  { value: 'yes', label: 'Households have added it' },
  { value: 'no', label: 'Editorial weight only' },
]
</script>

<template>
  <SideDrawer
    :open="open"
    title="Filters"
    subtitle="Narrows the whole catalog, not the page you are looking at."
    width="420px"
    @close="emit('close')"
  >
    <div class="cfd">
      <section class="cfd__group">
        <h3 class="u-caption cfd__legend">What it is</h3>
        <SelectField
          label="Type"
          :model-value="modelValue.type ?? null"
          :options="typeOptions"
          @update:model-value="set('type', $event as CatalogProductType | null)"
        />
        <SelectField
          label="Market"
          :model-value="modelValue.market ?? null"
          :options="marketOptions"
          @update:model-value="set('market', $event)"
        />
        <SelectField
          label="Record"
          :model-value="modelValue.tier ?? null"
          :options="tierOptions"
          @update:model-value="set('tier', $event)"
        />
        <SelectField
          label="Category"
          :model-value="modelValue.category ?? null"
          :options="categoryOptions"
          @update:model-value="set('category', $event)"
        />
        <SelectField
          label="Source"
          :model-value="modelValue.source ?? null"
          :options="sourceOptions"
          @update:model-value="set('source', $event)"
        />
        <SelectField
          label="Language"
          :model-value="modelValue.lang ?? null"
          :options="langOptions"
          @update:model-value="set('lang', $event)"
        />
      </section>

      <section class="cfd__group">
        <h3 class="u-caption cfd__legend">What it has</h3>
        <p class="cfd__hint">
          Missing is not the same as wrong. A generic with no brand and no barcode
          is a complete record; a commercial one with neither cannot be identified.
        </p>
        <div v-for="flag in FLAGS" :key="flag.key" class="cfd__flag" :title="flag.title">
          <SegmentedControl
            :label="flag.label"
            :segments="TRI"
            :model-value="triValue(modelValue[flag.key] as boolean | null)"
            @update:model-value="triSet(flag.key, $event)"
          />
        </div>
      </section>

      <section class="cfd__group">
        <h3 class="u-caption cfd__legend">How it got here</h3>
        <SelectField
          label="Popularity"
          :model-value="modelValue.earned == null ? null : modelValue.earned ? 'yes' : 'no'"
          :options="EARNED_OPTIONS"
          @update:model-value="set('earned', $event === null ? null : $event === 'yes')"
        />
        <SelectField
          label="Added"
          :model-value="modelValue.addedWithinDays != null ? String(modelValue.addedWithinDays) : null"
          :options="ADDED_OPTIONS"
          @update:model-value="set('addedWithinDays', $event === null ? null : Number($event))"
        />
      </section>
    </div>
  </SideDrawer>
</template>

<style scoped>
.cfd {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.cfd__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* The shared caption style carries the type; only the margin is local. See
   designSystem.test.ts, which fails on a hand-written copy of it. */
.cfd__legend {
  margin: 0;
}

.cfd__hint {
  margin: 0;
  font-size: var(--text-2xs);
  line-height: 1.5;
  color: var(--text-secondary);
}

/* Label left, control right, so five stacked tri-states line up as a column of
   choices rather than five differently-indented sentences. SelectField and
   SegmentedControl already agree on their label; this spreads the pair. */
.cfd__flag :deep(.seg-field),
.cfd__group :deep(.field) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.cfd__group :deep(.field__select) {
  flex: 1;
  min-width: 0;
  max-width: 60%;
}
</style>
