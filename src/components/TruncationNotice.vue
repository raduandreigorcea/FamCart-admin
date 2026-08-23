<script setup lang="ts">
import AppIcon from './AppIcon.vue'

// Shown when a client-side aggregate covered only part of the catalog.
//
// This is a different claim from every other state in the tool and needs its
// own voice. `empty` means nothing matched. `error` means the read failed and
// there are no numbers. StateBlock's `unrecorded` means nothing measures this.
// This one means: there ARE numbers on screen, they were computed correctly,
// and they are answers to a smaller question than the one the labels ask.
//
// That is the most dangerous state a dashboard can be in, because nothing about
// the figures looks wrong -- they are internally consistent, they just describe
// a prefix. So the notice sits ABOVE the numbers it qualifies rather than in a
// footnote, and it says which direction the error runs (everything undercounts)
// so a reader can reason about what they are looking at rather than only
// distrust it.

defineProps({
  /** Nothing renders when false, so callers can bind this unconditionally. */
  truncated: { type: Boolean, default: false },
  /** What the figures cover, named in the page's own terms. */
  subject: { type: String, default: 'These figures' },
})
</script>

<template>
  <div v-if="truncated" class="partial" role="status">
    <AppIcon class="partial__glyph" name="triangle-alert" :size="16" />
    <div class="partial__copy">
      <p class="partial__lead">{{ subject }} cover only part of the catalog.</p>
      <p class="partial__body">
        The client-side aggregate reached its row ceiling and stopped early, so every total below
        undercounts and every share is measured against the wrong denominator. Sources whose rows
        sort late may be missing entirely. Move the aggregate into the catalog project as a
        <code class="u-mono">catalog_stats()</code> function to fix this properly.
      </p>
    </div>
  </div>
</template>

<style scoped>
.partial {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--warning-bg);
  border: var(--border-width-thin) solid var(--warning-border);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-4);
}

.partial__glyph {
  color: var(--warning-text);
  flex: none;
  margin-top: 1px;
}

.partial__copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.partial__lead {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  color: var(--warning-text);
}

.partial__body {
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--text-secondary);
}
</style>
