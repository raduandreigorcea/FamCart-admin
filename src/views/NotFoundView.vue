<script setup lang="ts">
import { useRoute, RouterLink } from 'vue-router'

const route = useRoute()
</script>

<template>
  <div class="page">
    <div class="lost">
      <h1 class="lost__title">No such page</h1>
      <p class="lost__body">
        Nothing in this dashboard answers to <code class="u-mono">{{ route.fullPath }}</code>.
      </p>
      <RouterLink to="/" class="lost__link">Go to the overview</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.lost {
  max-width: 48ch;
  margin: 12vh auto 0;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  align-items: center;
}

.lost__title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.lost__body {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: var(--leading-normal);
}

.lost__link {
  color: var(--color-primary);
  font-weight: var(--weight-semibold);
  text-decoration: none;
  font-size: var(--text-sm);
}

.lost__link:hover {
  text-decoration: underline;
}
</style>
