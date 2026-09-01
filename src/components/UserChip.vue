<script setup lang="ts">
import { computed, type PropType } from 'vue'
import { RouterLink } from 'vue-router'
import UserAvatar from './UserAvatar.vue'
import { shortUserId } from '../lib/format'

// A person, said the same way everywhere: their photo and their name, and a
// route to them.
//
// Every admin RPC that names somebody now returns their image_url beside the
// name for this component to render, because the alternative -- a bare name, or
// worse a bare Clerk id -- is the dashboard knowing who did something and
// declining to show it. `user_3D7fKKF1I9xyLOo7JxtSKW5N3WE` is not a person a
// reader recognises; a face is.
//
// The name falls back to a shortened id, and the id falls back to `fallback`,
// so a row whose actor is not an account at all -- rate_limit_hit() runs on
// paths with no session -- still reads as a sentence rather than as a blank.

const props = defineProps({
  /** Clerk id. Absent means there is nobody to link to. */
  id: { type: String as PropType<string | null>, default: null },
  name: { type: String as PropType<string | null>, default: null },
  src: { type: String as PropType<string | null>, default: null },
  size: { type: Number, default: 22 },
  /**
   * Off where the chip already sits inside something clickable. A link inside a
   * link is not a thing the browser can resolve, and a row that opens a drawer
   * should not sometimes navigate instead.
   */
  link: { type: Boolean, default: true },
  /** What to say when there is neither a name nor an id. */
  fallback: { type: String, default: 'Unknown' },
})

const label = computed(() => props.name || (props.id ? shortUserId(props.id) : props.fallback))
const to = computed(() => (props.id ? `/users/${encodeURIComponent(props.id)}` : ''))
const linked = computed(() => props.link && Boolean(to.value))
</script>

<template>
  <component
    :is="linked ? RouterLink : 'span'"
    :to="linked ? to : undefined"
    class="chip"
    :class="{ 'chip--link': linked }"
  >
    <UserAvatar :id="id" :src="src" :name="label" :size="size" />
    <span class="chip__name u-truncate">{{ label }}</span>
  </component>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  max-width: 100%;
  color: inherit;
  text-decoration: none;
}

.chip__name {
  min-width: 0;
  font-weight: var(--weight-medium);
}

/* Underlined on hover rather than always, the same way every other link in a
   dense table here behaves: a grid where every name is underlined reads as a
   grid of warnings. */
.chip--link:hover .chip__name {
  color: var(--color-primary);
  text-decoration: underline;
}

.chip--link:focus-visible {
  outline: var(--border-width-thick) solid var(--color-primary);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}
</style>
