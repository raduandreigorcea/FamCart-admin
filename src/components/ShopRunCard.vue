<script setup lang="ts">
import { computed, type PropType } from 'vue'
import { RouterLink } from 'vue-router'
import StatusPill from './StatusPill.vue'
import CountryCode from './CountryCode.vue'
import AppIcon from './AppIcon.vue'
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
  /** What the bar measures, said under it: "1,200 of 3,568 departments". */
  progressLabel: { type: String, default: '' },
  /**
   * A bar that says only "working": a run with no plan reported and no earlier
   * run to compare with. It still moves, and a card with no bar read as a run
   * that was going nowhere.
   */
  indeterminate: { type: Boolean, default: false },
  /** Finished and held up: a tick beside the bar. */
  done: { type: Boolean, default: false },
  /** Ended badly: a cross where the tick would be, in the same place. */
  failed: { type: Boolean, default: false },
  /**
   * What KIND of job this was, when it is not the ordinary one -- "Removal".
   *
   * Beside the name rather than in the pill, because the kind and the outcome
   * are different questions and the pill answers the outcome. Folded into the
   * pill, a removal job that failed said only "Failed", which is how both real
   * ones read after they crashed at the end of a successful crawl.
   */
  kind: { type: String, default: '' },
  /** Draws the card's shape with nothing in it. */
  loading: { type: Boolean, default: false },
  /** The run's own page. The name becomes the link and the whole card its target. */
  to: { type: String, default: '' },
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
        <!-- One line, and the space spelled out: between two elements the
             template compiler drops a newline, and the name ran into its
             country ("LidlRO"). -->
        <RouterLink v-if="to" :to="to" class="shop__link">{{ name }}</RouterLink><template v-else>{{ name }}</template>{{ ' ' }}<CountryCode v-if="country" :code="country" :note="countryNote" />
        <span v-if="kind" class="shop__kind">{{ kind }}</span>
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

    <!-- Every row is drawn on every card, empty or not, so a row of cards
         lines up: the bar, its caption and the facts sit at the same height
         whatever a run has to say. -->
    <div class="shop__track">
      <div
        v-if="progress && percent !== null"
        class="shop__progress"
        role="progressbar"
        :aria-valuenow="progress.value"
        aria-valuemin="0"
        :aria-valuemax="progress.max"
        :aria-label="`${name}: ${percent}%${progressLabel ? `, ${progressLabel}` : ''}`"
      >
        <span class="shop__bar" :style="{ width: `${percent}%` }"></span>
      </div>
      <div
        v-else-if="indeterminate"
        class="shop__progress shop__progress--indeterminate"
        role="progressbar"
        :aria-label="`${name}: working, nothing to measure against yet`"
      >
        <span class="shop__bar"></span>
      </div>
      <div v-else class="shop__progress" aria-hidden="true"></div>
      <!-- Always there, hidden while a run is still going, so every bar is the
           same length. One slot for both endings: a run is one or the other. -->
      <AppIcon
        class="shop__mark"
        :class="[failed ? 'shop__mark--bad' : 'shop__mark--good', { 'shop__mark--off': !done && !failed }]"
        :name="failed ? 'x' : 'check'"
        :size="14"
        :label="failed ? 'Failed' : done ? 'Finished' : ''"
      />
    </div>
    <p class="shop__plan u-num">{{ progress && percent !== null ? progressLabel : '' }}&nbsp;</p>

    <p v-if="when" class="shop__when" :title="whenTitle || undefined">{{ when }}</p>

    <dl v-if="facts.length" class="shop__facts">
      <div v-for="fact in facts" :key="fact.label">
        <dt>{{ fact.label }}</dt>
        <dd class="u-num" :title="fact.title">{{ fact.value }}</dd>
      </div>
    </dl>

    <p
      class="shop__why"
      :class="{ 'shop__why--empty': !message }"
      :title="message || undefined"
      :aria-hidden="message ? undefined : 'true'"
    >{{ message }}&nbsp;</p>
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
  /* The card answers to its own width, not the window's: the same 240px card
     turns up in a five-wide row on a laptop and a two-wide one on a narrowed
     window, and only the card knows which. See the @container rules below. */
  container-type: inline-size;
}

/* One real link, on the name, stretched over the card by ::after. Not a card
   wrapped in <a>: the card holds a hover card (the country) and a list, and an
   <a> around those is invalid and reads as one enormous link to a screen
   reader. The position: relative is what the ::after measures against. */
.shop {
  position: relative;
}

.shop__link {
  color: inherit;
  text-decoration: none;
}

.shop__link::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
}

.shop__link:focus-visible {
  outline: none;
}

.shop:has(.shop__link:focus-visible) {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.shop:has(.shop__link):hover {
  border-color: var(--color-primary);
}

/* The country's hover card stays reachable above the stretched link. */
.shop__name :deep(.hover) {
  position: relative;
  z-index: 1;
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

/* Quieter than the name it follows: this says what the run was, and the run's
   own numbers are what the card is for. `capitalize` on the name would make it
   "Removal" whatever it is given, so the case here is the caller's. */
.shop__kind {
  margin-left: var(--space-1);
  padding: 0 var(--space-1);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  text-transform: none;
  vertical-align: middle;
}

.shop__count {
  margin: 0;
  display: flex;
  align-items: baseline;
  /* One line on every card: a unit that wrapped pushed the rest down. */
  flex-wrap: nowrap;
  column-gap: var(--space-2);
  min-width: 0;
}

.shop__unit {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  /* Room for two lines on every card: "running for 2 h 22 min · alive 57 s
     ago" wraps where "took 8 min" does not. */
  line-height: var(--leading-snug);
  min-height: calc(2em * var(--leading-snug));
}

.shop__delta {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
}

.shop__delta--up { color: var(--status-good); }
.shop__delta--down { color: var(--status-bad); }

.shop__track {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-1) 0;
}

.shop__progress {
  flex: 1;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--border-light);
  overflow: hidden;
}

.shop__bar {
  display: block;
  height: 100%;
  border-radius: inherit;
  /* The card's own state: blue while reading, green once done, red where a
     failed run stopped. */
  background: var(--edge);
  transition: width 0.6s ease;
}

.shop__mark {
  flex: none;
}

.shop__mark--good { color: var(--status-good); }
.shop__mark--bad { color: var(--status-bad); }

.shop__mark--off {
  visibility: hidden;
}

/* A third of the track, sliding, for a run with nothing to measure against. */
.shop__progress--indeterminate .shop__bar {
  width: 33%;
  animation: shop-slide 1.6s ease-in-out infinite;
}

@keyframes shop-slide {
  from { transform: translateX(-100%); }
  to { transform: translateX(300%); }
}

@media (prefers-reduced-motion: reduce) {
  .shop__progress--indeterminate .shop__bar {
    animation: none;
    width: 100%;
    opacity: 0.4;
  }
}

.shop__plan {
  margin: 0;
  font-size: var(--text-2xs);
  color: var(--text-secondary);
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

/* Two lines' worth on every card, a message or not. */
.shop__why {
  min-height: calc(2em * var(--leading-snug) + 2 * var(--space-2));
}

.shop__why--empty {
  visibility: hidden;
}

/* ── a narrow card ───────────────────────────────────────────────────────── */

/* Under 17rem "products read so far" no longer fits beside the figure and was
   ellipsised to "products read so...". So the unit takes its own line -- on
   EVERY card of that width, which is why this is a container query and not a
   wrap: cards in a row share a width, so they switch together and still line up,
   where a wrap would move only the cards whose unit happened to be long.

   The when-line gets a third line's room for the same reason: "running for 1 h
   13 min · alive 39 s ago" runs to three here, "took 14 min" does not, and the
   facts under it have to sit level across the row. */
@container (max-width: 17rem) {
  .shop__count {
    flex-wrap: wrap;
  }

  .shop__unit {
    flex-basis: 100%;
    order: 1;
  }

  .shop__when {
    min-height: calc(3em * var(--leading-snug));
  }
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
