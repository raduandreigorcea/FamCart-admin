// Types the shared components take as props.
//
// They live here rather than inside the components because `<script setup>`
// cannot contain ES module exports, type-only or otherwise -- the compiler
// rejects them. Declaring them in one plain module also means a view can import
// the shape without importing the component.

/** One line on a LineChart. */
export interface Series {
  /**
   * Stable identity, and what the colour is keyed to. It must not change when a
   * filter changes, or hiding one series would repaint the others.
   */
  key: string
  label: string
  values: number[]
}

/** One row on a BarChart. */
export interface Bar {
  key: string
  label: string
  value: number
  /** A second line under the label, for context that is not the value. */
  meta?: string
  /** Only for the folded "Other" row; never for a state. */
  tone?: 'default' | 'muted'
}

/**
 * One column of a DataTable.
 *
 * ─── WHY `key` IS NOT SIMPLY `keyof T` ───────────────────────────────────────
 *
 * Most keys do name a field on the row, and writing it that way would catch a
 * typo at compile time. But some columns are rendered entirely through a
 * `#cell-<key>` slot and correspond to no field at all -- 'quality' on the
 * catalog table is computed from five other columns, 'scope' on the local table
 * is derived from whether household_id is set. Constraining to `keyof T` would
 * reject both, and the workaround (widening the row type with fields that do
 * not exist) is worse than the problem.
 *
 * So: `keyof T` first, which is what an editor offers as autocomplete, then a
 * widening branch for the slot-only case. `(string & {})` rather than plain
 * `string` because a bare union with `string` collapses to `string` and throws
 * the autocomplete away.
 */
export interface Column<T = Record<string, unknown>> {
  key: (keyof T & string) | (string & {})
  label: string
  /** Right-align and use tabular figures. Every numeric column, always. */
  numeric?: boolean
  /** Sortable by this key, which must match a sort the RPC accepts. */
  sortable?: boolean
  width?: string
  /** Dropped below this viewport width, for columns that are context. */
  hideBelow?: 1100 | 1400
  align?: 'left' | 'right' | 'center'
  title?: string
  cell?: (row: T) => string
}

/** One option of a SegmentedControl. */
export interface Segment {
  value: string
  label: string
  title?: string
}

/** The tones a StatusPill can take. States only, never series identity. */
export type Tone = 'good' | 'warn' | 'bad' | 'idle' | 'accent'
