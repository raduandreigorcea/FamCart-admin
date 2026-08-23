<script setup lang="ts">
// The one container. Everything on a page is one of these, so the page is a
// grid of panels and nothing has to invent its own frame.
//
// It owns the header row (title, an optional note, and an actions slot) and
// nothing else. Body layout belongs to whatever is inside, because a table, a
// chart and a definition list want different padding and a container that tries
// to serve all three ends up fighting each of them.

defineProps({
  title: { type: String, default: '' },
  /** One line under the title. Where a derived metric admits it is derived. */
  note: { type: String, default: '' },
  /** Removes body padding, for a table that should meet the panel edge. */
  flush: { type: Boolean, default: false },
  /** Lets the panel stretch to its grid row rather than hug its content. */
  fill: { type: Boolean, default: false },
})
</script>

<template>
  <section class="panel" :class="{ 'panel--fill': fill }">
    <header v-if="title || $slots.actions" class="panel__head">
      <div class="panel__heading">
        <h3 v-if="title" class="panel__title">{{ title }}</h3>
        <p v-if="note" class="panel__note">{{ note }}</p>
      </div>
      <div v-if="$slots.actions" class="panel__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="panel__body" :class="{ 'panel__body--flush': flush }">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="panel__foot">
      <slot name="footer" />
    </footer>
  </section>
</template>

<style scoped>
.panel {
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  /* Deliberately tighter than FamCart's AppCard, which rounds at 24px. That
     radius is right for a single card on a phone; at a grid of twelve panels it
     reads as soft and eats the alignment between their edges. */
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  min-width: 0;
  box-shadow: var(--elevation-soft);
}

.panel--fill {
  height: 100%;
}

.panel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--border-width-thin) solid var(--border-light);
  min-height: 44px;
}

.panel__heading {
  min-width: 0;
}

.panel__title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.panel__note {
  margin: 2px 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: var(--leading-snug);
}

.panel__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.panel__body {
  padding: var(--space-4);
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.panel__body--flush {
  padding: 0;
}

.panel__foot {
  padding: var(--space-2) var(--space-4);
  border-top: var(--border-width-thin) solid var(--border-light);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
</style>
