<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { useAuth, useUser, SignIn } from '@clerk/vue'
import SideNav from './components/SideNav.vue'
import TopBar from './components/TopBar.vue'
import CommandPalette from './components/CommandPalette.vue'
import StateBlock from './components/StateBlock.vue'
import ErrorBoundary from './components/ErrorBoundary.vue'
import ProjectSwitcher from './components/ProjectSwitcher.vue'
import AppIcon from './components/AppIcon.vue'
import { activeProject, appTarget, useSupabaseAuthBridge } from './lib/supabase'
import { useSignOut } from './lib/useSignOut'
import { useAdminCheck } from './lib/useAdminCheck'

// The shell, and the three gates a request has to pass before any panel renders:
// Clerk has to have loaded, somebody has to be signed in, and the database has
// to agree that they are an admin.
//
// The third one is the real one. The first two only decide what to show; the gate
// that matters is enforced in Postgres by admin_guard(), inside every function
// this dashboard calls. What happens here is presentation: a person who is not
// an admin gets a sentence instead of a wall of failed panels.

const { isLoaded, isSignedIn } = useAuth()
const { user } = useUser()

/**
 * The way out.
 *
 * Every screen that can refuse you has to offer this, and the ones below did
 * not. Signing in with an account that is not in admin_users left you on a
 * page with no sign-out, no account switch and no project switch: a dead end
 * you could only leave by clearing site data. Clerk authenticates anyone with
 * a FamCart login, so landing there is normal rather than exceptional, and it
 * is exactly the case that needs an exit.
 *
 * An exit that can fail silently is not an exit -- see useSignOut.ts.
 */
const { signOut, busy: signingOut, error: signOutError } = useSignOut()

// Installs the token resolver the data layer uses. Done once, here, because the
// data layer is plain functions with no component context of their own -- the
// same split FamCart makes between useSupabase() and getSupabase().
useSupabaseAuthBridge()

// A computed, not a snapshot: the switcher can change it at any moment and the
// gate screens below name the project in their copy.
const target = appTarget

const route = useRoute()
const router = useRouter()

// Two different things, and conflating them is what made the narrow layout
// unusable. `collapsed` is the wide-screen rail shrinking to icons and keeping
// its grid column. `open` is the narrow-screen overlay, where the rail has no
// column at all and slides over the content. The hamburger drives the second;
// the brand button drives the first.
const navCollapsed = ref(false)
const navOpen = ref(false)
const paletteOpen = ref(false)

// The third gate, and the only one that matters. Guarded against a stale answer
// landing last -- see useAdminCheck.ts for the switch sequence that caused it.
const { state: adminState, error: adminError, check: checkAdmin } = useAdminCheck()

function onKeydown(event: KeyboardEvent) {
  const key = event.key.toLowerCase()
  if ((event.metaKey || event.ctrlKey) && key === 'k') {
    event.preventDefault()
    paletteOpen.value = !paletteOpen.value
    return
  }
  if (key === 'escape') {
    if (paletteOpen.value) paletteOpen.value = false
    else if (navOpen.value) navOpen.value = false
  }
  // A bare "/" opens search the way it does in every developer tool, but not
  // while the caret is in a field -- there it is a character.
  if (key === '/' && !paletteOpen.value) {
    const el = document.activeElement
    const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    if (!typing) {
      event.preventDefault()
      paletteOpen.value = true
    }
  }
}

// Waits for Clerk, then asks the database. Watching isSignedIn rather than
// checking once: Clerk resolves asynchronously and the first render always
// happens before it has.
const ready = computed(() => isLoaded.value)

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))

// Re-run the admin check whenever the session changes.
watch(
  () => [isLoaded.value, isSignedIn.value] as const,
  ([loaded, signedIn]) => {
    if (loaded && signedIn) void checkAdmin()
  },
  { immediate: true },
)

// Navigating closes the overlay rail. Leaving it open over the page you just
// asked for is the classic mobile-drawer bug: the tap appears to do nothing.
watch(() => route.fullPath, () => { navOpen.value = false })

// Switching project is not a filter, it is a different database with the same
// schema. Three things have to happen, and none of them is optional:
watch(activeProject, () => {
  // 1. Re-ask. Being an admin on one project says nothing about the other, and
  //    the answer decides whether the shell renders at all.
  void checkAdmin()

  // 2. Leave any detail route. A household uuid or a Clerk id from the database
  //    we just left means nothing in the one we arrived at, so the row would
  //    render its not-found state and read as data loss. The list above it is
  //    the same question asked of the new database, so that is where we go.
  if (Object.keys(route.params).length > 0) {
    void router.replace(`/${route.path.split('/')[1] ?? ''}`)
  }

  // 3. The view itself remounts, via the :key on the RouterView below, which
  //    abandons every in-flight request and reissues it. Without it a slow query
  //    against the old project could resolve after the switch and paint the
  //    wrong database's numbers under the new badge.
})
</script>

<template>
  <!-- Booting: Clerk has not resolved yet. -->
  <div v-if="!ready" class="boot">
    <div class="boot__mark">FamCart Admin</div>
    <StateBlock state="loading" :lines="2" />
  </div>

  <!-- Signed out: Clerk's own component, because an internal tool has no reason
       to maintain a bespoke sign-in form. FamCart has one for brand reasons that
       do not apply here. -->
  <div v-else-if="!isSignedIn" class="gate">
    <div class="gate__intro">
      <h1 class="gate__title">FamCart Admin</h1>
      <p class="gate__copy">
        Sign in with the account that holds admin access. This dashboard reads
        <strong class="u-mono">{{ target.label }}</strong> and is read-only apart from granting
        and revoking access.
      </p>
    </div>
    <SignIn />
  </div>

  <!-- Signed in but the database says no. -->
  <div v-else-if="adminState === 'no'" class="gate">
    <div class="gate__intro">
      <h1 class="gate__title">Not authorised</h1>
      <p class="gate__copy">
        {{ user?.fullName || 'This account' }} is signed in, but is not in
        <strong class="u-mono">public.admin_users</strong> on
        <strong class="u-mono">{{ target.label }}</strong>, so the database refuses every admin query.
      </p>
      <p class="gate__copy">
        An existing admin can grant access from the Access page. If there is no admin yet, seed the
        first row with the service role:
      </p>
      <pre class="gate__code">insert into public.admin_users (user_id, note)
values ('{{ user?.id }}', 'owner')
on conflict (user_id) do nothing;</pre>

      <div class="gate__actions">
        <ProjectSwitcher />
        <button type="button" class="gate__signout" :disabled="signingOut" @click="signOut">
          {{ signingOut ? 'Signing out…' : 'Sign out' }}
        </button>
      </div>
      <p v-if="signOutError" class="gate__signout-error" role="alert">{{ signOutError }}</p>
      <p class="gate__who">
        Signed in as {{ user?.primaryEmailAddress?.emailAddress || user?.fullName || 'this account' }}
      </p>
    </div>
  </div>

  <!-- Signed in, but the check itself failed. -->
  <div v-else-if="adminState === 'error'" class="gate">
    <div class="gate__intro">
      <h1 class="gate__title">Could not reach the database</h1>
      <p class="gate__copy">
        The admin check against <strong class="u-mono">{{ target.label }}</strong> failed. This is a
        configuration or connectivity problem rather than a permissions one.
      </p>
      <pre class="gate__code">{{ adminError }}</pre>
      <button type="button" class="gate__retry" @click="checkAdmin">Try again</button>

      <div class="gate__actions">
        <ProjectSwitcher />
        <button type="button" class="gate__signout" :disabled="signingOut" @click="signOut">
          {{ signingOut ? 'Signing out…' : 'Sign out' }}
        </button>
      </div>
      <p v-if="signOutError" class="gate__signout-error" role="alert">{{ signOutError }}</p>
      <p class="gate__who">
        Signed in as {{ user?.primaryEmailAddress?.emailAddress || user?.fullName || 'this account' }}
      </p>
    </div>
  </div>

  <div v-else-if="adminState === 'checking'" class="boot">
    <div class="boot__mark">FamCart Admin</div>
    <StateBlock state="loading" :lines="2" />
  </div>

  <!-- The tool. -->
  <div v-else class="shell" :class="{ 'shell--collapsed': navCollapsed }">
    <div class="brand">
      <button
        type="button"
        class="brand__toggle"
        :title="navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="navCollapsed = !navCollapsed"
      >
        <AppIcon class="brand__mark" name="panel-left" :size="17" />
        <span v-if="!navCollapsed" class="brand__name">FamCart <span class="brand__sub">Admin</span></span>
      </button>
    </div>

    <TopBar
      @search="paletteOpen = true"
      @toggle-nav="navOpen = !navOpen"
    />

    <SideNav
      :collapsed="navCollapsed"
      :open="navOpen"
      :target-label="target.label"
      :target-kind="target.kind"
    />

    <!-- Only ever visible under the overlay rail, below 900px. -->
    <div v-if="navOpen" class="nav-scrim" @click="navOpen = false"></div>

    <main class="shell__main">
      <!-- Inside the shell rather than around it: a view that throws should
           leave the sidebar, the breadcrumbs and the project switcher usable,
           because they are the way off the broken page. -->
      <ErrorBoundary>
        <!-- Keyed by project so a switch remounts the view. See the watcher
             above for why that is load-bearing rather than tidiness. -->
        <RouterView v-slot="{ Component }">
          <component :is="Component" :key="activeProject" />
        </RouterView>
      </ErrorBoundary>
    </main>

    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" />
  </div>
</template>

<style scoped>
.boot {
  display: grid;
  place-content: center;
  gap: var(--space-3);
  height: 100dvh;
  text-align: center;
}

.boot__mark {
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.gate {
  display: grid;
  place-items: center;
  align-content: center;
  gap: var(--space-6);
  min-height: 100dvh;
  padding: var(--space-8) var(--space-4);
  overflow-y: auto;
}

.gate__intro {
  max-width: 56ch;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  align-items: center;
}

.gate__title {
  margin: 0;
  font-size: var(--text-2xl);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.03em;
  color: var(--text-primary);
}

.gate__copy {
  margin: 0;
  font-size: var(--text-md);
  line-height: var(--leading-normal);
  color: var(--text-secondary);
}

.gate__code {
  margin: 0;
  width: 100%;
  text-align: left;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  overflow-x: auto;
  color: var(--text-primary);
  line-height: var(--leading-snug);
}

/* The escape hatch. A screen that can refuse you must offer a way off it, and
   the switcher is here as well as the sign-out because the commonest refusal is
   being an admin on one project and not the other -- one click, not a re-login. */
.gate__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.gate__who {
  margin: 0;
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}

.gate__signout {
  background: none;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  padding: 0.4rem var(--space-4);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  cursor: pointer;
}

.gate__signout:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.gate__signout:disabled {
  opacity: 0.6;
  cursor: default;
}

.gate__signout-error {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--danger-text);
}

/* Sits under the overlay rail and over the content, below 900px only. */
.nav-scrim {
  position: fixed;
  inset: var(--admin-topbar) 0 0 0;
  background: var(--backdrop);
  z-index: 29;
}

@media (min-width: 901px) {
  .nav-scrim {
    display: none;
  }
}

.gate__retry {
  background: var(--color-primary);
  color: var(--text-inverse);
  border: none;
  border-radius: var(--radius-md);
  padding: 0.55rem var(--space-5);
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  cursor: pointer;
}

/* ── brand cell ──────────────────────────────────────────────────────────── */

.brand {
  grid-area: brand;
  background: var(--admin-chrome);
  border-right: var(--border-width-thin) solid var(--admin-chrome-edge);
  border-bottom: var(--border-width-thin) solid var(--admin-chrome-edge);
  display: flex;
  align-items: center;
  padding: 0 var(--space-2);
}

@media (max-width: 900px) {
  .brand {
    display: none;
  }
}

.brand__toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 34px;
  width: 100%;
  padding: 0 var(--space-2);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-primary);
}

.brand__toggle:hover {
  background: var(--bg-hover);
}

.brand__mark {
  color: var(--color-primary);
  font-size: var(--text-md);
  flex: none;
}

.brand__name {
  font-size: var(--text-base);
  font-weight: var(--weight-extrabold);
  letter-spacing: -0.02em;
  white-space: nowrap;
}

.brand__sub {
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
}
</style>
