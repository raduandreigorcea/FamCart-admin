<script setup lang="ts">
import type { PropType } from 'vue'
import { formatRelative } from '../lib/format'
import AppIcon from './AppIcon.vue'

// Every page opens with the same four things: what it is, what it is for, when
// its numbers were read, and how to read them again.
//
// The timestamp matters more here than it looks. Nothing on this dashboard
// revalidates in the background, deliberately, so "as of when" always has an
// answer -- and this is where it is given.

defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  fetchedAt: { type: Number as PropType<number | null>, default: null },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits<{ (e: 'refresh'): void }>()
</script>

<template>
  <header class="head">
    <div class="head__text">
      <h1 class="head__title">{{ title }}</h1>
      <p v-if="description" class="head__desc">{{ description }}</p>
    </div>

    <div class="head__tools">
      <slot name="tools" />

      <span v-if="fetchedAt" class="head__stamp" :title="new Date(fetchedAt).toISOString()">
        Read {{ formatRelative(new Date(fetchedAt)) }}
      </span>

      <button
        type="button"
        class="head__refresh"
        :disabled="busy"
        title="Run every query on this page again"
        @click="emit('refresh')"
      >
        <AppIcon
          class="head__refresh-glyph"
          :class="{ 'head__refresh-glyph--spin': busy }"
          name="rotate-cw"
          :size="13"
        />
        Refresh
      </button>
    </div>
  </header>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.head__text {
  min-width: 0;
}

.head__title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-bold);
  letter-spacing: -0.02em;
  color: var(--text-primary);
  line-height: var(--leading-tight);
}

.head__desc {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: var(--leading-snug);
  max-width: 78ch;
}

.head__tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.head__stamp {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  white-space: nowrap;
}

.head__refresh {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 30px;
  padding: 0 var(--space-3);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  cursor: pointer;
}

.head__refresh:hover:not(:disabled) {
  background: var(--bg-hover);
}

.head__refresh:disabled {
  opacity: 0.55;
  cursor: progress;
}

.head__refresh-glyph--spin {
  display: inline-block;
  animation: head-spin 0.9s linear infinite;
}

@keyframes head-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .head__refresh-glyph--spin {
    animation: none;
  }
}
</style>
