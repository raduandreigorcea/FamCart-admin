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
})

const upper = computed(() => props.code.toUpperCase())
const name = computed(() => countryName(upper.value))
</script>

<template>
  <HoverCard>
    <span class="code">{{ upper }}</span>
    <template #card>
      <p class="country">{{ name }}</p>
      <p v-if="note" class="note">{{ note }}</p>
    </template>
  </HoverCard>
</template>

<style scoped>
.code {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.02em;
  color: var(--text-secondary);
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
