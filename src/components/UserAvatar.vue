<script setup lang="ts">
import { computed, type PropType } from 'vue'
import { initialOf } from '../lib/format'

// One person's photo, at one size, everywhere.
//
// This replaces six hand-rolled copies of the same dozen lines -- an <img> with
// a round-cropped initial beside it as the fallback -- which had drifted to four
// different diameters and two different fallback treatments. A face is how a
// person is recognised in a list without reading, so it has to look the same in
// every list or it stops doing that job.
//
// Decorative by construction: alt is empty and the initial is aria-hidden,
// because every use renders the name beside it. UserChip is that pairing and is
// what most callers should reach for. Use this directly only where the name is
// genuinely somewhere else on the row.

const props = defineProps({
  /** Clerk id. Used only to pick a stable fallback tint. */
  id: { type: String as PropType<string | null>, default: null },
  src: { type: String as PropType<string | null>, default: null },
  name: { type: String as PropType<string | null>, default: null },
  /** Rendered diameter in px. */
  size: { type: Number, default: 24 },
})

// Which of the four chart colours an initial is tinted with.
//
// Not decoration. A column of initials in one colour is a column of identical
// blobs, and telling people apart at a glance is the entire reason a photo is on
// the row -- an account with no photo should not fall out of that. The hash is
// over the Clerk id rather than the name, so the tint stays put when somebody
// renames themselves, and the palette is the chart one because those four are
// already chosen to be told apart from each other and already defined for both
// themes. Four, not forty: this is meant to break a column up, not to encode an
// identity nobody can decode.
const tint = computed(() => {
  const key = props.id || props.name || ''
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return `var(--chart-${(hash % 4) + 1})`
})

const style = computed(() => ({ '--av-size': `${props.size}px`, '--av-tint': tint.value }))
</script>

<template>
  <img v-if="src" class="av" :src="src" alt="" loading="lazy" :style="style" />
  <span v-else class="av av--initial" :style="style" aria-hidden="true">{{ initialOf(name) }}</span>
</template>

<style scoped>
.av {
  width: var(--av-size);
  height: var(--av-size);
  border-radius: var(--radius-pill);
  flex: none;
  object-fit: cover;
  /* Something to sit under a photo that is still loading, or that 404s, so the
     row does not reflow around a zero-height image. */
  background: var(--bg-surface-alt);
}

.av--initial {
  display: grid;
  place-items: center;
  /* Proportional to the circle rather than picked per call site, which is how
     the six copies ended up with three unrelated font sizes. */
  font-size: calc(var(--av-size) * 0.42);
  font-weight: var(--weight-bold);
  line-height: 1;
  color: var(--av-tint);
  background: color-mix(in srgb, var(--av-tint) 14%, transparent);
}
</style>
