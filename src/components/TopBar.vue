<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useClerk, useUser } from '@clerk/vue'
import AppIcon from './AppIcon.vue'
import ProjectSwitcher from './ProjectSwitcher.vue'
import { applyResolvedTheme, loadThemeMode, saveThemeMode, type ThemeMode } from '../vendor/theme'
import { initialOf } from '../lib/format'
import type { AppProject } from '../lib/supabase'

// Breadcrumbs, the global search trigger, the project switcher, the theme toggle
// and the account menu. Nothing else earns a permanent seat at the top of a tool
// this dense.
//
// The switcher reads the active project from the module rather than from a prop.
// It is the one piece of state up here that several unrelated components need at
// once -- the sidebar, two pages and the data layer itself -- and threading it
// through props would mean four copies of one fact drifting apart.

const emit = defineEmits<{
  (e: 'search'): void
  (e: 'toggle-nav'): void
  (e: 'switched', project: AppProject): void
}>()

const route = useRoute()
const { user } = useUser()
const clerk = useClerk()

// Breadcrumbs from the matched route records rather than from the URL, so a
// detail page can say "Households / The Smiths" and not "households / a uuid".
const crumbs = computed(() => {
  const trail = route.matched
    .filter((record) => record.meta?.crumb)
    .map((record) => ({
      label: String(record.meta.crumb),
      to: record.path.includes(':') ? '' : record.path,
    }))
  const leaf = route.meta?.leafCrumb as string | undefined
  if (leaf) trail.push({ label: leaf, to: '' })
  return trail
})

// ── theme ──────────────────────────────────────────────────────────────────
// Same key, same modes, same resolver as FamCart, because theme.ts is vendored
// from it. Setting the theme here and opening the app shows the same choice.
const mode = ref<ThemeMode>('system')
let media: MediaQueryList | null = null

function applyMode(next: ThemeMode) {
  mode.value = next
  saveThemeMode(localStorage, next)
  applyResolvedTheme(next)
}

function cycleTheme() {
  applyMode(mode.value === 'light' ? 'dark' : mode.value === 'dark' ? 'system' : 'light')
}

const themeIcon = computed(() =>
  mode.value === 'light' ? 'sun-medium' : mode.value === 'dark' ? 'moon' : 'sun-moon',
)
const themeTitle = computed(() => `Theme: ${mode.value}. Click to change.`)

function onSystemChange() {
  // Only 'system' follows the OS. A pinned choice must not be overridden when
  // the machine flips at sunset.
  if (mode.value === 'system') applyResolvedTheme('system')
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const searchHint = computed(() => (isMac ? '⌘K' : 'Ctrl K'))

onMounted(() => {
  mode.value = loadThemeMode(localStorage)
  media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', onSystemChange)
})

onBeforeUnmount(() => media?.removeEventListener('change', onSystemChange))

const accountOpen = ref(false)

async function signOut() {
  accountOpen.value = false
  await clerk.value?.signOut()
}
</script>

<template>
  <header class="topbar">
    <button type="button" class="topbar__hamburger" title="Sections" @click="emit('toggle-nav')">
      <AppIcon name="menu" :size="18" />
      <span class="u-sr">Toggle sections</span>
    </button>

    <nav class="crumbs" aria-label="Breadcrumb">
      <template v-for="(crumb, index) in crumbs" :key="`${crumb.label}-${index}`">
        <span v-if="index > 0" class="crumbs__sep" aria-hidden="true">/</span>
        <RouterLink v-if="crumb.to && index < crumbs.length - 1" :to="crumb.to" class="crumbs__link">
          {{ crumb.label }}
        </RouterLink>
        <span v-else class="crumbs__current" aria-current="page">{{ crumb.label }}</span>
      </template>
    </nav>

    <div class="topbar__spacer"></div>

    <button type="button" class="topbar__search" @click="emit('search')">
      <AppIcon name="search" :size="14" />
      <span class="topbar__search-label">Search users, households, products</span>
      <kbd class="topbar__kbd">{{ searchHint }}</kbd>
    </button>

    <!-- Which database every number on screen came from, and how to change it.
         Permanent, because a dashboard that does not say which of two identical
         schemas it is reading is one you cannot trust a figure from. -->
    <ProjectSwitcher @switched="emit('switched', $event)" />

    <button type="button" class="topbar__icon" :title="themeTitle" @click="cycleTheme">
      <AppIcon :name="themeIcon" :size="16" />
      <span class="u-sr">{{ themeTitle }}</span>
    </button>

    <div class="account">
      <button
        type="button"
        class="account__button"
        :aria-expanded="accountOpen"
        @click="accountOpen = !accountOpen"
      >
        <img v-if="user?.imageUrl" class="account__avatar" :src="user.imageUrl" alt="" />
        <span v-else class="account__initial" aria-hidden="true">{{ initialOf(user?.fullName) }}</span>
      </button>

      <div v-if="accountOpen" class="account__menu" @click.stop>
        <div class="account__identity">
          <strong class="account__name">{{ user?.fullName || 'Signed in' }}</strong>
          <span class="account__id u-mono">{{ user?.id }}</span>
        </div>
        <button type="button" class="account__action" @click="signOut">Sign out</button>
      </div>
      <div v-if="accountOpen" class="account__scrim" @click="accountOpen = false"></div>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  grid-area: topbar;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-4) 0 var(--space-3);
  background: var(--admin-chrome);
  border-bottom: var(--border-width-thin) solid var(--admin-chrome-edge);
  user-select: none;
}

.topbar__spacer {
  flex: 1;
}

.topbar__hamburger {
  display: none;
}

@media (max-width: 900px) {
  .topbar__hamburger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: var(--text-lg);
    color: var(--text-secondary);
  }
}

/* ── breadcrumbs ─────────────────────────────────────────────────────────── */

.crumbs {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-sm);
}

.crumbs__sep {
  color: var(--text-disabled);
}

.crumbs__link {
  color: var(--text-secondary);
  text-decoration: none;
}

.crumbs__link:hover {
  color: var(--color-primary);
  text-decoration: underline;
}

.crumbs__current {
  color: var(--text-primary);
  font-weight: var(--weight-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40ch;
}

/* ── search trigger ──────────────────────────────────────────────────────── */

.topbar__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 30px;
  padding: 0 var(--space-2) 0 var(--space-3);
  background: var(--bg-main);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  color: var(--text-disabled);
  font-size: var(--text-xs);
  cursor: pointer;
  min-width: 250px;
  transition: border-color var(--transition-fast) var(--ease-standard);
}

.topbar__search:hover {
  border-color: var(--border-dark);
}

.topbar__search-label {
  flex: 1;
  text-align: left;
}

@media (max-width: 1100px) {
  .topbar__search-label {
    display: none;
  }

  .topbar__search {
    min-width: 0;
  }
}

.topbar__kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-xs);
  padding: 1px 5px;
  color: var(--text-secondary);
}

/* ── icon button ─────────────────────────────────────────────────────────── */

.topbar__icon {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: var(--border-width-thin) solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-secondary);
  font-size: var(--text-md);
}

.topbar__icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* ── account ─────────────────────────────────────────────────────────────── */

.account {
  position: relative;
}

.account__button {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-pill);
  border: var(--border-width-thin) solid var(--border-main);
  background: var(--color-primary-bg);
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  display: grid;
  place-items: center;
}

.account__avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.account__initial {
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  color: var(--color-primary-text);
}

.account__scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.account__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 41;
  min-width: 230px;
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-modal);
  padding: var(--space-2);
  animation: modal-rise-in var(--transition-fast) var(--ease-rise);
}

.account__identity {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2);
  border-bottom: var(--border-width-thin) solid var(--border-light);
  margin-bottom: var(--space-1);
}

.account__name {
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.account__id {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  word-break: break-all;
}

.account__action {
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--danger-text);
  cursor: pointer;
}

.account__action:hover {
  background: var(--danger-bg);
}
</style>
