import { createApp } from 'vue'
import { clerkPlugin } from '@clerk/vue'
// Order matters: the vendored FamCart stylesheet defines the tokens, and
// admin.css reads them. Swap these and every var() in the admin layer resolves
// to nothing on first paint.
import './vendor/style.css'
import './styles/admin.css'
import App from './App.vue'
import router from './router'
import { applyResolvedTheme, loadThemeMode } from './vendor/theme'

// Before mount, so the first paint is already the right colour. Same reason
// FamCart's main.ts does it here, and the same storage key, so a theme chosen in
// one shows up in the other.
applyResolvedTheme(loadThemeMode(localStorage))

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined

if (!publishableKey) {
  // Rendering a broken shell would be worse than saying what is missing. This is
  // the one failure the app cannot recover from at runtime, since without Clerk
  // there is no token and therefore no query.
  const root = document.getElementById('app')
  if (root) {
    root.innerHTML = `
      <div style="max-width:56ch;margin:20vh auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.6">
        <h1 style="font-size:1.25rem;margin:0 0 .5rem">FamCart Admin is not configured</h1>
        <p style="margin:0 0 .75rem;color:#6b7280">
          VITE_CLERK_PUBLISHABLE_KEY is missing, so there is nothing to authenticate with.
          Copy <code>.env.example</code> to <code>.env</code> and fill it in.
        </p>
      </div>`
  }
} else {
  const app = createApp(App)

  // The backstop, not the primary handler.
  //
  // App.vue wraps the router outlet in an ErrorBoundary, which catches render
  // errors and returns false so they stop there. What reaches here is what the
  // boundary cannot see: a throw inside a watcher or lifecycle hook above it, a
  // failure in a component outside the outlet, or an error during the very
  // first mount. Without this, all of those are swallowed by Vue with only a
  // console warning that `no-console` guarantees nobody wrote.
  //
  // It re-throws asynchronously rather than reporting inline. That keeps Vue's
  // own recovery behaviour intact while surfacing the error to
  // window.onerror -- which is where a browser's own reporting, and any future
  // Sentry init, will already be looking. Swallowing it silently is the one
  // option that must not happen.
  app.config.errorHandler = (error, _instance, info) => {
    const wrapped = error instanceof Error ? error : new Error(String(error))
    wrapped.message = `[vue:${info}] ${wrapped.message}`
    setTimeout(() => {
      throw wrapped
    })
  }

  app.use(clerkPlugin, { publishableKey })
  app.use(router)
  app.mount('#app')
}
