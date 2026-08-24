import { computed, ref, shallowRef, watch, onScopeDispose, type Ref, type WatchSource } from 'vue'

// One async-state primitive for the whole dashboard.
//
// Every panel has the same four states and gets them wrong in the same way if
// each one hand-rolls them: `loading` left true after an error, a stale result
// from a slow request overwriting a fresh one, an empty array rendered as "no
// data" while the first request is still in flight. This owns all four so no
// view has to.
//
// Deliberately not a cache. Nothing here is shared between routes and nothing is
// revalidated in the background: an admin dashboard should show what the
// database said when you asked, and a stale-while-revalidate layer would mean
// the number on screen has no single answer to "as of when". Refresh is a
// button, and it says when it last ran.

export type QueryState = 'idle' | 'loading' | 'success' | 'error'

export interface QueryResult<T> {
  data: Ref<T | null>
  error: Ref<Error | null>
  state: Ref<QueryState>
  /** True only on the FIRST load. A refetch keeps the old data on screen. */
  loading: Ref<boolean>
  /** True while any request is in flight, including a refetch. */
  fetching: Ref<boolean>
  /** When the last successful result arrived. */
  fetchedAt: Ref<number | null>
  refetch: () => Promise<void>
}

export interface QueryOptions {
  /** Re-run whenever any of these change. */
  watch?: WatchSource[]
  /** Skip the initial fetch; call refetch() by hand. */
  manual?: boolean
  /**
   * Whether this panel wants data at all, re-read reactively.
   *
   * While it returns false nothing is requested, anything in flight is
   * cancelled, and refetch() is a no-op; when it turns true the query runs.
   * That last part is the difference from `manual`, which was being used for
   * this and cannot express it -- `manual: !configured` says "do not fetch on
   * mount" and has nothing to say about a condition that changes.
   *
   * The case it was added for: the Products page has two tabs over two
   * different databases, and both were fetching on every keystroke so that the
   * hidden one would be ready. Two round trips, one of them for a table nobody
   * was looking at, on every filter change.
   */
  enabled?: () => boolean
}

export function useQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: QueryOptions = {},
): QueryResult<T> {
  // shallowRef because the payloads here are large plain objects that are
  // replaced wholesale, never mutated in place. Deep reactivity on a 200-row
  // table is a proxy per row for no benefit.
  const data = shallowRef<T | null>(null)
  const error = shallowRef<Error | null>(null)
  const state = ref<QueryState>('idle')
  const loading = ref(false)
  const fetching = ref(false)
  const fetchedAt = ref<number | null>(null)

  // Monotonic, so a slow first request cannot overwrite a fast second one. The
  // AbortController handles the network side; this handles the case where the
  // request already resolved and is racing to assign.
  let requestId = 0
  let controller: AbortController | null = null

  function wanted(): boolean {
    return options.enabled ? options.enabled() : true
  }

  async function run(): Promise<void> {
    if (!wanted()) {
      // Not merely "do not start one" -- stop the one already running. A panel
      // that has just been hidden is the clearest case there is of a request
      // whose answer nobody will read.
      requestId += 1
      controller?.abort()
      controller = null
      fetching.value = false
      loading.value = false
      return
    }

    const id = ++requestId
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal

    fetching.value = true
    if (data.value === null) loading.value = true
    state.value = 'loading'

    try {
      const result = await fetcher(signal)
      if (id !== requestId || signal.aborted) return
      data.value = result
      error.value = null
      state.value = 'success'
      fetchedAt.value = Date.now()
    } catch (caught) {
      if (id !== requestId || signal.aborted) return
      // An aborted fetch is not a failure, it is a superseded request. Reporting
      // it as an error is how a dashboard ends up showing a red panel every time
      // someone changes the time range quickly.
      if ((caught as { name?: string })?.name === 'AbortError') return
      error.value = caught instanceof Error ? caught : new Error(String(caught))
      state.value = 'error'
    } finally {
      if (id === requestId) {
        fetching.value = false
        loading.value = false
      }
    }
  }

  // `enabled` is watched alongside the declared sources, so turning it on runs
  // the query rather than waiting for some unrelated filter to move.
  const sources: WatchSource[] = [...(options.watch ?? [])]
  if (options.enabled) sources.push(options.enabled)
  if (sources.length) watch(sources, () => void run())

  if (!options.manual) void run()

  onScopeDispose(() => controller?.abort())

  return { data, error, state, loading, fetching, fetchedAt, refetch: run }
}

/**
 * Turn whatever Supabase threw into a sentence worth showing.
 *
 * The one that matters is 42501, which is what admin_guard() raises and what
 * PostgREST returns as 403. Everything else is passed through, because an
 * internal tool's operator is better served by the real message than by a
 * friendly paraphrase of it.
 */
export function describeError(error: Error | null): { title: string; detail: string; forbidden: boolean } {
  if (!error) return { title: 'Something went wrong', detail: '', forbidden: false }

  const raw = error as Error & { code?: string; hint?: string; details?: string }
  const forbidden = raw.code === '42501' || /not an admin|insufficient_privilege/i.test(error.message)

  if (forbidden) {
    return {
      title: 'Not authorised',
      detail:
        'This account is not in public.admin_users, so the database refused the request. ' +
        'Ask an existing admin to grant access, or seed the first row with the service role.',
      forbidden: true,
    }
  }

  return {
    title: 'Request failed',
    detail: [error.message, raw.details, raw.hint].filter(Boolean).join(' · '),
    forbidden: false,
  }
}

/**
 * Several queries treated as one panel's worth of state.
 *
 * Overview runs five and Health runs five, and each of them hand-wrote a
 * `busy` from a SUBSET of its own: Overview watched three of five, Health two
 * of five. So the Refresh spinner stopped while three requests were still in
 * flight, which reads as "done" and is the one thing a refresh indicator must
 * never say early.
 *
 * `fetchedAt` is the OLDEST of the successful timestamps rather than the
 * newest, and that is the whole reason this is a function and not a `.some()`
 * at each call site. A header that says "as of 10:04" above a panel that last
 * loaded at 09:12 is a dashboard vouching for a number it has not re-read. The
 * page is exactly as fresh as its stalest panel, so that is the figure it
 * reports.
 *
 * A query that has never loaded contributes nothing here -- it is rendering its
 * own loading or error state a few pixels below, which says more than an absent
 * timestamp in the header would.
 */
export function useQueryGroup(queries: QueryResult<unknown>[]): {
  busy: Ref<boolean>
  fetchedAt: Ref<number | null>
  refresh: () => void
} {
  const busy = computed(() => queries.some((query) => query.fetching.value))

  const fetchedAt = computed(() => {
    const stamps = queries
      .map((query) => query.fetchedAt.value)
      .filter((stamp): stamp is number => stamp !== null)
    return stamps.length ? Math.min(...stamps) : null
  })

  function refresh() {
    for (const query of queries) void query.refetch()
  }

  return { busy, fetchedAt, refresh }
}
