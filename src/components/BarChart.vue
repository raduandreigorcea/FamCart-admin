<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Bar } from '../lib/uiTypes'

// Magnitude across a small number of named things, drawn horizontally.
//
// Horizontal rather than vertical, deliberately: every use of this chart here
// has a text category (a source, a run version, a household size band) and
// horizontal bars give a label the width to be read without rotating it. A
// rotated axis label is a chart asking the reader to tilt their head.
//
// One series only. Comparing two measures per category is a job for two charts
// side by side, not for a second colour on the same bar -- see the one-axis rule
// in LineChart.

const props = defineProps({
  bars: { type: Array as () => Bar[], required: true },
  format: { type: Function as unknown as () => (n: number) => string, default: () => (n: number) => String(n) },
  /** Row height. The dense variant is for the long lists (top products). */
  dense: { type: Boolean, default: false },
  /** Caps how many are drawn; the rest are summed into one "Other" row. */
  limit: { type: Number, default: 0 },
})

const hovered = ref<string | null>(null)

const rows = computed<Bar[]>(() => {
  if (!props.limit || props.bars.length <= props.limit) return props.bars
  const kept = props.bars.slice(0, props.limit)
  const rest = props.bars.slice(props.limit)
  // A ninth category is never a new colour. It folds into Other, which is the
  // honest summary and keeps the palette at the size it was validated for.
  return [
    ...kept,
    {
      key: '__other',
      label: `Other (${rest.length})`,
      value: rest.reduce((sum, b) => sum + b.value, 0),
      tone: 'muted' as const,
    },
  ]
})

const max = computed(() => Math.max(1, ...rows.value.map((b) => b.value)))
const total = computed(() => rows.value.reduce((sum, b) => sum + b.value, 0))

function width(value: number): string {
  return `${Math.max(value > 0 ? 1.5 : 0, (value / max.value) * 100)}%`
}

function share(value: number): string {
  if (!total.value) return ''
  return `${((value / total.value) * 100).toFixed(1)}%`
}
</script>

<template>
  <div class="bars" :class="{ 'bars--dense': dense }">
    <div
      v-for="bar in rows"
      :key="bar.key"
      class="bars__row"
      :class="{ 'bars__row--hot': hovered === bar.key }"
      @mouseenter="hovered = bar.key"
      @mouseleave="hovered = null"
    >
      <div class="bars__label">
        <span class="bars__name u-truncate" :title="bar.label">{{ bar.label }}</span>
        <span v-if="bar.meta" class="bars__meta u-truncate">{{ bar.meta }}</span>
      </div>

      <div class="bars__track">
        <div
          class="bars__fill"
          :class="{ 'bars__fill--muted': bar.tone === 'muted' }"
          :style="{ width: width(bar.value) }"
        ></div>
      </div>

      <div class="bars__value u-num">
        {{ format(bar.value) }}
        <span v-if="total" class="bars__share u-num">{{ share(bar.value) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bars {
  display: flex;
  flex-direction: column;
  /* The 2px surface gap between adjacent fills, so two long bars never read as
     one block. */
  gap: var(--space-2);
}

.bars--dense {
  gap: 6px;
}

.bars__row {
  display: grid;
  grid-template-columns: minmax(90px, 190px) 1fr minmax(84px, auto);
  align-items: center;
  gap: var(--space-3);
  padding: 3px var(--space-1);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast) var(--ease-standard);
}

.bars__row--hot {
  background: var(--bg-hover);
}

.bars__label {
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: var(--leading-snug);
}

.bars__name {
  font-size: var(--text-sm);
  color: var(--text-primary);
  font-weight: var(--weight-medium);
}

.bars__meta {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}

.bars__track {
  height: 100%;
  min-height: 18px;
  display: flex;
  align-items: center;
}

.bars--dense .bars__track {
  min-height: 14px;
}

.bars__fill {
  height: 10px;
  background: var(--chart-1);
  /* Rounded only on the end away from the baseline: the bar has to look
     anchored to zero, and a radius on the left would lift it off. */
  border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
  min-width: 2px;
  transition: width var(--transition-slow) var(--ease-rise);
}

.bars--dense .bars__fill {
  height: 8px;
}

.bars__fill--muted {
  background: var(--border-dark);
}

.bars__value {
  text-align: right;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  white-space: nowrap;
}

.bars__share {
  display: inline-block;
  margin-left: var(--space-2);
  min-width: 42px;
  font-size: var(--text-2xs);
  font-weight: var(--weight-regular);
  color: var(--text-disabled);
}

@media (prefers-reduced-motion: reduce) {
  .bars__fill {
    transition: none;
  }
}
</style>
