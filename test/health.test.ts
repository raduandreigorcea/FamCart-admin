import { describe, expect, it } from 'vitest'
import { reachabilityOf, severityOf, type ProbeResult } from '../src/lib/data/health'

function probe(ok: boolean, target = 'app'): ProbeResult {
  return { target, label: target, ok, latencyMs: ok ? 42 : null, detail: ok ? 'Responded' : 'boom' }
}

describe('reachabilityOf (BG-7)', () => {
  it('reports unknown before anything has been measured', () => {
    // THE REGRESSION TEST. The boolean this replaced was
    // `(probes.data.value ?? []).every(p => p.ok)`, and Array.every on an empty
    // array is true -- so the Health page claimed everything was answering
    // while the first probe was still in flight.
    expect(reachabilityOf(null)).toBe('unknown')
    expect(reachabilityOf(undefined)).toBe('unknown')
    expect(reachabilityOf([])).toBe('unknown')
  })

  it('reports ok only when every probe actually answered', () => {
    expect(reachabilityOf([probe(true)])).toBe('ok')
    expect(reachabilityOf([probe(true, 'app'), probe(true, 'catalog')])).toBe('ok')
  })

  it('reports degraded when any single probe failed', () => {
    expect(reachabilityOf([probe(false)])).toBe('degraded')
    expect(reachabilityOf([probe(true, 'app'), probe(false, 'catalog')])).toBe('degraded')
    expect(reachabilityOf([probe(false, 'app'), probe(true, 'catalog')])).toBe('degraded')
  })

  it('never reports ok for an absence of evidence', () => {
    // The property that matters, stated directly: only a non-empty, all-passing
    // result set may ever produce 'ok'.
    for (const input of [null, undefined, [] as ProbeResult[]]) {
      expect(reachabilityOf(input)).not.toBe('ok')
    }
  })
})

describe('severityOf', () => {
  it('treats failures and denials as errors', () => {
    expect(severityOf('invite_code_failed')).toBe('error')
    expect(severityOf('admin_denied')).toBe('error')
    expect(severityOf('request_rejected')).toBe('error')
    expect(severityOf('user_blocked')).toBe('error')
  })

  it('treats rate limiting and removals as warnings', () => {
    expect(severityOf('rate_limit_hit')).toBe('warn')
    expect(severityOf('member_removed')).toBe('warn')
    expect(severityOf('admin_revoked')).toBe('warn')
  })

  it('leaves deliberate acts and successes as info', () => {
    // The module's stated rule: a success and a deliberate grant do not belong
    // in an error count.
    expect(severityOf('invite_join_succeeded')).toBe('info')
    expect(severityOf('admin_granted')).toBe('info')
    expect(severityOf('household_created')).toBe('info')
  })
})
