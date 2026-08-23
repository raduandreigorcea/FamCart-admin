<script setup lang="ts">
import { computed, type PropType } from 'vue'
import type { Column } from '../lib/uiTypes'
import StateBlock from './StateBlock.vue'
import AppIcon from './AppIcon.vue'

// The table, which is most of this tool.
//
// Columns are declared as data rather than as markup, so sorting, alignment and
// numeric formatting are decided once per column instead of once per cell. A
// table built out of hand-written <td>s drifts: one column right-aligns its
// figures and the next does not, and the two stop being comparable.
//
// Sorting is CONTROLLED, not internal. Every list here is paginated server-side,
// so sorting a page in the browser would reorder 25 rows out of 300 and call it
// sorted -- the single most misleading thing a table can do. The parent owns the
// sort and sends it to the RPC; this only reports the click.

const props = defineProps({
  columns: { type: Array as PropType<Column[]>, required: true },
  rows: { type: Array as PropType<Record<string, unknown>[]>, default: () => [] },
  rowKey: { type: String, default: 'id' },
  sort: { type: String, default: '' },
  dir: { type: String as PropType<'asc' | 'desc'>, default: 'desc' },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  emptyTitle: { type: String, default: 'Nothing here' },
  emptyMessage: { type: String, default: '' },
  dense: { type: Boolean, default: false },
  /** Rows respond to click and look it. */
  clickable: { type: Boolean, default: false },
  selectedKey: { type: [String, Number], default: null },
})

const emit = defineEmits<{
  (e: 'sort', key: string): void
  (e: 'select', row: Record<string, unknown>): void
}>()

// Loading keeps the header on screen and fakes the body, so the table does not
// collapse and reflow the page every time a filter changes.
const showSkeleton = computed(() => props.loading && props.rows.length === 0)
const showEmpty = computed(() => !props.loading && !props.error && props.rows.length === 0)

function ariaSort(column: Column): 'ascending' | 'descending' | 'none' {
  if (!column.sortable || props.sort !== column.key) return 'none'
  return props.dir === 'asc' ? 'ascending' : 'descending'
}
</script>

<template>
  <div class="table-wrap">
    <div class="table-scroll">
      <table class="table" :class="{ 'table--dense': dense }">
        <thead>
          <tr>
            <th
              v-for="column in columns"
              :key="column.key"
              :style="column.width ? { width: column.width } : undefined"
              :class="[
                column.numeric || column.align === 'right' ? 'is-right' : '',
                column.align === 'center' ? 'is-center' : '',
                column.hideBelow ? `hide-below-${column.hideBelow}` : '',
              ]"
              :aria-sort="ariaSort(column)"
              scope="col"
            >
              <button
                v-if="column.sortable"
                type="button"
                class="table__sort"
                :title="column.title || `Sort by ${column.label}`"
                @click="emit('sort', column.key)"
              >
                {{ column.label }}
                <AppIcon
                  class="table__caret"
                  :class="{ 'table__caret--on': sort === column.key }"
                  :name="sort === column.key ? (dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'chevrons-up-down'"
                  :size="12"
                />
              </button>
              <span v-else :title="column.title">{{ column.label }}</span>
            </th>
          </tr>
        </thead>

        <tbody v-if="!showSkeleton && !showEmpty && !error">
          <tr
            v-for="row in rows"
            :key="String(row[rowKey])"
            :class="{
              'table__row--clickable': clickable,
              'table__row--selected': selectedKey !== null && row[rowKey] === selectedKey,
            }"
            :tabindex="clickable ? 0 : undefined"
            @click="clickable && emit('select', row)"
            @keydown.enter="clickable && emit('select', row)"
          >
            <td
              v-for="column in columns"
              :key="column.key"
              :class="[
                column.numeric || column.align === 'right' ? 'is-right' : '',
                column.align === 'center' ? 'is-center' : '',
                column.numeric ? 'u-num' : '',
                column.hideBelow ? `hide-below-${column.hideBelow}` : '',
              ]"
            >
              <slot :name="`cell-${column.key}`" :row="row" :value="row[column.key]">
                {{ column.cell ? column.cell(row) : (row[column.key] ?? '--') }}
              </slot>
            </td>
          </tr>
        </tbody>

        <tbody v-else-if="showSkeleton" aria-hidden="true">
          <tr v-for="n in dense ? 10 : 6" :key="`sk-${n}`" class="table__row--skeleton">
            <td v-for="column in columns" :key="column.key">
              <span class="table__skel" :style="{ width: `${40 + ((n * 13 + column.key.length * 7) % 45)}%` }"></span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <StateBlock
      v-if="error"
      state="error"
      title="Could not load this table"
      :message="error"
    />
    <StateBlock
      v-else-if="showEmpty"
      state="empty"
      :title="emptyTitle"
      :message="emptyMessage"
    >
      <template #action><slot name="empty-action" /></template>
    </StateBlock>
  </div>
</template>

<style scoped>
.table-wrap {
  min-width: 0;
}

/* Wide tables scroll inside their own panel rather than pushing the page
   sideways. A dashboard body must never scroll horizontally. */
.table-scroll {
  overflow-x: auto;
  min-width: 0;
}

.table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--text-sm);
}

.table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--admin-thead);
  border-bottom: var(--border-width-thin) solid var(--border-main);
  padding: var(--space-2) var(--space-3);
  text-align: left;
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  white-space: nowrap;
}

.table td {
  padding: 0 var(--space-3);
  height: var(--admin-row-comfortable);
  border-bottom: var(--border-width-thin) solid var(--border-light);
  color: var(--text-primary);
  vertical-align: middle;
}

.table--dense td {
  height: var(--admin-row-compact);
  font-size: var(--text-xs);
}

.table tbody tr:last-child td {
  border-bottom: none;
}

/* Zebra rather than a divider alone: at this density the eye loses the row on
   the way across a twelve-column table. */
.table tbody tr:nth-child(even) td {
  background: var(--admin-zebra);
}

.table__row--clickable {
  cursor: pointer;
}

.table__row--clickable:hover td {
  background: var(--bg-hover);
}

.table__row--clickable:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

.table__row--selected td,
.table__row--selected:nth-child(even) td {
  background: var(--admin-selected);
}

.is-right { text-align: right; }
.is-center { text-align: center; }

.table__sort {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
  text-transform: inherit;
  letter-spacing: inherit;
  color: inherit;
}

.table__sort:hover {
  color: var(--text-primary);
}

.is-right .table__sort {
  flex-direction: row-reverse;
}

.table__caret {
  opacity: 0.3;
  font-size: 0.9em;
}

.table__caret--on {
  opacity: 1;
  color: var(--color-primary);
}

.table__row--skeleton td {
  background: none;
}

.table__skel {
  display: block;
  height: 10px;
  border-radius: var(--radius-xs);
  background: linear-gradient(90deg, var(--bg-hover) 25%, var(--border-light) 37%, var(--bg-hover) 63%);
  background-size: 400% 100%;
  animation: table-skel 1.4s ease infinite;
}

@keyframes table-skel {
  from { background-position: 100% 50%; }
  to { background-position: 0 50%; }
}

@media (max-width: 1400px) {
  .hide-below-1400 { display: none; }
}

@media (max-width: 1100px) {
  .hide-below-1100 { display: none; }
}
</style>
