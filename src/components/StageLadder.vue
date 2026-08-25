<script setup lang="ts">
import { computed } from 'vue'
import { formatCount } from '../lib/format'

// The pipeline, drawn as what it is.
//
// This replaced a bar chart of read / rejected / dropped / review / auto, which
// put five numbers side by side as peers. They are not peers. They are one
// survivor and four kinds of loss, at four different moments, and drawing them
// as equals threw away the only thing the sequence had to say: how much of what
// arrived is still standing by the end.
//
// So it is one track, divided by outcome. Landed and the losses sum to exactly
// what was read, the width of each part IS its count, and every label sits under
// the part it names. "A quarter of what we read is in the catalog" is something
// you see before you read a single figure.

interface Funnel {
  read: number
  rejected: number
  dropped: number
  review: number
  auto: number
  capped: number
}

const props = defineProps<{ funnel: Funnel }>()

/**
 * Where everything went, as parts of one whole.
 *
 * The first draft drew this as a band that narrowed stage by stage, with each
 * loss hanging under the point it fell. It did not survive contact: the entry
 * segment was 100% wide and shared a flex row with the rest, so everything
 * shrank and the proportions lied, and the losses sat in an evenly spaced grid
 * that lined up with nothing. The idea it was meant to carry -- this much fell
 * out, here -- was the one thing it failed to show.
 *
 * So: one track. Landed plus the three losses is exactly what was read, which
 * makes them parts of a whole rather than a sequence of shrinking bars, and it
 * means every label sits under its own segment by construction instead of by
 * arithmetic that has to be kept in step.
 *
 * Landed leads because it is the answer to the question somebody came with.
 */
const parts = computed(() => {
  const f = props.funnel
  return [
    {
      key: 'auto',
      label: 'Landed',
      count: f.auto,
      tone: 'kept',
      why: 'Cleared the gate and is in the catalog now',
    },
    {
      key: 'review',
      label: 'Waiting on you',
      count: f.review,
      tone: 'held',
      why: 'The gate could not decide. These are the ones on the Review page',
    },
    {
      key: 'dropped',
      label: 'Dropped',
      count: f.dropped,
      tone: 'shed',
      why: 'Scored, and below the bar the gate sets',
    },
    {
      key: 'rejected',
      label: 'Rejected',
      count: f.rejected,
      tone: 'shed',
      why: 'Unusable before scoring: no name, no barcode, malformed',
    },
    {
      key: 'capped',
      label: 'Over the cap',
      count: f.capped,
      tone: 'shed',
      why: 'Good enough, but the market already had its fill',
    },
  ].filter((p) => p.count > 0)
})

const landed = computed(() => props.funnel.auto)

/**
 * Share of what was read.
 *
 * Floored at 3% so a part that is a rounding error is still wide enough to
 * carry its own label rather than collapsing to a sliver with text spilling
 * out either side.
 */
function share(n: number): number {
  const read = props.funnel.read || 1
  return Math.max(3, (n / read) * 100)
}

const survivalRate = computed(() =>
  props.funnel.read ? Math.round((landed.value / props.funnel.read) * 100) : 0,
)
</script>

<template>
  <div class="ladder">
    <div class="ladder__ends">
      <div class="end">
        <span class="end__label u-caption">Read from the subset</span>
        <span class="end__value u-num">{{ formatCount(funnel.read) }}</span>
      </div>
      <div class="end end--out">
        <span class="end__label u-caption">Landed in the catalog</span>
        <span class="end__value u-num">{{ formatCount(landed) }}</span>
        <span class="end__rate">{{ survivalRate }}% of what was read</span>
      </div>
    </div>

    <!-- One track and one row of labels, driven by the same widths, so a part
         and its name can never drift apart. -->
    <div
      class="track"
      role="img"
      :aria-label="`Of ${formatCount(funnel.read)} records read, ${formatCount(landed)} landed in the catalog.`"
    >
      <span
        v-for="p in parts"
        :key="p.key"
        class="track__part"
        :class="`track__part--${p.tone}`"
        :style="{ flexBasis: `${share(p.count)}%` }"
      ></span>
    </div>

    <ol class="parts">
      <li
        v-for="p in parts"
        :key="p.key"
        class="part"
        :class="`part--${p.tone}`"
        :style="{ flexBasis: `${share(p.count)}%` }"
      >
        <span class="part__count u-num">{{ formatCount(p.count) }}</span>
        <span class="part__label">{{ p.label }}</span>
        <span class="part__why">{{ p.why }}</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.ladder {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-5) var(--space-4);
}

.ladder__ends {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: var(--space-4);
}

.end {
  display: flex;
  flex-direction: column;
  gap: var(--caption-gap);
  min-width: 0;
}

.end--out {
  text-align: right;
  align-items: flex-end;
}

.end__label {
  color: var(--text-secondary);
}

.end__value {
  font-size: var(--text-3xl);
  font-weight: var(--weight-bold);
  line-height: 1;
  letter-spacing: var(--value-tracking);
  color: var(--text-primary);
}

.end--out .end__value {
  color: var(--chart-seq-5);
}

.end__rate {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

/* One track. Width is the count, and the labels below share the same basis, so
   a segment and its name are the same measurement rather than two that have to
   be kept in agreement. */
.track {
  display: flex;
  align-items: stretch;
  gap: 3px;
  height: 14px;
}

.track__part {
  border-radius: var(--radius-pill);
  min-width: 6px;
  flex-grow: 1;
  flex-shrink: 1;
}

/* Kept, held, shed. Three states and three tones: the catalog green for what
   landed, a lighter step of the same ramp for what is waiting on a person, and
   the set-aside grey for what will never land. Not red: a run that discards
   twelve thousand unusable rows is a run doing its job. */
.track__part--kept { background: var(--chart-seq-5); }
.track__part--held { background: var(--chart-seq-3); }
.track__part--shed { background: var(--stage-shed); }

.parts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  gap: var(--space-3);
}

.part {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex-grow: 1;
  flex-shrink: 1;
  padding-top: var(--space-2);
  border-top: var(--rule-weight) solid transparent;
}

.part--kept { border-top-color: var(--chart-seq-5); }
.part--held { border-top-color: var(--chart-seq-3); }
.part--shed { border-top-color: var(--stage-shed); }

.part__count {
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
  line-height: 1.1;
  letter-spacing: var(--value-tracking);
  color: var(--text-primary);
}

.part--shed .part__count {
  color: var(--stage-shed-ink);
}

.part__label {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.part__why {
  font-size: var(--text-2xs);
  line-height: var(--leading-snug);
  color: var(--text-secondary);
}

@media (max-width: 720px) {
  .ladder__ends {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
  }

  .end--out {
    text-align: left;
    align-items: flex-start;
  }

  /* Below this the segments are too narrow to carry a sentence each, so the
     labels stack and the track stays as the only proportional thing. */
  .parts {
    flex-direction: column;
    gap: var(--space-3);
  }

  .part {
    flex-basis: auto !important;
  }
}
</style>
