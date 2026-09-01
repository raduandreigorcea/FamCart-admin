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
    expect(wrapper.text()).not.toContain('Page — / —')
  })

  it('keeps the real range on screen during a refetch', () => {
    // A refetch retains the previous total, so the sentence must not fall back
    // to "Counting…" every time someone changes a filter on page three.
    const wrapper = pager({ total: 312, offset: 50, loading: true })
    expect(wrapper.text()).toContain('51–75 of 312')
    expect(wrapper.find('[aria-current="page"]').text()).toBe('3')
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

// First / Previous / Next was navigation you could only walk: page 9 of a
// 12,000-row band cost eight clicks, and there was no way back to the part you
// had been reading. The strip is windowed so a 500-page table does not render
// 500 buttons.

const numbers = (wrapper: ReturnType<typeof pager>) =>
  wrapper.findAll('.pager__pages li').map((li) => li.text())

describe('TablePager page strip', () => {
  it('marks the current page and does not offer it as a destination', () => {
    const wrapper = pager({ total: 312, offset: 100 })
    const current = wrapper.find('[aria-current="page"]')

    expect(current.text()).toBe('5')
    expect((current.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('jumps to a page by its number, in rows', () => {
    const wrapper = pager({ total: 312, offset: 0 })

    wrapper.findAll('.pager__pages button').find((b) => b.text() === '13')!.trigger('click')

    expect(wrapper.emitted('go')?.[0]).toEqual([300])
  })

  it('offers the last page without walking to it', () => {
    const wrapper = pager({ total: 312, offset: 0 })

    wrapper.findAll('button').find((b) => b.text() === 'Last')!.trigger('click')

    expect(wrapper.emitted('go')?.[0]).toEqual([300])
  })

  it('windows a long table rather than drawing every page', () => {
    // 13 pages, sitting on 7: first, last, the neighbours, ellipses between.
    expect(numbers(pager({ total: 312, offset: 150 }))).toEqual(['1', '…', '6', '7', '8', '…', '13'])
  })

  it('draws the page itself where an ellipsis would stand for one page', () => {
    // Sitting on 3 of 13: "1 … 3" costs the same width as "1 2 3" and hides a
    // page one click away.
    expect(numbers(pager({ total: 312, offset: 50 }))).toEqual(['1', '2', '3', '4', '…', '13'])
  })

  it('draws every page when they all fit', () => {
    expect(numbers(pager({ total: 60, offset: 0 }))).toEqual(['1', '2', '3'])
  })

  it('draws a single page once, not twice', () => {
    // first, last and current are all page 1, and a Set is what keeps that from
    // rendering three buttons.
    expect(numbers(pager({ total: 10, offset: 0 }))).toEqual(['1'])
  })

  it('withholds the numbers until there is a total to number', () => {
    const wrapper = pager({ total: 0, loading: true })
    expect(wrapper.find('.pager__pages').exists()).toBe(false)
    expect(wrapper.text()).toContain('Page — / —')
  })
})
