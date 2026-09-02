import { ref, type Ref } from 'vue'
import { fetchIsAdmin } from './data/users'

// Whether the signed-in account may use this tool, asked of whichever project
// is currently selected.
//
// ─── WHY THIS IS NOT JUST AN await INSIDE App.vue ────────────────────────────
//
// It was, and it carried the bug this file exists to prevent. The check is
// fired by TWO independent watchers -- one on the Clerk session, one on the
// project switcher -- and a bare await/assign has no way to tell a stale answer
// from a current one. Switch dev -> prod -> dev quickly and the middle request
// can resolve LAST, leaving the shell describing a project you are no longer
// on.
//
// Nothing leaks when that happens: admin_guard() still refuses every query
// inside Postgres, which is where the real gate is and always was. What breaks
// is the explanation. The shell shows "not authorised" for a project where you
// ARE an admin, or shows itself for one where you are not and every panel then
// fails at once. Both send someone hunting for a permissions problem that does
// not exist, which is the most expensive kind of wrong answer an internal tool
// can give.
//
// The fix is the same monotonic counter useQuery carries, for the same reason.
// It lives here rather than in the component so it can be tested -- a race
// guard nobody can exercise is a comment, not a guarantee.

export type AdminState = 'checking' | 'yes' | 'no' | 'error'

export interface AdminCheck {
  state: Ref<AdminState>
  /** Why the check failed, when state is 'error'. Empty otherwise. */
  error: Ref<string>
  check: () => Promise<void>
}

export function useAdminCheck(ask: () => Promise<boolean> = fetchIsAdmin): AdminCheck {
  const state = ref<AdminState>('checking')
  const error = ref('')

  let currentId = 0

  async function check(): Promise<void> {
    const id = ++currentId
    state.value = 'checking'

    try {
      const isAdmin = await ask()
      if (id !== currentId) return
      state.value = isAdmin ? 'yes' : 'no'
      error.value = ''
    } catch (caught) {
      if (id !== currentId) return
      // A failure here is not "not an admin". It is usually the app database
      // being unreachable or misconfigured, and reporting that as "not
      // authorised" points at the wrong problem entirely.
      state.value = 'error'

      // The detail goes to the console and not to the screen.
      //
      // Whoever needs it is debugging a misconfiguration and has devtools open;
      // whoever must not have it is any FamCart user who reached this dashboard,
      // since it authenticates against the same Clerk instance as the app. A
      // PostgREST failure carries the function it could not resolve and often
      // the schema around it, which is the same reconnaissance the "Not
      // authorised" gate stopped handing out.
      //
      // `error` still exists and is still set, because the retry logic and any
      // future caller may want to distinguish failures. It is simply not
      // rendered.
      // The one console statement in src/, and narrowly disabled rather than
      // loosening the rule. no-console is on because this tool's output is its
      // screens; the exception is that this particular failure has nowhere else
      // to go. It cannot be rendered (see above), there is no error reporter
      // wired into this dashboard, and swallowing it entirely would leave a
      // misconfiguration with no diagnosis at all -- which is worse than the
      // disclosure being avoided.
      // eslint-disable-next-line no-console
      console.error('[admin] the admin check failed', caught)
      error.value = caught instanceof Error ? caught.message : String(caught)
    }
  }

  return { state, error, check }
}
