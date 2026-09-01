#!/usr/bin/env node
// Copies the icons this dashboard uses out of the `lucide-static` package and
// into src/assets/, verbatim.
//
// ─── WHY THIS SCRIPT EXISTS ──────────────────────────────────────────────────
//
// The first version of these icons was written by hand, from memory of what the
// lucide originals look like. Eleven of the thirteen happened to be right; one
// (`search`) was off by 0.04 units, and one (`menu`) was plainly wrong — its
// three bars sat at y=6/12/18 where lucide draws them at y=5/12/19, so the
// hamburger was visibly more cramped than every other icon beside it.
//
// That is the whole argument for this file. Icon path data is not something
// anyone can review by reading it, so it must not be authored by hand. It is
// copied from a package with a version number, and `--check` proves the copies
// still match.
//
// ─── WHY THE FILES ARE COMMITTED RATHER THAN IMPORTED ────────────────────────
//
// lucide-static ships ~2,000 icons and this tool uses 30. Importing from the
// package at build time would work, but committing the 30 means the repo can be
// read, diffed and built without resolving a dependency to know what a button
// looks like. The dependency stays as a devDependency so the copies can be
// re-synced and verified, and it never reaches the bundle.
//
// The files are copied UNMODIFIED, including lucide's stroke-width="2", so a
// byte comparison against upstream is meaningful. Appearance is not set here:
// AppIcon.vue overrides size and stroke weight in CSS, which wins over the
// presentation attributes in the file.
//
// Usage:
//   node scripts/sync-icons.mjs           # write the icons
//   node scripts/sync-icons.mjs --check   # verify, exit 1 on any drift

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules', 'lucide-static', 'icons')
const dest = join(root, 'src', 'assets')

// Every icon the dashboard renders, and where. Kept as one list so an icon that
// stops being used is easy to spot and drop, and so adding one is a single edit
// here plus the name in a template.
const ICONS = [
  // sidebar sections
  'layout-grid',      // Overview
  'users-round',      // Users
  'house',            // Households
  'package-search',   // Products
  'workflow',         // Pipeline
  'search',           // Search, and every search field
  'activity',         // Health
  'key-round',        // Access

  // chrome
  'panel-left',       // collapse the rail
  'menu',             // open the rail on narrow screens
  'sun-medium',       // theme: light
  'moon',             // theme: dark
  'sun-moon',         // theme: follow the system
  'chevron-down',     // the project switcher's caret
  'log-out',

  // tables and controls
  'arrow-up',         // sort ascending, and a positive delta
  'arrow-down',       // sort descending, and a negative delta
  'chevrons-up-down', // sortable but not sorted
  'minus',            // a flat delta
  'chevron-left',
  'chevron-right',
  'rotate-cw',        // refresh
  'copy',
  'check',
  'x',
  'trash-2',          // the delete action on a household, and withdrawn ones
  'ban',              // Bans
  'circle',           // an unmet quality band
  'ellipsis',

  // status
  'triangle-alert',
  'shield',
  'database',
]

const check = process.argv.includes('--check')

if (!existsSync(source)) {
  console.error(
    'lucide-static is not installed. Run `npm install` first.\n' +
      'It is a devDependency and never reaches the bundle.',
  )
  process.exit(1)
}

const version = JSON.parse(
  readFileSync(join(root, 'node_modules', 'lucide-static', 'package.json'), 'utf8'),
).version

const missing = []
const drifted = []
let written = 0

for (const name of ICONS) {
  const from = join(source, `${name}.svg`)
  if (!existsSync(from)) {
    // A renamed or removed upstream icon. Loud, because the alternative is a
    // silently empty <span> where an icon should be.
    missing.push(name)
    continue
  }

  const svg = readFileSync(from, 'utf8')
  const to = join(dest, `${name}.svg`)
  const current = existsSync(to) ? readFileSync(to, 'utf8') : null

  if (current === svg) continue

  if (check) {
    drifted.push(current === null ? `${name} (not copied yet)` : name)
  } else {
    writeFileSync(to, svg)
    written += 1
  }
}

// Anything in src/assets that no icon in ICONS accounts for. Not an error — it
// may be deliberate — but worth naming, since an unused 1KB file is how a set
// like this slowly stops matching what the code uses.
const known = new Set(ICONS.map((n) => `${n}.svg`))
const stray = readdirSync(dest).filter((f) => f.endsWith('.svg') && !known.has(f))

if (missing.length) {
  console.error(`Not in lucide-static@${version}: ${missing.join(', ')}`)
  console.error('The icon was renamed or removed upstream. Pick its replacement and update ICONS.')
  process.exit(1)
}

if (check) {
  if (drifted.length) {
    console.error(`Out of sync with lucide-static@${version}: ${drifted.join(', ')}`)
    console.error('Run `npm run icons:sync`. Never edit the files in src/assets by hand.')
    process.exit(1)
  }
  console.log(`All ${ICONS.length} icons match lucide-static@${version}.`)
} else {
  console.log(`Synced ${written} of ${ICONS.length} icons from lucide-static@${version}.`)
}

if (stray.length) {
  console.log(`Not referenced by ICONS (safe to delete): ${stray.join(', ')}`)
}
