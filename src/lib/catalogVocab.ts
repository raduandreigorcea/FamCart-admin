// The closed vocabularies the reference catalog holds, in one place.
//
// Every list here is a check constraint in the catalog project's 002_products.sql
// restated in TypeScript, and each one is validated a second time by the admin
// RPCs before it can reach that constraint. So this file is a THIRD copy, and
// the reason it is worth having rather than avoiding is that the alternative was
// a fourth: CatalogFormDialog owned these lists privately, and the filter drawer
// needs the same eleven markets, the same seventeen categories and the same six
// languages to offer them.
//
// The failure mode if one of these drifts is quiet in one direction and loud in
// the other. A value here that the database does not accept comes back as a
// named error from the RPC -- annoying, visible, fixed in a minute. A value the
// database accepts that is MISSING here is a filter that can never be selected
// and a product that can never be given that category, with nothing anywhere
// reporting it. That asymmetry is why these are listed rather than derived from
// whatever the current page of rows happens to contain.

/** The six languages FamCart's interface speaks, so the six a name can be in. */
export const LANGS = ['en', 'de', 'es', 'ro', 'fr', 'it']

/**
 * The eleven the check constraint accepts, which are the eleven
 * src/lib/region.ts can emit. A code outside this list matches no product at
 * all and looks exactly like a ranking bug.
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

/** Quantity units, which move with a quantity or not at all. */
export const UNITS = ['g', 'kg', 'ml', 'l', 'cl', 'piece']

/** How complete a record is: A excellent, B good, C usable but incomplete. */
export const TIERS = ['A', 'B', 'C']

/**
 * Provenance, which is a licensing fact here rather than bookkeeping -- Open
 * Food Facts is ODbL. 'admin' is a row written from this dashboard and is
 * deliberately not 'curated', because catalog_prune_curated() deletes curated
 * rows the version-controlled seed does not name.
 */
export const SOURCES = [
  'curated', 'openfoodfacts', 'openproductsfacts', 'openbeautyfacts', 'user', 'admin',
]

/**
 * Provenance, shortened and toned for a table cell. 'openfoodfacts' is thirteen
 * lowercase characters that push every other column around, and the distinction
 * that matters when reading down a column is not which upstream catalog it was
 * but WHETHER A PERSON PUT IT THERE.
 */
export const SOURCE_LABELS: Record<string, string> = {
  admin: 'Admin',
  curated: 'Seed',
  user: 'User',
  openfoodfacts: 'OFF',
  openproductsfacts: 'OPF',
  openbeautyfacts: 'OBF',
}

export function sourceLabel(name: string): string {
  return SOURCE_LABELS[name] ?? name
}

/** Full country names, for a filter select where two letters are a guess. */
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

/** Full language names, same reason. */
export const LANG_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German',
  es: 'Spanish',
  ro: 'Romanian',
  fr: 'French',
  it: 'Italian',
}
