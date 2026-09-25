import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { Component } from 'vue'

// The run's log, live. What must hold: a run from before logs existed says so,
// the level filter narrows, a line arriving twice (Realtime and the poll) is
// drawn once, and the subscription is let go with the page.

const state = vi.hoisted(() => ({
  lines: [] as Array<Record<string, unknown>>,
  onLine: null as null | ((line: Record<string, unknown>) => void),
  unsubscribed: 0,
  fetches: 0,
  failNext: false,
}))

vi.mock('../src/lib/data/runLogs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/data/runLogs')>()),
  fetchRunLogs: async (_run: string, afterId: number) => {
    state.fetches++
    if (state.failNext) {
      state.failNext = false
      throw new Error('fetch failed')
    }
    return state.lines.filter((l) => (l.id as number) > afterId)
  },
  subscribeRunLogs: (_run: string, onLine: (line: Record<string, unknown>) => void) => {
    state.onLine = onLine
    return () => {
      state.unsubscribed++
    }
  },
}))

const Panel = (await import('../src/components/RunLogPanel.vue')).default as unknown as Component
const stubs = {
  PanelCard: { props: ['title'], template: '<section><slot name="actions" /><slot /></section>' },
  StateBlock: { props: ['title'], template: '<div class="state">{{ title }}</div>' },
}

const line = (id: number, level = 'info', message = `line ${id}`) => ({
  id,
  run_id: 'run-1',
  t: '2026-09-25T01:20:00Z',
  level,
  scope: 'lidl',
  message,
  fields: null,
})

beforeEach(() => {
  state.lines = []
  state.onLine = null
  state.unsubscribed = 0
  state.fetches = 0
  state.failNext = false
})

describe('RunLogPanel', () => {
  it('says when a run has no log at all', async () => {
    const wrapper = mount(Panel, { props: { runId: 'run-1', live: false }, global: { stubs } })
    await flushPromises()
    expect(wrapper.find('.state').text()).toContain('No log for this run')
  })

  it('draws the lines, and narrows to warnings and errors', async () => {
    state.lines = [line(1), line(2, 'warn', 'careful'), line(3, 'error', 'boom')]
    const wrapper = mount(Panel, { props: { runId: 'run-1', live: false }, global: { stubs } })
    await flushPromises()
    expect(wrapper.findAll('.log__line')).toHaveLength(3)
    await wrapper.find('select').setValue('warn')
    expect(wrapper.findAll('.log__line').map((l) => l.text())).toEqual([
      expect.stringContaining('careful'),
      expect.stringContaining('boom'),
    ])
    await wrapper.find('select').setValue('error')
    expect(wrapper.findAll('.log__line')).toHaveLength(1)
  })

  it('takes live lines once each, however they arrive', async () => {
    state.lines = [line(1)]
    const wrapper = mount(Panel, { props: { runId: 'run-1', live: true }, global: { stubs } })
    await flushPromises()
    state.onLine?.(line(2))
    state.onLine?.(line(2))
    await flushPromises()
    expect(wrapper.findAll('.log__line')).toHaveLength(2)
  })

  it('does not subscribe to a finished run, and lets go when it leaves', async () => {
    const done = mount(Panel, { props: { runId: 'run-1', live: false }, global: { stubs } })
    await flushPromises()
    expect(state.onLine).toBeNull()
    done.unmount()

    const live = mount(Panel, { props: { runId: 'run-1', live: true }, global: { stubs } })
    await flushPromises()
    live.unmount()
    expect(state.unsubscribed).toBe(1)
  })

  it('polls too, so a dead socket does not look like a quiet scraper', async () => {
    vi.useFakeTimers()
    try {
      mount(Panel, { props: { runId: 'run-1', live: true }, global: { stubs } })
      await flushPromises()
      const before = state.fetches
      await vi.advanceTimersByTimeAsync(30_000)
      expect(state.fetches).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the closing lines once the run ends, and stops listening', async () => {
    state.lines = [line(1)]
    const wrapper = mount(Panel, { props: { runId: 'run-1', live: true }, global: { stubs } })
    await flushPromises()
    state.lines = [line(1), line(2, 'info', 'done')]
    await wrapper.setProps({ live: false })
    await flushPromises()
    expect(state.unsubscribed).toBe(1)
    expect(wrapper.text()).toContain('done')
  })

  // Realtime can deliver a later line before the socket has seen the ones in
  // between (a join that took a second, a reconnect: postgres_changes does not
  // replay). The poll is what fills that gap, so Realtime must not move it.
  it('fills a gap Realtime skipped, on the next poll', async () => {
    vi.useFakeTimers()
    try {
      state.lines = [line(1)]
      const wrapper = mount(Panel, { props: { runId: 'run-1', live: true }, global: { stubs } })
      await flushPromises()
      state.onLine?.(line(5))
      state.lines = [line(1), line(2), line(3), line(4), line(5)]
      await vi.advanceTimersByTimeAsync(30_000)
      await flushPromises()
      expect(wrapper.findAll('.log__line').map((l) => l.text())).toEqual(
        [1, 2, 3, 4, 5].map((n) => expect.stringContaining(`line ${n}`)),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the lines on screen when one poll fails', async () => {
    vi.useFakeTimers()
    try {
      state.lines = [line(1)]
      const wrapper = mount(Panel, { props: { runId: 'run-1', live: true }, global: { stubs } })
      await flushPromises()
      state.failNext = true
      await vi.advanceTimersByTimeAsync(30_000)
      await flushPromises()
      expect(wrapper.findAll('.log__line')).toHaveLength(1)
      expect(wrapper.text()).toContain('Could not read the log')
    } finally {
      vi.useRealTimers()
    }
  })
})
