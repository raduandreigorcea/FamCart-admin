import { computed, ref, watch, type Ref, type WatchSource } from 'vue'

// The state every list view keeps, and the three rules it has to get right.
//
// Users, Households and Products each held their own `query`, `sort`, `dir` and
// `offset` refs and their own copies of the same handlers -- near-identical, and
// commented in three places with the same explanations. That is survivable. What
// is not is that one of the rules is enforced from the TEMPLATE: ProductsView
// wired `@update:model-value="reset"` onto six separate controls, and the
// seventh filter anyone adds is the one that forgets.
//
// So the rules live here instead:
//
//   1. Anything that narrows the result set returns to the first page. Staying
//      on page 4 of a set that now has one page shows an empty table, and an
//      empty table reads as "nothing matches" rather than as "you are past the
//      end".
//   2. Clicking the current sort column flips direction; clicking a different
//      one selects it and starts DESCENDING, because every sortable column in
//      this tool is a count or a date and "most" or "newest" is what is wanted
//      first.
//   3. A sort key the RPC does not accept never leaves the browser. DataTable
//      emits a bare string on a header click and the *_SORTS arrays mirror the
//      CASE arms server-side, so this is the one door an unchecked key could
//      come through -- and a wrong one comes back as a PostgREST 400 naming no
//      column at all.

export interface TableStateOptions<Sort extends string> {
  /** The guard built from this list's *_SORTS array. */
  isSort: (key: string) => key is Sort
  /** Which column the table opens on. */
  sort: Sort
  dir?: 'asc' | 'desc'
  limit?: number
  /**
   * Everything else that narrows the result set -- a source dropdown, a scope
   * segment. Changing any of them returns to the first page, so no view has to
   * remember to say so at each control.
   */
  filters?: WatchSource[]
}

export interface TableState<Sort extends string> {
  query: Ref<string>
  sort: Ref<Sort>
  dir: Ref<'asc' | 'desc'>
  offset: Ref<number>
  limit: number
  /** The four values the fetchers take, as one watchable source. */
  params: Ref<{
    query: string
    sort: Sort
    dir: 'asc' | 'desc'
    limit: number
    offset: number
  }>
  /** What a DataTable header click calls. Ignores keys the RPC would refuse. */
  onSort: (key: string) => void
  /** Back to page one, for the rare case a view has to say it explicitly. */
  firstPage: () => void
}

export function useTableState<Sort extends string>(
  options: TableStateOptions<Sort>,
): TableState<Sort> {
  const query = ref('')
  const sort = ref(options.sort) as Ref<Sort>
  const dir = ref<'asc' | 'desc'>(options.dir ?? 'desc')
  const offset = ref(0)
  const limit = options.limit ?? 25

  function firstPage() {
    offset.value = 0
  }

  // Rule 1, enforced once. `offset` is deliberately not among the sources: it is
  // the thing being reset, not a filter.
  watch([query, sort, dir, ...(options.filters ?? [])], firstPage)

  function onSort(key: string) {
    if (!options.isSort(key)) return
    if (sort.value === key) {
      dir.value = dir.value === 'asc' ? 'desc' : 'asc'
    } else {
      sort.value = key
      dir.value = 'desc'
    }
  }

  // One object rather than four refs, so a view watches one source and a fetcher
  // takes one argument. It recomputes only when a member actually changed, so
  // the identity change useQuery watches for is exactly a real change.
  const params = computed(() => ({
    query: query.value,
    sort: sort.value,
    dir: dir.value,
    limit,
    offset: offset.value,
  }))

  return { query, sort, dir, offset, limit, params, onSort, firstPage }
}
