import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { describeError, useQuery } from '../src/lib/useQuery'

// useQuery is the async primitive every panel in the tool is built on, and its
// entire reason to exist is the four states each panel would otherwise get
// wrong in the same four ways. None of that was verified before.
//
// Everything here settles promises BY HAND. A test that races two real timers
// passes on a fast machine and flakes on a loaded runner, which is a
// particularly bad property for the suite guarding a race.

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** useQuery calls onScopeDispose, which needs an owning effect scope. */
function inScope<T>(fn: () => T): { result: T; stop: () => void } {
  const scope = effectScope()
  const result = scope.run(fn)!
  return { result, stop: () => scope.stop() }
}

describe('the four states', () => {
  it('starts loading and lands on success', async () => {
    const gate = deferred<string>()
    const { result: query, stop } = inScope(() => useQuery(() => gate.promise))

    expect(query.state.value).toBe('loading')
    expect(query.loading.value).toBe(true)
    expect(query.fetching.value).toBe(true)
    expect(query.data.value).toBeNull()

    gate.resolve('rows')
    await nextTick()

    expect(query.state.value).toBe('success')
    expect(query.data.value).toBe('rows')
    expect(query.loading.value).toBe(false)
    expect(query.fetching.value).toBe(false)
    expect(query.error.value).toBeNull()
    expect(query.fetchedAt.value).not.toBeNull()
    stop()
  })

  it('does not leave loading true after an error', async () => {
    // The specific failure the module names first: a panel stuck in a skeleton
    // forever because the catch forgot to clear the flag.
    const gate = deferred<string>()
    const { result: query, stop } = inScope(() => useQuery(() => gate.promise))

    gate.reject(new Error('admin_list_users: permission denied'))
    await nextTick()
    await nextTick()

    expect(query.state.value).toBe('error')
    expect(query.loading.value).toBe(false)
    expect(query.fetching.value).toBe(false)
    expect(query.error.value?.message).toContain('permission denied')
    stop()
  })

  it('wraps a non-Error throw so consumers always get an Error', async () => {
    const gate = deferred<string>()
    const { result: query, stop } = inScope(() => useQuery(() => gate.promise))

    gate.reject('a bare string')
    await nextTick()
    await nextTick()

    expect(query.error.value).toBeInstanceOf(Error)
    expect(query.error.value?.message).toBe('a bare string')
    stop()
  })

  it('skips the initial fetch when manual', () => {
    const fetcher = vi.fn(async () => 'rows')
    const { result: query, stop } = inScope(() => useQuery(fetcher, { manual: true }))

    expect(fetcher).not.toHaveBeenCalled()
    expect(query.state.value).toBe('idle')
    stop()
  })
})

describe('loading vs fetching', () => {
  it('keeps old data on screen during a refetch, and says it is fetching', async () => {
    // The documented split: `loading` is FIRST load only, so a refetch does not
    // collapse a populated table back into a skeleton and reflow the page.
    let gate = deferred<string>()
    const { result: query, stop } = inScope(() => useQuery(() => gate.promise))

    gate.resolve('first')
    await nextTick()
    expect(query.data.value).toBe('first')

    gate = deferred<string>()
    const refetching = query.refetch()

    expect(query.fetching.value).toBe(true)
    expect(query.loading.value).toBe(false) // <- the point
    expect(query.data.value).toBe('first') // still on screen

    gate.resolve('second')
    await refetching

    expect(query.data.value).toBe('second')
    expect(query.fetching.value).toBe(false)
    stop()
  })
})

describe('superseded requests', () => {
  it('ignores a slow first result that resolves after a fast second', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const queue = [first.promise, second.promise]

    // The initial run takes `first`; the refetch below takes `second`.
    const { result: query, stop } = inScope(() => useQuery(() => queue.shift()!))
    const secondRun = query.refetch()

    second.resolve('fresh')
    await secondRun
    expect(query.data.value).toBe('fresh')

    // The abandoned first request now answers. It must not repaint the panel.
    first.resolve('stale')
    await nextTick()
    expect(query.data.value).toBe('fresh')
    stop()
  })

  it('does not surface a superseded request as an error', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const queue = [first.promise, second.promise]

    const { result: query, stop } = inScope(() => useQuery(() => queue.shift()!))
    const secondRun = query.refetch()

    second.resolve('fresh')
    await secondRun

    first.reject(new Error('aborted mid-flight'))
    await nextTick()
    await nextTick()

    expect(query.state.value).toBe('success')
    expect(query.error.value).toBeNull()
    stop()
  })

  it('treats an AbortError as superseded, never as a failure', async () => {
    // The stated reason: reporting an abort as an error is how a dashboard ends
    // up flashing a red panel every time someone changes the time range.
    const gate = deferred<string>()
    const { result: query, stop } = inScope(() => useQuery(() => gate.promise))

    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    gate.reject(abort)
    await nextTick()
    await nextTick()

    expect(query.state.value).not.toBe('error')
    expect(query.error.value).toBeNull()
    stop()
  })
})

describe('cancellation', () => {
  it('hands the fetcher a signal and aborts it when superseded', async () => {
    const signals: AbortSignal[] = []
    const gates = [deferred<string>(), deferred<string>()]
    let call = 0

    const { result: query, stop } = inScope(() =>
      useQuery((signal) => {
        signals.push(signal)
        return gates[call++].promise
      }),
    )

    expect(signals[0].aborted).toBe(false)
    void query.refetch()

    // Issuing a second request must abort the first one's signal, so the
    // in-flight HTTP request is actually cancelled rather than merely ignored.
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)

    gates[1].resolve('ok')
    await nextTick()
    stop()
  })

  it('aborts in flight when the owning scope is disposed', async () => {
    const signals: AbortSignal[] = []
    const gate = deferred<string>()

    const { stop } = inScope(() =>
      useQuery((signal) => {
        signals.push(signal)
        return gate.promise
      }),
    )

    expect(signals[0].aborted).toBe(false)
    stop() // the view unmounts
    expect(signals[0].aborted).toBe(true)
  })
})

describe('watched sources', () => {
  it('re-runs when a watched ref changes', async () => {
    const range = ref('7d')
    const seen: string[] = []

    const { stop } = inScope(() =>
      useQuery(
        async () => {
          seen.push(range.value)
          return range.value
        },
        { watch: [range] },
      ),
    )

    await nextTick()
    range.value = '30d'
    await nextTick()
    await nextTick()

    expect(seen).toEqual(['7d', '30d'])
    stop()
  })
})

describe('describeError', () => {
  it('recognises 42501 by code as the admin refusal', () => {
    const error = Object.assign(new Error('permission denied'), { code: '42501' })
    const described = describeError(error)

    expect(described.forbidden).toBe(true)
    expect(described.title).toBe('Not authorised')
    expect(described.detail).toMatch(/admin_users/)
  })

  it('recognises the refusal by message when no code survived', () => {
    expect(describeError(new Error('not an admin')).forbidden).toBe(true)
    expect(describeError(new Error('insufficient_privilege')).forbidden).toBe(true)
  })

  it('passes an ordinary failure through intact, with hint and details', () => {
    // An internal tool's operator is better served by the real message than by
    // a friendly paraphrase of it.
    const error = Object.assign(new Error('relation does not exist'), {
      details: 'admin_foo',
      hint: 'check the migration',
    })
    const described = describeError(error)

    expect(described.forbidden).toBe(false)
    expect(described.title).toBe('Request failed')
    expect(described.detail).toContain('relation does not exist')
    expect(described.detail).toContain('admin_foo')
    expect(described.detail).toContain('check the migration')
  })

  it('handles a null error without throwing', () => {
    expect(describeError(null).forbidden).toBe(false)
    expect(describeError(null).detail).toBe('')
  })
})

describe('useQuery enabled', () => {
  it('makes no request while it is false', async () => {
    const fetcher = vi.fn().mockResolvedValue('rows')
    const scope = effectScope()
    const query = scope.run(() => useQuery(fetcher, { enabled: () => false }))!

    await nextTick()
    expect(fetcher).not.toHaveBeenCalled()
    expect(query.state.value).toBe('idle')
    expect(query.fetching.value).toBe(false)
    scope.stop()
  })

  it('runs as soon as it turns true', async () => {
    // The whole reason this is not `manual`. `manual` says "not on mount" and
    // has nothing to say about a condition that changes later, so a hidden tab
    // becoming visible had to be wired by hand or not at all.
    const on = ref(false)
    const fetcher = vi.fn().mockResolvedValue('rows')
    const scope = effectScope()
    const query = scope.run(() => useQuery(fetcher, { enabled: () => on.value }))!

    await nextTick()
    expect(fetcher).not.toHaveBeenCalled()

    on.value = true
    await nextTick()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledOnce()
    expect(query.data.value).toBe('rows')
    scope.stop()
  })

  it('aborts the request in flight when it turns false', async () => {
    const on = ref(true)
    let captured: AbortSignal | null = null
    const scope = effectScope()
    const query = scope.run(() =>
      useQuery(
        (signal) => {
          captured = signal
          return new Promise<string>(() => {})
        },
        { enabled: () => on.value },
      ),
    )!

    await nextTick()
    expect(query.fetching.value).toBe(true)

    on.value = false
    await nextTick()

    expect(captured!.aborted).toBe(true)
    expect(query.fetching.value).toBe(false)
    expect(query.loading.value).toBe(false)
    scope.stop()
  })

  it('makes refetch a no-op while disabled', async () => {
    const fetcher = vi.fn().mockResolvedValue('rows')
    const scope = effectScope()
    const query = scope.run(() => useQuery(fetcher, { enabled: () => false }))!

    await query.refetch()
    expect(fetcher).not.toHaveBeenCalled()
    scope.stop()
  })

  it('does not disturb a query that declares no condition', async () => {
    const fetcher = vi.fn().mockResolvedValue('rows')
    const scope = effectScope()
    const query = scope.run(() => useQuery(fetcher))!

    await nextTick()
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(query.data.value).toBe('rows')
    scope.stop()
  })
})
