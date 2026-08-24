<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'

// One row above every table: a search box, whatever selects the table needs, and
// the count of what is showing. Filters go in one place and one order across the
// whole tool, so moving between sections does not mean relearning where they are.

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: 'Search' },
  /** Milliseconds to wait after typing stops before emitting. */
  debounce: { type: Number, default: 250 },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const local = ref(props.modelValue)
let timer: ReturnType<typeof setTimeout> | null = null

// Debounced outward, immediate inward. Typing must never lag behind the
// keyboard, and the parent must not issue a request per keystroke.
watch(local, (value) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => emit('update:modelValue', value), props.debounce)
})

watch(
  () => props.modelValue,
  (value) => {
    if (value !== local.value) local.value = value
  },
)

function clear() {
  if (timer) clearTimeout(timer)
  local.value = ''
  emit('update:modelValue', '')
}

// Same as CopyValue: a pending timer holding a closure over a component that is
// already gone. Harmless in effect -- the listener has been torn down too -- and
// still worth not leaving behind, because "harmless" is a property of today's
// handler rather than of the pattern.
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div class="filters">
    <div class="filters__search">
      <AppIcon class="filters__icon" name="search" :size="14" />
      <input
        v-model="local"
        class="filters__input"
        type="search"
        :placeholder="placeholder"
        autocomplete="off"
        spellcheck="false"
      />
      <button v-if="local" type="button" class="filters__clear" title="Clear search" @click="clear">
        <AppIcon name="x" :size="13" />
        <span class="u-sr">Clear search</span>
      </button>
    </div>

    <div class="filters__slots">
      <slot />
    </div>

    <div class="filters__end">
      <span v-if="busy" class="filters__busy">Loading…</span>
      <slot name="end" />
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.filters__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 32px;
  padding: 0 var(--space-2) 0 var(--space-3);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  min-width: 260px;
  flex: 0 1 320px;
  transition: border-color var(--transition-fast) var(--ease-standard);
}

.filters__search:focus-within {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-primary);
}

.filters__icon {
  color: var(--text-disabled);
}

.filters__input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  font-size: var(--text-sm);
  color: var(--text-primary);
}

/* The browser's own clear affordance duplicates ours and looks nothing like it. */
.filters__input::-webkit-search-cancel-button {
  display: none;
}

.filters__clear {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-disabled);
  font-size: var(--text-lg);
  line-height: 1;
  padding: 0 var(--space-1);
}

.filters__clear:hover {
  color: var(--text-primary);
}

.filters__slots {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.filters__end {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.filters__busy {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}
</style>
