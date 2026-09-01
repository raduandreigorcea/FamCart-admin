<script setup lang="ts">
import { computed } from 'vue'
import { formatCount } from '../lib/format'

// Offset pagination, stated in rows rather than in pages.
//
// "1–25 of 312" is what an operator actually wants to know; "page 1 of 13" makes
// them multiply. The page buttons are still there because clicking beats typing
// an offset, but the sentence is the primary readout.
//
// ─── WHY THERE ARE NUMBERS AND NOT JUST PREVIOUS / NEXT ──────────────────────
//
// First / Previous / Next was navigation you could only walk. Page 9 of a
// 12,000-row band cost eight clicks and there was no way back to where you had
// been, which on this tool is the review band and the outcomes table -- exactly
// the two places somebody works through a long list and wants to jump back to
// the part they were reading. The numbered strip is the cheap fix, windowed so
// a 500-page table does not render 500 buttons.

const props = defineProps({
  total: { type: Number, required: true },
  offset: { type: Number, required: true },
  limit: { type: Number, required: true },
  loading: { type: Boolean, default: false },
})

const emit = defineEmits<{ (e: 'go', offset: number): void }>()

const from = computed(() => (props.total === 0 ? 0 : props.offset + 1))
const to = computed(() => Math.min(props.offset + props.limit, props.total))
const atStart = computed(() => props.offset <= 0)
const atEnd = computed(() => props.offset + props.limit >= props.total)
const page = computed(() => Math.floor(props.offset / props.limit) + 1)
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.limit)))

/** Nothing has come back yet, so there is no count to report -- not a zero. */
const unknown = computed(() => props.loading && props.total === 0)

/** How many pages either side of the current one always get a button. */
const WINDOW = 1

/**
 * The strip: first, last, the current page and its neighbours, gaps between.
 *
 * A gap standing in for a SINGLE page is never drawn -- "1 … 3" costs the same
 * width as "1 2 3" and hides a page one click away for no reason.
 */
const strip = computed<(number | 'gap')[]>(() => {
  const last = pages.value
  const wanted = new Set<number>([1, last, page.value])
  for (let n = page.value - WINDOW; n <= page.value + WINDOW; n++) {
    if (n >= 1 && n <= last) wanted.add(n)
  }

  const out: (number | 'gap')[] = []
  let previous = 0
  for (const n of [...wanted].sort((a, b) => a - b)) {
    if (previous && n - previous === 2) out.push(previous + 1)
    else if (previous && n - previous > 2) out.push('gap')
    out.push(n)
    previous = n
  }
  return out
})

const goToPage = (n: number) => emit('go', (n - 1) * props.limit)
</script>

<template>
  <div class="pager">
    <!-- "No rows" is a finding, not a default.
    
         `total` is 0 before the first response as well as after an empty one,
         and this said "No rows / Page 1 / 1" in both cases -- so the first load
         of every table in the tool reported, definitively, that the database
         held nothing, a second before it filled with rows. That is the same
         mistake the data layer takes such care to avoid elsewhere: it is why
         Metric has an Unavailable arm and why CatalogShape carries `truncated`.
         Not knowing yet and knowing there is nothing are different answers, and
         only one of them is worth reporting.
    
         Only the first load is affected. A refetch keeps the previous `total`,
         so the real range stays on screen while the next page is fetched. -->
    <p class="pager__count u-num">
      <template v-if="unknown">Counting…</template>
      <template v-else-if="total === 0">No rows</template>
      <template v-else>
        {{ formatCount(from) }}–{{ formatCount(to) }} of {{ formatCount(total) }}
      </template>
    </p>

    <nav class="pager__controls" aria-label="Pages">
      <button
        type="button"
        class="pager__btn"
        :disabled="atStart || loading"
        @click="emit('go', 0)"
      >First</button>
      <button
        type="button"
        class="pager__btn"
        :disabled="atStart || loading"
        @click="emit('go', Math.max(0, offset - limit))"
      >Previous</button>

      <!-- Withheld for the same reason the count is: a page number invented
           before the first response is a claim, not a placeholder. -->
      <span v-if="unknown" class="pager__page u-num">Page — / —</span>
      <ol v-else class="pager__pages">
        <li v-for="(item, index) in strip" :key="`${item}-${index}`">
          <span v-if="item === 'gap'" class="pager__gap" aria-hidden="true">…</span>
          <button
            v-else-if="item === page"
            type="button"
            class="pager__btn pager__btn--current u-num"
            aria-current="page"
            disabled
          >{{ item }}</button>
          <button
            v-else
            type="button"
            class="pager__btn pager__num u-num"
            :disabled="loading"
            :aria-label="`Page ${item}`"
            @click="goToPage(item)"
          >{{ item }}</button>
        </li>
      </ol>

      <button
        type="button"
        class="pager__btn"
        :disabled="atEnd || loading"
        @click="emit('go', offset + limit)"
      >Next</button>
      <button
        type="button"
        class="pager__btn"
        :disabled="atEnd || loading"
        @click="goToPage(pages)"
      >Last</button>
    </nav>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* Two gaps, not one: the row gap only ever applies once the controls have
     wrapped under the count, where they need more air than the buttons need
     between themselves. */
  gap: var(--space-3) var(--space-5);
  flex-wrap: wrap;
}

.pager__count {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  white-space: nowrap;
}

.pager__controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.pager__pages {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  list-style: none;
  margin: 0;
  padding: 0 var(--space-1);
}

.pager__page {
  font-size: var(--text-xs);
  color: var(--text-disabled);
  padding: 0 var(--space-2);
}

.pager__gap {
  display: inline-block;
  padding: 0 var(--space-1);
  font-size: var(--text-xs);
  color: var(--text-disabled);
}

.pager__btn {
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-sm);
  padding: 0.3rem var(--space-3);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-standard);
}

/* Numbers are squarer than the worded buttons so the strip reads as one
   control rather than as five more First/Previous-sized things. */
.pager__num,
.pager__btn--current {
  min-width: 2rem;
  padding: 0.3rem var(--space-2);
  text-align: center;
}

.pager__btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.pager__btn:active:not(:disabled) {
  background: var(--bg-press);
}

.pager__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* The current page is disabled because clicking it does nothing, but it is the
   one disabled button here that is not unavailable -- so it keeps full contrast
   and takes the emphasis the others lose. */
.pager__btn--current:disabled {
  opacity: 1;
  cursor: default;
  background: var(--bg-press);
  border-color: var(--border-dark);
  color: var(--text-primary);
}
</style>
