import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref, watch } from 'vue'
import { useTableState } from '../src/lib/useTableState'
import { sortGuard } from '../src/lib/data/types'

// The rules three list views used to keep three copies of, one of which lived in
// ProductsView's TEMPLATE as `@update:model-value="reset"` repeated across six
// controls.

const isSort = sortGuard(['popularity', 'name', 'created_at'] as const)

/** Run inside a scope so the internal watcher can be torn down afterwards. */
function withState<T>(body: () => T): { value: T; stop: () => void } {
  const scope = effectScope()
  const value = scope.run(body) as T
  return { value, stop: () => scope.stop() }
}

describe('useTableState paging', () => {
  it('returns to the first page when the query changes', async () => {
    const { value: table, stop } = withState(() =>
      useTableState({ isSort, sort: 'popularity' }),
    )

    table.offset.value = 75
    table.query.value = 'lapte'
    await nextTick()

    expect(table.offset.value).toBe(0)
    stop()
  })

  it('returns to the first page when any declared filter changes', async () => {
    // The one the template was enforcing by hand. A seventh filter added to
    // ProductsView now gets this for free, which is the point.
    const source = ref<string | null>(null)
    const { value: table, stop } = withState(() =>
      useTableState({ isSort, sort: 'popularity', filters: [source] }),
    )

    table.offset.value = 50
    source.value = 'openfoodfacts'
    await nextTick()

    expect(table.offset.value).toBe(0)
    stop()
  })

  it('does not fight the pager', async () => {
    // `offset` is the thing being reset, not a filter. If it were watched too,
    // page 2 would bounce straight back to page 1.
    const { value: table, stop } = withState(() =>
      useTableState({ isSort, sort: 'popularity' }),
    )

    table.offset.value = 25
    await nextTick()

    expect(table.offset.value).toBe(25)
    stop()
  })
})

describe('useTableState sorting', () => {
  it('flips direction when the current column is clicked again', () => {
    const { value: table, stop } = withState(() =>
      useTableState({ isSort, sort: 'popularity' }),
    )

    expect(table.dir.value).toBe('desc')
    table.onSort('popularity')
    expect(table.dir.value).toBe('asc')
    table.onSort('popularity')
    expect(table.dir.value).toBe('desc')
    stop()
  })

  it('starts a newly chosen column descending', () => {
    // Every sortable column in this tool is a count or a date, so "most" and
    // "newest" are what is wanted first.
    const { value: table, stop } = withState(() =>
      useTableState({ isSort, sort: 'popularity', dir: 'asc' }),
    )

    table.onSort('name')
    expect(table.sort.value).toBe('name')
    expect(table.dir.value).toBe('desc')
    stop()
  })

  it('ignores a key the RPC would refuse, changing nothing', () => {
    // DataTable emits a bare string on a header click. This is the one door an
    // unchecked key could come through, and the answer it produces server-side
    // is a PostgREST 400 naming no column at all.
    const { value: table, stop } = withState(() =>
      useTableState({ isSort, sort: 'popularity' }),
    )

    table.onSort('barcode')
    expect(table.sort.value).toBe('popularity')
    expect(table.dir.value).toBe('desc')
    stop()
  })

  it('returns to the first page on a sort change', async () => {
    const { value: table, stop } = withState(() =>
      useTableState({ isSort, sort: 'popularity' }),
    )

    table.offset.value = 100
    table.onSort('name')
    await nextTick()

    expect(table.offset.value).toBe(0)
    stop()
  })
})

describe('useTableState params', () => {
  it('carries the five values a fetcher needs', () => {
    const { value: table, stop } = withState(() =>
      useTableState({ isSort, sort: 'popularity', limit: 50 }),
    )

    expect(table.params.value).toEqual({
      query: '',
      sort: 'popularity',
      dir: 'desc',
      limit: 50,
      offset: 0,
    })
    stop()
  })

  it('fires a watcher ONCE when a filter change also resets the page', async () => {
    // The reset runs in its own watcher, so both `query` and `offset` change
    // before anything reading `params` is flushed. If that ordering were wrong
    // the page would issue two requests per keystroke -- one of them against a
    // page number it had already abandoned.
    const { value: table, stop } = withState(() => {
      const state = useTableState({ isSort, sort: 'popularity' })
      const seen: unknown[] = []
      watch([state.params], () => seen.push({ ...state.params.value }))
      return { state, seen }
    })

    table.state.offset.value = 75
    await nextTick()
    table.seen.length = 0

    table.state.query.value = 'lapte'
    await nextTick()

    expect(table.seen).toEqual([{ query: 'lapte', sort: 'popularity', dir: 'desc', limit: 25, offset: 0 }])
    stop()
  })
})
