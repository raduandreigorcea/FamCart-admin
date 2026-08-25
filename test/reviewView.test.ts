import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'

// The Review view is the one screen here whose job is a decision rather than a
// number, which makes two things worth asserting that no other view needs: that
// it says a verdict does nothing until the next run, and that an unrecorded
// signal never renders as a zero.

const fetchReviewCandidates = vi.fn()
const fetchReviewDecisions = vi.fn()
const recordDecision = vi.fn().mockResolvedValue(undefined)
const clearDecision = vi.fn().mockResolvedValue(undefined)
const approveAbove = vi.fn().mockResolvedValue(3)

vi.mock('../src/lib/data/review', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/data/review')>(
    '../src/lib/data/review',
  )
  return {
    ...actual,
    fetchReviewCandidates,
    fetchReviewDecisions,
    recordDecision,
    clearDecision,
    approveAbove,
  }
})

vi.mock('../src/lib/data/products', () => ({
  catalogConfigured: () => true,
  CatalogNotConfigured: class extends Error {},
}))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

const ReviewView = (await import('../src/views/ReviewView.vue')).default as unknown as Component

const stubs = {
  PageHeader: { template: '<div><slot name="tools" /></div>' },
  PanelCard: { template: '<div><slot /></div>' },
  // wouldRequire included: the real StateBlock renders it as the footnote, and
  // it is where the fix for a refusal is spelled out.
  StateBlock: {
    props: ['title', 'message', 'wouldRequire'],
    template: '<div class="state">{{ title }} {{ message }} {{ wouldRequire }}</div>',
  },
  ConfirmDialog: { props: ['open', 'title'], template: '<div v-if="open" class="dialog">{{ title }}</div>' },
  SegmentedControl: true,
  StatusPill: { props: ['label'], template: '<span>{{ label }}</span>' },
  SideDrawer: { props: ['open'], template: '<div v-if="open"><slot /></div>' },
  TablePager: true,
  // Renders the cell slots, because every control on this screen lives in one.
  // A stub that dropped them would make the buttons untestable while the tests
  // still looked like they covered them.
  DataTable: {
    props: ['rows'],
    template: `<table><tbody>
      <tr v-for="r in rows" :key="r.barcode" class="row">
        <td><slot name="cell-name" :row="r">{{ r.name }}</slot></td>
        <td><slot name="cell-scans" :row="r" /></td>
        <td><slot name="cell-verdict" :row="r" /></td>
        <td><slot name="cell-actions" :row="r" /></td>
      </tr>
    </tbody></table>`,
  },
}

const candidate = {
  barcode: '5941000000001',
  name: 'Ciocolata',
  maker: 'Kandia',
  score: 58,
  reason: 'middle-band',
  flags: [],
  signals: { lang: 'ro', scans: 42, markets: ['en:romania'] },
  run_id: 'run-1',
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function pageOf<T>(rows: T[]) {
  return { rows, total: rows.length, offset: 0 }
}

beforeEach(() => {
  fetchReviewCandidates.mockReset().mockResolvedValue(pageOf([candidate]))
  fetchReviewDecisions.mockReset().mockResolvedValue(pageOf([]))
  recordDecision.mockClear()
  clearDecision.mockClear()
  approveAbove.mockClear()
})

describe('ReviewView', () => {
  it('lists the pending band', async () => {
    const wrapper = mount(ReviewView, { global: { stubs } })
    await flush()

    expect(wrapper.text()).toContain('Ciocolata')
    expect(wrapper.text()).toContain('Kandia')
  })

  // Without this line you approve fifty products and go looking for them in the
  // catalog. It is the single most load-bearing sentence on the screen.
  it('says approving does nothing until the next run', async () => {
    const wrapper = mount(ReviewView, { global: { stubs } })
    await flush()

    expect(wrapper.text()).toMatch(/next score and load run/i)
  })

  it('records a verdict and refetches', async () => {
    const wrapper = mount(ReviewView, { global: { stubs } })
    await flush()

    await wrapper.find('[data-test="approve"]').trigger('click')
    await flush()

    expect(recordDecision).toHaveBeenCalledWith('5941000000001', 'approve')
    // Twice: once on mount, once after the write. A verdict that does not
    // refetch leaves the row sitting in a band it no longer belongs to.
    expect(fetchReviewCandidates.mock.calls.length).toBeGreaterThan(1)
  })

  it('records a rejection from the same row', async () => {
    const wrapper = mount(ReviewView, { global: { stubs } })
    await flush()

    await wrapper.find('[data-test="reject"]').trigger('click')
    await flush()

    expect(recordDecision).toHaveBeenCalledWith('5941000000001', 'reject')
  })

  // Rows written before 005_review.sql carry an empty signals object and cannot
  // be backfilled. "Never scanned" and "we did not write it down" are opposite
  // facts, and the reviewer is deciding on exactly this.
  it('renders an unrecorded signal as a dash rather than a zero', async () => {
    fetchReviewCandidates.mockResolvedValue(pageOf([{ ...candidate, signals: {} }]))

    const wrapper = mount(ReviewView, { global: { stubs } })
    await flush()

    expect(wrapper.find('[data-test="scans"]').text()).toBe('—')
  })

  it('renders a recorded zero as zero', async () => {
    fetchReviewCandidates.mockResolvedValue(pageOf([{ ...candidate, signals: { scans: 0 } }]))

    const wrapper = mount(ReviewView, { global: { stubs } })
    await flush()

    expect(wrapper.find('[data-test="scans"]').text()).toBe('0')
  })

  it('explains a refusal rather than showing a failed table', async () => {
    const forbidden = Object.assign(new Error('list_review_candidates: admin only'), {
      code: '42501',
    })
    fetchReviewCandidates.mockRejectedValue(forbidden)

    const wrapper = mount(ReviewView, { global: { stubs } })
    await flush()

    expect(wrapper.text()).toMatch(/not a catalog admin/i)
    expect(wrapper.text()).toMatch(/admins:add/i)
  })
})
