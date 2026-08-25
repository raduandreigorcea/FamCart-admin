import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'

// The run control is the panel that replaced "runs cannot be started from a
// browser". What is worth asserting is not that a button enqueues -- that is one
// RPC call -- but the two things that make it honest: it refuses to offer a
// control nobody is listening for, and it never shows a spinner that cannot end.

const enqueueRun = vi.fn().mockResolvedValue('req-1')
const cancelRun = vi.fn().mockResolvedValue(undefined)
const fetchRunRequests = vi.fn()
const fetchRunRequest = vi.fn()
const fetchWorkers = vi.fn()

vi.mock('../src/lib/data/runs', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/data/runs')>(
    '../src/lib/data/runs',
  )
  return { ...actual, enqueueRun, cancelRun, fetchRunRequests, fetchRunRequest, fetchWorkers }
})

vi.mock('../src/lib/data/products', () => ({
  catalogConfigured: () => true,
  CatalogNotConfigured: class extends Error {},
}))

const RunControl = (await import('../src/components/RunControl.vue'))
  .default as unknown as Component

const stubs = {
  PanelCard: { template: '<div><slot /></div>' },
  StateBlock: {
    props: ['title', 'message', 'wouldRequire'],
    template: '<div>{{ title }} {{ message }} {{ wouldRequire }}</div>',
  },
  StatusPill: { props: ['label'], template: '<span>{{ label }}</span>' },
  ConfirmDialog: {
    props: ['open', 'title'],
    template: '<div v-if="open" class="dialog">{{ title }}</div>',
  },
  DataTable: {
    props: ['rows'],
    template: `<table><tbody><tr v-for="r in rows" :key="r.id">
      <td>{{ r.kind }}</td><td><slot name="cell-error" :row="r" /></td>
    </tr></tbody></table>`,
  },
}

const liveWorker = {
  id: 'w1',
  hostname: 'desktop',
  started_at: '2026-08-25T00:00:00.000Z',
  last_seen_at: '2026-08-25T00:00:00.000Z',
  current_request: null,
  seconds_since_seen: 2,
  sources: ['openfoodfacts', 'openbeautyfacts'],
}

const runningRequest = {
  id: 'r1',
  kind: 'load',
  source: 'openfoodfacts',
  status: 'running',
  requested_by: null,
  requested_at: '2026-08-25T00:00:00.000Z',
  claimed_by: 'w1',
  claimed_at: null,
  finished_at: null,
  run_id: null,
  stage: 'loading',
  progress_done: 12,
  progress_total: 240,
  error: null,
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  enqueueRun.mockClear()
  cancelRun.mockClear()
  fetchWorkers.mockReset().mockResolvedValue([liveWorker])
  fetchRunRequests.mockReset().mockResolvedValue([])
  fetchRunRequest.mockReset().mockResolvedValue(null)
})

describe('RunControl', () => {
  it('names the machine that is listening', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()
    expect(w.text()).toMatch(/desktop/)
  })

  // A button that queues into a void is worse than a disabled one.
  it('disables the buttons and says the command when nobody has checked in', async () => {
    fetchWorkers.mockResolvedValue([])
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.find('[data-test="run-score"]').attributes('disabled')).toBeDefined()
    expect(w.text()).toMatch(/npm run worker/)
  })

  it('enqueues a re-score without a confirmation', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    await w.find('[data-test="run-score"]').trigger('click')
    await flush()

    expect(enqueueRun).toHaveBeenCalledWith('score', 'openfoodfacts')
  })

  // Apply writes the catalog. The other three cost time and nothing else.
  it('confirms before applying, and does not enqueue until confirmed', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    await w.find('[data-test="run-load-apply"]').trigger('click')
    await flush()

    expect(w.find('.dialog').exists()).toBe(true)
    expect(enqueueRun).not.toHaveBeenCalled()
  })

  it('shows progress and the last log lines while a run is active', async () => {
    fetchRunRequests.mockResolvedValue([runningRequest])
    fetchRunRequest.mockResolvedValue({
      ...runningRequest,
      log: [{ at: '2026-08-25T00:00:01.000Z', level: 'info', text: 'chunk 12/240' }],
    })

    const w = mount(RunControl, { global: { stubs } })
    await flush()
    await flush()

    expect(w.text()).toContain('12')
    expect(w.text()).toContain('240')
    expect(w.text()).toContain('chunk 12/240')
  })

  it('will not start a second run while one is active', async () => {
    fetchRunRequests.mockResolvedValue([runningRequest])
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.find('[data-test="run-score"]').attributes('disabled')).toBeDefined()
  })

  // The worker marks its own request failed on ctrl-c, so a running request with
  // nobody listening is a power cut. A spinner that never finishes is the one
  // state this panel must not show.
  it('calls a running request stalled when no worker is listening', async () => {
    fetchWorkers.mockResolvedValue([])
    fetchRunRequests.mockResolvedValue([runningRequest])

    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.text()).toMatch(/stalled/i)
  })

  it('cancels the active request', async () => {
    fetchRunRequests.mockResolvedValue([runningRequest])
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    await w.find('[data-test="cancel-run"]').trigger('click')
    await flush()

    expect(cancelRun).toHaveBeenCalledWith('r1')
  })

  // Pressing Normalize for a source nobody acquired failed in under a second
  // with "no market subset". The error was right; the button was wrong.
  it('refuses a source the runner has not acquired, and names the command', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    await w.find('select').setValue('openproductsfacts')
    await flush()

    expect(w.find('[data-test="not-acquired"]').exists()).toBe(true)
    expect(w.text()).toMatch(/acquire:opf/)
    expect(w.find('[data-test="run-normalize"]').attributes('disabled')).toBeDefined()
  })

  it('leaves the buttons live for a source the runner has acquired', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    await w.find('select').setValue('openbeautyfacts')
    await flush()

    expect(w.find('[data-test="not-acquired"]').exists()).toBe(false)
    expect(w.find('[data-test="run-normalize"]').attributes('disabled')).toBeUndefined()
  })

  it('renders a failure with its reason', async () => {
    fetchRunRequests.mockResolvedValue([
      { ...runningRequest, id: 'r2', status: 'failed', error: 'subset missing' },
    ])
    const w = mount(RunControl, { global: { stubs } })
    await flush()
    expect(w.text()).toContain('subset missing')
  })

  it('explains a refusal rather than showing a broken panel', async () => {
    const forbidden = Object.assign(new Error('list_workers: admin only'), { code: '42501' })
    fetchWorkers.mockRejectedValue(forbidden)
    fetchRunRequests.mockRejectedValue(forbidden)

    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.text()).toMatch(/not a catalog admin/i)
    expect(w.text()).toMatch(/admins:add/i)
  })
})
