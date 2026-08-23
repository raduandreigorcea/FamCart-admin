import { computed, ref, type ComputedRef } from 'vue'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { useAuth } from '@clerk/vue'

// Two app databases, one catalog, one Clerk session.
//
// FamCart has two projects with IDENTICAL schemas and very different
// consequences: `famcart` holds real households, `famcart-dev` holds whatever
// was last tried. This dashboard can point at either, and switching is a
// deliberate act rather than a config edit and a restart.
//
// The catalog project deliberately does NOT switch with them. There is only one,
// shared live by both apps, which is the whole reason it exists as its own
// project. So a switch changes every household number on screen and leaves every
// product number exactly where it was, and the UI says so.
//
// What this file still does not have is a service-role key, and must never. The
// dashboard sees across households because public.admin_users says the signed-in
// account may, checked inside every admin_* function. The browser holds nothing
// more privileged than FamCart's own bundle does — twice over now, which changes
// nothing: an anon key is publishable by design and RLS is what stands behind it.

export type AppProject = 'production' | 'development'

interface ProjectConfig {
  key: AppProject
  label: string
  url: string | undefined
  anonKey: string | undefined
}

const PROJECTS: Record<AppProject, ProjectConfig> = {
  production: {
    key: 'production',
    label: 'famcart',
    url: import.meta.env.VITE_PROD_SUPABASE_URL,
    anonKey: import.meta.env.VITE_PROD_SUPABASE_ANON_KEY,
  },
  development: {
    key: 'development',
    label: 'famcart-dev',
    url: import.meta.env.VITE_DEV_SUPABASE_URL,
    anonKey: import.meta.env.VITE_DEV_SUPABASE_ANON_KEY,
  },
}

const catalogUrl = import.meta.env.VITE_CATALOG_SUPABASE_URL as string | undefined
const catalogAnonKey = import.meta.env.VITE_CATALOG_SUPABASE_ANON_KEY as string | undefined

function isConfigured(project: ProjectConfig): boolean {
  return Boolean(project.url && project.anonKey)
}

export function configuredProjects(): AppProject[] {
  return (Object.keys(PROJECTS) as AppProject[]).filter((key) => isConfigured(PROJECTS[key]))
}

/** True only when there is a choice to make. One project means no switcher. */
export function canSwitchProjects(): boolean {
  return configuredProjects().length > 1
}

const STORAGE_KEY = 'famcart-admin-project'

/**
 * Which project to open on.
 *
 * Development wins a tie, always. Landing on production by default would make
 * the safe case the one you have to notice, and the whole point of the badge is
 * that you never have to notice the safe case.
 *
 * A stored choice is honoured, including a stored 'production' — being thrown
 * back to dev on every reload would make the switcher useless for the job it
 * exists for. What keeps that safe is that production is unmistakable on screen
 * and that switching TO it is confirmed.
 */
function initialProject(): AppProject {
  const available = configuredProjects()
  if (available.length === 0) return 'development'

  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if ((saved === 'production' || saved === 'development') && available.includes(saved)) {
      return saved
    }
  } catch {
    // Storage disabled. The default below applies and simply will not persist.
  }

  return available.includes('development') ? 'development' : available[0]
}

const active = ref<AppProject>(initialProject())

/** The current project. Read it, do not write it — see setActiveProject. */
export const activeProject: ComputedRef<AppProject> = computed(() => active.value)

/**
 * Point the dashboard at another project.
 *
 * Everything downstream reacts: App.vue re-runs the admin check (being an admin
 * on one project says nothing about the other), remounts the view so every
 * in-flight query is abandoned and reissued, and leaves any detail route it was
 * on, because a household id from one database means nothing in the other.
 */
export function setActiveProject(next: AppProject): void {
  if (!isConfigured(PROJECTS[next]) || next === active.value) return
  active.value = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Storage disabled. The switch still applies for this session.
  }
}

/**
 * The Supabase project ref, parsed out of its URL.
 *
 * Shown on every screen. Two identical schemas are told apart by this string and
 * nothing else, and a dashboard that does not say which database it is reading
 * is a dashboard you cannot trust a number from.
 */
export function projectRef(url: string | undefined): string | null {
  if (!url) return null
  const match = /^https:\/\/([a-z0-9]+)\.supabase\./i.exec(url.trim())
  return match ? match[1] : null
}

export interface TargetInfo {
  project: AppProject
  ref: string | null
  label: string
  kind: 'production' | 'development'
  configured: boolean
}

function describe(project: ProjectConfig): TargetInfo {
  return {
    project: project.key,
    ref: projectRef(project.url),
    label: isConfigured(project) ? project.label : `${project.label} (not configured)`,
    kind: project.key,
    configured: isConfigured(project),
  }
}

/** Every project, for the switcher, including ones with no credentials. */
export function allTargets(): TargetInfo[] {
  return (Object.keys(PROJECTS) as AppProject[]).map((key) => describe(PROJECTS[key]))
}

/**
 * The project currently being read.
 *
 * A computed, not a plain call: it is rendered in the topbar, the sidebar and on
 * two pages, and all four have to change the instant the switcher does.
 */
export const appTarget: ComputedRef<TargetInfo> = computed(() => describe(PROJECTS[active.value]))

export function catalogTarget(): { ref: string | null; label: string; configured: boolean } {
  const ref_ = projectRef(catalogUrl)
  return {
    ref: ref_,
    label: ref_ ?? 'not configured',
    configured: Boolean(catalogUrl && catalogAnonKey),
  }
}

/** The Clerk instance this build authenticates against, for the same badge. */
export function clerkIssuer(): string | null {
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined
  if (!key) return null
  // A publishable key is `pk_test_<base64 of "issuer.host$">`. Decoding it is how
  // the badge names the instance without another environment variable to keep in
  // step with this one.
  const encoded = key.replace(/^pk_(test|live)_/, '')
  try {
    return atob(encoded).replace(/\$$/, '') || null
  } catch {
    return null
  }
}

// Reads that die at the network layer get one short retry, for the reason
// FamCart's copy of this documents: after a machine sleeps the first request
// often goes out on a dead keep-alive socket and fails without reaching
// Supabase. HTTP responses are never retried, and neither are mutations.
const RETRY_DELAYS_MS = [250, 750]

async function fetchWithRetry(url: RequestInfo | URL, options: RequestInit = {}): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase()
  const retriable = method === 'GET' || method === 'HEAD'
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, options)
    } catch (error) {
      const aborted =
        options.signal?.aborted || (error as { name?: string })?.name === 'AbortError'
      if (!retriable || aborted || attempt >= RETRY_DELAYS_MS.length) throw error
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
    }
  }
}

let getTokenFn: (() => Promise<string | null>) | null = null

function clientOptions() {
  return {
    auth: { persistSession: false, autoRefreshToken: false },
    // supabase-js resolves this once per request and attaches the header itself.
    // Shared by every client here: one Clerk session authenticates all three
    // projects, because all three name that issuer in their Third-Party Auth
    // settings.
    accessToken: async () => (getTokenFn ? await getTokenFn() : null),
    global: { fetch: fetchWithRetry },
  }
}

// One client per project, built on first use and kept. Switching does not tear a
// client down: coming back to a project should not pay for a new connection, and
// the clients hold no per-session state to go stale (persistSession is off and
// the token comes from the resolver on every request).
const clients = new Map<AppProject, SupabaseClient>()
let catalogClient: SupabaseClient | null = null

/** The app database currently selected. Throws when it is unconfigured. */
export function getAppSupabase(): SupabaseClient {
  const project = PROJECTS[active.value]
  if (!project.url || !project.anonKey) {
    throw new Error(
      `The ${project.key} project is not configured. Set VITE_${
        project.key === 'production' ? 'PROD' : 'DEV'
      }_SUPABASE_URL and the matching anon key.`,
    )
  }

  const existing = clients.get(project.key)
  if (existing) return existing

  const created = createClient(project.url, project.anonKey, clientOptions())
  clients.set(project.key, created)
  return created
}

/**
 * The catalog project, or null where it is not configured.
 *
 * Does not switch, and that is not an oversight. There is one catalog, shared
 * live by production and development alike, which is exactly why it is its own
 * project in its own organisation. Null is a supported state: the Products and
 * Pipeline sections say so and nothing else is affected.
 */
export function getCatalogSupabase(): SupabaseClient | null {
  if (!catalogUrl || !catalogAnonKey) return null
  if (!catalogClient) catalogClient = createClient(catalogUrl, catalogAnonKey, clientOptions())
  return catalogClient
}

/**
 * How the clients learn to mint tokens.
 *
 * Installed once from App.vue rather than per component, because the data layer
 * is plain functions that run outside any component context and useAuth() needs
 * one. Same split FamCart makes.
 */
export function setTokenResolver(resolve: () => Promise<string | null>): void {
  getTokenFn = resolve
}

/** Inside a component, where useAuth() is available. */
export function useSupabaseAuthBridge(): void {
  const { getToken } = useAuth()
  setTokenResolver(async () => getToken.value({ template: 'supabase' }))
}
