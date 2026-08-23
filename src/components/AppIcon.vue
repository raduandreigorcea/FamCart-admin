<script setup lang="ts">
import { computed, type PropType } from 'vue'

// Every icon in the dashboard, in one place.
//
// This replaces a set of Unicode glyphs (◍ ⛶ ⌂ ❑ ⇥ ⌕ ⏱ ⚿) that were standing in
// for icons. They were a mistake for a reason worth writing down: a glyph is
// whatever the user's font decides it is. Plus Jakarta Sans has no coverage for
// most of those, so they fell through to a system font at a different weight and
// optical size, and several rendered as tofu boxes. An icon that renders as a
// rectangle on someone else's machine is not an icon.
//
// These are lucide, copied verbatim out of the lucide-static package by
// scripts/sync-icons.mjs, which can also verify them (npm run icons:check).
// Never edit a file in src/assets by hand: icon path data cannot be reviewed by
// reading it, so the only thing that makes it trustworthy is that it came from a
// package with a version number and still matches.
//
// ─── WHY ?raw AND v-html ─────────────────────────────────────────────────────
//
// Same pattern FamCart uses, for the same reason: the alternative is an <img>,
// which cannot inherit currentColor, so every icon would need a hardcoded colour
// and would not follow the theme. Everything bound here is build-time content
// from this repository, resolved through a static map below. No user data, no
// network, no database value ever reaches it, and the eager glob means an
// unknown name cannot resolve to anything at all.

// eager: the whole set is ~1KB of markup and lazy-loading 30 tiny files would
// mean 30 requests and a frame of empty boxes on first paint.
const FILES = import.meta.glob('../assets/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([path, markup]) => [
    path.replace('../assets/', '').replace('.svg', ''),
    markup,
  ]),
)

export type IconName = string

const props = defineProps({
  name: { type: String as PropType<IconName>, required: true },
  /** Rendered size in px. The 24px viewBox scales to it. */
  size: { type: Number, default: 16 },
  /**
   * Stroke weight. FamCart's files carry 1, which suits icons drawn large on a
   * phone; at 16px in a dense table that reads as a smudge, so the default here
   * is heavier. Set as a CSS property, which wins over the presentation
   * attribute baked into the file.
   */
  stroke: { type: Number, default: 1.75 },
  /**
   * Icons are decoration beside a label almost everywhere in this tool, so they
   * are hidden from screen readers by default. Pass a label for the few that
   * carry meaning alone.
   */
  label: { type: String, default: '' },
})

const markup = computed(() => ICONS[props.name] ?? '')

const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  '--icon-stroke': String(props.stroke),
}))
</script>

<template>
  <!-- v-html is safe by construction here, and narrowly so: `markup` can only be
       a value from the eager import.meta.glob above, i.e. a .svg file in this
       repo resolved at build time. An unknown name yields '' and renders
       nothing. No user data, no database value and no network response can reach
       it. Disabled around this one element rather than in eslint.config.js, so a
       genuine misuse of v-html anywhere else still fails the build. -->
  <!-- eslint-disable vue/no-v-html -->
  <span
    v-if="markup"
    class="icon"
    :style="style"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    v-html="markup"
  ></span>
  <!-- eslint-enable vue/no-v-html -->
</template>

<style scoped>
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  color: inherit;
}

/* :deep because the svg arrives through v-html and so carries no scope id. */
.icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
  stroke-width: var(--icon-stroke);
}
</style>
