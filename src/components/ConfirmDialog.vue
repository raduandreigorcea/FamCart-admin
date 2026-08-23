<script setup lang="ts">
import { onBeforeUnmount, ref, watch, type PropType } from 'vue'

// The confirmation, for the two writes this tool can make.
//
// It names the target rather than asking an abstract question. "Remove admin
// access?" is answerable without knowing whose, which is exactly how the wrong
// person gets removed; "Remove admin access from Pat?" is not.
//
// The destructive button is never the default focus. Focus lands on Cancel, so
// a reflexive Enter is always the safe outcome.

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, required: true },
  message: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Confirm' },
  tone: { type: String as PropType<'primary' | 'danger'>, default: 'primary' },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()

const cancelButton = ref<HTMLButtonElement | null>(null)
let returnFocusTo: HTMLElement | null = null

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && !props.busy) {
    event.stopPropagation()
    emit('cancel')
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      returnFocusTo = document.activeElement as HTMLElement | null
      document.addEventListener('keydown', onKeydown)
      requestAnimationFrame(() => cancelButton.value?.focus())
    } else {
      document.removeEventListener('keydown', onKeydown)
      returnFocusTo?.focus?.()
      returnFocusTo = null
    }
  },
)

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="open" class="confirm">
    <!-- The scrim does not close while a write is in flight: dismissing the
         dialog would not cancel the request, only hide whether it worked. -->
    <div class="confirm__scrim" @click="busy || emit('cancel')"></div>

    <div class="confirm__panel" role="alertdialog" aria-modal="true" :aria-label="title">
      <h2 class="confirm__title">{{ title }}</h2>
      <p v-if="message" class="confirm__message">{{ message }}</p>

      <slot />

      <p v-if="error" class="confirm__error">{{ error }}</p>

      <div class="confirm__actions">
        <button
          ref="cancelButton"
          type="button"
          class="confirm__btn confirm__btn--ghost"
          :disabled="busy"
          @click="emit('cancel')"
        >Cancel</button>
        <button
          type="button"
          class="confirm__btn"
          :class="tone === 'danger' ? 'confirm__btn--danger' : 'confirm__btn--primary'"
          :disabled="busy"
          @click="emit('confirm')"
        >{{ busy ? 'Working…' : confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: center;
  padding: var(--space-4);
}

.confirm__scrim {
  position: absolute;
  inset: 0;
  background: var(--backdrop);
}

.confirm__panel {
  position: relative;
  width: min(430px, 100%);
  background: var(--bg-surface);
  border-radius: var(--radius-dialog);
  box-shadow: var(--elevation-dialog);
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  --modal-rise: 16px;
  animation: modal-rise-in var(--transition-base) var(--ease-rise);
}

.confirm__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.confirm__message {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--text-secondary);
}

.confirm__error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--danger-bg);
  border: var(--border-width-thin) solid var(--danger-border);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--danger-text);
}

.confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

/* Matches AppButton's treatment without importing it: AppButton is FamCart's,
   not vendored here, and copying one button's look is cheaper than vendoring a
   component and guarding it against drift forever. */
.confirm__btn {
  border-radius: var(--radius-md);
  padding: 0.55rem var(--space-4);
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  cursor: pointer;
  border: var(--border-width-thin) solid transparent;
  transition: background var(--transition-base) var(--ease-standard);
}

.confirm__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.confirm__btn--ghost {
  background: none;
  color: var(--text-secondary);
  border-color: var(--border-main);
}

.confirm__btn--ghost:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.confirm__btn--primary {
  background: var(--color-primary);
  color: var(--text-inverse);
  box-shadow: var(--elevation-primary);
}

.confirm__btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-primary) 85%, var(--text-primary));
}

.confirm__btn--danger {
  background: var(--danger-solid);
  color: var(--text-inverse);
  box-shadow: var(--elevation-danger);
}

.confirm__btn--danger:hover:not(:disabled) {
  background: var(--danger-solid-hover);
}
</style>
