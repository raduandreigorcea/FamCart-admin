import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

// Every view is a lazy chunk. There is no auth guard here on purpose: App.vue
// decides what to render based on Clerk and on is_admin(), and the database
// refuses every query regardless, so a guard would be a third place to keep the
// same rule in step with the other two.
//
// `crumb` feeds the breadcrumb trail in TopBar. A detail view appends the last
// segment itself through useLeafCrumb(), so the trail can say "Households / The
// Smiths" rather than "Households / a uuid".

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'overview',
    component: () => import('../views/OverviewView.vue'),
    meta: { crumb: 'Overview' },
  },
  {
    path: '/users',
    name: 'users',
    component: () => import('../views/UsersView.vue'),
    meta: { crumb: 'Users' },
  },
  {
    path: '/users/:userId',
    name: 'user-detail',
    component: () => import('../views/UserDetailView.vue'),
    meta: { crumb: 'Users' },
  },
  {
    path: '/households',
    name: 'households',
    component: () => import('../views/HouseholdsView.vue'),
    meta: { crumb: 'Households' },
  },
  {
    path: '/households/:householdId',
    name: 'household-detail',
    component: () => import('../views/HouseholdDetailView.vue'),
    meta: { crumb: 'Households' },
  },
  {
    path: '/products',
    name: 'products',
    component: () => import('../views/ProductsView.vue'),
    meta: { crumb: 'Products' },
  },
  {
    path: '/products/:productId',
    name: 'product-detail',
    component: () => import('../views/ProductDetailView.vue'),
    meta: { crumb: 'Products' },
  },
  {
    path: '/pipeline',
    name: 'pipeline',
    component: () => import('../views/PipelineView.vue'),
    meta: { crumb: 'Pipeline' },
  },
  {
    path: '/review',
    name: 'review',
    component: () => import('../views/ReviewView.vue'),
    meta: { crumb: 'Review' },
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('../views/SearchView.vue'),
    meta: { crumb: 'Search' },
  },
  {
    path: '/health',
    name: 'health',
    component: () => import('../views/HealthView.vue'),
    meta: { crumb: 'Health' },
  },
  {
    path: '/access',
    name: 'access',
    component: () => import('../views/AccessView.vue'),
    meta: { crumb: 'Access' },
  },
  {
    path: '/trash',
    name: 'trash',
    component: () => import('../views/TrashView.vue'),
    meta: { crumb: 'Trash' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
    meta: { crumb: 'Not found' },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  // The content pane scrolls, not the window, so vue-router's own scroll
  // restoration has nothing to restore. The pane is reset in each view instead.
  scrollBehavior: () => ({ top: 0 }),
})

// ─── surviving a redeploy ────────────────────────────────────────────────────
//
// Every view above is a lazy import(), and Vite gives each built chunk a
// content hash. Deploy while a tab is open and that tab is still holding the
// OLD hashes: the next navigation asks for a file the server no longer has, the
// dynamic import rejects, and vue-router aborts the navigation.
//
// With no handler that abort is completely silent. The click does nothing, and
// keeps doing nothing forever, with no error, no message and no hint that a
// reload would fix it in one second. It is the single most confusing failure
// this app can produce, and the operator's most likely conclusion is that the
// dashboard is broken rather than stale.
//
// So: detect that specific failure and reload into the requested route. A
// reload is safe here because nothing in this tool holds unsaved state -- it is
// a read-only dashboard apart from grant and revoke, both of which are
// single-click confirmed actions that complete before anything navigates.
export function isChunkLoadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    // Safari's wording, which matches none of the above.
    /Unable to load a module|Load failed/i.test(message)
  )
}

/**
 * The path to reload into, or null if the router handed us something that would
 * leave this origin.
 *
 * `to.fullPath` looks like it must be a path, and for every route in this app
 * it is. But the catch-all `/:pathMatch(.*)*` accepts anything the address bar
 * can hold, and vue-router does NOT normalise a leading double slash: it
 * resolves `//evil.com` to a fullPath of `//evil.com`, which is
 * protocol-relative, and `location.assign()` reads that as another host
 * entirely. The dev-only VUE_ROUTER_R0003 warning it logs is stripped from a
 * production build.
 *
 * Nothing an attacker controls can make the chunk import fail in the first
 * place, so this was never a live redirect. It is guarded anyway because the
 * argument for its safety is a fact about today's failure modes, and the
 * argument for the guard is one line.
 */
export function reloadTarget(fullPath: string, origin: string): string | null {
  let url: URL
  try {
    url = new URL(fullPath, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  return `${url.pathname}${url.search}${url.hash}`
}

// Guards against a reload loop: if the chunk is genuinely missing rather than
// merely stale, reloading again would not help and would spin. One attempt per
// destination, remembered for this document only.
const reloadAttempted = new Set<string>()

router.onError((error, to) => {
  if (!isChunkLoadFailure(error)) throw error

  if (reloadAttempted.has(to.fullPath)) {
    // Already tried. Let it surface rather than reloading again -- App.vue's
    // ErrorBoundary will render it with a message the reader can act on.
    throw error
  }

  const target = reloadTarget(to.fullPath, window.location.origin)
  // Off-origin, so there is no route here to reload into. Let the chunk error
  // surface to the ErrorBoundary rather than navigating somewhere on the
  // strength of a string that came out of the address bar.
  if (target === null) throw error

  reloadAttempted.add(to.fullPath)
  window.location.assign(target)
})

export default router
