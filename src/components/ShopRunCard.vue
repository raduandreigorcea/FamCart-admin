<script setup lang="ts">
import { computed, type PropType } from 'vue'
import StatusPill from './StatusPill.vue'
import CountryCode from './CountryCode.vue'
import type { Tone } from '../lib/uiTypes'
import { formatCount } from '../lib/format'

// One shop's run, as a card. Health and Scrapers both draw a row of these, and
// they had drifted into two copies of the same markup with different rules for
// when a card got a coloured edge.
//
// It is presentational: the view decides what the run means (the tone, the
// label, which facts matter) and this only draws it. Health judges a shop by
// its last run against the one before; Scrapers watches a run in progress. Same
// card, different questions.
//
// Every card has an edge in the colour of its state, and the pill beside the
// name says the same thing in words, so colour never carries it alone:
//   good  green   finished and held up
//   live  blue    still reading
//   warn  amber   finished but needs a look (refused to sweep, found fewer)
//   bad   red     failed
//   idle  grey    never run, or switched off

export interface ShopFact {
  label: string
  value: string
  title?: string
}

type CardTone = Exclude<Tone, 'accent'>

const props = defineProps({
  name: { type: String, default: '' },
  /** Market code, shown beside the name: nine shops are called Lidl. */
  country: { type: String, default: '' },
  /** A line under the country's name on hover, e.g. how many shops it has. */
  countryNote: { type: String, default: '' },
  tone: { type: String as PropType<CardTone>, default: 'idle' },
  label: { type: String, default: '' },
  /** The pill's dot becomes a spinner. */
  running: { type: Boolean, default: false },
  /** Somebody should act on this one: the card is tinted, not only edged. */
  attention: { type: Boolean, default: false },
  /** The headline figure, already formatted by the view. */
  count: { type: String, default: '--' },
  countTitle: { type: String, default: '' },
  /** Words after the figure: "products read", "of about 8,875 so far". */
  unit: { type: String, default: '' },
  /** Change against the previous run. Hidden when null or zero. */
  delta: { type: Number as PropType<number | null>, default: null },
  deltaTitle: { type: String, default: '' },
  /** How far a running crawl has got against what it is expected to read. */
  progress: { type: Object as PropType<{ value: number; max: number } | null>, default: null },
  when: { type: String, default: '' },
  whenTitle: { type: String, default: '' },
  facts: { type: Array as PropType<ShopFact[]>, default: () => [] },
  /** What the run said. The one sentence on the card worth reading. */
  message: { type: String as PropType<string | null>, default: null },
  /** Draws the card's shape with nothing in it. */
  loading: { type: Boolean, default: false },
})

const percent = computed(() =>
  props.progress && props.progress.max > 0
    ? Math.min(100, Math.round((props.progress.value / props.progress.max) * 100))
    : null,
)
</script>

<template>
  <li v-if="loading" class="shop shop--loading" aria-hidden="true">
    <div class="shop__head">
      <span class="u-skeleton sk sk--name"></span>
      <span class="u-skeleton sk sk--pill"></span>
    </div>
    <span class="u-skeleton sk sk--count"></span>
    <span class="u-skeleton sk sk--line"></span>
    <div class="shop__facts">
      <span v-for="n in 3" :key="n" class="u-skeleton sk sk--fact"></span>
    </div>
  </li>

  <li
    v-else
    class="shop"
    :class="[`shop--${tone}`, { 'shop--attention': attention, 'shop--running': running }]"
  >
    <div class="shop__head">
      <h4 class="shop__name">
        {{ name }}
        <CountryCode v-if="country" :code="country" :note="countryNote" />
      </h4>
      <StatusPill :tone="tone" :label="label" :busy="running" />
    </div>

    <p class="shop__count">
      <span class="shop__number u-num" :title="countTitle || undefined">{{ count }}</span>
      <span v-if="unit" class="shop__unit">{{ unit }}</span>
      <!-- A run that read a tenth of a shop and finished cleanly looks identical
           to a good one until the previous number is beside it. -->
      <span
        v-if="delta"
        class="shop__delta u-num"
        :class="delta > 0 ? 'shop__delta--up' : 'shop__delta--down'"
        :title="deltaTitle || undefined"
      >{{ delta > 0 ? '+' : '' }}{{ formatCount(delta) }}</span>
    </p>

    <div
      v-if="progress && percent !== null"
      class="shop__progress"
      role="progressbar"
      :aria-valuenow="progress.value"
      aria-valuemin="0"
      :aria-valuemax="progress.max"
      :aria-label="`${name}: ${percent}% of what its last full run read`"
    >
      <span class="shop__bar" :style="{ width: `${percent}%` }"></span>
    </div>

    <p v-if="when" class="shop__when" :title="whenTitle || undefined">{{ when }}</p>

    <dl v-if="facts.length" class="shop__facts">
      <div v-for="fact in facts" :key="fact.label">
        <dt>{{ fact.label }}</dt>
        <dd class="u-num" :title="fact.title">{{ fact.value }}</dd>
      </div>
    </dl>

    <p v-if="message" class="shop__why" :title="message">{{ message }}</p>
  </li>
</template>

<style scoped>
.shop {
  --edge: var(--status-idle);
  --tint: var(--status-idle-bg);
  --ink: var(--text-secondary);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4) var(--space-4) var(--space-4) var(--space-5);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  /* An inset edge rather than a border-left: it follows the card's rounding and
     does not shift the content by its own width when the state changes. */
  box-shadow: inset 4px 0 0 var(--edge);
  min-width: 0;
}

.shop--good { --edge: var(--status-good); --tint: var(--status-good-bg); --ink: var(--status-good); }
.shop--live { --edge: var(--status-live); --tint: var(--status-live-bg); --ink: var(--status-live-ink); }
.shop--warn { --edge: var(--status-warn-edge); --tint: var(--status-warn-bg); --ink: var(--status-warn); }
.shop--bad { --edge: var(--status-bad); --tint: var(--status-bad-bg); --ink: var(--status-bad); }

/* Every state washes the card in its own tint, so no one state reads as the odd
   card out. A shop somebody has to act on gets a stronger wash. */
.shop {
  background: color-mix(in srgb, var(--tint) 40%, var(--bg-surface));
}

.shop--attention {
  background: color-mix(in srgb, var(--tint) 70%, var(--bg-surface));
}

.shop__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}

.shop__name {
  margin: 0;
  min-width: 0;
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  /* Not --leading-tight. With overflow hidden (for the ellipsis) a tight line
     box clips the descenders: the g of "Mega Image" lost its tail. */
  line-height: var(--leading-snug);
  text-transform: capitalize;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shop__count {
  margin: 0;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  column-gap: var(--space-2);
}

.shop__number {
  font-size: var(--text-2xl);
  font-weight: var(--weight-bold);
  line-height: var(--leading-tight);
  color: var(--text-primary);
}

.shop__unit,
.shop__when {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.shop__when {
  margin: 0;
}

.shop__delta {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
}

.shop__delta--up { color: var(--status-good); }
.shop__delta--down { color: var(--status-bad); }

.shop__progress {
  height: 6px;
  margin: var(--space-1) 0;
  border-radius: var(--radius-pill);
  background: var(--border-light);
  overflow: hidden;
}

.shop__bar {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--status-live);
  transition: width 0.6s ease;
}

.shop__facts {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  padding-top: var(--space-3);
  border-top: var(--border-width-thin) solid var(--border-light);
}

.shop__facts dt {
  font-size: var(--text-2xs);
  color: var(--text-secondary);
}

.shop__facts dd {
  /* The browser indents a <dd> by 40px, which is what pushed every value off
     its label in the first version of these cards. */
  margin: 0;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

/* Pinned to the bottom, so the messages of a row of cards line up whatever the
   cards above them hold. */
.shop__why {
  margin: auto 0 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--tint);
  color: var(--ink);
  font-size: var(--text-xs);
  line-height: var(--leading-snug);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.shop__facts + .shop__why {
  margin-top: var(--space-3);
}

/* ── loading ─────────────────────────────────────────────────────────────── */

.sk--name { width: 7rem; height: 14px; }
.sk--pill { width: 4.5rem; height: 18px; border-radius: var(--radius-pill); }
.sk--count { width: 5rem; height: 26px; margin-top: var(--space-1); }
.sk--line { width: 9rem; height: 11px; margin-top: var(--space-1); }
.sk--fact { height: 28px; }

@media (prefers-reduced-motion: reduce) {
  .shop__bar { transition: none; }
}
</style>
