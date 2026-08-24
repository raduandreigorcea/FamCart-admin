import { onBeforeUnmount, watch, type Ref } from 'vue'

// What a modal owes the keyboard, in one place, because three components each
// implemented most of it.
//
// ConfirmDialog, SideDrawer and CommandPalette all moved focus in on open,
// closed on Escape and returned focus on close. All three then declared
// `aria-modal="true"` and let Tab walk straight out of the panel into the page
// behind it -- where the links still work, the table rows are still clickable,
// and nothing on screen suggests the dialog is no longer where you are. That
// attribute is a promise to assistive technology that the rest of the document
// is inert; without a trap it is simply false.
//
// So this adds the two halves nobody had written: Tab is confined to the panel,
// and the page behind it stops scrolling.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // offsetParent is null for anything display:none or inside it, which is how
    // a hidden tab's buttons end up in the tab order of a dialog that is
    // rendering something else.
    (element) => element.offsetParent !== null || element === document.activeElement,
  )
}

// Nested modals are possible -- the command palette can open over a drawer -- so
// the lock counts rather than toggles. Restoring on the first close would give
// the page its scrollbar back underneath a dialog that is still open.
let lockCount = 0
let restoreOverflow = ''

function lockScroll() {
  if (lockCount === 0) {
    restoreOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  lockCount += 1
}

function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) document.body.style.overflow = restoreOverflow
}

export interface ModalOptions {
  /** Whether the modal is on screen. */
  open: () => boolean
  /** Called on Escape and expected to close the modal. */
  close: () => void
  /** The panel. Tab is confined inside it and focus lands here by default. */
  panel: Ref<HTMLElement | null>
  /**
   * What to focus instead of the panel itself. ConfirmDialog points this at
   * Cancel, so a reflexive Enter is always the safe outcome.
   */
  initialFocus?: () => HTMLElement | null | undefined
  /** Return false to refuse Escape -- a write in flight, for instance. */
  dismissible?: () => boolean
}

export function useModal(options: ModalOptions): void {
  let returnFocusTo: HTMLElement | null = null
  // Whether activate() has run and not yet been undone. Deliberately NOT
  // `options.open()`: closing sets that ref synchronously while the watcher
  // that reacts to it is pre-flush, so a modal closed and unmounted in one tick
  // -- a route change out from under an open drawer -- would answer "already
  // closed" to a teardown that had never happened, and leave the document
  // listener attached and the page unscrollable for the rest of the session.
  let active = false

  function trapTab(event: KeyboardEvent) {
    const root = options.panel.value
    if (!root) return

    const items = focusableWithin(root)
    if (items.length === 0) {
      // Nothing to move to, so keep focus on the panel rather than letting it
      // escape to the address bar and back into the page.
      event.preventDefault()
      root.focus()
      return
    }

    const first = items[0]
    const last = items[items.length - 1]
    const current = document.activeElement
    const outside = !(current instanceof Node) || !root.contains(current)

    if (event.shiftKey && (outside || current === first)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (outside || current === last)) {
      event.preventDefault()
      first.focus()
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (options.dismissible && !options.dismissible()) return
      event.stopPropagation()
      options.close()
      return
    }
    if (event.key === 'Tab') trapTab(event)
  }

  function activate() {
    if (active) return
    active = true
    returnFocusTo = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', onKeydown)
    lockScroll()
    // A frame, so the panel is in the document before it is focused.
    requestAnimationFrame(() => {
      const target = options.initialFocus?.() ?? options.panel.value
      target?.focus()
    })
  }

  function deactivate() {
    if (!active) return
    active = false
    document.removeEventListener('keydown', onKeydown)
    unlockScroll()
    returnFocusTo?.focus?.()
    returnFocusTo = null
  }

  watch(options.open, (open) => (open ? activate() : deactivate()), { immediate: true })

  onBeforeUnmount(deactivate)
}
