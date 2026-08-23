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
})

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()
</script>

<template>
  <div class="seg" role="radiogroup" :aria-label="ariaLabel">
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
  </div>
</template>

<style scoped>
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
