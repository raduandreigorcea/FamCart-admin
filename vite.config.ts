/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Deliberately small. This is an internal desktop tool: no PWA, no service
// worker, no source-map upload, no Capacitor. FamCart's vite config carries all
// of that because it ships to phones; none of it applies to a dashboard that
// only ever opens in a browser on a desk.
//
// Port 5174 rather than Vite's 5173 so `npm run dev` here and `npm run dev` in
// FamCart can be up at the same time, which is the normal way to work on this:
// the app on one port producing rows, the dashboard on another reading them.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    // Same reasoning as FamCart's config: binding every interface is a decision
    // to make per session, not once in a file. There is no dev:host script here
    // because a desktop admin tool has no phone to test on.
    strictPort: true,
  },
  build: {
    // The dashboard is not latency-critical and is read by one person on a fast
    // connection, so the default warning limit only produces noise. Charts and
    // views are lazy-loaded anyway (see src/router).
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Vendor chunks named after what is IN them.
        //
        // Rollup names a shared chunk after whichever module happened to be its
        // entry point, which produced a build listing where the 239 kB chunk was
        // called StateBlock (a component of about eighty lines that happens to
        // import the Supabase client) and the 59 kB one was called
        // _plugin-vue_export-helper. Nothing about that listing told you that
        // half the bundle is one database client, which is the single most
        // useful fact in it.
        //
        // This is naming, not shrinking. The same bytes ship either way -- every
        // view needs the Supabase client, so it was never going to be deferred
        // -- but "supabase 239 kB" is a number somebody can act on and
        // "StateBlock 239 kB" is a number that looks like a mistake in a
        // component.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('@supabase')) return 'supabase'
          if (id.includes('@clerk')) return 'clerk'
          return undefined
        },
      },
    },
  },
  test: {
    // happy-dom rather than jsdom: @vue/test-utils needs a DOM to mount into,
    // and happy-dom is the lighter of the two for a suite this size. Without
    // this line Vitest defaults to the `node` environment, where `document` does
    // not exist and every component test fails on mount with an error that does
    // not mention the environment at all.
    environment: 'happy-dom',
    // Tests live in test/, never beside the source. tsconfig.json already
    // includes test/**/*.ts, so they typecheck under the same strict flags as
    // src/ -- which is the point: a test that does not typecheck is not
    // testing the contract it claims to.
    include: ['test/**/*.test.ts'],
    // The dashboard pins one locale and one timezone in src/lib/format.ts on
    // purpose (see the comment there). Pinning TZ here means a date assertion
    // means the same thing on this machine and on a CI runner in another
    // offset, rather than passing in one place and failing in the other.
    env: { TZ: 'UTC' },
  },
})
