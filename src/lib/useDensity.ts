import { computed, ref } from 'vue'
import type { Segment } from './uiTypes'

// Row density, once, for the whole tool.
//
// It was a per-view `ref('comfortable')` on Users and Households and nowhere
// else -- so five of the seven tables in this dashboard, including the densest
// one on System Health, could not be compacted at all, and the two that could
// forgot the choice the moment you navigated away. Both halves of that are the
// same mistake: density is a property of the READER, not of a page. Somebody
// who wants tight rows wants them everywhere and still wants them tomorrow.
//
// So it lives here, is persisted, and every DataTable reads it. The control
// appears once per page in PageHeader's tools slot -- the slot that already
// carries the time range -- rather than once per panel, because System Health
// alone has four tables and four toggles that all do the same thing is not a
// choice, it is a puzzle.

export type Density = 'comfortable' | 'compact'

// Namespaced like FamCart's own theme key, so the two tools can share an origin
// in development without reading each other's preferences.
const STORAGE_KEY = 'famcart-admin:density'

function load(): Density {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable'
  } catch {
    // Storage disabled. Comfortable is the safe default: a reader who wanted
    // compact will say so again, and nobody is harmed by roomy rows.
    return 'comfortable'
  }
}

const density = ref<Density>(load())

export const DENSITY_SEGMENTS: Segment[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
]

export function setDensity(next: Density): void {
  density.value = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // The choice still applies for this session.
  }
}

export function useDensity() {
  return {
    density,
    /** What DataTable's `dense` prop takes. */
    dense: computed(() => density.value === 'compact'),
    setDensity,
    segments: DENSITY_SEGMENTS,
  }
}
