<script setup lang="ts">
import { computed } from 'vue'
import { formatCount } from '../lib/format'

// Offset pagination, stated in rows rather than in pages.
//
// "1–25 of 312" is what an operator actually wants to know; "page 1 of 13" makes
// them multiply. The page buttons are still there because clicking beats typing
// an offset, but the sentence is the primary readout.

const props = defineProps({
  total: { type: Number, required: true },
  offset: { type: Number, required: true },
  limit: { type: Number, required: true },
  loading: { type: Boolean, default: false },
})

const emit = defineEmits<{ (e: 'go', offset: number): void }>()

const from = computed(() => (props.total === 0 ? 0 : props.offset + 1))
const to = computed(() => Math.min(props.offset + props.limit, props.total))
const atStart = computed(() => props.offset <= 0)
const atEnd = computed(() => props.offset + props.limit >= props.total)
const page = computed(() => Math.floor(props.offset / props.limit) + 1)
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.limit)))
</script>

<template>
  <div class="pager">
    <p class="pager__count u-num">
      <template v-if="total === 0">No rows</template>
      <template v-else>
        {{ formatCount(from) }}–{{ formatCount(to) }} of {{ formatCount(total) }}
      </template>
    </p>

    <div class="pager__controls">
      <span class="pager__page u-num">Page {{ page }} / {{ pages }}</span>
      <button
        type="button"
        class="pager__btn"
        :disabled="atStart || loading"
        @click="emit('go', 0)"
      >First</button>
      <button
        type="button"
        class="pager__btn"
        :disabled="atStart || loading"
        @click="emit('go', Math.max(0, offset - limit))"
      >Previous</button>
      <button
        type="button"
        class="pager__btn"
        :disabled="atEnd || loading"
        @click="emit('go', offset + limit)"
      >Next</button>
    </div>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.pager__count {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.pager__controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.pager__page {
  font-size: var(--text-xs);
  color: var(--text-disabled);
  margin-right: var(--space-1);
}

.pager__btn {
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-sm);
  padding: 0.3rem var(--space-3);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-standard);
}

.pager__btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.pager__btn:active:not(:disabled) {
  background: var(--bg-press);
}

.pager__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
