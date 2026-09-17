<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId } from 'vue'

// More about a terse value -- a country code, a user id -- on hover or keyboard
// focus, without leaving the page. The trigger is the default slot; what the
// card says is the `card` slot, rendered only while it is open.
//
// WHY NOT `interestfor` AND `popover="hint"`, which are the platform's own
// answer to exactly this: in 2026 both are Chrome-only and need a polyfill each,
// and a card that loads its content (UserId) needs script on open anyway. So
// the card is a plain `popover="manual"` -- Baseline, and in the top layer, so
// no table's overflow or stacking context can clip it -- and this component does
// the rest. What it owes, per WCAG 1.4.13 (content on hover or focus):
//
//   - it waits before opening, so a pointer crossing a table does not flash a
//     card per row;
//   - it stays open while the pointer moves from the trigger onto the card, so
//     the card can be read, and a link in it clicked;
//   - it closes on Escape without the pointer or focus having to move;
//   - it opens from the keyboard as well as the pointer.
//
// Positioned by script rather than CSS anchor positioning, which would need a
// polyfill for Firefox and Safari: under the trigger, flipped above when there
// is no room below, kept inside the window. It closes on scroll rather than
// chase its trigger, which is what a card this small should do.

defineOptions({ inheritAttrs: false })

defineProps({
  /**
   * Whether the trigger takes keyboard focus itself. Off when what it wraps is
   * already focusable -- a copy button, a link -- so Tab does not stop twice on
   * one value; focus inside it still opens the card.
   */
  focusable: { type: Boolean, default: true },
  /**
   * The card holds a link or a button. Then the trigger points at it with
   * aria-details, which allows interactive content, instead of aria-describedby,
   * which is read as plain text.
   */
  interactive: { type: Boolean, default: false },
})

const emit = defineEmits<{ (e: 'open'): void }>()

const OPEN_DELAY_MS = 300
const CLOSE_DELAY_MS = 150
const GAP_PX = 6
const EDGE_PX = 8

const cardId = `hover-${useId()}`
const open = ref(false)
const trigger = ref<HTMLElement | null>(null)
const card = ref<HTMLElement | null>(null)

let openTimer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

function clearTimers() {
  if (openTimer) clearTimeout(openTimer)
  if (closeTimer) clearTimeout(closeTimer)
  openTimer = closeTimer = null
}

function scheduleOpen() {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
  if (open.value || openTimer) return
  openTimer = setTimeout(show, OPEN_DELAY_MS)
}

function scheduleClose() {
  if (openTimer) clearTimeout(openTimer)
  openTimer = null
  if (!open.value || closeTimer) return
  closeTimer = setTimeout(hide, CLOSE_DELAY_MS)
}

function keepOpen() {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
}

async function show() {
  openTimer = null
  open.value = true
  emit('open')
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('scroll', hide, { capture: true, passive: true })
  window.addEventListener('resize', hide, { passive: true })
  await nextTick()
  const el = card.value
  if (!el) return
  // Where popover is unsupported the attribute is ignored and the card is a
  // fixed element like any other, which is the fallback.
  if (typeof el.showPopover === 'function') {
    try {
      el.showPopover()
    } catch {
      // Already showing, or detached mid-open: nothing to do.
    }
  }
  place(el)
}

function hide() {
  clearTimers()
  if (!open.value) return
  open.value = false
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('scroll', hide, { capture: true })
  window.removeEventListener('resize', hide)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') hide()
}

function place(el: HTMLElement) {
  const anchor = trigger.value?.getBoundingClientRect()
  if (!anchor) return
  const box = el.getBoundingClientRect()
  const below = anchor.bottom + GAP_PX
  const top =
    below + box.height > window.innerHeight - EDGE_PX && anchor.top - GAP_PX - box.height > EDGE_PX
      ? anchor.top - GAP_PX - box.height
      : below
  const left = Math.max(EDGE_PX, Math.min(anchor.left, window.innerWidth - box.width - EDGE_PX))
  el.style.top = `${Math.round(top)}px`
  el.style.left = `${Math.round(left)}px`
}

onBeforeUnmount(hide)

// The trigger's own events. focusout only closes when focus left the trigger
// AND did not go into the card: tabbing to the card's link must keep it open.
function onFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null
  if (next && (trigger.value?.contains(next) || card.value?.contains(next))) return
  scheduleClose()
}

</script>

<template>
  <!-- Two roots -- the trigger and the teleported card -- so what a parent
       passes (a class, an id) is bound to the trigger by hand. -->
  <span
    v-bind="$attrs"
    ref="trigger"
    class="hover"
    :tabindex="focusable ? 0 : undefined"
    :aria-describedby="open && !interactive ? cardId : undefined"
    :aria-details="open && interactive ? cardId : undefined"
    @mouseenter="scheduleOpen"
    @mouseleave="scheduleClose"
    @focusin="scheduleOpen"
    @focusout="onFocusOut"
  >
    <slot />
  </span>
  <Teleport to="body">
    <div
      v-if="open"
      :id="cardId"
      ref="card"
      popover="manual"
      class="hover__card"
      @mouseenter="keepOpen"
      @mouseleave="scheduleClose"
      @focusout="onFocusOut"
    >
      <slot name="card" />
    </div>
  </Teleport>
</template>

<style scoped>
/* The cue that there is more here, which content on hover must give: a dotted
   underline, the convention for "hover me" rather than "click me". */
.hover {
  text-decoration: underline dotted;
  text-decoration-color: var(--text-disabled);
  text-underline-offset: 3px;
  cursor: help;
  border-radius: var(--radius-xs);
}

.hover:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

/* Reset what the UA gives a popover -- centred, bordered, inset 0 -- and place
   it where place() says. */
.hover__card {
  position: fixed;
  inset: auto;
  margin: 0;
  z-index: 1000;
  max-width: 20rem;
  padding: var(--space-3);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: var(--text-sm);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.14);
}
</style>
