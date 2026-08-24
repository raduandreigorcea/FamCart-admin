import { ref } from 'vue'
import { useClerk } from '@clerk/vue'

// Signing out, with the two ways it can fail made visible.
//
// Both call sites were `await clerk.value?.signOut()`, one expression carrying
// two silent failures:
//
//   - `clerk.value` is undefined until Clerk finishes loading, and the optional
//     chain turns that into a no-op. The button does nothing, says nothing, and
//     looks identical to a button that is broken.
//   - a rejected signOut() escapes an inline template handler as an unhandled
//     rejection. Same symptom.
//
// Neither is exotic on the screens that need this most. The Not authorised and
// Could not reach the database gates render before anything else has settled,
// and on both of them sign-out is the ONLY way off the page -- an account that
// is not in admin_users cannot navigate anywhere and cannot sign in as someone
// else. A dead end whose one exit fails quietly is a page you leave by clearing
// site data.

export function useSignOut() {
  const clerk = useClerk()
  /** True while a sign-out is in flight, so the button can refuse a second. */
  const busy = ref(false)
  /** Empty unless the last attempt failed. Shown next to the button. */
  const error = ref('')

  async function signOut(): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try {
      const instance = clerk.value
      if (!instance) {
        throw new Error('Clerk has not finished loading. Try again in a moment.')
      }
      await instance.signOut()
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      busy.value = false
    }
  }

  return { signOut, busy, error }
}
