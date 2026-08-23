import { describe, expect, it } from 'vitest'
import { qualityLabel, qualityScore } from '../src/lib/data/products'

// The derived quality score, which is labelled as derived everywhere it
// appears because the importer has a real scorer and this is not it. What it
// measures is row COMPLETENESS, and the property worth pinning is that the
// weights add to 100 and that nothing can be bought with popularity alone.

type Row = Parameters<typeof qualityScore>[0]

function row(over: Partial<Row> = {}): Row {
  return {
    barcode: null,
    maker: null,
    search_aliases: null,
    markets: [],
    base_weight: 0,
    ...over,
  }
}

describe('qualityScore', () => {
  it('scores an empty row at zero without throwing', () => {
    const { score, bands } = qualityScore(row())
    expect(score).toBe(0)
    expect(bands.every((b) => !b.met)).toBe(true)
  })

  it('scores a complete row at 100', () => {
    const { score } = qualityScore(
      row({
        barcode: '5941234567890',
        maker: 'Napolact',
        search_aliases: 'milk lapte',
        markets: ['RO'],
        base_weight: 150,
      }),
    )
    expect(score).toBe(100)
  })

  it('has bands that add up to exactly 100', () => {
    // If someone adds a band without rebalancing, the score silently stops
    // being a percentage and every "Quality" cell in the table is wrong.
    const total = qualityScore(row()).bands.reduce((sum, b) => sum + b.possible, 0)
    expect(total).toBe(100)
  })

  it('weights each attribute as documented', () => {
    expect(qualityScore(row({ barcode: '5941234567890' })).score).toBe(30)
    expect(qualityScore(row({ maker: 'Napolact' })).score).toBe(20)
    expect(qualityScore(row({ search_aliases: 'milk' })).score).toBe(20)
    expect(qualityScore(row({ markets: ['RO'] })).score).toBe(15)
  })

  it('caps editorial weight so popularity cannot buy a missing barcode', () => {
    // The stated rule: a very popular product must not make up for having no
    // barcode and no maker.
    const enormous = qualityScore(row({ base_weight: 100_000 }))
    expect(enormous.score).toBe(15)
    expect(enormous.score).toBeLessThan(30)
  })

  it('treats an empty markets array as unplaced, not as placed', () => {
    expect(qualityScore(row({ markets: [] })).score).toBe(0)
    expect(qualityScore(row({ markets: ['RO', 'BG'] })).score).toBe(15)
  })

  it('survives a null base_weight and a null markets array', () => {
    // Both are nullable in the catalog schema, and a thrown TypeError here
    // would take out the whole Products table rather than one cell.
    const nulled = { ...row(), base_weight: null, markets: null } as unknown as Row
    expect(() => qualityScore(nulled)).not.toThrow()
    expect(qualityScore(nulled).score).toBe(0)
  })

  it('never reports a band as met while earning nothing for it', () => {
    const complete = qualityScore(
      row({ barcode: '1', maker: 'x', search_aliases: 'y', markets: ['RO'], base_weight: 40 }),
    )
    for (const band of complete.bands) {
      expect(band.met).toBe(band.earned > 0)
    }
  })
})

describe('qualityLabel', () => {
  it('bands at the documented boundaries', () => {
    expect(qualityLabel(100)).toBe('strong')
    expect(qualityLabel(70)).toBe('strong')
    expect(qualityLabel(69)).toBe('fair')
    expect(qualityLabel(40)).toBe('fair')
    expect(qualityLabel(39)).toBe('thin')
    expect(qualityLabel(0)).toBe('thin')
  })
})
