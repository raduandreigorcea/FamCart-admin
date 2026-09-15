<script setup lang="ts">
import type { PropType } from 'vue'
import AppSpinner from './AppSpinner.vue'
import type { Tone } from '../lib/uiTypes'

// A state, said in words and colour together.
//
// Colour never carries the meaning alone here: the label is always rendered, and
// `tone` only tints it. That is the rule the chart palette follows too, and it is
// what keeps a red pill legible to someone who cannot see it as red.

defineProps({
  tone: { type: String as PropType<Tone>, default: 'idle' },
  label: { type: String, required: true },
  /** A leading dot. Off for pills that are really tags rather than states. */
  dot: { type: Boolean, default: true },
  /** The dot turns into a spinner: this state is still happening. */
  busy: { type: Boolean, default: false },
  title: { type: String, default: undefined },
})
</script>

<template>
  <span class="pill" :class="`pill--${tone}`" :title="title">
    <AppSpinner v-if="busy" :size="9" />
    <span v-else-if="dot" class="pill__dot" aria-hidden="true"></span>
    {{ label }}
  </span>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: 0.15rem var(--space-2);
  border-radius: var(--radius-pill);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  line-height: 1.5;
  white-space: nowrap;
  border: var(--border-width-thin) solid transparent;
}

.pill__dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: currentColor;
  flex: none;
}

.pill--good {
  color: var(--status-good);
  background: var(--status-good-bg);
  border-color: color-mix(in srgb, var(--status-good) 22%, transparent);
}

.pill--warn {
  color: var(--status-warn);
  background: var(--status-warn-bg);
  border-color: var(--warning-border);
}

.pill--bad {
  color: var(--status-bad);
  background: var(--status-bad-bg);
  border-color: var(--danger-border);
}

.pill--live {
  color: var(--status-live-ink);
  background: var(--status-live-bg);
  border-color: var(--status-live-border);
}

.pill--idle {
  color: var(--text-secondary);
  background: var(--bg-hover);
  border-color: var(--border-main);
}

.pill--accent {
  color: var(--color-primary-text);
  background: var(--color-primary-bg);
  border-color: color-mix(in srgb, var(--color-primary) 26%, transparent);
}
</style>
