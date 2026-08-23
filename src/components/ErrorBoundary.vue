<script setup lang="ts">
import { onErrorCaptured, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import StateBlock from './StateBlock.vue'

// The last thing between a thrown error and a white page.
//
// Vue unmounts the whole tree when a render throws and nothing catches it, so
// before this existed a single bad `.map()` on an unexpected null anywhere in
// any view left the operator staring at an empty document -- no message, no
// route, no way back except typing a URL. For an internal tool with one reader
// and no session replay, that is also the least debuggable possible outcome:
// the one person who could report what happened sees nothing to report.
//
// ─── WHY IT RESETS ON NAVIGATION ─────────────────────────────────────────────
//
// A boundary that latches is a boundary that turns one broken page into a
// broken shell. The error is almost always specific to the view that threw --
// a shape the RPC returned that this page did not expect -- so the sidebar,
// the project switcher and every other section are still fine. Clearing on
// route change means the way out of a broken page is to click another one,
// which is what a person will try first anyway.

defineProps({
  /** Shown above the message, so the reader knows which layer failed. */
  title: { type: String, default: 'This section could not be displayed' },
})

const error = ref<Error | null>(null)
const route = useRoute()

onErrorCaptured((caught) => {
  error.value = caught instanceof Error ? caught : new Error(String(caught))
  // `false` stops it propagating further. The boundary IS the handler; letting
  // it continue to app.config.errorHandler would double-report every error
  // that this already renders.
  return false
})

// Navigating away from the page that threw clears the boundary. See above.
watch(() => route.fullPath, () => { error.value = null })

function retry() {
  // Re-mounting the slot is enough for the common case: a transient shape from
  // one bad response. If it throws again the boundary simply catches it again.
  error.value = null
}

function reload() {
  window.location.reload()
}
</script>

<template>
  <div v-if="error" class="boundary">
    <StateBlock state="error" :title="title" :message="error.message">
      <template #action>
        <div class="boundary__actions">
          <button type="button" class="boundary__btn boundary__btn--primary" @click="retry">
            Try again
          </button>
          <button type="button" class="boundary__btn" @click="reload">Reload the page</button>
        </div>
      </template>
    </StateBlock>

    <!-- The stack, folded away. An internal tool's operator is better served by
         the real trace than by a friendly paraphrase of it -- the same argument
         describeError() makes for passing Supabase messages through intact. -->
    <details v-if="error.stack" class="boundary__details">
      <summary class="boundary__summary">Technical detail</summary>
      <pre class="boundary__stack">{{ error.stack }}</pre>
    </details>
  </div>

  <slot v-else />
</template>

<style scoped>
.boundary {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-6) var(--space-4);
}

.boundary__actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: center;
  margin-top: var(--space-2);
}

.boundary__btn {
  background: none;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: 0.4rem var(--space-4);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  cursor: pointer;
}

.boundary__btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.boundary__btn--primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--text-inverse);
}

.boundary__btn--primary:hover {
  background: var(--color-primary);
  color: var(--text-inverse);
  filter: brightness(1.05);
}

.boundary__details {
  width: min(72ch, 100%);
}

.boundary__summary {
  font-size: var(--text-xs);
  color: var(--text-disabled);
  cursor: pointer;
  user-select: none;
}

.boundary__stack {
  margin: var(--space-2) 0 0;
  padding: var(--space-3);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: var(--leading-snug);
  color: var(--text-secondary);
  overflow-x: auto;
  white-space: pre;
}
</style>
