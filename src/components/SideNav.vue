<script setup lang="ts">
import { RouterLink } from 'vue-router'
import AppIcon from './AppIcon.vue'

// The sidebar, and the section order is an argument rather than an alphabet.
//
// Overview first because it is where you land. Then the three nouns the system
// is made of, in the order they depend on each other: users belong to
// households, households consume products. Then the two things that ACT on
// products -- the pipeline that fills the catalog and the searches that read it.
// Health last, because it is where you go when one of the others looked wrong.

defineProps({
  collapsed: { type: Boolean, default: false },
  /** Narrow screens only: whether the overlay rail is showing. */
  open: { type: Boolean, default: false },
  targetLabel: { type: String, default: '' },
  targetKind: { type: String, default: 'unknown' },
})

interface NavItem {
  to: string
  label: string
  icon: string
  /** Why this section exists, shown as a tooltip and when collapsed. */
  title: string
}

const groups: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Monitor',
    items: [
      { to: '/', label: 'Overview', icon: 'layout-grid', title: 'System totals, activity and what just happened' },
    ],
  },
  {
    heading: 'People',
    items: [
      { to: '/users', label: 'Users', icon: 'users-round', title: 'Every account, what it belongs to and what it does' },
      { to: '/households', label: 'Households', icon: 'house', title: 'Groups, rosters, lists and buying patterns' },
    ],
  },
  {
    heading: 'Catalog',
    items: [
      { to: '/products', label: 'Products', icon: 'package-search', title: 'The catalog project and the app database, side by side' },
      { to: '/pipeline', label: 'Pipeline', icon: 'workflow', title: 'Ingestion runs, source health and what the importer left behind' },
      { to: '/search', label: 'Search', icon: 'search', title: 'What the catalog served, and what it missed' },
    ],
  },
  {
    heading: 'Operate',
    items: [
      { to: '/health', label: 'Health', icon: 'activity', title: 'Reachability, database condition and the audit trail' },
      { to: '/access', label: 'Access', icon: 'key-round', title: 'Who can use this dashboard' },
    ],
  },
]
</script>

<template>
  <nav class="nav" :class="{ 'nav--collapsed': collapsed, 'nav--open': open }" aria-label="Sections">
    <div v-for="group in groups" :key="group.heading" class="nav__group">
      <h2 v-if="!collapsed || open" class="nav__heading">{{ group.heading }}</h2>
      <RouterLink
        v-for="item in group.items"
        :key="item.to"
        :to="item.to"
        class="nav__item"
        :title="collapsed ? item.label : item.title"
      >
        <AppIcon class="nav__glyph" :name="item.icon" :size="17" />
        <span v-if="!collapsed || open" class="nav__label">{{ item.label }}</span>
      </RouterLink>
    </div>

    <!-- The target, pinned to the bottom of the rail.
         It is repeated from the topbar on purpose. Which database you are
         reading is the one fact that changes what every number on screen means,
         and it should be impossible to have this tool open without it in view. -->
    <div class="nav__target" :class="`nav__target--${targetKind}`">
      <template v-if="collapsed && !open">
        <span class="nav__target-dot" :title="targetLabel" aria-hidden="true"></span>
        <span class="u-sr">{{ targetLabel }}</span>
      </template>
      <template v-else>
        <span class="nav__target-label">Reading</span>
        <span class="nav__target-name u-mono">{{ targetLabel }}</span>
      </template>
    </div>
  </nav>
</template>

<style scoped>
.nav {
  grid-area: nav;
  background: var(--admin-chrome);
  border-right: var(--border-width-thin) solid var(--admin-chrome-edge);
  padding: var(--space-3) var(--space-2) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  overflow-y: auto;
  user-select: none;
}

/* Below 900px the rail has no grid column (see admin.css), so it stops being a
   column and becomes an overlay instead of disappearing.

   It used to be `display: none`, which meant a narrow window had NO navigation at
   all: the hamburger toggled `collapsed`, and collapsing something already hidden
   does nothing. There was no way to reach another section without editing the URL. */
@media (max-width: 900px) {
  .nav {
    position: fixed;
    top: var(--admin-topbar);
    bottom: 0;
    left: 0;
    width: var(--admin-sidebar);
    z-index: 30;
    transform: translateX(-100%);
    transition: transform var(--transition-base) var(--ease-rise);
    box-shadow: var(--elevation-modal);
  }

  /* Never the icon-only rail on an overlay: there is room for the labels and no
     reason to make someone guess an icon on the layout where icons are smallest. */
  .nav--collapsed {
    width: var(--admin-sidebar);
  }

  .nav--collapsed .nav__item {
    justify-content: flex-start;
    padding: 0 var(--space-3);
  }

  .nav--open {
    transform: translateX(0);
  }
}

@media (max-width: 900px) and (prefers-reduced-motion: reduce) {
  .nav {
    transition: none;
  }
}

.nav__group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.nav__heading {
  margin: 0 0 var(--space-1) var(--space-3);
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-disabled);
}

.nav__item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-3);
  height: 34px;
  border-radius: var(--radius-sm);
  text-decoration: none;
  color: var(--text-secondary);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  transition: background var(--transition-fast) var(--ease-standard),
              color var(--transition-fast) var(--ease-standard);
}

.nav--collapsed .nav__item {
  justify-content: center;
  padding: 0;
}

.nav__item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* The active rule is a left bar rather than a filled pill: at this row height a
   filled block reads as a button and the sidebar starts looking like a toolbar. */
.nav__item.router-link-exact-active {
  background: var(--color-primary-bg);
  color: var(--color-primary-text);
  font-weight: var(--weight-semibold);
  box-shadow: inset 2px 0 0 var(--color-primary);
}

.nav__glyph {
  width: 18px;
  flex: none;
}

.nav__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav__target {
  margin-top: auto;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  border: var(--border-width-thin) solid var(--border-main);
  background: var(--bg-main);
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: var(--text-2xs);
}

.nav--collapsed .nav__target {
  align-items: center;
  padding: var(--space-2);
}

.nav__target-label {
  color: var(--text-disabled);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: var(--weight-bold);
}

.nav__target-name {
  color: var(--text-primary);
  font-weight: var(--weight-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav__target-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--text-disabled);
}

/* Production is marked, development is not. The asymmetry is deliberate: you
   need to be told when a mistake is expensive, not when it is cheap. */
.nav__target--production {
  border-color: var(--danger-border);
  background: var(--danger-bg);
}

.nav__target--production .nav__target-name,
.nav__target--production .nav__target-label {
  color: var(--danger-text);
}

.nav__target--production .nav__target-dot {
  background: var(--danger-text);
}
</style>
