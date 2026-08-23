import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusPill from '../src/components/StatusPill.vue'

// Proves the two halves of the Vitest wiring in vite.config.ts, so that a later
// component test failing means the component is wrong rather than the
// environment. Without `environment: 'happy-dom'` the mount below fails on a
// missing `document`, with an error that never mentions the environment.

describe('test environment', () => {
  it('provides a DOM', () => {
    expect(typeof document).toBe('object')
    expect(document.createElement('div')).toBeTruthy()
  })

  it('runs in UTC, so date assertions mean the same thing everywhere', () => {
    expect(new Date('2026-08-23T00:00:00.000Z').getHours()).toBe(0)
  })

  it('can mount a single-file component', () => {
    const pill = mount(StatusPill, { props: { tone: 'good', label: 'fresh' } })
    expect(pill.text()).toContain('fresh')
    expect(pill.classes()).toContain('pill--good')
  })

  it('renders the label even with the dot off, so colour never carries meaning alone', () => {
    // The component's own stated rule, asserted rather than trusted.
    const pill = mount(StatusPill, { props: { tone: 'bad', label: 'stale', dot: false } })
    expect(pill.text()).toContain('stale')
    expect(pill.find('.pill__dot').exists()).toBe(false)
  })
})
