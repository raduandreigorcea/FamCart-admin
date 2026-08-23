<script setup lang="ts">
import type { PropType } from 'vue'

// A native select, styled to match the filter row.
//
// Native rather than a custom listbox, on purpose. A custom one would have to
// reimplement typeahead, keyboard selection, scroll containment and the mobile
// picker, and would end up worse at all four. The only thing wrong with the
// native control is its chrome, and that is the part CSS can fix.

defineProps({
  modelValue: { type: String as PropType<string | null>, default: null },
  options: {
    type: Array as PropType<{ value: string | null; label: string }[]>,
    required: true,
  },
  label: { type: String, required: true },
  /** Shows the label inline, for filters whose meaning is not obvious. */
  showLabel: { type: Boolean, default: true },
})

const emit = defineEmits<{ (e: 'update:modelValue', value: string | null): void }>()

function onChange(event: Event) {
  const raw = (event.target as HTMLSelectElement).value
  // The empty string is how a native option carries "no filter"; null is what
  // the RPCs take, and the two must not be confused -- an empty string filter
  // would match nothing rather than everything.
  emit('update:modelValue', raw === '' ? null : raw)
}
</script>

<template>
  <label class="field">
    <span v-if="showLabel" class="field__label">{{ label }}</span>
    <span v-else class="u-sr">{{ label }}</span>
    <select class="field__select" :value="modelValue ?? ''" @change="onChange">
      <option v-for="option in options" :key="option.value ?? '__all'" :value="option.value ?? ''">
        {{ option.label }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
}

.field__label {
  color: var(--text-secondary);
  font-weight: var(--weight-semibold);
  white-space: nowrap;
}

.field__select {
  height: 32px;
  padding: 0 var(--space-6) 0 var(--space-3);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
  cursor: pointer;
  appearance: none;
  /* The caret, drawn rather than imported: one inline SVG beats an icon file and
     a request for a 10px triangle. currentColor would not work in a data URI, so
     it is the token value spelled out. */
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236b7280' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right var(--space-3) center;
}

.field__select:hover {
  border-color: var(--border-dark);
}

.field__select:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-primary);
}
</style>
