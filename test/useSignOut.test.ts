import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// The sign-out button on the two gate screens is the ONLY way off them: an
// account that is not in admin_users cannot navigate anywhere else. So the
// failure that matters is not "sign-out threw", it is "sign-out did nothing and
// said nothing", which is what `await clerk.value?.signOut()` produced for both
// of its failure modes.

const clerk = ref<{ signOut: () => Promise<void> } | undefined>(undefined)

vi.mock('@clerk/vue', () => ({ useClerk: () => clerk }))

const { useSignOut } = await import('../src/lib/useSignOut')

describe('useSignOut', () => {
  it('signs out when Clerk is ready', async () => {
    const signOutSpy = vi.fn().mockResolvedValue(undefined)
    clerk.value = { signOut: signOutSpy }

    const handle = useSignOut()
    await handle.signOut()

    expect(signOutSpy).toHaveBeenCalledOnce()
    expect(handle.error.value).toBe('')
    expect(handle.busy.value).toBe(false)
  })

  it('says so when Clerk has not loaded, instead of doing nothing', async () => {
    // `clerk.value?.signOut()` made this a no-op. The button looked broken and
    // the operator had no way to tell it from a broken button.
    clerk.value = undefined

    const handle = useSignOut()
    await handle.signOut()

    expect(handle.error.value).toMatch(/not finished loading/i)
    expect(handle.busy.value).toBe(false)
  })

  it('reports a rejected sign-out instead of leaking an unhandled rejection', async () => {
    clerk.value = { signOut: () => Promise.reject(new Error('network request failed')) }

    const handle = useSignOut()
    await handle.signOut()

    expect(handle.error.value).toBe('network request failed')
    expect(handle.busy.value).toBe(false)
  })

  it('refuses a second attempt while one is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const signOutSpy = vi.fn().mockReturnValue(gate)
    clerk.value = { signOut: signOutSpy }

    const handle = useSignOut()
    const first = handle.signOut()
    expect(handle.busy.value).toBe(true)

    await handle.signOut()
    expect(signOutSpy).toHaveBeenCalledOnce()

    release()
    await first
    expect(handle.busy.value).toBe(false)
  })

  it('clears a previous error when retried', async () => {
    clerk.value = { signOut: () => Promise.reject(new Error('network request failed')) }
    const handle = useSignOut()
    await handle.signOut()
    expect(handle.error.value).not.toBe('')

    clerk.value = { signOut: () => Promise.resolve() }
    await handle.signOut()
    expect(handle.error.value).toBe('')
  })
})
