import { describe, expect, it } from 'vitest'
import { useAdminCheck } from '../src/lib/useAdminCheck'

// BG-3. The check is fired by two independent watchers -- the Clerk session and
// the project switcher -- so overlapping calls are normal, not exotic.
//
// These tests resolve the pending promises BY HAND rather than racing real
// timers. A race test that depends on one setTimeout beating another is a test
// that passes on a fast machine and flakes on a loaded CI runner, which is the
// worst possible property for the test guarding a race.

/** A promise whose settlement this test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useAdminCheck', () => {
  it('starts in checking', () => {
    const { state } = useAdminCheck(async () => true)
    expect(state.value).toBe('checking')
  })

  it('resolves to yes for an admin and no for everyone else', async () => {
    const admin = useAdminCheck(async () => true)
    await admin.check()
    expect(admin.state.value).toBe('yes')

    const guest = useAdminCheck(async () => false)
    await guest.check()
    expect(guest.state.value).toBe('no')
  })

  it('reports a failed check as error, never as "not an admin"', async () => {
    // The distinction the module exists to preserve: an unreachable database is
    // a configuration problem, and calling it a permissions problem points the
    // reader at the wrong thing entirely.
    const { state, error, check } = useAdminCheck(async () => {
      throw new Error('fetch failed: getaddrinfo ENOTFOUND')
    })

    await check()

    expect(state.value).toBe('error')
    expect(state.value).not.toBe('no')
    expect(error.value).toContain('ENOTFOUND')
  })

  it('clears a previous error once a later check succeeds', async () => {
    let fail = true
    const { state, error, check } = useAdminCheck(async () => {
      if (fail) throw new Error('database asleep')
      return true
    })

    await check()
    expect(error.value).toContain('database asleep')

    fail = false
    await check()
    expect(state.value).toBe('yes')
    expect(error.value).toBe('')
  })

  describe('overlapping checks (the dev -> prod -> dev race)', () => {
    it('ignores a stale answer that resolves after a newer one', async () => {
      const first = deferred<boolean>()
      const second = deferred<boolean>()
      const queue = [first.promise, second.promise]

      const { state, check } = useAdminCheck(() => queue.shift()!)

      const a = check() // dev   -> will answer LAST
      const b = check() // prod  -> will answer FIRST

      // The newer request lands first and wins.
      second.resolve(false)
      await b
      expect(state.value).toBe('no')

      // The older one now resolves with the opposite answer. Before the guard
      // this overwrote the newer result and the shell showed the wrong gate.
      first.resolve(true)
      await a
      expect(state.value).toBe('no')
    })

    it('ignores a stale FAILURE that resolves after a newer success', async () => {
      const first = deferred<boolean>()
      const second = deferred<boolean>()
      const queue = [first.promise, second.promise]

      const { state, error, check } = useAdminCheck(() => queue.shift()!)

      const a = check()
      const b = check()

      second.resolve(true)
      await b
      expect(state.value).toBe('yes')

      first.reject(new Error('stale project unreachable'))
      await a

      // The shell must not flip to an error screen because a request for a
      // project we already left failed.
      expect(state.value).toBe('yes')
      expect(error.value).toBe('')
    })

    it('lets the newest answer win regardless of settle order', async () => {
      const first = deferred<boolean>()
      const second = deferred<boolean>()
      const third = deferred<boolean>()
      const queue = [first.promise, second.promise, third.promise]

      const { state, check } = useAdminCheck(() => queue.shift()!)

      const a = check()
      const b = check()
      const c = check()

      // Settle completely out of order: middle, oldest, newest.
      second.resolve(false)
      await b
      first.resolve(false)
      await a
      third.resolve(true)
      await c

      expect(state.value).toBe('yes')
    })
  })
})
