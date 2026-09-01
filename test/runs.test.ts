import { describe, expect, it } from 'vitest'
import {
  UNCLAIMED_SECONDS,
  WORKER_STALE_SECONDS,
  availableArtifacts,
  isActive,
  isStalled,
  isUnclaimed,
  runnerOnline,
  sourceReady,
  stepBlockedReason,
  stepReady,
  type ArtifactRow,
  type RunKind,
  type RunRequest,
  type WorkerRow,
} from '../src/lib/data/runs'

/** Every queueable kind, in pipeline order. */
const KINDS: RunKind[] = ['acquire', 'acquire-delta', 'normalize', 'score', 'load', 'load-apply']

const NOW = new Date('2026-08-25T12:00:00.000Z').getTime()

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


// ── What the buttons run off ─────────────────────────────────────────────────
//
// This used to be the worker's heartbeat: `sources` was a readdir of its .cache/
// and `stages` was the contents of its out/. A runner is a CI job now -- empty
// disk on the way in, deleted on the way out -- so the question moved to the
// bucket, and catalog_artifacts is the index of it.
//
// The old "a worker that reports nothing can do anything" fallback is gone with
// it, deliberately. That existed because an older worker predating the column
// was indistinguishable from one with an empty disk. A bucket index has no such
// ambiguity: an absent row means the file is absent, which on a fresh bucket
// correctly leaves Acquire as the only live button.

const artifact = (key: string, source: string, over: Partial<ArtifactRow> = {}): ArtifactRow => ({
  key,
  source,
  remote_key: key === 'subset' ? `subsets/${source}-markets-subset.jsonl` : `out/${key}.jsonl`,
  bytes: 1024,
  updated_at: '2026-08-25T00:00:00.000Z',
  ...over,
})

/** A bucket that has been all the way through the pipeline for one source. */
const complete = (source = 'openfoodfacts'): ArtifactRow[] => [
  artifact('subset', source),
  artifact('staged', source),
  artifact('scored', source),
]

describe('sourceReady', () => {
  it('is false for an empty bucket', () => {
    expect(sourceReady([], 'openfoodfacts')).toBe(false)
  })

  it('is true for a source with a subset stored', () => {
    expect(sourceReady(complete(), 'openfoodfacts')).toBe(true)
  })

  it('is false for a source nothing has been acquired for', () => {
    expect(sourceReady(complete(), 'openproductsfacts')).toBe(false)
  })

  // Subsets are per source and out/ is one shared slot, so a staged.jsonl for
  // another source says nothing about whether this one was acquired.
  it('does not count another source out/ file as an acquisition', () => {
    expect(sourceReady([artifact('staged', 'openbeautyfacts')], 'openbeautyfacts')).toBe(false)
  })
})

describe('stepReady', () => {
  it('offers only acquire against a completely empty bucket', () => {
    const live = KINDS.filter((k) => stepReady([], k, 'openfoodfacts'))
    expect(live).toEqual(['acquire'])
  })

  // acquire is what MAKES a source ready, so gating it on readiness would leave
  // it disabled on exactly the empty bucket it exists for.
  it('offers acquire for a source with nothing stored', () => {
    expect(stepReady(complete(), 'acquire', 'openproductsfacts')).toBe(true)
    expect(stepBlockedReason(complete(), 'acquire', 'openproductsfacts')).toBe('')
  })

  it('offers normalize and the delta refresh once a subset exists', () => {
    const only = [artifact('subset', 'openfoodfacts')]
    expect(stepReady(only, 'normalize', 'openfoodfacts')).toBe(true)
    expect(stepReady(only, 'acquire-delta', 'openfoodfacts')).toBe(true)
  })

  // The delta refresh folds changes INTO an existing subset, so unlike acquire
  // it genuinely needs one.
  it('refuses the delta refresh for a source that was never acquired', () => {
    expect(stepReady([], 'acquire-delta', 'openproductsfacts')).toBe(false)
    expect(stepBlockedReason([], 'acquire-delta', 'openproductsfacts')).toMatch(/not been acquired/)
  })

  it('refuses score until something has been normalized', () => {
    const only = [artifact('subset', 'openfoodfacts')]
    expect(stepReady(only, 'score', 'openfoodfacts')).toBe(false)
    expect(stepBlockedReason(only, 'score', 'openfoodfacts')).toMatch(/Normalize first/)
  })

  it('refuses apply until something has been scored', () => {
    const rows = [artifact('subset', 'openfoodfacts'), artifact('staged', 'openfoodfacts')]
    expect(stepReady(rows, 'load-apply', 'openfoodfacts')).toBe(false)
    expect(stepBlockedReason(rows, 'load-apply', 'openfoodfacts')).toMatch(/Re-score first/)
  })

  // out/ is shared, so whose file it is matters as much as whether one exists.
  // Re-scoring against another source's staged products would stamp them wrong
  // at load time.
  it('refuses score when out/ belongs to another source', () => {
    const rows = [artifact('subset', 'openfoodfacts'), artifact('staged', 'openbeautyfacts')]
    expect(stepReady(rows, 'score', 'openfoodfacts')).toBe(false)
    expect(stepBlockedReason(rows, 'score', 'openfoodfacts')).toMatch(/holds openbeautyfacts/)
  })

  it('allows the whole sequence once every file is this source', () => {
    expect(KINDS.every((k) => stepReady(complete(), k, 'openfoodfacts'))).toBe(true)
  })
})

// The replacement for the "No runner" badge. There is no process whose absence
// means anything now -- a runner exists for one stage and is deleted after -- so
// the observable failure is a request nothing ever claimed.
describe('isUnclaimed', () => {
  const at = (secondsAgo: number) =>
    request({ status: 'queued', requested_at: new Date(NOW - secondsAgo * 1000).toISOString() })

  it('is patient while a runner is still being allocated', () => {
    expect(isUnclaimed(at(30), NOW)).toBe(false)
  })

  // Dispatch, runner allocation, checkout and npm ci are two or three minutes
  // before a stage starts. Below that this is just waiting.
  it('is quiet just inside the window', () => {
    expect(isUnclaimed(at(UNCLAIMED_SECONDS - 1), NOW)).toBe(false)
  })

  it('complains once nothing has claimed it for long enough', () => {
    expect(isUnclaimed(at(UNCLAIMED_SECONDS + 60), NOW)).toBe(true)
  })

  // A running request has been claimed by definition; if its runner then dies,
  // that is isStalled's job and it says something different.
  it('says nothing about a request that was picked up', () => {
    expect(isUnclaimed(request({ status: 'running' }), NOW)).toBe(false)
    expect(isUnclaimed(request({ status: 'done' }), NOW)).toBe(false)
  })
})

// Which of the two answers to "what exists" wins.
//
// A worker on a real machine is reading its own disk and is the more accurate
// of the two, so while one is online it answers. A CI runner cannot be asked --
// empty disk in, deleted out -- so with no worker the index it wrote is what is
// left. Both, rather than one, because the cloud pipeline is built and not yet
// switched on.
describe('availableArtifacts', () => {
  const index = complete('openbeautyfacts')

  it('uses the index when no worker is online', () => {
    expect(availableArtifacts(null, index)).toBe(index)
  })

  it('prefers a live worker, which is looking at the actual disk', () => {
    const rows = availableArtifacts(worker(2), index)
    expect(sourceReady(rows, 'openfoodfacts')).toBe(true)
    // The index said openbeautyfacts; the worker did not, so it does not win.
    expect(stepReady(rows, 'score', 'openbeautyfacts')).toBe(false)
  })

  it('turns the heartbeat into the same shape the index has', () => {
    const rows = availableArtifacts(worker(2), [])
    expect(rows.filter((r) => r.key === 'subset').map((r) => r.source)).toEqual([
      'openfoodfacts',
      'openbeautyfacts',
    ])
    expect(stepReady(rows, 'load-apply', 'openfoodfacts')).toBe(true)
  })

  it('reports an empty out/ as an empty out/, not as unknown', () => {
    const rows = availableArtifacts(worker(2, { stages: {} }), [])
    expect(stepReady(rows, 'normalize', 'openfoodfacts')).toBe(true)
    expect(stepReady(rows, 'score', 'openfoodfacts')).toBe(false)
  })

  // A worker predating the column cannot tell us anything, so the index answers.
  // It may be empty, which offers only Acquire -- recoverable by pressing it,
  // where trusting the silence would claim files exist that do not.
  it('falls back to the index for a worker that reports nothing', () => {
    expect(availableArtifacts(worker(2, { sources: null }), index)).toBe(index)
  })
})
