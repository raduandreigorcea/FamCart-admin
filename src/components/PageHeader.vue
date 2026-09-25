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
    <div class="head__ident">
      <span v-if="icon" class="head__plate" aria-hidden="true">
        <AppIcon :name="icon" :size="22" :stroke="2" />
      </span>
      <div class="head__text">
        <h1 class="head__title">{{ title }}</h1>
        <p v-if="description" class="head__desc">{{ description }}</p>
      </div>
    </div>

    <div class="head__tools">
      <slot name="tools" />

      <!-- The stamp hangs under Refresh instead of sitting beside it. Beside it,
           every change of wording -- "now", "30 s ago", "2 min ago" -- changed
           its width and pushed the page's own controls sideways, twice a minute
           on a page that polls. Under it, and out of the flow, it moves nothing. -->
      <div class="head__refresh-wrap">
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

        <span v-if="fetchedAt" class="head__stamp" :title="new Date(fetchedAt).toISOString()">
          Read {{ formatRelative(new Date(fetchedAt)) }}
        </span>
      </div>
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

/* The mark beside a block holding the title AND the description, centred on the
   two together -- exactly how FamCart lays out a dialog's title (the
   __title-wrap in AppSettingsModal and the rest): a flex row, a 12px gap, the
   text stacked in its own box.

   It used to be a grid that centred the plate on the title's line alone, with
   the description hanging below it in a second row. That was a deliberate
   choice for a single line, and it made every page header here look unlike the
   app the moment a description was present, which is every page. */
.head__ident {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.head__text {
  min-width: 0;
}

/* The section mark. Tinted rather than outlined, because it is identity and not
   a control -- nothing about it should invite a click.

   Drawn exactly as FamCart draws the mark beside a dialog title (AppSettingsModal,
   ListSettingsModal, PurchaseHistoryModal and the rest): a 38px plate, a
   22px icon, the primary mixed 10% into the surface. It had its own 36px plate,
   18px icon and --admin-accent-wash tint, which made the dashboard look like a
   different product from the app it administers. */
.head__plate {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-surface));
  color: var(--color-primary);
}

.head__title {
  margin: 0;
  /* text-lg and extrabold, as FamCart's dialog titles are. It was a step larger
     on the grounds that this is a page heading, and beside the app it simply
     read as too big. */
  font-size: var(--text-lg);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.02em;
  color: var(--text-primary);
  line-height: var(--leading-tight);
}

.head__desc {
  margin: 0.1rem 0 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
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
  /* flex: none stops the tools squeezing beside the title; this stops them
     outgrowing the row once they have wrapped under it. */
  max-width: 100%;
}

.head__refresh-wrap {
  position: relative;
}

/* Absolute, so its width never reaches the row. It sits in the header's own
   bottom padding, right-aligned under the button it describes. */
.head__stamp {
  position: absolute;
  top: calc(100% + 2px);
  right: 0;
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
