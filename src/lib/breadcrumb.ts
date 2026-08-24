import { onScopeDispose, ref, watch, type Ref } from 'vue'

// The last segment of the breadcrumb trail, which only a detail view can supply.
//
// ─── WHY THIS IS NOT ON route.meta ──────────────────────────────────────────
//
// It was: each detail view wrote `route.meta.leafCrumb = name` and TopBar read
// it back. That looked like the tidy answer -- route meta is reactive, so the
// two components never had to know about each other -- and it is wrong for one
// reason that is easy to miss.
//
// `route.meta` on a flat route IS the route record's meta object. Not a copy,
// not per-navigation state: the same object the router was constructed with,
// living for the lifetime of the module. So the write outlived the component
// that made it. Leave /users/alice, come back later at /users/bob, and the
// trail said "Users / Alice" for every frame between the route changing and the
// new view's watcher getting around to firing -- the wrong person's name, on
// screen, on a page about somebody else.
//
// A ref bound to the consuming component's scope has no such window. It clears
// on unmount, and Vue unmounts the outgoing view before mounting the incoming
// one, so the trail is briefly short rather than briefly wrong. Short is the
// honest state: at that moment nothing knows the name yet.

/**
 * The crumb for a record the route names by id: the name once the loaded record
 * IS that record, the id until then.
 *
 * The identity check is the whole point and is easy to leave out. A detail view
 * is reused across a params change rather than remounted, and useQuery keeps
 * the last payload on screen while the next request is in flight -- so for the
 * full duration of that round trip, `data` describes the PREVIOUS entity while
 * the route names the next one. Reading the name unguarded put one person's
 * name on another person's page for seconds at a time.
 *
 * Falling back to the id is not a placeholder. The id is the true answer to
 * "what is this page about" at that moment; the name is not yet known.
 */
export function crumbOf<T>(
  id: string,
  record: T | null | undefined,
  identity: (record: T) => string,
  label: (record: T) => string | null | undefined,
): string {
  if (!record || identity(record) !== id) return id
  return label(record) || id
}

const leaf = ref<string | null>(null)

/** Read-only view of the leaf crumb, for TopBar. */
export function leafCrumb(): Readonly<Ref<string | null>> {
  return leaf
}

/**
 * Publish the leaf crumb for as long as the calling component is alive.
 *
 * `source` is re-read reactively, because a detail view knows the id before it
 * knows the name and should show the id in the meantime rather than nothing.
 */
export function useLeafCrumb(source: () => string | null | undefined): void {
  watch(
    source,
    (value) => {
      leaf.value = value ?? null
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    leaf.value = null
  })
}
