import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'
import DataTable from '../src/components/DataTable.vue'
import type { Column } from '../src/lib/uiTypes'

// The skeleton is not decoration. It holds the shape of the table that is
// coming, so the page does not reflow when the rows land -- and it was holding
// the wrong shape: its <td>s carried no per-column classes at all.
//
// `hide-below-*` is the one that mattered. Below 1400px the header hid three
// columns and the skeleton kept all nine, so the loading table was two cells
// and three hundred pixels wider than the header sitting on top of it.
//
// These assert that one column answers the alignment question once, for the
// header, the body and the skeleton alike.

interface Row {
  name: string
  items: number
  note: string
}

const columns: Column<Row>[] = [
  { key: 'name', label: 'Name' },
  { key: 'items', label: 'Items', numeric: true, hideBelow: 1400 },
  { key: 'note', label: 'Note', align: 'center', hideBelow: 1100 },
]

const rows: Row[] = [{ name: 'Lapte', items: 3, note: 'ok' }]

const stubs = { AppIcon: true, StateBlock: true }

// mount() cannot carry a generic SFC's type parameter: DataTable arrives here
// as DataTable<object>, which rejects Column<Row> and narrows rowKey to never.
// The cast is confined to this one boundary, and it costs nothing that matters
// -- the props are typechecked where they are actually written, in the seven
// views, which is what making the component generic was for.
const Table = DataTable as unknown as Component

function loadedTable() {
  return mount(Table, { props: { columns, rows, rowKey: 'name' }, global: { stubs } })
}

function loadingTable() {
  return mount(Table, {
    props: { columns, rows: [], rowKey: 'name', loading: true },
    global: { stubs },
  })
}

/** Layout classes only: `u-num` is a property of content, not of the column. */
function layoutClasses(cells: { classes(): string[] }[]) {
  return cells.map((cell) =>
    cell
      .classes()
      .filter((c) => c !== 'u-num')
      .sort()
      .join(' '),
  )
}

describe('DataTable column classes', () => {
  it('dresses header, body and skeleton cells identically', () => {
    const loaded = loadedTable()
    const loading = loadingTable()

    const header = layoutClasses(loaded.findAll('thead th'))
    const body = layoutClasses(loaded.findAll('tbody td'))
    const skeleton = layoutClasses(loading.findAll('tbody tr:first-child td'))

    expect(body).toEqual(header)
    expect(skeleton).toEqual(header)
    expect(header).toEqual(['', 'hide-below-1400 is-right', 'hide-below-1100 is-center'])
  })

  it('hides the same columns while loading as when loaded', () => {
    // The measured symptom: header 7 visible cells, skeleton 9.
    const loading = loadingTable()
    const hidden = (sel: string) =>
      loading.findAll(sel).map((c) => c.classes().filter((x) => x.startsWith('hide-below-')).join())

    expect(hidden('tbody tr:first-child td')).toEqual(hidden('thead th'))
  })

  it('keeps tabular figures on the body cell only', () => {
    // A header is words and a skeleton is a grey bar; neither has digits to
    // line up, and only the body cell should carry the font feature.
    const loaded = loadedTable()
    const loading = loadingTable()

    expect(loaded.findAll('tbody td')[1].classes()).toContain('u-num')
    expect(loaded.findAll('thead th')[1].classes()).not.toContain('u-num')
    expect(loading.findAll('tbody td')[1].classes()).not.toContain('u-num')
  })
})

describe('DataTable alignment CSS', () => {
  // The class bindings were already reaching the header before this; what was
  // broken was the cascade. `.table th` sets text-align:left and scores
  // (0,1,1); a bare `.is-right` scores (0,1,0) and lost -- on the header only,
  // since nothing competes for it on a td. So every numeric column in the tool
  // rendered a left-aligned label above a right-aligned column of figures.
  //
  // Scoped styles are not applied by test-utils, so this reads the source.
  const source = readFileSync('src/components/DataTable.vue', 'utf8')

  it('qualifies the alignment selectors by their cell', () => {
    expect(source).toMatch(/\.table th\.is-right,\s*\r?\n?\s*\.table td\.is-right/)
    expect(source).toMatch(/\.table th\.is-center,\s*\r?\n?\s*\.table td\.is-center/)
  })

  it('does not reintroduce the bare selectors that lost to .table th', () => {
    expect(source).not.toMatch(/^\.is-right\s*\{/m)
    expect(source).not.toMatch(/^\.is-center\s*\{/m)
  })
})

describe('the floor under the table', () => {
  // `.table-scroll` has promised a sideways scroll since the component was
  // written and could never deliver one: `.table` is width:100% with no lower
  // bound, so it always fitted its panel exactly and there was nothing to
  // scroll. The columns just kept shrinking. These pin the floor that makes the
  // wrapper's promise real, and pin that it is computed per table -- one
  // constant cannot serve a five column table and an eleven column one.

  function floors(cols: Column<Row>[]) {
    const wrapper = mount(Table, {
      props: { columns: cols, rows, rowKey: 'name' },
      global: { stubs },
    })
    const style = wrapper.find('table').attributes('style') ?? ''
    const declared = new Map(
      style
        .split(';')
        .map((part) => part.split(':').map((half) => half.trim()))
        .filter((pair) => pair.length === 2)
        .map(([name, value]) => [name, Number.parseInt(value, 10) || 0]),
    )
    return {
      full: declared.get('--table-floor') ?? 0,
      b1400: declared.get('--table-floor-1400') ?? 0,
      b1100: declared.get('--table-floor-1100') ?? 0,
    }
  }

  const wide: Column<Row>[] = [
    { key: 'name', label: 'Name', width: '80%' },
    { key: 'items', label: 'Items', width: '10%', hideBelow: 1400 },
    { key: 'note', label: 'Note', width: '10%', hideBelow: 1100 },
  ]

  it('is driven by the column that would get thinnest', () => {
    // 10% is the tightest share, and MIN_CELL is 64: 64 / 0.10 = 640.
    expect(floors(wide).full).toBe(640)
  })

  // The whole reason there are three. Below each breakpoint the column SET is
  // different, so the percentages renormalise and the floor moves with them. A
  // single number sized for every column would force a scroll on the ones that
  // survive, which is the same mistake pointing the other way.
  it('falls as the breakpoints drop columns', () => {
    const f = floors(wide)
    expect(f.b1400).toBeLessThan(f.full)
    expect(f.b1100).toBeLessThan(f.b1400)
    // Only `name` is left below 1100, so nothing is thinner than the whole table.
    expect(f.b1100).toBe(64)
  })

  // A percentage is the wrong unit for a cell whose content has a fixed size:
  // two buttons are 145px whatever the window does, and under table-layout:fixed
  // the cell cannot grow to hold them -- it spills and the panel clips it. That
  // was `Remove` being cut off on the catalog at a 1536px window.
  it('respects a column that declares a pixel need', () => {
    const withButtons: Column<Row>[] = [
      { key: 'name', label: 'Name', width: '86%' },
      { key: 'items', label: 'Items', width: '14%', minPx: 150 },
    ]
    // 150 / 0.14 = 1071.4, rounded up.
    expect(floors(withButtons).full).toBe(1072)
  })

  it('asks for nothing when the columns declare no widths', () => {
    expect(floors([{ key: 'name', label: 'Name' }]).full).toBe(0)
  })
})
