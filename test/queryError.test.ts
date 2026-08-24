import { describe, expect, it } from 'vitest'
import { queryError } from '../src/lib/data/errors'
import { describeError } from '../src/lib/useQuery'

// Twenty-three copies of one line, and every one of them dropped `details` and
// `hint`. describeError() has always rendered `[message, details, hint]`, so
// the detail line under a failed panel had been showing a third of what
// Postgres said.

function thrown(fn: () => never): Error & { code?: string; details?: string; hint?: string } {
  try {
    fn()
  } catch (caught) {
    return caught as Error & { code?: string; details?: string; hint?: string }
  }
  throw new Error('queryError did not throw')
}

describe('queryError', () => {
  it('names the query that failed', () => {
    // A dozen concurrent requests to two databases means a message with no
    // subject is unactionable.
    const error = thrown(() => queryError('admin_list_users', { message: 'timeout' }))
    expect(error.message).toBe('admin_list_users: timeout')
  })

  it('carries the code, which is what tells 42501 apart', () => {
    const error = thrown(() =>
      queryError('admin_overview', { message: 'permission denied', code: '42501' }),
    )
    expect(error.code).toBe('42501')
    expect(describeError(error).forbidden).toBe(true)
  })

  it('carries details and hint through to the rendered message', () => {
    const error = thrown(() =>
      queryError('admin_grant', {
        message: 'insert or update violates foreign key constraint',
        code: '23503',
        details: 'Key (user_id)=(user_2abc) is not present in table "profiles".',
        hint: 'The account has to sign in once before it can be granted admin.',
      }),
    )

    expect(error.details).toMatch(/user_2abc/)
    expect(error.hint).toMatch(/sign in once/)

    const rendered = describeError(error).detail
    expect(rendered).toContain('foreign key constraint')
    expect(rendered).toContain('user_2abc')
    expect(rendered).toContain('sign in once')
  })

  it('omits absent fields rather than rendering undefined', () => {
    const error = thrown(() => queryError('is_admin', { message: 'network error' }))
    expect(error.details).toBeUndefined()
    expect(error.hint).toBeUndefined()
    expect(describeError(error).detail).toBe('is_admin: network error')
  })

  it('survives a null error object', () => {
    // PostgREST can answer with neither data nor a populated error; the throw
    // still has to say which query it was.
    const error = thrown(() => queryError('admin_health', null))
    expect(error.message).toBe('admin_health: unknown error')
  })

  it('is a real Error, so instanceof checks upstream still hold', () => {
    const error = thrown(() => queryError('admin_health', { message: 'boom' }))
    expect(error).toBeInstanceOf(Error)
  })
})
