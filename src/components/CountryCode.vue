<script setup lang="ts">
import { computed } from 'vue'
import HoverCard from './HoverCard.vue'
import { countryName } from '../lib/data/scrapers'

// A market code, "CH", with the country it stands for on hover. Two letters are
// not always obvious -- CH is Switzerland (Confoederatio Helvetica), not Czechia,
// which is CZ -- and the whole name is one hover away rather than a search away.

const props = defineProps({
  code: { type: String, required: true },
  /** A line under the name, e.g. how many shops are read there. */
  note: { type: String, default: '' },
  /**
   * Off inside something focusable -- a segment of a control -- which is then
   * what Tab stops on. The country's name is still in the text, hidden from
   * sight, so the control's accessible name says it: "CH Switzerland".
   */
  focusable: { type: Boolean, default: true },
})

const upper = computed(() => props.code.toUpperCase())
const name = computed(() => countryName(upper.value))
</script>

<template>
  <HoverCard :focusable="focusable">
    <span class="code" :class="{ 'code--inherit': !focusable }">{{ upper }}</span>
    <span v-if="!focusable" class="sr-only">{{ name }}</span>
    <template #card>
      <p class="country">{{ name }}</p>
      <p v-if="note" class="note">{{ note }}</p>
    </template>
  </HoverCard>
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.code {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}

/* Inside a control, the control decides the colour: a selected segment must
   not keep a secondary grey. */
.code--inherit {
  color: inherit;
  font-size: inherit;
}

.country {
  margin: 0;
  font-weight: var(--weight-semibold);
}

.note {
  margin: var(--space-1) 0 0;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
</style>
