// The closed vocabularies the reference catalog holds, in one place.
//
// Every list here is a check constraint in the catalog project's 002_catalog.sql
// restated in TypeScript, and each one is validated a second time by the admin
// RPCs before it can reach that constraint. So this file is a THIRD copy, and
// the reason it is worth having rather than avoiding is that the alternative was
// a fourth: CatalogFormDialog owned these lists privately, and the filter drawer
// needs the same categories and the same units to offer them.
//
// The failure mode if one of these drifts is quiet in one direction and loud in
// the other. A value here that the database does not accept comes back as a
// named error from the RPC -- annoying, visible, fixed in a minute. A value the
// database accepts that is MISSING here is a filter that can never be selected
// and a product that can never be given that category, with nothing anywhere
// reporting it. That asymmetry is why these are listed rather than derived from
// whatever the current page of rows happens to contain.
//
// WHAT WENT WHEN THE CATALOG WAS REBUILT (2026-09-04). LANGS, TIERS and SOURCES
// described a catalog imported from Open Food Facts: a name per language, a
// completeness grade, and which upstream food database a row came from. The
// catalog is now built from what real shops list, so a product has one name in
// one language, no grade, and a set of RETAILERS rather than a source. Those
// three lists are gone rather than emptied -- an empty vocabulary is a filter
// that renders and does nothing.

/**
 * The eleven the check constraint accepts, which are the eleven
 * src/lib/region.ts can emit. Kept because a RETAILER has a country, even though
 * a product no longer has a market list of its own.
 */
export const MARKETS = ['RO', 'MD', 'DE', 'AT', 'CH', 'ES', 'FR', 'BE', 'IT', 'GB', 'IE']

/**
 * The seventeen the check constraint accepts. A free-text box here meant any
 * typo became a constraint violation naming a table.
 */
export const CATEGORIES = [
  'produce', 'dairy', 'bakery', 'meat', 'fish', 'pantry', 'frozen',
  'snacks', 'drinks', 'alcohol', 'baby', 'household', 'personal-care',
  'health', 'pet', 'home', 'other',
]

/**
 * Quantity units, which move with a quantity or not at all.
 *
 * Five now, not six: 'cl' and 'piece' are gone. The catalog stores centilitres
 * as millilitres (there is no cl in the constraint) and counts as 'buc', which
 * is what Romanian shelf labels say.
 */
export const UNITS = ['g', 'kg', 'ml', 'l', 'buc']

/** The shops the catalog is built from, matching catalog/src/core/registry.ts. */
export const RETAILERS = ['auchan', 'carrefour', 'lidl']

/** Sentence case for a slug, for a table cell or a select. */
export function retailerLabel(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1)
}

export const MARKET_NAMES: Record<string, string> = {
  RO: 'Romania',
  MD: 'Moldova',
  DE: 'Germany',
  AT: 'Austria',
  CH: 'Switzerland',
  ES: 'Spain',
  FR: 'France',
  BE: 'Belgium',
  IT: 'Italy',
  GB: 'United Kingdom',
  IE: 'Ireland',
}
