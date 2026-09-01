<script setup lang="ts">
import { computed, ref, watch, type PropType } from 'vue'
import { useModal } from '../lib/useModal'
import type { LocalProductRow } from '../lib/data/types'

// Adding a product, and correcting one.
//
// A dialog of its own rather than ConfirmDialog's slot, for one reason:
// ConfirmDialog puts initial focus on Cancel, deliberately, so that a reflexive
// Enter on a destructive question is always the safe outcome. That is exactly
// wrong for a form somebody came here to type into -- it would mean tabbing past
// Cancel to reach the name field on every add. The modal machinery underneath
// (focus trap, Escape, scrim, teleport) is the same useModal both use.
//
// WHAT THE FORM DOES NOT OFFER, AND WHY
//
// No add_count. It is earned usage and half of the generated popularity column,
// and an admin who could set it could manufacture the appearance of demand that
// the promotion gate in 006_product_catalog reads. The RPC will not accept it
// either; this is the same rule stated where somebody can see it.
//
// No household. A scoped row records that a specific household asked for
// something, and one invented here would be a contribution nobody made. Editing
// an existing scoped row leaves its household alone.
//
// Base weight is offered only for global rows. On a household's own row it is
// meaningless -- nothing ranks a scoped row against anything -- and showing a
// zero there invites somebody to set it.

const props = defineProps({
  open: { type: Boolean, default: false },
  /** The row being corrected, or null when adding. */
  product: { type: Object as PropType<LocalProductRow | null>, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits<{
  (e: 'submit', value: { name: string; maker: string | null; barcode: string | null; baseWeight: number | null }): void
  (e: 'cancel'): void
}>()

const panel = ref<HTMLElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)

const name = ref('')
const maker = ref('')
const barcode = ref('')
const baseWeight = ref('')

const editing = computed(() => props.product !== null)
// A household's own row. Global rows -- promoted, or curated by an admin -- have
// no household_id, and adding always creates one of those.
const global = computed(() => !props.product || props.product.household_id === null)

// Reset from the row every time the dialog opens, not on mount: the component
// stays alive between openings, so without this the second edit would show the
// first one's values.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    name.value = props.product?.name ?? ''
    maker.value = props.product?.maker ?? ''
    barcode.value = props.product?.barcode ?? ''
    baseWeight.value = props.product ? String(props.product.base_weight) : ''
  },
  { immediate: true },
)

// The server enforces all of this and says so in a sentence the dialog renders.
// This only stops the obviously empty submit, so that the common mistake does
// not cost a round trip.
const submittable = computed(() => name.value.trim().length > 0 && !props.busy)

function submit() {
  if (!submittable.value) return
  emit('submit', {
    name: name.value.trim(),
    maker: maker.value.trim() || null,
    barcode: barcode.value.trim() || null,
    // Null means "leave it" to the RPC, which is what a scoped row wants: it
    // has no weight worth setting and the field is not shown.
    baseWeight: global.value ? Number(baseWeight.value.trim() || '0') : null,
  })
}

useModal({
  open: () => props.open,
  close: () => emit('cancel'),
  panel,
  initialFocus: () => nameInput.value,
  // Escape is refused while the write is in flight, for the same reason the
  // scrim is: dismissing would not cancel the request, only hide whether it
  // worked.
  dismissible: () => !props.busy,
})
</script>

<template>
  <!-- Teleported for the reason ConfirmDialog is: a transform, filter or
       overflow:hidden on any ancestor makes position:fixed resolve against that
       ancestor, and the dialog is clipped by the card that opened it. -->
  <Teleport to="body">
    <div v-if="open" class="pf">
      <div class="pf__scrim" @click="busy || emit('cancel')"></div>

      <div
        ref="panel"
        class="pf__panel"
        role="dialog"
        aria-modal="true"
        :aria-label="editing ? 'Edit product' : 'Add product'"
        tabindex="-1"
      >
        <h2 class="pf__title">{{ editing ? 'Edit product' : 'Add product' }}</h2>
        <p class="pf__note">
          {{
            editing
              ? global
                ? 'A global product. Everyone sees it.'
                : 'A household’s own row. Its household, contributor and earned adds are left alone.'
              : 'Added as a global curated product, visible to every household.'
          }}
        </p>

        <form class="pf__form" @submit.prevent="submit">
          <label class="pf__field">
            <span class="pf__label">Name</span>
            <input
              ref="nameInput"
              v-model="name"
              class="pf__input"
              type="text"
              maxlength="120"
              required
              :disabled="busy"
            />
          </label>

          <label class="pf__field">
            <span class="pf__label">Brand</span>
            <input v-model="maker" class="pf__input" type="text" maxlength="60" :disabled="busy" />
          </label>

          <label class="pf__field">
            <span class="pf__label">Barcode</span>
            <input
              v-model="barcode"
              class="pf__input"
              type="text"
              inputmode="numeric"
              :disabled="busy"
            />
          </label>

          <!-- Only where it means something. See the header. -->
          <label v-if="global" class="pf__field">
            <span class="pf__label">Base weight</span>
            <input
              v-model="baseWeight"
              class="pf__input"
              type="number"
              min="0"
              :disabled="busy"
            />
            <span class="pf__hint">
              The editorial thumb on the scale. Real adds are counted separately and
              cannot be set from here.
            </span>
          </label>

          <p v-if="error" class="pf__error">{{ error }}</p>

          <div class="pf__actions">
            <button type="button" class="pf__btn pf__btn--ghost" :disabled="busy" @click="emit('cancel')">
              Cancel
            </button>
            <button type="submit" class="pf__btn pf__btn--primary" :disabled="!submittable">
              {{ busy ? 'Saving…' : editing ? 'Save' : 'Add product' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pf {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: var(--space-4);
}

.pf__scrim {
  position: absolute;
  inset: 0;
  background: var(--scrim, rgba(15, 23, 42, 0.45));
}

.pf__panel {
  position: relative;
  width: min(420px, 100%);
  padding: var(--space-5);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-lg);
  box-shadow: var(--elevation-modal, 0 18px 48px rgba(15, 23, 42, 0.2));
}

.pf__title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-md);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.pf__note {
  margin: 0 0 var(--space-4);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.pf__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.pf__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.pf__label {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
}

.pf__input {
  height: 34px;
  padding: 0 var(--space-3);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.pf__input:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

.pf__hint {
  font-size: var(--text-xs);
  color: var(--text-disabled);
}

.pf__error {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-danger);
}

.pf__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

/* Deliberately the same as ConfirmDialog's, spelled out rather than shared:
   there is no button component in this tool yet, and inventing one for two
   dialogs would be the wrong moment. If a third arrives, that is the moment. */
.pf__btn {
  border-radius: var(--radius-md);
  padding: 0.55rem var(--space-4);
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  cursor: pointer;
  border: var(--border-width-thin) solid transparent;
  transition: background var(--transition-base) var(--ease-standard);
}

.pf__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pf__btn--ghost {
  background: none;
  color: var(--text-secondary);
  border-color: var(--border-main);
}

.pf__btn--ghost:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.pf__btn--primary {
  background: var(--color-primary);
  color: var(--text-inverse);
  box-shadow: var(--elevation-primary);
}

.pf__btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-primary) 85%, var(--text-primary));
}
</style>
