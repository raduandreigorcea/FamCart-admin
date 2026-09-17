<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import HoverCard from './HoverCard.vue'
import UserAvatar from './UserAvatar.vue'
import { loadUserCard, type UserCard } from '../lib/data/userCard'
import { formatCount, shortUserId } from '../lib/format'

// A Clerk id, with the person behind it on hover: their photo, their name, how
// many households they are in, and a way to their page.
//
// `user_3D7fKKF1I9xyLOo7JxtSKW5N3WE` is not somebody a reader recognises. Where
// a row already names the person this only confirms it; where it does not --
// UserChip for an actor with no name -- it is the only way to find out who.
//
// Nothing is asked for until the first hover, and each person only once while
// the page is open (see loadUserCard).

const props = defineProps({
  id: { type: String, required: true },
  /** Shown instead of the short id, e.g. a copy button that already shows it. */
  wraps: { type: Boolean, default: false },
})

const state = ref<'idle' | 'loading' | 'ready' | 'missing' | 'failed'>('idle')
const person = ref<UserCard | null>(null)
const short = computed(() => shortUserId(props.id))
const to = computed(() => `/users/${encodeURIComponent(props.id)}`)

async function load() {
  if (state.value === 'loading' || state.value === 'ready' || state.value === 'missing') return
  state.value = 'loading'
  try {
    person.value = await loadUserCard(props.id)
    state.value = person.value ? 'ready' : 'missing'
  } catch {
    state.value = 'failed'
  }
}
</script>

<template>
  <HoverCard :focusable="!wraps" interactive @open="load">
    <slot>
      <span class="id u-mono">{{ short }}</span>
    </slot>
    <template #card>
      <div v-if="state === 'ready' && person" class="person">
        <UserAvatar :id="person.id" :src="person.imageUrl" :name="person.name" :size="36" />
        <div class="person__text">
          <p class="person__name">{{ person.name }}</p>
          <p class="person__meta">
            {{ formatCount(person.households) }} {{ person.households === 1 ? 'household' : 'households' }}
            <template v-if="person.isAdmin"> · admin</template>
          </p>
          <RouterLink :to="to" class="person__link">Open profile</RouterLink>
        </div>
      </div>
      <p v-else-if="state === 'missing'" class="muted">No profile for this account in this project.</p>
      <p v-else-if="state === 'failed'" class="muted">Could not load this person.</p>
      <p v-else class="muted">Loading…</p>
      <p class="full u-mono">{{ id }}</p>
    </template>
  </HoverCard>
</template>

<style scoped>
.id {
  font-size: var(--text-xs);
}

.person {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.person__text {
  min-width: 0;
}

.person__name {
  margin: 0;
  font-weight: var(--weight-semibold);
}

.person__meta {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.person__link {
  font-size: var(--text-xs);
  color: var(--color-primary);
}

.muted {
  margin: 0;
  color: var(--text-secondary);
}

/* The whole id, for the rare time it is needed: selectable, not a headline. */
.full {
  margin: var(--space-2) 0 0;
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  word-break: break-all;
}
</style>
