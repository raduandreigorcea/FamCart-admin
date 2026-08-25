import { describe, expect, it } from 'vitest'
import {
  WORKER_STALE_SECONDS,
  isActive,
  isStalled,
  runnerOnline,
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
  // The worker marks its own request failed on ctrl-c, so this is the other
  // case: a power cut. A spinner that never finishes is the one state the panel
  // must not show.
  it('is stalled when a running request has nobody listening', () => {
    expect(isStalled(request(), null)).toBe(true)
  })

  it('is not stalled while a worker is online', () => {
    expect(isStalled(request(), worker(2))).toBe(false)
  })

  it('is not stalled for a queued request, which nobody has claimed yet', () => {
    expect(isStalled(request({ status: 'queued' }), null)).toBe(false)
  })

  it('is not stalled for a finished request', () => {
    expect(isStalled(request({ status: 'done' }), null)).toBe(false)
  })
})
