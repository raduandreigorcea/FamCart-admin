import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ShopRunCard from '../src/components/ShopRunCard.vue'

// The card both Health and Scrapers draw. What it has to get right is that a
// card's colour and its words never disagree, and that a card still loading
// cannot be read as a shop with nothing in it.

function card(props: Record<string, unknown> = {}) {
  return mount(ShopRunCard, {
    props: { name: 'lidl', tone: 'good', label: 'Completed', count: '412', ...props },
  })
}

describe('ShopRunCard', () => {
  it('wears its tone as an edge, whatever the state', () => {
    for (const tone of ['good', 'live', 'warn', 'bad', 'idle']) {
      expect(card({ tone }).classes()).toContain(`shop--${tone}`)
    }
  })

  it('says the state in words too, so colour never carries it alone', () => {
    expect(card({ tone: 'bad', label: 'Failed' }).find('.pill').text()).toBe('Failed')
  })

  it('spins the pill while a run is still reading', () => {
    const wrapper = card({ tone: 'live', label: 'Running', running: true })
    expect(wrapper.find('.pill .spinner').exists()).toBe(true)
    expect(wrapper.find('.pill__dot').exists()).toBe(false)
  })

  it('signs the change against the run before', () => {
    expect(card({ delta: 839 }).find('.shop__delta').text()).toBe('+839')
    expect(card({ delta: -75 }).find('.shop__delta--down').exists()).toBe(true)
    expect(card({ delta: 0 }).find('.shop__delta').exists()).toBe(false)
  })

  it('draws progress against what the last full run read', () => {
    const bar = card({ progress: { value: 4000, max: 8000 } }).find('[role="progressbar"]')
    expect(bar.attributes('aria-valuenow')).toBe('4000')
    expect(bar.find('.shop__bar').attributes('style')).toContain('50%')
  })

  it('says what the bar measures, in words under it and to a screen reader', () => {
    const wrapper = card({ progress: { value: 1200, max: 3568 }, progressLabel: '1,200 of 3,568 departments' })
    expect(wrapper.find('.shop__plan').text()).toBe('1,200 of 3,568 departments')
    expect(wrapper.find('[role="progressbar"]').attributes('aria-label')).toContain('1,200 of 3,568 departments')
  })

  // A run with no plan and no earlier run to compare with still moves, and a
  // card with no bar at all read as a run that was not going anywhere.
  it('draws a bar that says only "working" when there is nothing to measure against', () => {
    const bar = card({ running: true, indeterminate: true }).find('[role="progressbar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.classes()).toContain('shop__progress--indeterminate')
    expect(bar.attributes('aria-valuenow')).toBeUndefined()
  })

  it('shows only a skeleton while loading, and nothing that reads as data', () => {
    const wrapper = card({ loading: true })
    expect(wrapper.classes()).toContain('shop--loading')
    expect(wrapper.text()).toBe('')
    expect(wrapper.findAll('.u-skeleton').length).toBeGreaterThan(0)
  })
})
