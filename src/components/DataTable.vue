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
/**
 * The layout classes one column imposes on every cell in it -- header, body and
 * skeleton alike.
 *
 * Written once because it had been written three times and drifted twice: the
 * header and body agreed, and the skeleton carried NO classes at all, so below
 * 1400px the header hid three columns while the skeleton kept all nine and the
 * loading table was wider than its own header. Alignment is a property of the
 * column, so it is answered in one place and asked for in three.
 *
 * `u-num` is deliberately not here. Tabular figures are a property of the
 * CONTENT, not the column: a header is words and a skeleton is a grey bar, and
 * neither has digits to line up.
 */
function columnClasses(column: Column<T>): string[] {
  return [
    column.numeric || column.align === 'right' ? 'is-right' : '',
    column.align === 'center' ? 'is-center' : '',
    column.hideBelow ? `hide-below-${column.hideBelow}` : '',
  ].filter(Boolean)
}

// ─── the floor under the table ───────────────────────────────────────────────
//
// `.table-scroll` promises a sideways scroll for a table too wide for its panel,
// and until this existed it could never happen: the table is `width: 100%` with
// no lower bound, so it always fitted exactly and there was nothing to scroll.
// What the wrapper actually bought was the opposite -- every column shrinking in
// proportion, without end. Past the last breakpoint an eight column table in a
// 700px panel gave a product name 175px and broke it mid-word.
//
// COMPUTED RATHER THAN A CONSTANT, because one number cannot serve nine tables.
// A floor sized for Health's eleven columns would make Access scroll at widths
// where its five are comfortable, and a floor sized for Access would not stop
// Health crushing. So each table gets its own, from its own columns.
//
// THREE OF THEM, because the column SET changes at each breakpoint that hides
// one, and a floor computed for eight columns is wrong for the five that survive
// below 1100. The percentages are renormalised over whichever columns are still
// showing, exactly as the browser renormalises them.
//
// The rule: no column may fall below its own minimum, so the table may not fall
// below the largest width any of them implies.

/**
 * What a column with nothing particular to say still needs: a short value and
 * its padding. Deliberately small. Columns here are narrow on purpose -- the
 * catalog's Record column is one letter in a 7% badge -- and a generous default
 * would compute a floor those tables never asked for. Anything with a real
 * pixel need declares `minPx`.
 */
const MIN_CELL = 64

function pctOf(column: Column<T>): number {
  const match = /^([\d.]+)%$/.exec(column.width ?? '')
  return match ? Number(match[1]) : 0
}

function floorFor(visible: Column<T>[]): number {
  const total = visible.reduce((sum, c) => sum + pctOf(c), 0)
  if (total <= 0) return 0

  return Math.ceil(
    Math.max(
      ...visible.map((c) => {
        const share = pctOf(c) / total
        return share > 0 ? (c.minPx ?? MIN_CELL) / share : 0
      }),
    ),
  )
}

// Below 1400 the hide-below-1400 columns are gone; below 1100 BOTH media queries
// are in force, so the 1100 set is the columns that hide at neither.
const floors = computed(() => ({
  '--table-floor': `${floorFor(props.columns)}px`,
  '--table-floor-1400': `${floorFor(props.columns.filter((c) => c.hideBelow !== 1400))}px`,
  '--table-floor-1100': `${floorFor(props.columns.filter((c) => !c.hideBelow))}px`,
}))

function cellValue(row: T, key: string): unknown {
  return (row as Record<string, unknown>)[key]
}
</script>

<template>
  <div class="table-wrap">
    <div class="table-scroll">
      <table class="table" :style="floors">
        <thead>
          <tr>
            <th
              v-for="column in columns"
              :key="column.key"
              :style="column.width ? { width: column.width } : undefined"
              :class="columnClasses(column)"
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
              :class="[columnClasses(column), column.numeric ? 'u-num' : '']"
            >
              <slot :name="`cell-${column.key}`" :row="row" :value="cellValue(row, column.key)">
                {{ column.cell ? column.cell(row) : (cellValue(row, column.key) ?? '--') }}
              </slot>
            </td>
          </tr>
        </tbody>

        <!-- The skeleton carries the SAME per-column classes as a real row, and
             `hide-below-*` is the one that matters: without it the header hid
             three columns below 1400px while the skeleton kept all nine, so the
             loading table was literally wider and more numerous than the header
             sitting on top of it. A skeleton whose whole job is to hold the
             shape of what is coming has to hold the right shape. -->
        <tbody v-else-if="showSkeleton" aria-hidden="true">
          <tr v-for="n in 6" :key="`sk-${n}`" class="table__row--skeleton">
            <td
              v-for="column in columns"
              :key="column.key"
              :class="columnClasses(column)"
            >
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

/* The floor, computed per table in the script above and delivered as three
   custom properties. It only binds when a panel is narrower than it, so a table
   with room to spare never scrolls. */
.table {
  min-width: var(--table-floor, 0);
}

@media (max-width: 1400px) {
  .table { min-width: var(--table-floor-1400, 0); }
}

@media (max-width: 1100px) {
  .table { min-width: var(--table-floor-1100, 0); }
}

.table {
  width: 100%;
  /* Fixed, so the width each column declares is the width it GETS.
   *
   * Auto layout treats a th's width as a hint and lets content overrule it,
   * which means one long value decides the whole grid. A ban reason typed as
   * 368 characters without a space stretched its column to 2272px, pushed the
   * households count and the Lift ban button off the right-hand edge, wrapped
   * the date column to three lines and left the panel scrolling sideways --
   * from one row of test data. The reason cell had asked to ellipsize all
   * along; ellipsis needs a bound, and auto layout never gave it one.
   *
   * Safe because every column in every table here declares a width, and each
   * table's widths sum to 100%. Nothing was relying on a column growing.
   *
   * .table-scroll above stays: it is what keeps a narrow window from pushing
   * the page sideways, which is a different problem from this one. */
  table-layout: fixed;
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
  letter-spacing: var(--tracking-caption);
  color: var(--text-secondary);
  white-space: nowrap;
}

.table td {
  padding: 0 var(--space-3);
  height: var(--admin-row);
  border-bottom: var(--border-width-thin) solid var(--border-light);
  color: var(--text-primary);
  vertical-align: middle;
  /* The other half of fixed layout: a token with nowhere to break -- a barcode,
     a Clerk id, a reason typed without spaces -- now breaks inside its own
     column rather than painting across the next one. Cells that would rather
     cut the line and show an ellipsis say so on the element itself
     (u-truncate, or white-space: nowrap), and this never reaches those. */
  overflow-wrap: anywhere;
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

/* Qualified by the cell, and that is the entire point.
 *
 * `.table th` sets text-align: left and scores (0,1,1). A bare `.is-right`
 * scores (0,1,0) and therefore lost -- on the HEADER only, because no rule
 * competes for it on a td. So every numeric column in this tool has been
 * rendering a left-aligned label above a right-aligned column of figures, in
 * every table, since the component was written.
 *
 * It read as intentional rather than broken because `.is-right .table__sort`
 * below DOES apply: the sort caret dutifully flipped to the left of the label
 * as if the cell were right-aligned, while the label itself did not move. */
.table th.is-right,
.table td.is-right {
  text-align: right;
}

.table th.is-center,
.table td.is-center {
  text-align: center;
}

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
}

.table__caret--on {
  opacity: 1;
  color: var(--color-primary);
}

.table__row--skeleton td {
  background: none;
}

.table__skel {
  display: inline-block;
  height: 10px;
  vertical-align: middle;
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
