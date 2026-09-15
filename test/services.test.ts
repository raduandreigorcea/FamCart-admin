import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FunctionsHttpError } from '@supabase/supabase-js'

// Sentry, OneSignal and Clerk, through FamCart's admin-services edge function.
//
// What is worth pinning is how a failure is told apart, because each one sends
// the reader somewhere different: a secret nobody set (set it), a function
// nobody deployed (deploy it), a non-admin (the same "Not authorised" screen as
// every RPC), and anything else (an error with the vendor's own words).

const calls = vi.hoisted(() => ({ name: '', body: null as unknown }))
const answer = vi.hoisted(() => ({ data: null as unknown, error: null as unknown }))

vi.mock('../src/lib/supabase', () => ({
  getAppSupabase: () => ({
    functions: {
      invoke: async (name: string, options: { body: unknown }) => {
        calls.name = name
        calls.body = options.body
        return { data: answer.data, error: answer.error }
      },
    },
  }),
}))

const {
  ServiceUnavailable,
  fetchClerkUser,
  fetchPushNotifications,
  fetchSentryIssues,
  methodsLabel,
  pushTotals,
  serviceProblem,
} = await import('../src/lib/data/services')
const { describeError } = await import('../src/lib/useQuery')

const signal = () => new AbortController().signal

function httpError(status: number, body: unknown) {
  return new FunctionsHttpError(new Response(JSON.stringify(body), { status }))
}

beforeEach(() => {
  answer.data = null
  answer.error = null
})

describe('asking admin-services', () => {
  it('names the service and view, and unwraps the payload', async () => {
    answer.data = { data: [{ id: '1' }] }
    await expect(fetchSentryIssues(signal())).resolves.toEqual([{ id: '1' }])
    expect(calls.name).toBe('admin-services')
    expect(calls.body).toEqual({ service: 'sentry', view: 'issues' })
  })

  it('sends the user id for one account', async () => {
    answer.data = { data: null }
    await expect(fetchClerkUser('user_2abcdefghij', signal())).resolves.toBeNull()
    expect(calls.body).toEqual({ service: 'clerk', view: 'user', userId: 'user_2abcdefghij' })
  })

  it('reports a missing secret by name', async () => {
    answer.error = httpError(503, { code: 'not_configured', missing: ['ONESIGNAL_REST_API_KEY'] })
    const error = await fetchPushNotifications(signal()).catch((e: Error) => e)
    expect(error).toBeInstanceOf(ServiceUnavailable)
    const problem = serviceProblem(error as Error)
    expect(problem?.title).toBe('OneSignal is not connected on this project')
    expect(problem?.message).toContain('ONESIGNAL_REST_API_KEY')
  })

  it('reads a 404 as the function not being deployed', async () => {
    answer.error = httpError(404, { code: 'NOT_FOUND', message: 'Requested function was not found' })
    const error = await fetchSentryIssues(signal()).catch((e: Error) => e)
    expect(serviceProblem(error as Error)?.title).toMatch(/not deployed/)
  })

  it('lets a non-admin reach the same screen every RPC does', async () => {
    answer.error = httpError(403, { code: 'not_admin', error: 'This account is not an admin of this project.' })
    const error = await fetchSentryIssues(signal()).catch((e: Error) => e)
    expect(serviceProblem(error as Error)).toBeNull()
    expect(describeError(error as Error).forbidden).toBe(true)
  })

  it('keeps the vendor failure in the message', async () => {
    answer.error = httpError(502, { code: 'upstream', error: 'Clerk refused the key this project holds (401).' })
    const error = await fetchClerkUser('user_2abcdefghij', signal()).catch((e: Error) => e)
    expect((error as Error).message).toContain('Clerk refused the key')
  })
})

describe('pushTotals', () => {
  it('adds up every notification', () => {
    const row = { id: 'n', text: '', at: null, remaining: 0, canceled: false }
    expect(
      pushTotals([
        { ...row, delivered: 2, unsubscribed: 1, errored: 0 },
        { ...row, delivered: 3, unsubscribed: 0, errored: 1 },
      ]),
    ).toEqual({ delivered: 5, unsubscribed: 1, errored: 1 })
  })
})

describe('methodsLabel', () => {
  it('says how someone signs in, in words', () => {
    expect(methodsLabel(['google', 'email'])).toBe('Google, Email code')
    expect(methodsLabel([])).toBe('Nothing set up')
  })
})
