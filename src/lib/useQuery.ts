import { ref, shallowRef, watch, onScopeDispose, type Ref, type WatchSource } from 'vue'

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

  async function run(): Promise<void> {
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

  if (options.watch?.length) {
    watch(options.watch, () => void run())
  }

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
