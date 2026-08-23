<script setup lang="ts">
import { computed } from 'vue'

// A stat tile's trend, and nothing more.
//
// No axes, no grid, no tooltip. A sparkline answers one question -- "which way,
// and how steadily" -- and every mark added to it answers a question the number
// beside it already answered better. The tile carries the value; this carries
// the shape.
//
// It is explicitly not a chart for reading values off, so it has no hover layer.
// That is the one exception the interaction rule allows, and this is it.

const props = defineProps({
  values: { type: Array as () => number[], default: () => [] },
  /** Series colour token. Defaults to the first categorical hue. */
  stroke: { type: String, default: 'var(--chart-1)' },
  height: { type: Number, default: 34 },
  /** Screen-reader description, since the shape is the content. */
  label: { type: String, default: 'Trend' },
})

const WIDTH = 120

const geometry = computed(() => {
  const values = props.values.filter((v) => Number.isFinite(v))
  if (values.length < 2) return null

  const min = Math.min(...values)
  const max = Math.max(...values)
  // A flat series has no range to scale into. Drawing it down the middle is
  // truthful; scaling it to fill the box would turn noise into a mountain.
  const span = max - min || 1
  const top = 3
  const bottom = props.height - 3

  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * WIDTH
    const y = bottom - ((value - min) / span) * (bottom - top)
    return [x, y] as const
  })

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${WIDTH},${props.height} L0,${props.height} Z`
  const last = points[points.length - 1]

  return { line, area, last, flat: max === min }
})
</script>

<template>
  <svg
    v-if="geometry"
    class="spark"
    :viewBox="`0 0 ${WIDTH} ${height}`"
    :height="height"
    preserveAspectRatio="none"
    role="img"
    :aria-label="label"
  >
    <path :d="geometry.area" class="spark__area" :style="{ fill: stroke }" />
    <path :d="geometry.line" class="spark__line" :style="{ stroke }" />
    <!-- The most recent point, marked because "where it ended up" is the one
         value a sparkline is actually read for. The surface-coloured ring is the
         2px gap that keeps it separate from the line under it. -->
    <circle
      :cx="geometry.last[0]"
      :cy="geometry.last[1]"
      r="2.6"
      :style="{ fill: stroke }"
      class="spark__end"
    />
  </svg>
  <div v-else class="spark spark--empty" :style="{ height: `${height}px` }" aria-hidden="true"></div>
</template>

<style scoped>
.spark {
  display: block;
  width: 100%;
  overflow: visible;
}

.spark__line {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  /* preserveAspectRatio="none" stretches the stroke with the box, which makes a
     2px line render at different weights on a wide tile and a narrow one. */
  vector-effect: non-scaling-stroke;
}

.spark__area {
  opacity: 0.10;
  stroke: none;
}

.spark__end {
  stroke: var(--chart-gap);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.spark--empty {
  border-bottom: var(--border-width-thin) dashed var(--border-main);
}
</style>
