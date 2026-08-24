<script setup lang="ts">
import type { PropType } from 'vue'
import type { Segment } from '../lib/uiTypes'

// A short, mutually exclusive choice: the time range, a table density, a scope.
// Segmented rather than a select, because with four options the whole choice
// fits on screen and picking one is a single click instead of two.

defineProps({
  segments: { type: Array as PropType<Segment[]>, required: true },
  modelValue: { type: String, required: true },
  ariaLabel: { type: String, default: 'Choose one' },
  /**
   * An inline label, matching SelectField's.
   *
   * Optional because most of these stand alone -- the time range, the row
   * density -- where a label would only repeat what the options already say.
   * It exists for the filter row, where two SelectFields carried "Source" and
   * "Market" beside them and the segmented control next to them carried
   * nothing, so one filter in the row looked like a set of loose buttons.
   *
   * When given it also names the group, so the visible text and the accessible
   * name cannot drift apart.
   */
  label: { type: String, default: '' },
})

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()
</script>

<template>
  <!-- The wrapper is unconditional so the control has one box model whether or
       not it is labelled; it is inline-flex like .seg was, so an unlabelled one
       lays out exactly as before. -->
  <span class="seg-field">
    <span v-if="label" class="seg-field__label">{{ label }}</span>
    <span class="seg" role="radiogroup" :aria-label="label || ariaLabel">
    <button
      v-for="segment in segments"
      :key="segment.value"
      type="button"
      role="radio"
      class="seg__item"
      :class="{ 'seg__item--on': modelValue === segment.value }"
      :aria-checked="modelValue === segment.value"
      :title="segment.title"
      @click="emit('update:modelValue', segment.value)"
    >
      {{ segment.label }}
    </button>
    </span>
  </span>
</template>

<style scoped>
/* Matches SelectField's .field / .field__label exactly, because a filter row
   reading "Source [ ] Market [ ] Barcode [ ]" should not have three different
   ideas about how a label sits beside its control. */
.seg-field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
}

.seg-field__label {
  color: var(--text-secondary);
  font-weight: var(--weight-semibold);
  white-space: nowrap;
}

.seg {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  background: var(--bg-main);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  user-select: none;
}

.seg__item {
  border: none;
  background: none;
  padding: 0 var(--space-3);
  height: 24px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--transition-fast) var(--ease-standard),
              color var(--transition-fast) var(--ease-standard);
}

.seg__item:hover:not(.seg__item--on) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.seg__item--on {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: var(--elevation-soft);
}
</style>
