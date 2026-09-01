<script setup lang="ts">
import { computed, type PropType } from 'vue'
import SparkLine from './SparkLine.vue'
import AppIcon from './AppIcon.vue'
import { formatBytes, formatCompact, formatCount, formatPercent } from '../lib/format'
import type { Delta } from '../lib/data/overview'

// One number, said once, with just enough around it to know whether it is good.
//
// The compact form (10.8k) is the headline and the exact figure is the title
// attribute, because a tile is read at a glance and a table is read for
// precision. Tables never use formatCompact for the same reason.

const props = defineProps({
  label: { type: String, required: true },
  value: { type: Number as PropType<number | null>, default: null },
  /**
   * What `value` is measured in. `count` is a number of things and gets the
   * compact form; `bytes` is a size and gets 12.5 MB, because 13.1M bytes is a
   * quantity nobody thinks in.
   */
  format: { type: String as PropType<'count' | 'bytes'>, default: 'count' },
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

const display = computed(() => {
  if (props.value === null) return '--'
  return props.format === 'bytes' ? formatBytes(props.value) : formatCompact(props.value)
})
const exact = computed(() => {
  if (props.value === null) return ''
  return props.format === 'bytes' ? `${formatCount(props.value)} bytes` : formatCount(props.value)
})

const deltaText = computed(() => {
  const d = props.delta
  if (!d) return null
  const sign = d.change > 0 ? '+' : ''
  // A ratio against a previous window of zero is not "+100%", it is a first
  // occurrence. Saying "new" is the truthful version.
  const ratio = d.ratio === null ? 'new' : formatPercent(Math.abs(d.ratio))
  return { text: `${sign}${formatCount(d.change)}`, ratio, change: d.change }
})

// The foot says the same kind of thing in both states -- what the number counts,
// or why there is no number -- so it is one line of copy, not two elements.
const footHint = computed(() => (props.unrecorded ? props.unrecordedReason : props.hint))

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

    <!-- One seat, two states, rather than two layouts that happen to look alike.
         The rule has to be drawn on the same line whether or not there is a
         number on it: that is the entire device, and two separate blocks had
         drifted twelve pixels apart, which turned the empty tile from "nobody
         recorded this" into "this tile has slipped out of the row". -->
    <div class="tile__row" :class="{ 'tile__row--empty': unrecorded }">
      <div v-if="unrecorded" class="tile__nodata">Not recorded</div>
      <template v-else>
        <div class="tile__value u-num" :title="exact">{{ display }}</div>
        <SparkLine
          v-if="spark.length > 1"
          class="tile__spark"
          :values="spark"
          :stroke="sparkColor"
          :label="`${label} trend`"
        />
      </template>
    </div>

    <div class="tile__foot">
      <span
        v-if="!unrecorded && deltaText"
        class="tile__delta"
        :class="`tile__delta--${deltaTone}`"
      >
        <AppIcon
          :name="deltaTone === 'up' ? 'arrow-up' : deltaTone === 'down' ? 'arrow-down' : 'minus'"
          :size="11"
        />
        {{ deltaText.text }}
        <span class="tile__ratio">{{ deltaText.ratio }}</span>
      </span>
      <span v-if="footHint" class="tile__hint">{{ footHint }}</span>
    </div>
  </div>
</template>

<style scoped>
.tile {
  /* The clearance that keeps a sparkline's last point off the rule. */
  --tile-lift: 3px;
  /* The seat: everything from the top of the value to the underside of the
     rule, so the rule lands on one line across a row of tiles whatever each
     tile happens to hold -- a figure, a figure with a sparkline, or the
     "Not recorded" treatment, which is a third shorter than the other two.
     Stated as a border-box height, because that is what min-height measures
     under the global border-box sizing. */
  --tile-seat: calc(
    var(--text-3xl) + var(--tile-lift) + var(--space-1-5) + var(--rule-weight)
  );
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
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

/* The rule.
 *
 * Every measured value on this screen sits on one. It is not a divider: it is
 * the baseline the number rests on, and its whole job is that an EMPTY one
 * reads as "nobody recorded this" rather than as a zero. types.ts makes that
 * argument in prose; this is the same argument in a line. */
.tile__row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--tile-seat);
  padding-bottom: var(--space-1-5);
  border-bottom: var(--rule-weight) solid var(--rule-ink);
}

/* Seated ON the rule, and sized so the seating reads.
 *
 * A number at text-2xl floating a few pixels above a hairline looks like text
 * that happens to have a border under it. Bigger, tighter and sat right down on
 * a drawn baseline looks like a figure entered on a form, which is what every
 * value in this tool actually is. */
.tile__value {
  font-size: var(--text-3xl);
  font-weight: var(--weight-bold);
  line-height: 1;
  color: var(--text-primary);
  /* Compared down a column far more often than read in a sentence, so the
     figure widths are locked and the eye gets a grid to run down. */
  font-variant-numeric: var(--value-figures);
  letter-spacing: var(--value-tracking);
}


.tile__spark {
  width: 92px;
  flex: none;
  margin-bottom: var(--tile-lift);
}

.tile__foot {
  display: flex;
  /* Centred, not baseline-aligned. A flex item whose first child is an icon
     with no text in it has no baseline of its own, so the browser synthesises
     one from the icon's bottom edge -- which is why the delta caret sat a pixel
     high. The delta and the hint are both --text-2xs, so centring them puts
     their baselines together anyway, without depending on that. */
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  min-height: 16px;
}

.tile__delta {
  display: inline-flex;
  align-items: center;
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
  border-color: var(--unrecorded-line);
  background-color: var(--unrecorded-bg);
}

/* The empty rule, and the whole point of the device.
 *
 * A recorded tile rests its number on a solid baseline. This one shows the same
 * baseline with nothing on it, hatched the way a blank field on a form is
 * hatched. Read down a column of tiles and the ones nobody measured are obvious
 * at a glance instead of being grey text you have to stop and parse.
 *
 * The tile's own border stays ordinary. It was dashed as well, which was two
 * devices saying the same thing, and the quieter one had to go. */
.tile__nodata {
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  color: var(--text-disabled);
  line-height: 1.4;
}

/* The empty rule, and the whole point of the device: the same seat, on the same
   line as its neighbours, hatched the way a blank field on a form is hatched. */
.tile__row--empty {
  border-bottom-color: var(--rule-empty);
  background-image: var(--rule-hatch);
  background-repeat: no-repeat;
  background-position: left bottom var(--rule-weight);
  background-size: 100% 10px;
}
</style>
