<script setup lang="ts">
import { computed, type PropType } from 'vue'
import { useRoute } from 'vue-router'
import { formatRelative } from '../lib/format'
import AppIcon from './AppIcon.vue'

// Every page opens with the same four things: what it is, what it is for, when
// its numbers were read, and how to read them again.
//
// The timestamp matters more here than it looks. Nothing on this dashboard
// revalidates in the background, deliberately, so "as of when" always has an
// answer -- and this is where it is given.
//
// The section glyph is the fifth, and it is read from the route rather than
// passed in. Twelve views would otherwise each have to name their own icon, and
// the first one to name a different glyph from the one in its sidebar row would
// have broken the only thing the glyph is for: recognising, without reading,
// which of twelve near-identical grids of panels you are looking at. See the
// `icon` note in router/index.ts.

defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  fetchedAt: { type: Number as PropType<number | null>, default: null },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits<{ (e: 'refresh'): void }>()

const route = useRoute()
const icon = computed(() => (typeof route.meta.icon === 'string' ? route.meta.icon : ''))
</script>

<template>
  <header class="head">
    <div class="head__ident" :class="{ 'head__ident--plain': !icon }">
      <span v-if="icon" class="head__plate" aria-hidden="true">
        <AppIcon :name="icon" :size="18" />
      </span>
      <h1 class="head__title">{{ title }}</h1>
      <p v-if="description" class="head__desc">{{ description }}</p>
    </div>

    <div class="head__tools">
      <slot name="tools" />

      <span v-if="fetchedAt" class="head__stamp" :title="new Date(fetchedAt).toISOString()">
        Read {{ formatRelative(new Date(fetchedAt)) }}
      </span>

      <button
        type="button"
        class="u-btn head__refresh"
        :disabled="busy"
        title="Run every query on this page again"
        @click="emit('refresh')"
      >
        <AppIcon
          class="head__refresh-glyph"
          :class="{ 'head__refresh-glyph--spin': busy }"
          name="rotate-cw"
          :size="13"
        />
        Refresh
      </button>
    </div>
  </header>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  /* The page's own baseline. Every panel below it is a box with an edge, so the
     header needed something other than an edge to sit on or it read as one more
     box that had lost its border. Same argument as the ledger rule, one level
     up: this is the line the page rests on. */
  padding-bottom: var(--space-4);
  border-bottom: var(--border-width-thin) solid var(--border-main);
}

/* A two-column grid rather than a flex row, so the plate is centred on the
   TITLE's line box instead of on the whole ident column.
   Top-aligning the two is what read as broken: the title's cap sits about five
   pixels below the top of its line box, so a 36px plate flush with that top
   hangs six pixels low beside it. Giving the title its own grid row hands the
   plate a box of exactly the right height to centre in, which holds at any type
   scale and needs no nudge kept in sync by hand. */
.head__ident {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  column-gap: var(--space-3);
  min-width: 0;
}

.head__plate { grid-row: 1; }
.head__title { grid-column: 2; grid-row: 1; }
.head__desc { grid-column: 2; grid-row: 2; }

/* No section glyph. The empty first column would still be followed by a column
   gap, indenting the title by twelve pixels against nothing. */
.head__ident--plain {
  grid-template-columns: minmax(0, 1fr);
}

.head__ident--plain .head__title,
.head__ident--plain .head__desc {
  grid-column: 1;
}

/* The section mark. Tinted rather than outlined, because it is identity and not
   a control -- nothing about it should invite a click. */
.head__plate {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: var(--radius-md);
  background: var(--admin-accent-wash);
  color: var(--color-primary);
}

.head__title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-bold);
  letter-spacing: -0.02em;
  color: var(--text-primary);
  line-height: var(--leading-tight);
}

.head__desc {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: var(--leading-snug);
  max-width: 78ch;
}

.head__tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  flex: none;
}

.head__stamp {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  white-space: nowrap;
}

/* Geometry comes from .u-btn. This says only the one thing that is true of
   Refresh and of no other button: a disabled Refresh is busy, not forbidden. */
.head__refresh:disabled {
  cursor: progress;
}

.head__refresh-glyph--spin {
  display: inline-block;
  animation: head-spin 0.9s linear infinite;
}

@keyframes head-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .head__refresh-glyph--spin {
    animation: none;
  }
}
</style>
