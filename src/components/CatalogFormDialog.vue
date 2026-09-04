<script setup lang="ts">
import { computed, ref, watch, type PropType } from 'vue'
import { useModal } from '../lib/useModal'
import type { CatalogProductRow } from '../lib/data/catalog'
// The closed vocabularies, shared with the filter drawer -- see catalogVocab.ts
// for why one more copy of the check constraints is the right trade.
import { CATEGORIES, UNITS } from '../lib/catalogVocab'

// Adding and correcting a reference product.
//
// Separate from ProductFormDialog rather than one dialog with a mode, because
// the two tables genuinely differ: this one belongs to a catalog assembled from
// shop listings and the other to a household's own contributions. A single
// dialog would have been a form where half the fields were conditional on which
// database it was pointed at, which is the shape that hides a bug.
//
// THE FORM GOT SHORTER when the catalog was rebuilt, and every field that went
// described something that no longer exists. Product type (generic/commercial),
// name language, market list, quality tier and editorial weight all belonged to
// a catalog of concepts imported from Open Food Facts. A product now comes from
// a shop, in Romanian, and either a shop lists it or none does.
//
// WHAT IT WILL NOT LET YOU SET
//
// add_count, for the reason it is unwritable everywhere: it is earned usage and
// half of the generated popularity column, and bump_product_popularity() is the
// only thing entitled to move it. listing_count likewise -- it is maintained by
// a trigger on the listings that actually exist, so an import that fails halfway
// cannot leave a product claiming four shops stock it.
//
// The LISTINGS. What a shop calls a product, what it charges and whether it has
// it are that shop's facts, refreshed by the next scrape. Editing them here
// would be a value that reverts on a schedule, which is worse than no field.
//
// EVERYTHING ELSE IS EDITABLE, the barcode included. It was withheld at first
// because a scan resolves through that value and nowhere else, so moving one
// silently redirects every future scan -- but withholding the field was the
// wrong answer to a real risk. The RPC refuses a code another product already
// claims, and clearing is distinguishable from leaving alone, so the dangerous
// version of the edit is impossible rather than merely undocumented.


const props = defineProps({
  open: { type: Boolean, default: false },
  product: { type: Object as PropType<CatalogProductRow | null>, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits<{
  (e: 'submit', value: {
    name: string
    brand: string | null
    category: string | null
    barcode: string | null
    quantity: number | null
    quantityUnit: string | null
    imageUrl: string | null
  }): void
  (e: 'cancel'): void
}>()

const panel = ref<HTMLElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)

const name = ref('')
const brand = ref('')
const category = ref('')
const barcode = ref('')
const quantity = ref('')
const quantityUnit = ref('')
const imageUrl = ref('')

const editing = computed(() => props.product !== null)

// Reset from the row on every open, not on mount: the component stays alive
// between openings, so without this the second edit shows the first one's values.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    const p = props.product
    name.value = p?.canonical_name ?? ''
    brand.value = p?.brand ?? ''
    category.value = p?.category ?? ''
    barcode.value = p?.barcodes[0] ?? ''
    quantity.value = p?.quantity != null ? String(p.quantity) : ''
    quantityUnit.value = p?.quantity_unit ?? ''
    imageUrl.value = p?.image_url ?? ''
  },
  { immediate: true },
)

const submittable = computed(() => name.value.trim().length > 0 && !props.busy)

function submit() {
  if (!submittable.value) return

  // Empty string, not null, for the fields the RPC treats as clearable. null
  // there means "I am not mentioning this column"; this form mentions all of
  // them every time, so an emptied input has to arrive as an emptied value or
  // clearing a barcode would silently do nothing.
  //
  // Creating is the exception: there is nothing to leave alone yet, and the
  // create RPC reads an empty barcode as no barcode.
  emit('submit', {
    name: name.value.trim(),
    brand: brand.value.trim() || null,
    category: editing.value ? category.value.trim() : category.value.trim() || null,
    barcode: editing.value ? barcode.value.trim() : barcode.value.trim() || null,
    quantity: quantity.value.trim() ? Number(quantity.value.trim()) : null,
    quantityUnit: editing.value ? quantityUnit.value : quantityUnit.value || null,
    imageUrl: editing.value ? imageUrl.value.trim() : imageUrl.value.trim() || null,
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

          <label class="cf__field">
            <span class="cf__label">Brand</span>
            <input v-model="brand" class="cf__input" type="text" maxlength="80" :disabled="busy" />
            <span class="cf__hint">Null is ordinary. A banana has no brand, and Auchan files loose produce as "Non-brand", which is stored as nothing.</span>
          </label>

          <label class="cf__field">
            <span class="cf__label">Category</span>
            <select v-model="category" class="cf__input" :disabled="busy">
              <option value="">None</option>
              <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
            </select>
            <span class="cf__hint">
              Often empty, and honestly so: only Auchan states a department, and a
              guessed shelf is invisible where a missing one is findable.
            </span>
          </label>

          <div class="cf__row">
            <label class="cf__field cf__field--grow">
              <span class="cf__label">Quantity</span>
              <input v-model="quantity" class="cf__input" type="number" min="0" step="any" :disabled="busy" />
            </label>

            <label class="cf__field">
              <span class="cf__label">Unit</span>
              <select v-model="quantityUnit" class="cf__input" :disabled="busy">
                <option value="">None</option>
                <option v-for="u in UNITS" :key="u" :value="u">{{ u }}</option>
              </select>
            </label>
          </div>

          <label class="cf__field">
            <span class="cf__label">Barcode</span>
            <input v-model="barcode" class="cf__input" type="text" inputmode="numeric" :disabled="busy" />
            <span class="cf__hint">
              8 to 14 digits, and a scan resolves through this and nothing else. A code another
              product already claims is refused; emptying it makes this one unscannable.
            </span>
          </label>

          <label class="cf__field">
            <span class="cf__label">Image address</span>
            <input v-model="imageUrl" class="cf__input" type="url" :disabled="busy" />
            <span class="cf__hint">https:// only, under 500 characters.</span>
          </label>

          <p class="cf__note">
            A product created here has no listing, so no shop is selling it. That is a
            legitimate thing to want, and it also means the next scrape will not sweep it.
          </p>

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
