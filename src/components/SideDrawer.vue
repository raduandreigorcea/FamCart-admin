<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'

// A right-hand drawer for detail that belongs beside a table rather than instead
// of it: the row you clicked stays visible and in context.
//
// Full detail pages exist too, and the split is deliberate. A drawer is for
// looking; a page is for landing on from a link or a bookmark. So the drawer
// always offers "Open full page" rather than trying to be one.
//
// Focus handling follows the rules FamCart's AppModal established: focus moves
// in on open, Escape closes, and focus returns to whatever opened it. Written
// out rather than vendored because AppModal is built around a teleport, a shared
// layer stack and Android's back button, none of which exist here.

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  width: { type: String, default: '520px' },
})

const emit = defineEmits<{ (e: 'close'): void }>()

const panel = ref<HTMLElement | null>(null)
let returnFocusTo: HTMLElement | null = null

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      returnFocusTo = document.activeElement as HTMLElement | null
      document.addEventListener('keydown', onKeydown)
      // Wait a frame so the panel exists before it is focused.
      requestAnimationFrame(() => panel.value?.focus())
    } else {
      document.removeEventListener('keydown', onKeydown)
      returnFocusTo?.focus?.()
      returnFocusTo = null
    }
  },
)

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="open" class="drawer">
    <div class="drawer__scrim" @click="emit('close')"></div>

    <aside
      ref="panel"
      class="drawer__panel"
      :style="{ width }"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
    >
      <header class="drawer__head">
        <div class="drawer__heading">
          <h2 class="drawer__title">{{ title }}</h2>
          <p v-if="subtitle" class="drawer__subtitle">{{ subtitle }}</p>
        </div>
        <div class="drawer__head-actions">
          <slot name="head-actions" />
          <button type="button" class="drawer__close" title="Close" @click="emit('close')">
            <AppIcon name="x" :size="16" />
            <span class="u-sr">Close</span>
          </button>
        </div>
      </header>

      <div class="drawer__body">
        <slot />
      </div>

      <footer v-if="$slots.footer" class="drawer__foot">
        <slot name="footer" />
      </footer>
    </aside>
  </div>
</template>

<style scoped>
.drawer {
  position: fixed;
  inset: 0;
  z-index: 55;
  display: flex;
  justify-content: flex-end;
}

.drawer__scrim {
  position: absolute;
  inset: 0;
  background: var(--backdrop);
  animation: drawer-fade var(--transition-base) var(--ease-standard);
}

@keyframes drawer-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.drawer__panel {
  position: relative;
  max-width: 92vw;
  height: 100%;
  background: var(--bg-surface);
  border-left: var(--border-width-thin) solid var(--border-main);
  box-shadow: var(--elevation-modal);
  display: flex;
  flex-direction: column;
  animation: drawer-slide var(--transition-slow) var(--ease-rise);
  outline: none;
}

@keyframes drawer-slide {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .drawer__panel {
    animation: drawer-fade var(--transition-fast) var(--ease-standard);
  }
}

.drawer__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

.drawer__heading {
  min-width: 0;
}

.drawer__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.drawer__subtitle {
  margin: 2px 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.drawer__head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.drawer__close {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--text-xl);
  line-height: 1;
  color: var(--text-secondary);
}

.drawer__close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.drawer__body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.drawer__foot {
  padding: var(--space-3) var(--space-4);
  border-top: var(--border-width-thin) solid var(--border-light);
  background: var(--bg-surface-alt);
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
