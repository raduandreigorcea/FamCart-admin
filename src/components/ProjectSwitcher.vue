<script setup lang="ts">
import { computed, ref } from 'vue'
import ConfirmDialog from './ConfirmDialog.vue'
import AppIcon from './AppIcon.vue'
import {
  activeProject,
  allTargets,
  appTarget,
  canSwitchProjects,
  catalogTarget,
  clerkIssuer,
  setActiveProject,
  type AppProject,
} from '../lib/supabase'

// Which database the dashboard is reading, and how to change it.
//
// The badge is always present, whether or not there is anything to switch to,
// because its first job is to say where the numbers came from. It only becomes a
// menu when a second project is configured.
//
// ─── THE ASYMMETRY ───────────────────────────────────────────────────────────
//
// Switching to development happens on the click. Switching to production asks
// first. That is not inconsistency, it is the same rule the sidebar already
// follows: you need to be told when a mistake is expensive, not when it is
// cheap. Development is the recoverable case and interrupting it would train the
// habit of dismissing the dialog.


const target = appTarget
const catalog = catalogTarget()
const issuer = clerkIssuer()
const switchable = canSwitchProjects()
const targets = allTargets()

const open = ref(false)
const pendingProduction = ref(false)

const tooltip = computed(() =>
  [
    `App database: ${target.value.label}`,
    `Catalog: ${catalog.configured ? catalog.label : 'not configured'} (shared, does not switch)`,
    `Clerk: ${issuer ?? 'unknown'}`,
    switchable ? 'Click to switch project' : 'Only one app project is configured',
  ].join('\n'),
)

function choose(project: AppProject) {
  if (project === activeProject.value) {
    open.value = false
    return
  }
  if (project === 'production') {
    // Held until confirmed. The menu closes so the dialog is the only thing on
    // screen making a decision.
    open.value = false
    pendingProduction.value = true
    return
  }
  apply(project)
}

function apply(project: AppProject) {
  // No event goes out. `activeProject` is a computed everything downstream
  // already watches -- App.vue re-runs the admin check and remounts the view
  // off it -- so an emit alongside it would be a second channel carrying the
  // same fact, and the one more likely to be wired up wrong.
  setActiveProject(project)
  open.value = false
  pendingProduction.value = false
}
</script>

<template>
  <div class="switcher">
    <button
      type="button"
      class="badge"
      :class="[`badge--${target.kind}`, { 'badge--static': !switchable }]"
      :title="tooltip"
      :aria-haspopup="switchable ? 'menu' : undefined"
      :aria-expanded="switchable ? open : undefined"
      :disabled="!switchable"
      @click="open = !open"
    >
      <span class="badge__dot" aria-hidden="true"></span>
      <span class="badge__name u-mono">{{ target.label }}</span>
      <span v-if="target.kind === 'production'" class="badge__flag">live</span>
      <AppIcon v-if="switchable" class="badge__caret" name="chevron-down" :size="12" />
    </button>

    <template v-if="open">
      <div class="switcher__scrim" @click="open = false"></div>
      <div class="menu" role="menu">
        <p class="menu__heading u-caption">App database</p>

        <button
          v-for="option in targets"
          :key="option.project"
          type="button"
          role="menuitemradio"
          class="menu__item"
          :class="{ 'menu__item--on': option.project === activeProject }"
          :aria-checked="option.project === activeProject"
          :disabled="!option.configured"
          @click="choose(option.project)"
        >
          <span class="menu__dot" :class="`menu__dot--${option.kind}`" aria-hidden="true"></span>
          <span class="menu__body">
            <span class="menu__name u-mono">{{ option.label }}</span>
            <span class="menu__meta">
              {{
                !option.configured
                  ? 'No credentials in .env'
                  : option.kind === 'production'
                    ? 'Real households, lists and history'
                    : 'The same schema, development data'
              }}
            </span>
          </span>
          <AppIcon v-if="option.project === activeProject" class="menu__tick" name="check" :size="14" />
        </button>

        <!-- Said here rather than discovered later. Switching changes every
             household number on screen and no product number, and that is
             surprising unless you know the catalog is one shared project. -->
        <p class="menu__note">
          The catalog project is shared and does not switch. Product and pipeline
          figures stay the same.
        </p>
      </div>
    </template>

    <ConfirmDialog
      :open="pendingProduction"
      title="Read the production database?"
      message="Every household, list and purchase you see next belongs to a real person. This dashboard is read-only apart from granting and revoking admin access, so nothing here can change their data, but it can show all of it."
      confirm-label="Switch to production"
      tone="danger"
      @cancel="pendingProduction = false"
      @confirm="apply('production')"
    />
  </div>
</template>

<style scoped>
.switcher {
  position: relative;
}

.badge {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 26px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  border: var(--border-width-thin) solid var(--border-main);
  background: var(--bg-main);
  font-size: var(--text-2xs);
  font-family: inherit;
  cursor: pointer;
  transition: border-color var(--transition-fast) var(--ease-standard);
}

.badge:hover:not(:disabled) {
  border-color: var(--border-dark);
}

/* Not a button when there is nothing to choose. Keeps the cursor honest. */
.badge--static {
  cursor: help;
}

.badge__dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-pill);
  background: var(--status-good);
  flex: none;
}

.badge__name {
  color: var(--text-secondary);
  font-weight: var(--weight-semibold);
}

.badge__caret {
  color: var(--text-disabled);
  font-size: 9px;
}

/* Production is marked, development is not. The asymmetry is the point: you
   need to be told when a mistake is expensive, not when it is cheap. */
.badge--production {
  border-color: var(--danger-border);
  background: var(--danger-bg);
}

.badge--production .badge__dot {
  background: var(--danger-main);
}

.badge--production .badge__name,
.badge--production .badge__caret {
  color: var(--danger-text);
}

.badge__flag {
  text-transform: uppercase;
  letter-spacing: var(--tracking-caption);
  font-weight: var(--weight-bold);
  color: var(--danger-text);
}

@media (max-width: 800px) {
  .badge__name {
    display: none;
  }
}

/* ── menu ────────────────────────────────────────────────────────────────── */

.switcher__scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 41;
  width: 280px;
  padding: var(--space-2);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-modal);
  animation: modal-rise-in var(--transition-fast) var(--ease-rise);
}

.menu__heading {
  margin: 0 0 var(--space-1) var(--space-2);
}

.menu__item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  font: inherit;
}

/* The two projects are a choice between two databases, not a list of related
   commands, so they are set apart rather than stacked flush. Sitting edge to
   edge they read as one block and the hover highlight ran from one straight
   into the other. */
.menu__item + .menu__item {
  margin-top: var(--space-2);
}

.menu__item:hover:not(:disabled) {
  background: var(--bg-hover);
}

.menu__item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.menu__item--on {
  background: var(--color-primary-bg);
}

.menu__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  flex: none;
  margin-top: 5px;
  background: var(--status-good);
}

.menu__dot--production {
  background: var(--danger-main);
}

.menu__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: var(--leading-snug);
}

.menu__name {
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.menu__meta {
  font-size: var(--text-2xs);
  color: var(--text-secondary);
}

.menu__tick {
  color: var(--color-primary);
  font-size: var(--text-xs);
  flex: none;
}

.menu__note {
  margin: var(--space-2) 0 0;
  padding: var(--space-2);
  border-top: var(--border-width-thin) solid var(--border-light);
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  line-height: var(--leading-snug);
}
</style>
