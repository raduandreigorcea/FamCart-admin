<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Series } from '../lib/uiTypes'

// Change over time, up to four series, with a crosshair and a tooltip.
//
// Hand-rolled SVG rather than a charting library, for the reason FamCart has no
// UI framework either: four hundred lines here replaces two hundred kilobytes of
// download, and every decision below is one this dashboard actually needed to
// make rather than one configured around a library's defaults.
//
// The rules it follows, from the top:
//   * ONE y-axis. Two measures of different magnitude go in two charts, never on
//     two scales in one frame -- the single most common way a chart lies.
//   * Colour follows the SERIES, by its key, not its position. Toggling one off
//     must not repaint the others.
//   * A legend is always present for two or more series, so identity is never
//     carried by colour alone.
//   * Grid and axes are recessive. The data is the only thing at full strength.

const props = defineProps({
  series: { type: Array as () => Series[], required: true },
  labels: { type: Array as () => string[], required: true },
  height: { type: Number, default: 240 },
  /** Formatter for the tooltip and the axis. */
  format: { type: Function as unknown as () => (n: number) => string, default: () => (n: number) => String(n) },
})

// Fixed order, never cycled. A fifth series is not a generated hue -- the caller
// folds it into the four or splits the chart, which is a decision for the caller
// because only it knows which measures belong together.
const SERIES_TOKENS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)']

const PAD = { top: 12, right: 14, bottom: 26, left: 46 }
const WIDTH = 900

const hidden = ref(new Set<string>())
const hoverIndex = ref<number | null>(null)

function toggle(key: string) {
  const next = new Set(hidden.value)
  // Never let the last visible series be hidden: an empty frame with a legend is
  // a broken-looking chart rather than a filtered one.
  if (next.has(key)) next.delete(key)
  else if (visible.value.length > 1) next.add(key)
  hidden.value = next
}

const visible = computed(() => props.series.filter((s) => !hidden.value.has(s.key)))

/** Colour is keyed to the series' index in the ORIGINAL array, never in the
 *  filtered one, so hiding series 2 leaves series 3 the colour it had. */
const colorOf = computed(() => {
  const map = new Map<string, string>()
  props.series.forEach((s, i) => map.set(s.key, SERIES_TOKENS[i % SERIES_TOKENS.length]))
  return map
})

const plot = computed(() => ({
  w: WIDTH - PAD.left - PAD.right,
  h: props.height - PAD.top - PAD.bottom,
}))

const maxValue = computed(() => {
  const all = visible.value.flatMap((s) => s.values)
  const max = all.length ? Math.max(...all) : 0
  // A chart of all zeros still needs a scale, and it should read as a flat line
  // on a floor rather than as a divide-by-zero.
  return max <= 0 ? 1 : max
})

/** Round, human tick values rather than max/4 -- nobody reads an axis of 8.75. */
const ticks = computed(() => {
  const max = maxValue.value
  const rough = max / 4
  const magnitude = 10 ** Math.floor(Math.log10(rough || 1))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10
  const out: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 100) / 100)
  return out
})

const axisMax = computed(() => Math.max(maxValue.value, ticks.value[ticks.value.length - 1] ?? 1))

function x(index: number): number {
  const count = props.labels.length
  if (count <= 1) return PAD.left + plot.value.w / 2
  return PAD.left + (index / (count - 1)) * plot.value.w
}

function y(value: number): number {
  return PAD.top + plot.value.h - (value / axisMax.value) * plot.value.h
}

const paths = computed(() =>
  visible.value.map((s) => ({
    key: s.key,
    label: s.label,
    color: colorOf.value.get(s.key) ?? SERIES_TOKENS[0],
    d: s.values
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(' '),
  })),
)

/** Which x-labels to draw, so they never collide however long the range is. */
const labelStride = computed(() => Math.max(1, Math.ceil(props.labels.length / 8)))

function onMove(event: MouseEvent) {
  const target = event.currentTarget as SVGSVGElement
  const box = target.getBoundingClientRect()
  // The SVG scales to its container, so the pointer has to be mapped back into
  // viewBox units before it means anything.
  const vx = ((event.clientX - box.left) / box.width) * WIDTH
  const count = props.labels.length
  if (count === 0) return
  const ratio = (vx - PAD.left) / plot.value.w
  hoverIndex.value = Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))))
}

const tooltip = computed(() => {
  const index = hoverIndex.value
  if (index === null || !props.labels[index]) return null
  const left = (x(index) / WIDTH) * 100
  return {
    index,
    label: props.labels[index],
    left,
    // Flip the tooltip to the other side of the crosshair near the right edge,
    // so it is never clipped by the panel.
    flip: left > 62,
    rows: visible.value.map((s) => ({
      key: s.key,
      label: s.label,
      color: colorOf.value.get(s.key) ?? SERIES_TOKENS[0],
      value: s.values[index] ?? 0,
    })),
  }
})
</script>

<template>
  <div class="chart">
    <div v-if="series.length > 1" class="chart__legend" role="group" aria-label="Series">
      <button
        v-for="s in series"
        :key="s.key"
        type="button"
        class="chart__legend-item"
        :class="{ 'chart__legend-item--off': hidden.has(s.key) }"
        :aria-pressed="!hidden.has(s.key)"
        @click="toggle(s.key)"
      >
        <span class="chart__swatch" :style="{ background: colorOf.get(s.key) }" aria-hidden="true"></span>
        {{ s.label }}
      </button>
    </div>

    <div class="chart__frame">
      <svg
        class="chart__svg"
        :viewBox="`0 0 ${WIDTH} ${height}`"
        preserveAspectRatio="none"
        role="img"
        :aria-label="`${series.map((s) => s.label).join(', ')} over time`"
        @mousemove="onMove"
        @mouseleave="hoverIndex = null"
      >
        <!-- grid, recessive -->
        <g class="chart__grid">
          <line
            v-for="tick in ticks"
            :key="`g-${tick}`"
            :x1="PAD.left"
            :x2="WIDTH - PAD.right"
            :y1="y(tick)"
            :y2="y(tick)"
          />
        </g>

        <!-- y axis values -->
        <g class="chart__axis">
          <text
            v-for="tick in ticks"
            :key="`t-${tick}`"
            :x="PAD.left - 8"
            :y="y(tick) + 3.5"
            text-anchor="end"
          >{{ format(tick) }}</text>
        </g>

        <!-- x axis values -->
        <g class="chart__axis">
          <template v-for="(label, index) in labels" :key="`x-${index}`">
            <!-- The end labels anchor to their own edge rather than to their
                 centre. Centred, half of the last date hung past the right of
                 the viewBox and was clipped mid-word ("27 Auc"), because the
                 last point sits exactly on the plot's right edge. -->
            <text
              v-if="index % labelStride === 0 || index === labels.length - 1"
              :x="x(index)"
              :y="height - 8"
              :text-anchor="
                index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'
              "
            >{{ label }}</text>
          </template>
        </g>

        <line
          v-if="hoverIndex !== null"
          class="chart__crosshair"
          :x1="x(hoverIndex)"
          :x2="x(hoverIndex)"
          :y1="PAD.top"
          :y2="PAD.top + plot.h"
        />

        <path
          v-for="p in paths"
          :key="p.key"
          :d="p.d"
          class="chart__line"
          :style="{ stroke: p.color }"
        />

        <g v-if="hoverIndex !== null">
          <circle
            v-for="p in paths"
            :key="`d-${p.key}`"
            :cx="x(hoverIndex)"
            :cy="y(series.find((s) => s.key === p.key)?.values[hoverIndex] ?? 0)"
            r="4"
            class="chart__dot"
            :style="{ fill: p.color }"
          />
        </g>
      </svg>

      <div
        v-if="tooltip"
        class="chart__tooltip"
        :class="{ 'chart__tooltip--flip': tooltip.flip }"
        :style="{ left: `${tooltip.left}%` }"
        role="status"
      >
        <div class="chart__tooltip-label u-caption">{{ tooltip.label }}</div>
        <div v-for="row in tooltip.rows" :key="row.key" class="chart__tooltip-row">
          <span class="chart__swatch" :style="{ background: row.color }" aria-hidden="true"></span>
          <span class="chart__tooltip-name">{{ row.label }}</span>
          <span class="chart__tooltip-value u-num">{{ format(row.value) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.chart__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-4);
}

.chart__legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  background: none;
  border: none;
  padding: 2px 0;
  cursor: pointer;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  /* Text ink, never the series colour. The swatch beside it carries identity. */
  color: var(--text-secondary);
}

.chart__legend-item--off {
  opacity: 0.42;
  text-decoration: line-through;
}

.chart__swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  flex: none;
}

.chart__frame {
  position: relative;
}

.chart__svg {
  display: block;
  width: 100%;
  height: auto;
}

.chart__grid line {
  stroke: var(--chart-grid);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.chart__axis text {
  fill: var(--chart-axis);
  font-size: 11px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}

.chart__line {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.chart__crosshair {
  stroke: var(--border-dark);
  stroke-width: 1;
  stroke-dasharray: 3 3;
  vector-effect: non-scaling-stroke;
}

.chart__dot {
  /* The surface ring: 2px of background so overlapping dots stay separate. */
  stroke: var(--chart-gap);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.chart__tooltip {
  position: absolute;
  top: 0;
  transform: translateX(10px);
  pointer-events: none;
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-card);
  padding: var(--space-2) var(--space-3);
  min-width: 150px;
  z-index: 2;
}

.chart__tooltip--flip {
  transform: translateX(calc(-100% - 10px));
}

.chart__tooltip-label {
  margin-bottom: var(--space-1);
}

.chart__tooltip-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  padding: 1px 0;
}

.chart__tooltip-name {
  color: var(--text-secondary);
  flex: 1;
}

.chart__tooltip-value {
  color: var(--text-primary);
  font-weight: var(--weight-semibold);
}
</style>
