import { describe, expect, it } from 'vitest'
import {
  WORKER_STALE_SECONDS,
  isActive,
  isStalled,
  runnerOnline,
  sourceReady,
  stepBlockedReason,
  stepReady,
  type RunRequest,
  type WorkerRow,
} from '../src/lib/data/runs'

const worker = (seconds: number, over: Partial<WorkerRow> = {}): WorkerRow => ({
  id: 'w1',
  hostname: 'desktop',
  started_at: '2026-08-25T00:00:00.000Z',
  last_seen_at: '2026-08-25T00:00:00.000Z',
  current_request: null,
  seconds_since_seen: seconds,
  sources: ['openfoodfacts', 'openbeautyfacts'],
  stages: { staged: 'openfoodfacts', scored: 'openfoodfacts' },
  ...over,
})

const request = (over: Partial<RunRequest> = {}): RunRequest => ({
  id: 'r1',
  kind: 'score',
  source: 'openfoodfacts',
  status: 'running',
  requested_by: null,
  requested_at: '2026-08-25T00:00:00.000Z',
  claimed_by: 'w1',
  claimed_at: null,
  finished_at: null,
  run_id: null,
  stage: null,
  progress_done: null,
  progress_total: null,
  error: null,
  ...over,
})

describe('runnerOnline', () => {
  it('is offline when nothing has ever checked in', () => {
    expect(runnerOnline([])).toBeNull()
  })

  it('is online for a fresh heartbeat', () => {
    expect(runnerOnline([worker(3)])?.hostname).toBe('desktop')
  })

  // Six missed beats. Long enough that a slow chunk does not flap the badge,
  // short enough that pressing a dead button is rare.
  it('is offline once the heartbeat is older than the stale window', () => {
    expect(runnerOnline([worker(WORKER_STALE_SECONDS + 1)])).toBeNull()
  })

  it('is still online exactly at the boundary', () => {
    expect(runnerOnline([worker(WORKER_STALE_SECONDS)])).not.toBeNull()
  })

  it('picks the freshest worker when several have checked in', () => {
    const stale = worker(120, { id: 'old', hostname: 'laptop' })
    expect(runnerOnline([stale, worker(2)])?.hostname).toBe('desktop')
  })
})

describe('isActive', () => {
  it('counts queued, running and cancelling as active', () => {
    expect(['queued', 'running', 'cancelling'].every(isActive)).toBe(true)
  })

  it('counts finished states as inactive, so polling can stop', () => {
    expect(['done', 'failed', 'cancelled'].some(isActive)).toBe(false)
  })
})

describe('isStalled', () => {
  it('is stalled when nothing is listening at all', () => {
    expect(isStalled(request(), [])).toBe(true)
  })

  it('is not stalled while the worker that claimed it is alive', () => {
    expect(isStalled(request({ claimed_by: 'w1' }), [worker(2)])).toBe(false)
  })

  // The one that bit: a worker killed outright never marks its request, so
  // restarting the worker left the old request running forever while the new
  // one reported itself healthy. Asking "is anyone online" called that Running
  // and let it block every button on the panel.
  it('is stalled when a DIFFERENT worker is online', () => {
    const replacement = worker(2, { id: 'w2' })
    expect(isStalled(request({ claimed_by: 'w1' }), [replacement])).toBe(true)
  })

  it('is stalled when the claiming worker has gone stale', () => {
    expect(isStalled(request({ claimed_by: 'w1' }), [worker(120)])).toBe(true)
  })

  it('is not stalled for a queued request, which nobody has claimed yet', () => {
    expect(isStalled(request({ status: 'queued' }), [])).toBe(false)
  })

  it('is not stalled for a finished request', () => {
    expect(isStalled(request({ status: 'done' }), [])).toBe(false)
  })

  // The one that locked the panel for two hours. cancel_run asks the worker to
  // stop between chunks; a worker that never comes back leaves the row asking
  // forever, and `cancelling` counted as active without ever counting as
  // stalled, so every button stayed grey with no way out but editing the
  // database by hand.
  it('is stalled when a cancelling request has lost its worker', () => {
    expect(isStalled(request({ status: 'cancelling', claimed_by: 'w1' }), [])).toBe(true)
  })

  it('is not stalled while a cancelling request still has its worker', () => {
    expect(isStalled(request({ status: 'cancelling', claimed_by: 'w1' }), [worker(2)])).toBe(false)
  })
})

// Pressing Normalize for a source nobody has acquired failed in under a second
// with "no market subset". The error was right; the button should not have been
// offered. Only the worker can see which subsets exist, so it reports them.
describe('sourceReady', () => {
  it('is false with no runner at all', () => {
    expect(sourceReady(null, 'openfoodfacts')).toBe(false)
  })

  it('is true for a source the runner has acquired', () => {
    expect(sourceReady(worker(2), 'openfoodfacts')).toBe(true)
  })

  it('is false for a source the runner has not acquired', () => {
    expect(sourceReady(worker(2), 'openproductsfacts')).toBe(false)
  })

  it('is false when the runner has acquired nothing', () => {
    expect(sourceReady(worker(2, { sources: [] }), 'openfoodfacts')).toBe(false)
  })

  // An older worker that never reports the column must not read as a machine
  // with nothing acquired, or every button goes dead on a runner that works.
  it('allows everything when the runner reports nothing at all', () => {
    expect(sourceReady(worker(2, { sources: null }), 'openproductsfacts')).toBe(true)
  })
})

// The four buttons are drawn as a sequence and were enabled regardless, so with
// an empty out/ Apply was lit and would have failed on a missing scored.jsonl.
describe('stepReady', () => {
  it('offers nothing at all with no runner', () => {
    expect(stepReady(null, 'normalize', 'openfoodfacts')).toBe(false)
  })

  it('offers normalize for an acquired source with an empty out/', () => {
    const w = worker(2, { stages: {} })
    expect(stepReady(w, 'normalize', 'openfoodfacts')).toBe(true)
  })

  it('refuses score until something has been normalized', () => {
    const w = worker(2, { stages: {} })
    expect(stepReady(w, 'score', 'openfoodfacts')).toBe(false)
    expect(stepBlockedReason(w, 'score', 'openfoodfacts')).toMatch(/Normalize first/)
  })

  it('refuses apply until something has been scored', () => {
    const w = worker(2, { stages: { staged: 'openfoodfacts' } })
    expect(stepReady(w, 'load-apply', 'openfoodfacts')).toBe(false)
    expect(stepBlockedReason(w, 'load-apply', 'openfoodfacts')).toMatch(/Re-score first/)
  })

  // out/ is shared, so whose file it is matters as much as whether one exists.
  it('refuses score when out/ belongs to another source', () => {
    const w = worker(2, { stages: { staged: 'openbeautyfacts' } })
    expect(stepReady(w, 'score', 'openfoodfacts')).toBe(false)
    expect(stepBlockedReason(w, 'score', 'openfoodfacts')).toMatch(/holds openbeautyfacts/)
  })

  it('allows the whole sequence once both files are this source', () => {
    const w = worker(2)
    expect(['normalize', 'score', 'load', 'load-apply'].every((k) =>
      stepReady(w, k as never, 'openfoodfacts'))).toBe(true)
  })

  // A worker predating the column must not read as an empty out/.
  it('allows everything when the runner reports no stages at all', () => {
    const w = worker(2, { stages: null })
    expect(stepReady(w, 'load-apply', 'openfoodfacts')).toBe(true)
  })
})
