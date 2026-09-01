<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import AppIcon from './AppIcon.vue'

// An identifier, shown in full and copyable in one click.
//
// Half of what this tool is used for is getting a Clerk id, an invite code or a
// uuid out of it and into somewhere else. Selecting monospace text by hand out
// of a dense table row is exactly the kind of small friction that makes a tool
// feel unfinished.

defineProps({
  value: { type: String, required: true },
  /** What to show, when the full value is too long for the cell. */
  display: { type: String, default: '' },
  label: { type: String, default: 'value' },
})

const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    copied.value = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => (copied.value = false), 1400)
  } catch {
    // Clipboard access can be refused (an insecure origin, a permissions
    // policy). The value is still on screen and selectable, so the fallback is
    // doing nothing rather than showing an error for a convenience.
  }
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <button
    type="button"
    class="copy"
    :title="copied ? 'Copied' : `Copy ${label}: ${value}`"
    @click.stop="copy(value)"
  >
    <span class="copy__text u-mono u-truncate">{{ display || value }}</span>
    <AppIcon
      class="copy__glyph"
      :class="{ 'copy__glyph--done': copied }"
      :name="copied ? 'check' : 'copy'"
      :size="12"
    />
    <span class="u-sr">{{ copied ? 'Copied' : `Copy ${label}` }}</span>
  </button>
</template>

<style scoped>
.copy {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  max-width: 100%;
  background: none;
  border: none;
  padding: 1px var(--space-1);
  margin-left: calc(var(--space-1) * -1);
  border-radius: var(--radius-xs);
  cursor: pointer;
  color: var(--text-secondary);
  font-size: inherit;
  text-align: left;
}

.copy:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.copy__text {
  min-width: 0;
}

.copy__glyph {
  flex: none;
  opacity: 0;
  transition: opacity var(--transition-fast) var(--ease-standard);
}

.copy:hover .copy__glyph,
.copy:focus-visible .copy__glyph {
  opacity: 0.6;
}

.copy__glyph--done {
  opacity: 1 !important;
  color: var(--status-good);
}
</style>
