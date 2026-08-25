<script setup lang="ts">
import type { PropType } from 'vue'

// Loading, empty and error, as one component, because a panel that hand-rolls
// them gets one of them wrong. Most often it is the difference between "empty"
// and "still loading", which look identical if you render an empty array.
//
// `unrecorded` is the fourth state and the one this tool needed that a normal
// dashboard does not. It means the number does not exist because nothing
// measures it -- not that the measurement came back zero. It is drawn hatched so
// the two can never be confused at a glance, and it names what would have to be
// built, because a dead end that tells you the way out is not a dead end.

defineProps({
  state: {
    type: String as PropType<'loading' | 'empty' | 'error' | 'unrecorded'>,
    required: true,
  },
  title: { type: String, default: '' },
  message: { type: String, default: '' },
  /** Only for `unrecorded`: what would have to exist. */
  wouldRequire: { type: String, default: '' },
  /** Rows to fake while loading, so the skeleton is the shape of the answer. */
  lines: { type: Number, default: 3 },
  compact: { type: Boolean, default: false },
})
</script>

<template>
  <div class="state" :class="{ 'state--compact': compact }">
    <template v-if="state === 'loading'">
      <div class="skeleton" role="status" aria-live="polite">
        <span class="u-sr">Loading</span>
        <div v-for="line in lines" :key="line" class="skeleton__line" :style="{ width: `${92 - line * 11}%` }"></div>
      </div>
    </template>

    <template v-else-if="state === 'unrecorded'">
      <div class="unrecorded">
        <div class="unrecorded__head">
          <span class="unrecorded__tag">Not recorded</span>
          <h4 v-if="title" class="unrecorded__title">{{ title }}</h4>
        </div>
        <p v-if="message" class="unrecorded__body">{{ message }}</p>
        <p v-if="wouldRequire" class="unrecorded__fix">
          <span class="unrecorded__fix-label u-caption">To measure it</span>
          {{ wouldRequire }}
        </p>
      </div>
    </template>

    <template v-else>
      <div class="message" :class="{ 'message--error': state === 'error' }">
        <h4 v-if="title" class="message__title">{{ title }}</h4>
        <p v-if="message" class="message__body">{{ message }}</p>
        <slot name="action" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.state {
  padding: var(--space-6) var(--space-5);
}

.state--compact {
  padding: var(--space-4);
}

/* ── loading ─────────────────────────────────────────────────────────────── */

.skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.skeleton__line {
  height: 12px;
  border-radius: var(--radius-xs);
  background: linear-gradient(
    90deg,
    var(--bg-hover) 25%,
    var(--border-light) 37%,
    var(--bg-hover) 63%
  );
  background-size: 400% 100%;
  animation: skeleton-slide 1.4s ease infinite;
}

@keyframes skeleton-slide {
  from { background-position: 100% 50%; }
  to { background-position: 0 50%; }
}

/* ── empty and error ─────────────────────────────────────────────────────── */

.message {
  text-align: center;
  max-width: 46ch;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: center;
}

.message__title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.message--error .message__title {
  color: var(--danger-text);
}

.message__body {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--text-secondary);
}

/* ── not recorded ────────────────────────────────────────────────────────── */
/* The hatch is the whole point: it reads as "no signal here" at a glance and
   cannot be mistaken for a panel reporting a real zero. Kept low-contrast so it
   is texture rather than pattern.

   It is --rule-hatch rather than a gradient of its own. This block and the empty
   rule under a stat tile are the same statement at two sizes -- "nobody recorded
   this" -- and they were drawn at different angles and different pitches, which
   made them look like two unrelated textures instead of one idea. */
.unrecorded {
  border: var(--border-width-thin) dashed var(--unrecorded-line);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  background-color: var(--unrecorded-bg);
  background-image: var(--rule-hatch);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.unrecorded__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.unrecorded__tag {
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caption);
  color: var(--unrecorded-ink);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-pill);
  padding: 0.1rem var(--space-2);
}

.unrecorded__title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.unrecorded__body,
.unrecorded__fix {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--text-secondary);
  /* The copy sits on the hatch, so it gets its own plate to stay readable. */
  background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
}

.unrecorded__fix-label {
  display: block;
  margin-bottom: var(--caption-gap);
}
</style>
