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
const fetchArtifacts = vi.fn()

vi.mock('../src/lib/data/runs', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/data/runs')>(
    '../src/lib/data/runs',
  )
  return {
    ...actual,
    enqueueRun,
    cancelRun,
    fetchRunRequests,
    fetchRunRequest,
    fetchWorkers,
    fetchArtifacts,
  }
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
    props: ['open', 'title', 'message', 'confirmLabel'],
    emits: ['confirm', 'cancel'],
    template: `<div v-if="open" class="dialog">{{ title }} {{ message }}
      <button class="dialog-confirm" @click="$emit('confirm')">{{ confirmLabel }}</button>
    </div>`,
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
  stages: { staged: 'openfoodfacts', scored: 'openfoodfacts' },
}

// What the buttons actually run off now. The worker heartbeat described one
// machine's disk; a CI runner's disk is empty on the way in and gone on the way
// out, so readiness lives in the bucket index instead.
const stored = [
  { key: 'subset', source: 'openfoodfacts', remote_key: 'subsets/off.jsonl', bytes: 900, updated_at: '2026-08-25T00:00:00.000Z' },
  { key: 'subset', source: 'openbeautyfacts', remote_key: 'subsets/obf.jsonl', bytes: 10, updated_at: '2026-08-25T00:00:00.000Z' },
  { key: 'staged', source: 'openfoodfacts', remote_key: 'out/staged.jsonl', bytes: 1764, updated_at: '2026-08-25T00:00:00.000Z' },
  { key: 'scored', source: 'openfoodfacts', remote_key: 'out/scored.jsonl', bytes: 2304, updated_at: '2026-08-25T00:00:00.000Z' },
]

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
  fetchArtifacts.mockReset().mockResolvedValue(stored)
  fetchRunRequests.mockReset().mockResolvedValue([])
  fetchRunRequest.mockReset().mockResolvedValue(null)
})

describe('RunControl', () => {
  // Ready is a dot beside the source, not a sentence. The old line spent a
  // whole row saying everything was normal, and personified a hostname doing it.
  it('says nothing about the runner when the runner is fine', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.find('.ready').exists()).toBe(true)
    expect(w.text()).not.toMatch(/is listening/)
  })

  // A step whose input does not exist must not be offered. Apply was lit with an
  // empty out/ and would have failed on a missing scored.jsonl.
  it('offers only normalize when out/ is empty', async () => {
    fetchWorkers.mockResolvedValue([])
    fetchArtifacts.mockResolvedValue(stored.filter((a) => a.key === 'subset'))
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.find('[data-test="run-normalize"]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-test="run-score"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test="run-load-apply"]').attributes('disabled')).toBeDefined()
    expect(w.text()).toMatch(/Normalize first/)
  })

  // A button that queues into a void is worse than a disabled one. This is the
  // arrangement in use today: a worker somebody started, whose absence means
  // nothing will ever come.
  it('disables every button and says why when nothing is listening', async () => {
    fetchWorkers.mockResolvedValue([])
    fetchArtifacts.mockResolvedValue([])
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.find('[data-test="run-score"]').attributes('disabled')).toBeDefined()
    // acquire is exempt from the acquired-source gate, but not from this one:
    // there would be nothing to claim the request.
    expect(w.find('[data-test="run-acquire"]').attributes('disabled')).toBeDefined()
    expect(w.text()).toMatch(/nothing is listening/i)
  })

  // The cloud pipeline has no process to be online -- a runner is made per
  // request and deleted after -- so once it is switched on, "no worker" is the
  // normal state between runs and the artifact index is the evidence that
  // something is serving the queue.
  it('stays usable with no worker when the artifact index says runs have happened', async () => {
    fetchWorkers.mockResolvedValue([])
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.find('[data-test="run-acquire"]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-test="run-score"]').attributes('disabled')).toBeUndefined()
    expect(w.text()).not.toMatch(/npm run worker/)
  })

  // The heartbeat wins while a worker is online: it is looking at its own disk,
  // where the index is a record of a bucket that machine may not even use.
  it('believes a live worker over the artifact index', async () => {
    fetchWorkers.mockResolvedValue([{ ...liveWorker, stages: {} }])
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.find('[data-test="run-normalize"]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-test="run-score"]').attributes('disabled')).toBeDefined()
  })

  // What replaced it. The observable failure is not an absent process, it is a
  // request that was written and that nothing ever came for -- a broken dispatch
  // chain rather than an idle pipeline.
  it('says so when a request has sat queued with nobody claiming it', async () => {
    fetchWorkers.mockResolvedValue([])
    fetchRunRequests.mockResolvedValue([
      {
        ...runningRequest,
        status: 'queued',
        claimed_by: null,
        requested_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      },
    ])

    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.find('[data-test="unclaimed"]').exists()).toBe(true)
    expect(w.text()).toMatch(/Not picked up/)
  })

  // A request queued seconds ago is a runner being allocated, not a fault.
  it('is patient about a request that was only just queued', async () => {
    fetchWorkers.mockResolvedValue([])
    fetchRunRequests.mockResolvedValue([
      { ...runningRequest, status: 'queued', claimed_by: null, requested_at: new Date().toISOString() },
    ])

    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.find('[data-test="unclaimed"]').exists()).toBe(false)
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

    await w.find('.dialog-confirm').trigger('click')
    await flush()
    expect(enqueueRun).toHaveBeenCalledWith('load-apply', 'openfoodfacts')
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
  //
  // Acquire is the exception, and the reason the gate is per-step rather than
  // per-source: it is the button that FIXES an unacquired source, so gating it
  // on the source being acquired would disable it exactly when it is wanted.
  it('refuses a source the runner has not acquired, except for acquire itself', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    await w.find('select').setValue('openproductsfacts')
    await flush()

    expect(w.find('[data-test="not-acquired"]').exists()).toBe(true)
    expect(w.find('[data-test="run-normalize"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test="run-acquire-delta"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test="run-acquire"]').attributes('disabled')).toBeUndefined()
  })

  // The trap: `disabled` was `canAct && ready`, so choosing a source nobody had
  // acquired disabled the very control you would use to choose another one.
  // The panel offered Acquire -- hours of downloading -- as the only way out of
  // a mis-click.
  //
  // setValue() drives the DOM property directly and works on a disabled select,
  // which is why the case above passed while the page was stuck. Asserting on
  // the attribute is what actually reproduces it.
  it('lets the source be changed back after picking one that is not acquired', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    await w.find('select').setValue('openproductsfacts')
    await flush()

    expect(w.find('[data-test="not-acquired"]').exists()).toBe(true)
    expect(w.find('select').attributes('disabled')).toBeUndefined()

    await w.find('select').setValue('openfoodfacts')
    await flush()

    expect(w.find('[data-test="not-acquired"]').exists()).toBe(false)
    expect(w.find('[data-test="run-normalize"]').attributes('disabled')).toBeUndefined()
  })

  // Hours of downloading is not something to start by mis-clicking, so acquire
  // gets the dialog that until now only Apply had.
  it('confirms before starting an acquire, and enqueues on confirm', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    await w.find('[data-test="run-acquire"]').trigger('click')
    await flush()
    expect(enqueueRun).not.toHaveBeenCalled()
    // The dialog is per-kind now, so it must be acquire's copy and not Apply's.
    expect(w.find('.dialog').text()).toMatch(/12\.7 GB/)

    await w.find('.dialog-confirm').trigger('click')
    await flush()
    expect(enqueueRun).toHaveBeenCalledWith('acquire', 'openfoodfacts')
  })

  // The cheap refresh is minutes, not hours, so it goes straight through.
  it('enqueues a delta refresh without a confirmation', async () => {
    const w = mount(RunControl, { global: { stubs } })
    await flush()

    await w.find('select').setValue('openbeautyfacts')
    await flush()
    await w.find('[data-test="run-acquire-delta"]').trigger('click')
    await flush()

    expect(enqueueRun).toHaveBeenCalledWith('acquire-delta', 'openbeautyfacts')
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
    expect(w.text()).toMatch(/catalog_admins/i)
  })

  // The state the panel is actually in today. The catalog schema was removed
  // along with the repo that owned it, so PostgREST answers PGRST205 for the
  // queue table. The ladder must not be drawn over that: with no readable
  // queue this panel cannot tell what is running, and a row of buttons under a
  // failed read is a control claiming it can do something it has not checked.
  it('hides the ladder when the queue table is not in the database', async () => {
    const missing = Object.assign(
      new Error("Could not find the table 'public.catalog_run_requests' in the schema cache"),
      { code: 'PGRST205' },
    )
    fetchWorkers.mockRejectedValue(missing)
    fetchRunRequests.mockRejectedValue(missing)

    const w = mount(RunControl, { global: { stubs } })
    await flush()

    expect(w.find('[data-test="run-acquire"]').exists()).toBe(false)
    expect(w.find('[data-test="run-normalize"]').exists()).toBe(false)
    expect(w.text()).toMatch(/not in the database yet/i)
  })
})
