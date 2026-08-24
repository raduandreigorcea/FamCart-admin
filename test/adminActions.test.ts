import { describe, expect, it, vi } from 'vitest'

// The dashboard's only destructive-looking calls. Each is a thin wrapper, and
// the thing worth asserting about a thin wrapper is that it passes the right
// argument names -- PostgREST resolves an RPC by argument NAME, so a rename in
// the SQL and a stale name here fail at runtime as a 404 that mentions neither.

const rpc = vi.fn()
const abortSignal = vi.fn()

vi.mock('../src/lib/supabase', () => ({
  getAppSupabase: () => ({ rpc }),
  getCatalogSupabase: () => null,
}))

const { deleteHousehold, restoreHousehold, fetchDeletedHouseholds } = await import(
  '../src/lib/data/households'
)
const { banUser, unbanUser } = await import('../src/lib/data/users')

function resolving(data: unknown = null, error: unknown = null) {
  abortSignal.mockResolvedValue({ data, error })
  rpc.mockReturnValue({ abortSignal })
}

const signal = () => new AbortController().signal

describe('household deletion calls', () => {
  it('names the household by p_id when deleting', async () => {
    resolving()
    await deleteHousehold('h-1', signal())
    expect(rpc).toHaveBeenCalledWith('admin_delete_household', { p_id: 'h-1' })
  })

  it('names the household by p_id when restoring', async () => {
    resolving()
    await restoreHousehold('h-1', signal())
    expect(rpc).toHaveBeenCalledWith('admin_restore_household', { p_id: 'h-1' })
  })

  it('returns an empty list rather than null when nothing is deleted', async () => {
    // A view that has to guard against null AND empty is a view with two empty
    // states, and one of them will be wrong.
    resolving(null)
    await expect(fetchDeletedHouseholds(signal())).resolves.toEqual([])
  })

  it('passes the abort signal through to PostgREST', async () => {
    resolving([])
    const s = signal()
    await fetchDeletedHouseholds(s)
    expect(abortSignal).toHaveBeenCalledWith(s)
  })

  it('names the failing RPC and keeps the code when the database refuses', async () => {
    resolving(null, { message: 'not an admin', code: '42501' })
    await expect(deleteHousehold('h-1', signal())).rejects.toMatchObject({
      message: expect.stringContaining('admin_delete_household'),
      code: '42501',
    })
  })
})

describe('ban calls', () => {
  it('passes the reason through', async () => {
    // The reason is the whole audit value of a ban. Dropping it leaves a
    // security_events row that records something happened and not why.
    resolving()
    await banUser('user_2abc', 'spam', signal())
    expect(rpc).toHaveBeenCalledWith('admin_ban_user', {
      p_user_id: 'user_2abc',
      p_reason: 'spam',
    })
  })

  it('sends an empty reason as an empty string, not undefined', async () => {
    // p_reason has no default in the SQL, so undefined would be a 404 on
    // argument resolution rather than a ban with no stated reason.
    resolving()
    await banUser('user_2abc', '', signal())
    expect(rpc).toHaveBeenCalledWith('admin_ban_user', { p_user_id: 'user_2abc', p_reason: '' })
  })

  it('unbans by user id', async () => {
    resolving()
    await unbanUser('user_2abc', signal())
    expect(rpc).toHaveBeenCalledWith('admin_unban_user', { p_user_id: 'user_2abc' })
  })
})
