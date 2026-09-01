<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useUser } from '@clerk/vue'
import AppIcon from './AppIcon.vue'
import ProjectSwitcher from './ProjectSwitcher.vue'
import { applyResolvedTheme, loadThemeMode, saveThemeMode, type ThemeMode } from '../vendor/theme'
import UserAvatar from './UserAvatar.vue'
import { leafCrumb } from '../lib/breadcrumb'
import { useSignOut } from '../lib/useSignOut'

// Breadcrumbs, the global search trigger, the project switcher, the theme toggle
// and the account menu. Nothing else earns a permanent seat at the top of a tool
// this dense.
//
// The switcher reads the active project from the module rather than from a prop.
// It is the one piece of state up here that several unrelated components need at
// once -- the sidebar, two pages and the data layer itself -- and threading it
// through props would mean four copies of one fact drifting apart.

defineProps({
  /** Wide screens: whether the rail is currently showing icons only. */
  navCollapsed: { type: Boolean, default: false },
})

const emit = defineEmits<{
  (e: 'search'): void
  (e: 'toggle-nav'): void
  (e: 'toggle-collapse'): void
}>()

const route = useRoute()
const leaf = leafCrumb()
const { user } = useUser()

/**
 * Where a crumb goes when you click it: the route's own path, with any
 * parameterised tail cut off. `/households/:householdId` points at
 * `/households`, which is the list the detail page came from.
 *
 * The parameterised routes used to resolve to '' here, so on a detail page the
 * "Households" crumb rendered as inert text -- the one control on the screen
 * that looks exactly like the way back and was not it. The catch-all route is
 * `/:pathMatch(.*)*`, whose tail starts at index 0, so it still yields '' and
 * still renders as text: Not found has no list to go back to.
 */
function listPathOf(path: string): string {
  const tail = path.indexOf('/:')
  return tail === -1 ? path : path.slice(0, tail)
}

// Breadcrumbs from the matched route records rather than from the URL, so a
// detail page can say "Households / The Smiths" and not "households / a uuid".
const crumbs = computed(() => {
  const trail = route.matched
    .filter((record) => record.meta?.crumb)
    .map((record) => ({
      label: String(record.meta.crumb),
      to: listPathOf(record.path),
    }))
  if (leaf.value) trail.push({ label: leaf.value, to: '' })
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

// Which modifier to name in the search hint. `navigator.platform` is deprecated
// and still the only thing Safari and Firefox implement, so it stays as the
// fallback behind userAgentData rather than being replaced by it. Getting this
// wrong costs a wrong keycap in a tooltip, which is why it is not worth a
// user-agent parser.
const isApple = (() => {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? '')
})()

const searchHint = computed(() => (isApple ? '⌘K' : 'Ctrl K'))

onMounted(() => {
  mode.value = loadThemeMode(localStorage)
  media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', onSystemChange)
})

onBeforeUnmount(() => media?.removeEventListener('change', onSystemChange))

const accountOpen = ref(false)

const { signOut, busy: signingOut, error: signOutError } = useSignOut()

async function requestSignOut() {
  await signOut()
  // The menu stays open on failure, because the message is inside it. Closing
  // it on the way out would hide the only explanation the operator gets.
  if (!signOutError.value) accountOpen.value = false
}
</script>

<template>
  <header class="topbar">
    <!-- One rail, two controls, one per breakpoint: wide screens collapse it to
         icons, narrow screens slide it over the page. They sit in the same slot
         because they answer the same question, and only ever one is on screen. -->
    <button
      type="button"
      class="topbar__rail"
      :title="navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
      :aria-expanded="!navCollapsed"
      @click="emit('toggle-collapse')"
    >
      <AppIcon name="panel-left" :size="17" />
      <span class="u-sr">{{ navCollapsed ? 'Expand sidebar' : 'Collapse sidebar' }}</span>
    </button>

    <button type="button" class="topbar__hamburger" title="Sections" @click="emit('toggle-nav')">
      <AppIcon name="menu" :size="18" />
      <span class="u-sr">Toggle sections</span>
    </button>

    <nav class="crumbs" aria-label="Breadcrumb">
      <template v-for="(crumb, index) in crumbs" :key="`${crumb.label}-${index}`">
        <span v-if="index > 0" class="crumbs__sep" aria-hidden="true">/</span>
        <RouterLink v-if="crumb.to && crumb.to !== route.path" :to="crumb.to" class="crumbs__link">
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
    <ProjectSwitcher />

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
        <!-- Clerk's own user rather than a profiles row, so the id it hashes
             for a fallback tint is the same Clerk id every other chip uses. -->
        <UserAvatar :id="user?.id" :src="user?.imageUrl" :name="user?.fullName" :size="26" />
      </button>

      <div v-if="accountOpen" class="account__menu" @click.stop>
        <div class="account__identity">
          <strong class="account__name">{{ user?.fullName || 'Signed in' }}</strong>
          <span class="account__id u-mono">{{ user?.id }}</span>
        </div>
        <button
          type="button"
          class="account__action"
          :disabled="signingOut"
          @click="requestSignOut"
        >
          {{ signingOut ? 'Signing out…' : 'Sign out' }}
        </button>
        <p v-if="signOutError" class="account__error" role="alert">{{ signOutError }}</p>
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
  padding: 0 var(--space-4) 0 var(--space-2);
  background: var(--admin-chrome);
  border-bottom: var(--border-width-thin) solid var(--admin-chrome-edge);
  user-select: none;
}

/* The rail toggle. Wide screens only -- below 900px the rail has no column to
   collapse, so collapsing it would do nothing and the hamburger takes over. */
.topbar__rail {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--admin-control);
  height: var(--admin-control);
  flex: none;
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-secondary);
}

.topbar__rail:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

@media (max-width: 900px) {
  .topbar__rail {
    display: none;
  }
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
    width: var(--admin-control);
    height: var(--admin-control);
    border: none;
    background: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: var(--text-lg);
    color: var(--text-secondary);
  }

  .topbar__hamburger:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
}

/* ── breadcrumbs ─────────────────────────────────────────────────────────── */

.crumbs {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  margin-left: var(--space-1);
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
  height: var(--admin-control);
  padding: 0 var(--space-2) 0 var(--space-3);
  background: var(--bg-surface);
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
  width: var(--admin-control);
  height: var(--admin-control);
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
  margin-left: var(--space-1);
  border-radius: var(--radius-pill);
  border: var(--border-width-thin) solid var(--border-main);
  background: var(--color-primary-bg);
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  display: grid;
  place-items: center;
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

.account__action:hover:not(:disabled) {
  background: var(--danger-bg);
}

.account__action:disabled {
  opacity: 0.6;
  cursor: default;
}

.account__error {
  margin: 0 var(--space-2) var(--space-2);
  font-size: var(--text-2xs);
  color: var(--danger-text);
}
</style>
