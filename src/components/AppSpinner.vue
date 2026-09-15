<script setup lang="ts">
import { computed } from 'vue'

// Something is being fetched or is still running, and how long it will take is
// not known. A skeleton says "this shape is coming"; this says "working on it",
// which is the right thing for a banner still checking or a crawl still reading.
//
// It draws in currentColor, so it takes the colour of whatever it sits in: grey
// in a panel head, yellow in a running pill.

const props = defineProps({
  size: { type: Number, default: 14 },
  /** Announced to a screen reader. Leave empty when the text beside it already
   *  says what is happening, and the spinner is hidden from the tree instead. */
  label: { type: String, default: '' },
})

const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  borderWidth: `${Math.max(1.5, props.size / 7)}px`,
}))
</script>

<template>
  <span
    class="spinner"
    :style="style"
    :role="label ? 'status' : undefined"
    :aria-hidden="label ? undefined : 'true'"
  ><span v-if="label" class="u-sr">{{ label }}</span></span>
</template>

<style scoped>
.spinner {
  display: inline-block;
  flex: none;
  box-sizing: border-box;
  border-radius: 50%;
  border-style: solid;
  border-color: color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: currentColor;
  vertical-align: middle;
  animation: spinner-turn 0.8s linear infinite;
}

@keyframes spinner-turn {
  to { transform: rotate(360deg); }
}
</style>
