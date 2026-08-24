<script setup lang="ts" generic="T extends object">
import { computed } from 'vue'
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

// Generic in its row type, which is what lets a caller pass AdminUserRow[]
// straight in. It used to take Record<string, unknown>[], so all nine callers
// laundered their rows through `as unknown as Record<string, unknown>[]` and
// then cast BACK inside every select handler to read a field -- eighteen casts
// that between them switched off type checking at the one boundary where column
// keys meet row fields.
const props = withDefaults(
  defineProps<{
    columns: Column<T>[]
    rows?: T[]
    /**
     * Which field identifies a row. Required, and must be a real key of T.
     *
     * It defaulted to 'id', which was a lie for half the tables here --
     * AdminUserRow is keyed by user_id, TableHealth by table_name -- and a
     * wrong rowKey does not fail loudly: every row resolves to the string
     * "undefined", Vue sees one duplicated key, and rows silently stop being
     * re-used correctly. Every call site already passed this explicitly, so
     * requiring it costs nothing and makes the identity checked.
     */
    rowKey: keyof T & string
    sort?: string
    dir?: 'asc' | 'desc'
    loading?: boolean
    error?: string
    emptyTitle?: string
    emptyMessage?: string
    dense?: boolean
    /** Rows respond to click and look it. */
    clickable?: boolean
    selectedKey?: string | number | null
  }>(),
  {
    rows: () => [],
    sort: '',
    dir: 'desc',
    loading: false,
    error: '',
    emptyTitle: 'Nothing here',
    emptyMessage: '',
    dense: false,
    clickable: false,
    selectedKey: null,
  },
)

const emit = defineEmits<{
  (e: 'sort', key: string): void
  (e: 'select', row: T): void
}>()

// Loading keeps the header on screen and fakes the body, so the table does not
// collapse and reflow the page every time a filter changes.
const showSkeleton = computed(() => props.loading && props.rows.length === 0)
const showEmpty = computed(() => !props.loading && !props.error && props.rows.length === 0)

function ariaSort(column: Column<T>): 'ascending' | 'descending' | 'none' {
  if (!column.sortable || props.sort !== column.key) return 'none'
  return props.dir === 'asc' ? 'ascending' : 'descending'
}

/**
 * Read a cell by column key.
 *
 * The one widening cast in this component, and the reason `T extends object`
 * rather than `T extends Record<string, unknown>`: an INTERFACE does not
 * satisfy an index signature in TypeScript, only a type alias does. Constraining
 * to Record would therefore reject AdminUserRow, AdminHouseholdRow and every
 * other row shape in the data layer -- which is exactly what silently forced
 * `T` back to `Record<string, unknown>` and kept the eighteen casts alive in
 * the views.
 *
 * A column key may also be slot-only (see Column in uiTypes.ts), so it is not
 * always a `keyof T`. Hence the widening here, once, rather than in every
 * caller.
 */
function cellValue(row: T, key: string): unknown {
  return (row as Record<string, unknown>)[key]
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
          <!-- A clickable row is reachable by Tab and activates on Enter AND on
               Space. Space is not decoration: it is what every button-like
               control in a browser answers to, and a row that ignores it does
               something worse than nothing -- it scrolls the page, moving the
               row out from under the person who was trying to open it. Hence
               .prevent.

               Deliberately NOT role="button": that would replace the row's own
               role, and a table whose rows are not rows stops being navigable
               as a table at all. The row keeps its semantics and announces its
               selected state; making the target announce itself as actionable
               is a job for a link in the primary cell, not for an aria patch
               over a <tr>. -->
          <tr
            v-for="row in rows"
            :key="String(row[rowKey])"
            :class="{
              'table__row--clickable': clickable,
              'table__row--selected': selectedKey !== null && row[rowKey] === selectedKey,
            }"
            :tabindex="clickable ? 0 : undefined"
            :aria-selected="selectedKey !== null ? row[rowKey] === selectedKey : undefined"
            @click="clickable && emit('select', row)"
            @keydown.enter="clickable && emit('select', row)"
            @keydown.space.prevent="clickable && emit('select', row)"
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
              <slot :name="`cell-${column.key}`" :row="row" :value="cellValue(row, column.key)">
                {{ column.cell ? column.cell(row) : (cellValue(row, column.key) ?? '--') }}
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
