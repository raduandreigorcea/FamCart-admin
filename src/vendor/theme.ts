// The theme preference: one key, one set of modes, one way of putting a mode
// onto the page.
//
// This existed twice — main.ts applied the saved theme before mount so the
// first paint is never the wrong colour, and AppSettingsModal read and wrote
// the same key with its own copy of the literal and its own resolver. Two
// spellings of one storage key is the exact hazard nativeUpdate.ts documents:
// a surface that needs two grep patterns to enumerate is one that gets missed
// when auditing what reads or clears it. Same argument as lib/inviteCode and
// lib/clipboard, both of which exist because a behaviour written twice drifts.

export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'famcart-theme'

/**
 * The saved mode, or 'system' when nothing usable is saved. 'system' is the
 * app's default posture — follow the OS — so an unset key, a value no build
 * ever wrote, and storage being disabled all land on the same answer.
 */
export function loadThemeMode(storage: Pick<Storage, 'getItem'>): ThemeMode {
  try {
    const saved = storage.getItem(THEME_STORAGE_KEY)
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
  } catch {
    return 'system'
  }
}

export function saveThemeMode(storage: Pick<Storage, 'setItem'>, mode: ThemeMode): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // Storage disabled — the theme applies now and simply won't persist.
  }
}

/**
 * Resolve `mode` to a concrete light/dark and stamp it on the root element,
 * which is what every `[data-theme]` selector in style.css keys off.
 * 'system' asks the OS; note the caller owns re-applying when the OS answer
 * changes (AppSettingsModal watches prefers-color-scheme for that).
 */
export function applyResolvedTheme(mode: ThemeMode): void {
  const resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode
  document.documentElement.setAttribute('data-theme', resolved)
}
