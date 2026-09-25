import { FunctionsHttpError } from '@supabase/supabase-js'
import { getAppSupabase } from '../supabase'

// Sentry, OneSignal and Clerk, read through FamCart's admin-services edge
// function.
//
// Not directly, and never directly: all three answer only to a secret key, and
// this dashboard holds none (.env.example says why). The function holds the
// keys as secrets of the app project it is deployed to, checks is_admin() with
// the caller's own Clerk token, and returns only the fields these pages render.
// Its request and response shapes are in FamCart's
// supabase/functions/_shared/services.ts; the types below mirror them.
//
// It follows the project switcher like every list read does, because it
// is deployed to both app projects and each answers from its own secrets. So a
// page on famcart-dev can say "not configured" for a service production has.

export type Service = 'sentry' | 'onesignal' | 'clerk'

export interface SentryIssue {
  id: string
  shortId: string
  title: string
  culprit: string | null
  level: string
  events: number
  users: number
  firstSeen: string
  lastSeen: string
  url: string
}

export interface SentryFeedback {
  id: string
  shortId: string
  message: string
  name: string | null
  email: string | null
  /** unresolved, resolved or ignored; ignored is what Sentry calls archived. */
  status: string
  at: string
  url: string
}

export interface PushNotification {
  id: string
  text: string
  at: string | null
  delivered: number
  /** Devices that had unsubscribed: gone, rather than broken. */
  unsubscribed: number
  errored: number
  remaining: number
  canceled: boolean
}

export interface ClerkUser {
  id: string
  name: string | null
  email: string | null
  imageUrl: string | null
  methods: string[]
  createdAt: string | null
  lastSignInAt: string | null
  lastActiveAt: string | null
  twoFactor: boolean
  banned: boolean
  locked: boolean
}

export interface ClerkSummary {
  total: number
  recent: ClerkUser[]
}

const SERVICE_NAMES: Record<Service, string> = { sentry: 'Sentry', onesignal: 'OneSignal', clerk: 'Clerk' }

/**
 * The service cannot be asked on this project at all, as opposed to having
 * failed. Two causes, and a page says which, because the fixes differ: a secret
 * nobody set, or a function nobody deployed.
 */
export class ServiceUnavailable extends Error {
  constructor(
    readonly service: Service,
    readonly reason: 'not_configured' | 'not_deployed',
    readonly missing: string[] = [],
  ) {
    super(`${SERVICE_NAMES[service]} is not ${reason === 'not_configured' ? 'configured' : 'deployed'} on this project`)
  }
}

/** What a page says instead of its content, or null when it has content. */
export function serviceProblem(error: Error | null): { title: string; message: string } | null {
  if (!(error instanceof ServiceUnavailable)) return null
  const name = SERVICE_NAMES[error.service]
  if (error.reason === 'not_deployed') {
    return {
      title: 'The admin-services function is not deployed here',
      message: `This project has no admin-services edge function, so ${name} cannot be read from it. Deploy it with: npx supabase functions deploy admin-services --no-verify-jwt --project-ref <ref>`,
    }
  }
  return {
    title: `${name} is not connected on this project`,
    message: `This project is missing the ${error.missing.join(', ')} secret${error.missing.length === 1 ? '' : 's'}. Set ${error.missing.length === 1 ? 'it' : 'them'} with: npx supabase secrets set --project-ref <ref>`,
  }
}

async function failure(service: Service, error: unknown): Promise<Error> {
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response
    const body = (await res.json().catch(() => null)) as
      | { code?: string; error?: string; missing?: string[] }
      | null
    if (body?.code === 'not_configured') return new ServiceUnavailable(service, 'not_configured', body.missing ?? [])
    // The function never answers 404, so a 404 is the platform saying it is
    // not there.
    if (res.status === 404) return new ServiceUnavailable(service, 'not_deployed')
    return Object.assign(new Error(`admin-services/${service}: ${body?.error ?? `HTTP ${res.status}`}`), {
      code: body?.code,
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`admin-services/${service}: ${message}`)
}

async function ask<T>(body: { service: Service; view: string; userId?: string }, signal: AbortSignal): Promise<T> {
  const { data, error } = await getAppSupabase().functions.invoke('admin-services', { body, signal })
  if (error) throw await failure(body.service, error)
  return (data as { data: T }).data
}

export function fetchSentryIssues(signal: AbortSignal): Promise<SentryIssue[]> {
  return ask({ service: 'sentry', view: 'issues' }, signal)
}

export function fetchSentryFeedback(signal: AbortSignal): Promise<SentryFeedback[]> {
  return ask({ service: 'sentry', view: 'feedback' }, signal)
}

export function fetchPushNotifications(signal: AbortSignal): Promise<PushNotification[]> {
  return ask({ service: 'onesignal', view: 'notifications' }, signal)
}

export function fetchClerkSummary(signal: AbortSignal): Promise<ClerkSummary> {
  return ask({ service: 'clerk', view: 'summary' }, signal)
}

/** Null when the profile's Clerk account no longer exists. */
export function fetchClerkUser(userId: string, signal: AbortSignal): Promise<ClerkUser | null> {
  return ask({ service: 'clerk', view: 'user', userId }, signal)
}

const METHOD_LABELS: Record<string, string> = {
  google: 'Google',
  apple: 'Apple',
  facebook: 'Facebook',
  password: 'Password',
  email: 'Email code',
}

/** How a person signs in, in words: "Google, Email code". */
export function methodsLabel(methods: string[]): string {
  if (!methods.length) return 'Nothing set up'
  return methods.map((m) => METHOD_LABELS[m] ?? m.charAt(0).toUpperCase() + m.slice(1)).join(', ')
}

/** Totals across a list of notifications, for the tiles above it. */
export function pushTotals(rows: PushNotification[]) {
  return rows.reduce(
    (sum, row) => ({
      delivered: sum.delivered + row.delivered,
      unsubscribed: sum.unsubscribed + row.unsubscribed,
      errored: sum.errored + row.errored,
    }),
    { delivered: 0, unsubscribed: 0, errored: 0 },
  )
}
