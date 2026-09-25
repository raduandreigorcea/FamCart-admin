import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LineChart from '../src/components/LineChart.vue'

// The chart's two axes. Both broke on the scrape run page: a chart given no
// `format` printed its default function's source as tick labels ("tring(n)"),
// and the always-drawn last date landed on top of the one before it.

const series = (n: number) => [{ key: 'a', label: 'A', values: Array.from({ length: n }, (_, i) => i * 10) }]
const labels = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`)

function axes(n: number, props: Record<string, unknown> = {}) {
  const wrapper = mount(LineChart, { props: { series: series(n), labels: labels(n), ...props } })
  const [yAxis, xAxis] = wrapper.findAll('.chart__axis')
  return { y: yAxis.findAll('text').map((t) => t.text()), x: xAxis.findAll('text').map((t) => t.text()) }
}

describe('LineChart axes', () => {
  it('prints plain numbers on the y axis when given no format', () => {
    const { y } = axes(5)
    expect(y.length).toBeGreaterThan(0)
    for (const tick of y) expect(tick).toMatch(/^\d+$/)
  })

  it('always shows the first and last date', () => {
    const { x } = axes(30)
    expect(x[0]).toBe('L0')
    expect(x.at(-1)).toBe('L29')
  })

  it('never draws a date right beside the last one', () => {
    // 30 labels: stride 4, so L28 would sit one slot from L29.
    const { x } = axes(30)
    const drawn = x.map((l) => Number(l.slice(1)))
    for (let i = 1; i < drawn.length; i++) expect(drawn[i] - drawn[i - 1]).toBeGreaterThanOrEqual(4)
  })
})
