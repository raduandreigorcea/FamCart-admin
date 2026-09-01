<script setup lang="ts">
// The FamCart cart, and the only place in this repo that names the file.
//
// It is the app's own icon rather than a lookalike drawn for the dashboard:
// public/icons/pwa-192.png is copied byte-for-byte out of FamCart's
// public/icons/, so the tab, the phone home screen and this sidebar all carry
// one mark. A second mark drawn "in the same spirit" is how a brand ends up
// with two.
//
// A PNG rather than an SVG because there is no SVG source anywhere -- the mark
// only exists as the icon set. That is fine here: the file is 192px and every
// use below is 56px or smaller, so it is downsampling on any display, and the
// ground is genuinely transparent (RGBA, alpha 0 between the strokes), which is
// what lets the same file sit on the light chrome and the dark one without a
// plate behind it.
//
// It does NOT follow the theme, and should not. The cart is green in the phone
// app in both themes; a mark that changes colour with the OS is a different
// mark twice.

defineProps({
  /** Rendered size in px, square. */
  size: { type: Number, default: 20 },
})
</script>

<template>
  <img
    class="mark"
    src="/icons/pwa-192.png"
    alt=""
    aria-hidden="true"
    :width="size"
    :height="size"
    :style="{ width: `${size}px`, height: `${size}px` }"
  />
</template>

<style scoped>
.mark {
  display: block;
  flex: none;
  object-fit: contain;
  /* The mark is decoration beside a wordmark everywhere it appears, so it must
     never be the thing a drag grabs hold of. */
  user-select: none;
  -webkit-user-drag: none;
}
</style>
