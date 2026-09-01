<script setup lang="ts">
import { computed, ref, watch, type PropType } from 'vue'
import { useModal } from '../lib/useModal'
import type { CatalogProductRow, CatalogProductType } from '../lib/data/catalog'

// Adding and correcting a reference product.
//
// Separate from ProductFormDialog rather than one dialog with a mode, because
// the two tables genuinely differ: this one has a product type, a name language
// and a market list, and none of those exist on the app database's rows. A
// single dialog would have been a form where half the fields were conditional on
// which database it was pointed at, which is the shape that hides a bug.
//
// WHAT IT WILL NOT LET YOU SET
//
// add_count, for the reason it is unwritable everywhere: it is earned usage and
// half of the generated popularity column, and bump_product_popularity() is the
// only thing entitled to move it.
//
// Aliases. A product's names in six languages are derived and imported, and a
// text box here would be a fourth writer competing with the seed, discovery and
// the import RPC. Editing the canonical name is enough to be useful; editing the
// alias set is a different feature with a different shape.

const LANGS = ['en', 'de', 'es', 'ro', 'fr', 'it']

// The eleven the check constraint accepts, which are the eleven src/lib/region.ts
// can emit. A code outside this list matches no product at all and looks exactly
// like a ranking bug.
const MARKETS = ['RO', 'MD', 'DE', 'AT', 'CH', 'ES', 'FR', 'BE', 'IT', 'GB', 'IE']

const props = defineProps({
  open: { type: Boolean, default: false },
  product: { type: Object as PropType<CatalogProductRow | null>, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits<{
  (e: 'submit', value: {
    name: string
    type: CatalogProductType
    lang: string
    brand: string | null
    category: string | null
    markets: string[]
    barcode: string | null
    baseWeight: number | null
  }): void
  (e: 'cancel'): void
}>()

const panel = ref<HTMLElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)

const name = ref('')
const type = ref<CatalogProductType>('generic')
const lang = ref('en')
const brand = ref('')
const category = ref('')
const markets = ref<string[]>([])
const barcode = ref('')
const baseWeight = ref('')

const editing = computed(() => props.product !== null)

// Reset from the row on every open, not on mount: the component stays alive
// between openings, so without this the second edit shows the first one's values.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    const p = props.product
    name.value = p?.canonical_name ?? ''
    type.value = p?.product_type ?? 'generic'
    lang.value = p?.name_lang ?? 'en'
    brand.value = p?.brand ?? ''
    category.value = p?.category ?? ''
    markets.value = [...(p?.markets ?? [])]
    barcode.value = p?.barcodes[0] ?? ''
    baseWeight.value = p ? String(p.base_weight) : ''
  },
  { immediate: true },
)

function toggleMarket(code: string) {
  markets.value = markets.value.includes(code)
    ? markets.value.filter((m) => m !== code)
    : [...markets.value, code]
}

const submittable = computed(() => name.value.trim().length > 0 && !props.busy)

function submit() {
  if (!submittable.value) return
  emit('submit', {
    name: name.value.trim(),
    type: type.value,
    lang: lang.value,
    brand: brand.value.trim() || null,
    category: category.value.trim() || null,
    markets: markets.value,
    // The barcode is only ever set on a create. Changing an identifier on an
    // existing product is a different operation from correcting its name, and
    // the update RPC does not accept one: a scan resolves through that value and
    // nowhere else, so moving it silently would send every scan of that code to
    // a different product.
    barcode: editing.value ? null : barcode.value.trim() || null,
    baseWeight: Number(baseWeight.value.trim() || '0'),
  })
}

useModal({
  open: () => props.open,
  close: () => emit('cancel'),
  panel,
  initialFocus: () => nameInput.value,
  dismissible: () => !props.busy,
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cf">
      <div class="cf__scrim" @click="busy || emit('cancel')"></div>

      <div
        ref="panel"
        class="cf__panel"
        role="dialog"
        aria-modal="true"
        :aria-label="editing ? 'Edit catalog product' : 'Add catalog product'"
        tabindex="-1"
      >
        <h2 class="cf__title">{{ editing ? 'Edit catalog product' : 'Add catalog product' }}</h2>
        <p class="cf__note">
          The shared reference catalog. Production and development read it at the same time.
        </p>

        <form class="cf__form" @submit.prevent="submit">
          <label class="cf__field">
            <span class="cf__label">Name</span>
            <input
              ref="nameInput"
              v-model="name"
              class="cf__input"
              type="text"
              maxlength="120"
              required
              :disabled="busy"
            />
          </label>

          <div class="cf__row">
            <label class="cf__field cf__field--grow">
              <span class="cf__label">Type</span>
              <select v-model="type" class="cf__input" :disabled="busy">
                <option value="generic">Generic — a concept, no brand</option>
                <option value="commercial">Commercial — off a shelf</option>
              </select>
            </label>

            <label class="cf__field">
              <span class="cf__label">Name language</span>
              <select v-model="lang" class="cf__input" :disabled="busy">
                <option v-for="code in LANGS" :key="code" :value="code">{{ code }}</option>
              </select>
            </label>
          </div>

          <label class="cf__field">
            <span class="cf__label">Brand</span>
            <input v-model="brand" class="cf__input" type="text" maxlength="60" :disabled="busy" />
            <span class="cf__hint">Null is ordinary. A banana has no brand.</span>
          </label>

          <label class="cf__field">
            <span class="cf__label">Category</span>
            <input v-model="category" class="cf__input" type="text" :disabled="busy" />
          </label>

          <fieldset class="cf__field cf__markets" :disabled="busy">
            <legend class="cf__label">Markets</legend>
            <div class="cf__chips">
              <button
                v-for="code in MARKETS"
                :key="code"
                type="button"
                class="cf__chip"
                :class="{ 'cf__chip--on': markets.includes(code) }"
                :aria-pressed="markets.includes(code)"
                @click="toggleMarket(code)"
              >{{ code }}</button>
            </div>
            <span class="cf__hint">
              A relevance signal, not a filter: a product from the next country is still
              suggested, just lower. Empty means unknown, which is not the same as sold nowhere.
            </span>
          </fieldset>

          <!-- Create only. See the note in submit(). -->
          <label v-if="!editing" class="cf__field">
            <span class="cf__label">Barcode</span>
            <input v-model="barcode" class="cf__input" type="text" inputmode="numeric" :disabled="busy" />
            <span class="cf__hint">8 to 14 digits. A scan resolves through this and nothing else.</span>
          </label>

          <label class="cf__field">
            <span class="cf__label">Base weight</span>
            <input v-model="baseWeight" class="cf__input" type="number" min="0" :disabled="busy" />
            <span class="cf__hint">
              The editorial thumb on the scale. Real adds are counted separately and cannot be
              set from here.
            </span>
          </label>

          <p v-if="error" class="cf__error">{{ error }}</p>

          <div class="cf__actions">
            <button type="button" class="cf__btn cf__btn--ghost" :disabled="busy" @click="emit('cancel')">
              Cancel
            </button>
            <button type="submit" class="cf__btn cf__btn--primary" :disabled="!submittable">
              {{ busy ? 'Saving…' : editing ? 'Save' : 'Add product' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cf {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: var(--space-4);
}

.cf__scrim {
  position: absolute;
  inset: 0;
  background: var(--scrim, rgba(15, 23, 42, 0.45));
}

.cf__panel {
  position: relative;
  width: min(520px, 100%);
  max-height: calc(100vh - var(--space-8));
  overflow-y: auto;
  padding: var(--space-5);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-lg);
  box-shadow: var(--elevation-modal, 0 18px 48px rgba(15, 23, 42, 0.2));
}

.cf__title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-md);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.cf__note {
  margin: 0 0 var(--space-4);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.cf__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.cf__row {
  display: flex;
  gap: var(--space-3);
}

.cf__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  border: none;
  padding: 0;
  margin: 0;
  min-width: 0;
}

.cf__field--grow {
  flex: 1;
}

.cf__label {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  padding: 0;
}

.cf__input {
  height: 34px;
  padding: 0 var(--space-3);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.cf__input:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

.cf__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.cf__chip {
  padding: 0.25rem var(--space-2);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  cursor: pointer;
}

.cf__chip--on {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--text-inverse);
}

.cf__hint {
  font-size: var(--text-xs);
  color: var(--text-disabled);
}

.cf__error {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-danger);
}

.cf__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.cf__btn {
  border-radius: var(--radius-md);
  padding: 0.55rem var(--space-4);
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  cursor: pointer;
  border: var(--border-width-thin) solid transparent;
  transition: background var(--transition-base) var(--ease-standard);
}

.cf__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cf__btn--ghost {
  background: none;
  color: var(--text-secondary);
  border-color: var(--border-main);
}

.cf__btn--ghost:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.cf__btn--primary {
  background: var(--color-primary);
  color: var(--text-inverse);
  box-shadow: var(--elevation-primary);
}

.cf__btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-primary) 85%, var(--text-primary));
}
</style>
