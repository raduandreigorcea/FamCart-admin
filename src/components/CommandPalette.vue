<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from './AppIcon.vue'
import { fetchUsers } from '../lib/data/users'
import { fetchHouseholds } from '../lib/data/households'
import { catalogConfigured, fetchCatalogProducts } from '../lib/data/products'
import UserAvatar from './UserAvatar.vue'
import { shortUserId } from '../lib/format'
import { useModal } from '../lib/useModal'

// Global search. One box over three different things, because an operator
// arrives knowing a name and not knowing which section it belongs to.
//
// Queries all three sources concurrently with allSettled semantics: an
// unreachable catalog project must cost the catalog rows and nothing else, which
// is the same rule FamCart's own suggestions follow and the same one the health
// probes follow. A palette that returns nothing because one of three backends is
// down is worse than one that returns two thirds.

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits<{ (e: 'close'): void }>()

const router = useRouter()
const panel = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const busy = ref(false)
const activeIndex = ref(0)

interface Hit {
  id: string
  group: 'Users' | 'Households' | 'Catalog'
  title: string
  subtitle: string
  to: string
  /**
   * The account this hit is about, where it is about one. Households and
   * catalog rows leave both null and the row renders without a face, which is
   * right: neither of them is a person.
   */
  userId?: string
  imageUrl?: string | null
}

const hits = ref<Hit[]>([])

// Two guards, and they do different jobs. `searchId` stops a slow answer from
// overwriting a fast one; the controller stops the slow request from being made
// at all. Only the first was here, so every keystroke past the debounce left
// three requests running to completion against three databases -- their results
// discarded on arrival, their cost already paid.
let searchId = 0
let controller: AbortController | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

/** Stop whatever is in flight and forget whatever is about to start. */
function cancel() {
  searchId += 1
  controller?.abort()
  controller = null
  if (debounce) {
    clearTimeout(debounce)
    debounce = null
  }
}

async function run(term: string) {
  const id = ++searchId
  const trimmed = term.trim()

  controller?.abort()
  if (trimmed.length < 2) {
    controller = null
    hits.value = []
    busy.value = false
    return
  }

  controller = new AbortController()
  const { signal } = controller

  busy.value = true

  const tasks: Promise<Hit[]>[] = [
    fetchUsers({ query: trimmed, limit: 5 }, signal).then((page) =>
      page.rows.map((row) => ({
        id: `u-${row.user_id}`,
        group: 'Users' as const,
        title: row.display_name,
        subtitle: `${shortUserId(row.user_id)} · ${row.households} household${row.households === 1 ? '' : 's'}`,
        to: `/users/${encodeURIComponent(row.user_id)}`,
        userId: row.user_id,
        imageUrl: row.image_url,
      })),
    ),
    fetchHouseholds({ query: trimmed, limit: 5 }, signal).then((page) =>
      page.rows.map((row) => ({
        id: `h-${row.id}`,
        group: 'Households' as const,
        title: `${row.emoji ? `${row.emoji} ` : ''}${row.name}`,
        subtitle: `${row.members} member${row.members === 1 ? '' : 's'} · ${row.invite_code}`,
        to: `/households/${row.id}`,
      })),
    ),
  ]

  if (catalogConfigured()) {
    tasks.push(
      fetchCatalogProducts({ query: trimmed, limit: 6 }, signal).then((page) =>
        page.rows.map((row) => ({
          id: `p-${row.id}`,
          group: 'Catalog' as const,
          title: row.name,
          subtitle: [row.maker, row.barcode, row.source].filter(Boolean).join(' · '),
          to: `/products/${row.id}`,
        })),
      ),
    )
  }

  const settled = await Promise.allSettled(tasks)
  if (id !== searchId) return

  hits.value = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  activeIndex.value = 0
  busy.value = false
}

watch(query, (value) => {
  if (debounce) clearTimeout(debounce)
  // Long enough to mean "stopped typing" on a keyboard, which is faster than the
  // 300ms FamCart uses for thumbs.
  debounce = setTimeout(() => void run(value), 180)
})

// Focus in, Escape out, Tab confined, page behind locked. See useModal.ts.
useModal({
  open: () => props.open,
  close: () => emit('close'),
  panel,
  initialFocus: () => input.value,
})

watch(
  () => props.open,
  (open) => {
    if (open) return
    // Closing must actually stop the search. Clearing `query` alone fires the
    // watcher above, which schedules ANOTHER run -- of the empty string, but
    // still after an in-flight one that nothing had cancelled.
    cancel()
    query.value = ''
    hits.value = []
    busy.value = false
  },
)

// The palette lives for the life of the shell, so this fires on teardown rather
// than on every close -- but a pending timer holding a closure over an unmounted
// component is the kind of thing that is only ever noticed in a test run.
onBeforeUnmount(cancel)

const grouped = computed(() => {
  const order: Hit['group'][] = ['Users', 'Households', 'Catalog']
  return order
    .map((group) => ({ group, rows: hits.value.filter((h) => h.group === group) }))
    .filter((g) => g.rows.length > 0)
})

/** Flat order, so arrow keys cross group boundaries the way the eye does. */
const flat = computed(() => grouped.value.flatMap((g) => g.rows))

function move(step: number) {
  if (!flat.value.length) return
  activeIndex.value = (activeIndex.value + step + flat.value.length) % flat.value.length
}

function choose(hit?: Hit) {
  const target = hit ?? flat.value[activeIndex.value]
  if (!target) return
  emit('close')
  void router.push(target.to)
}
</script>

<template>
  <Teleport to="body">
  <div v-if="open" class="palette" role="dialog" aria-modal="true" aria-label="Search">
    <div class="palette__scrim" @click="emit('close')"></div>

    <div ref="panel" class="palette__panel" tabindex="-1">
      <div class="palette__field">
        <AppIcon class="palette__icon" name="search" :size="17" />
        <input
          ref="input"
          v-model="query"
          class="palette__input"
          type="text"
          placeholder="Search users, households and catalog products"
          autocomplete="off"
          spellcheck="false"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="choose()"
        />
        <span v-if="busy" class="palette__busy" aria-label="Searching">…</span>
      </div>

      <div class="palette__results">
        <p v-if="query.trim().length < 2" class="palette__hint">
          Type at least two characters. Names, Clerk ids, invite codes and barcodes all match.
        </p>
        <p v-else-if="!busy && flat.length === 0" class="palette__hint">
          Nothing matches “{{ query.trim() }}”.
        </p>

        <div v-for="group in grouped" :key="group.group" class="palette__group">
          <h3 class="palette__group-title u-caption">{{ group.group }}</h3>
          <button
            v-for="hit in group.rows"
            :key="hit.id"
            type="button"
            class="palette__hit"
            :class="{
              'palette__hit--active': flat[activeIndex]?.id === hit.id,
              'palette__hit--person': Boolean(hit.userId),
            }"
            @click="choose(hit)"
            @mouseenter="activeIndex = flat.findIndex((h) => h.id === hit.id)"
          >
            <UserAvatar
              v-if="hit.userId"
              class="palette__hit-face"
              :id="hit.userId"
              :src="hit.imageUrl"
              :name="hit.title"
              :size="26"
            />
            <span class="palette__hit-title u-truncate">{{ hit.title }}</span>
            <span class="palette__hit-sub u-truncate">{{ hit.subtitle }}</span>
          </button>
        </div>
      </div>

      <footer class="palette__foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>esc</kbd> close</span>
      </footer>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.palette {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
}

.palette__scrim {
  position: absolute;
  inset: 0;
  background: var(--backdrop);
}

.palette__panel {
  position: relative;
  width: min(620px, calc(100vw - var(--space-8)));
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-dialog);
  box-shadow: var(--elevation-dialog);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 68vh;
  animation: modal-rise-in var(--transition-base) var(--ease-rise);
}

.palette__field {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

/* The input below sets `outline: none`, and until now put nothing back -- the
   one control in the tool with its focus indicator removed and not replaced.
   It is focused automatically on open, which is why it went unnoticed: Tab away
   to a result and back and there was no way to tell where you were.

   Same shape as FilterBar's: the ring belongs on the field, not on the bare
   input, because the input has no border of its own to draw it around. */
.palette__field:focus-within {
  border-bottom-color: var(--color-primary);
  box-shadow: inset 0 -1px 0 var(--color-primary);
}

.palette__icon {
  color: var(--text-disabled);
  font-size: var(--text-lg);
}

.palette__input {
  flex: 1;
  border: none;
  background: none;
  /* Replaced by the :focus-within treatment on .palette__field above. */
  outline: none;
  font-size: var(--text-md);
  color: var(--text-primary);
}

.palette__input::placeholder {
  color: var(--text-disabled);
}

.palette__busy {
  color: var(--text-disabled);
}

.palette__results {
  overflow-y: auto;
  padding: var(--space-2);
  flex: 1;
}

.palette__hint {
  margin: 0;
  padding: var(--space-4);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-align: center;
}

.palette__group + .palette__group {
  margin-top: var(--space-2);
}

.palette__group-title {
  margin: 0 0 var(--caption-gap) var(--space-2);
}

.palette__hit {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  min-width: 0;
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.palette__hit--active {
  background: var(--color-primary-bg);
}

/* A person's hit carries their face, which means two rows of text beside one
   square rather than a stack. Only a person's: households and catalog rows have
   no face, and giving them the same empty column would indent their titles past
   nothing. */
.palette__hit--person {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  column-gap: var(--space-3);
  row-gap: 1px;
}

.palette__hit-face {
  grid-row: 1 / span 2;
}

.palette__hit--person .palette__hit-title,
.palette__hit--person .palette__hit-sub {
  grid-column: 2;
}

.palette__hit-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
  max-width: 100%;
}

.palette__hit-sub {
  font-size: var(--text-2xs);
  color: var(--text-secondary);
  max-width: 100%;
}

.palette__foot {
  display: flex;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-4);
  border-top: var(--border-width-thin) solid var(--border-light);
  background: var(--bg-surface-alt);
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}

.palette__foot kbd {
  font-family: var(--font-mono);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-xs);
  padding: 0 var(--space-1);
  margin-right: 3px;
  background: var(--bg-surface);
}
</style>
