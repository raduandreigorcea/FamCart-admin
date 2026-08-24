<script setup lang="ts">
import { computed, type PropType } from 'vue'
import SparkLine from './SparkLine.vue'
import AppIcon from './AppIcon.vue'
import { formatCompact, formatCount, formatPercent } from '../lib/format'
import type { Delta } from '../lib/data/overview'

// One number, said once, with just enough around it to know whether it is good.
//
// The compact form (10.8k) is the headline and the exact figure is the title
// attribute, because a tile is read at a glance and a table is read for
// precision. Tables never use formatCompact for the same reason.

const props = defineProps({
  label: { type: String, required: true },
  value: { type: Number as PropType<number | null>, default: null },
  /** Under the number: what it counts, or a caveat about how it is derived. */
  hint: { type: String, default: '' },
  delta: { type: Object as PropType<Delta | null>, default: null },
  /** Which direction is good. `neutral` colours the delta grey. */
  polarity: { type: String as PropType<'up-good' | 'down-good' | 'neutral'>, default: 'up-good' },
  spark: { type: Array as PropType<number[]>, default: () => [] },
  sparkColor: { type: String, default: 'var(--chart-1)' },
  /** Renders the "not recorded" treatment instead of a number. */
  unrecorded: { type: Boolean, default: false },
  unrecordedReason: { type: String, default: '' },
})

const display = computed(() => (props.value === null ? '--' : formatCompact(props.value)))
const exact = computed(() => (props.value === null ? '' : formatCount(props.value)))

const deltaText = computed(() => {
  const d = props.delta
  if (!d) return null
  const sign = d.change > 0 ? '+' : ''
  // A ratio against a previous window of zero is not "+100%", it is a first
  // occurrence. Saying "new" is the truthful version.
  const ratio = d.ratio === null ? 'new' : formatPercent(Math.abs(d.ratio))
  return { text: `${sign}${formatCount(d.change)}`, ratio, change: d.change }
})

const deltaTone = computed(() => {
  const d = props.delta
  if (!d || d.change === 0 || props.polarity === 'neutral') return 'flat'
  const good = props.polarity === 'up-good' ? d.change > 0 : d.change < 0
  return good ? 'up' : 'down'
})
</script>

<template>
  <div class="tile" :class="{ 'tile--unrecorded': unrecorded }">
    <div class="tile__label">{{ label }}</div>

    <template v-if="unrecorded">
      <div class="tile__nodata">Not recorded</div>
      <p class="tile__hint">{{ unrecordedReason }}</p>
    </template>

    <template v-else>
      <div class="tile__row">
        <div class="tile__value u-num" :title="exact">{{ display }}</div>
        <SparkLine
          v-if="spark.length > 1"
          class="tile__spark"
          :values="spark"
          :stroke="sparkColor"
          :label="`${label} trend`"
        />
      </div>

      <div class="tile__foot">
        <span v-if="deltaText" class="tile__delta" :class="`tile__delta--${deltaTone}`">
          <AppIcon
            :name="deltaTone === 'up' ? 'arrow-up' : deltaTone === 'down' ? 'arrow-down' : 'minus'"
            :size="11"
          />
          {{ deltaText.text }}
          <span class="tile__ratio">{{ deltaText.ratio }}</span>
        </span>
        <span v-if="hint" class="tile__hint">{{ hint }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tile {
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-lg);
  padding: var(--space-3) var(--space-4) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  height: 100%;
  box-shadow: var(--elevation-soft);
}

.tile__label {
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caption);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tile__row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
}

.tile__value {
  font-size: var(--text-2xl);
  font-weight: var(--weight-bold);
  line-height: 1.1;
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.tile__spark {
  width: 92px;
  flex: none;
  margin-bottom: 3px;
}

.tile__foot {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
  min-height: 16px;
}

.tile__delta {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

/* Direction is carried by the caret AND the colour, never by colour alone. */
.tile__delta--up { color: var(--status-good); }
.tile__delta--down { color: var(--danger-text); }
.tile__delta--flat { color: var(--text-disabled); }

.tile__ratio {
  color: var(--text-disabled);
  font-weight: var(--weight-regular);
}

.tile__hint {
  margin: 0;
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  line-height: var(--leading-snug);
}

.tile--unrecorded {
  border-style: dashed;
  border-color: var(--unrecorded-line);
  background-color: var(--unrecorded-bg);
}

.tile__nodata {
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  color: var(--text-disabled);
  line-height: 1.4;
}
</style>
