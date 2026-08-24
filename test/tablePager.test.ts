import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TablePager from '../src/components/TablePager.vue'

// `total` is 0 before the first response as well as after an empty one, and the
// pager reported "No rows / Page 1 / 1" for both -- so the first load of every
// table in the tool stated, definitively, that the database held nothing, a
// second before it filled with rows.
//
// The same distinction the data layer is built around: Metric has an
// Unavailable arm and CatalogShape carries `truncated` precisely because not
// knowing yet and knowing there is nothing are different answers.

function pager(props: { total: number; offset?: number; limit?: number; loading?: boolean }) {
  return mount(TablePager, {
    props: { offset: 0, limit: 25, loading: false, ...props },
  })
}

describe('TablePager count', () => {
  it('says nothing definite while the first request is in flight', () => {
    const wrapper = pager({ total: 0, loading: true })
    expect(wrapper.text()).toContain('Counting…')
    expect(wrapper.text()).not.toContain('No rows')
  })

  it('does not claim a page number it cannot know', () => {
    const wrapper = pager({ total: 0, loading: true })
    expect(wrapper.text()).toContain('Page — / —')
    expect(wrapper.text()).not.toMatch(/Page 1 \/ 1/)
  })

  it('reports an empty result once it IS a result', () => {
    const wrapper = pager({ total: 0, loading: false })
    expect(wrapper.text()).toContain('No rows')
    expect(wrapper.text()).toContain('Page 1 / 1')
  })

  it('keeps the real range on screen during a refetch', () => {
    // A refetch retains the previous total, so the sentence must not fall back
    // to "Counting…" every time someone changes a filter on page three.
    const wrapper = pager({ total: 312, offset: 50, loading: true })
    expect(wrapper.text()).toContain('51–75 of 312')
    expect(wrapper.text()).toContain('Page 3 / 13')
  })

  it('states the range in rows, not pages, once loaded', () => {
    const wrapper = pager({ total: 312, offset: 0 })
    expect(wrapper.text()).toContain('1–25 of 312')
  })

  it('does not run the last page past the total', () => {
    const wrapper = pager({ total: 312, offset: 300 })
    expect(wrapper.text()).toContain('301–312 of 312')
  })
})
