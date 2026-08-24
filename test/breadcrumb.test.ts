import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { crumbOf, leafCrumb, useLeafCrumb } from '../src/lib/breadcrumb'

// Two defects, and only one of them is about publishing.
//
// The mechanism one: `route.meta.leafCrumb = name` wrote onto the ROUTE
// RECORD's meta, which is one module-level object shared by every visit, so the
// name outlived the view that set it.
//
// The one that was actually on screen for whole seconds: a detail view is
// REUSED across a params change, not remounted, and useQuery deliberately keeps
// the old data while the next request is in flight. So reading the name without
// checking whose it is put one person's name on another person's page for the
// entire round trip.

interface Profile {
  user_id: string
  display_name: string
}

const alice: Profile = { user_id: 'user_alice', display_name: 'Alice' }
const idOf = (p: Profile) => p.user_id
const nameOf = (p: Profile) => p.display_name

describe('crumbOf', () => {
  it('shows the name when the loaded record is the one the route names', () => {
    expect(crumbOf('user_alice', alice, idOf, nameOf)).toBe('Alice')
  })

  it('shows the id while a DIFFERENT record is still loaded', () => {
    // The stale window: route already says bob, useQuery still holds alice.
    expect(crumbOf('user_bob', alice, idOf, nameOf)).toBe('user_bob')
  })

  it('shows the id when nothing is loaded yet', () => {
    expect(crumbOf('user_bob', null, idOf, nameOf)).toBe('user_bob')
    expect(crumbOf('user_bob', undefined, idOf, nameOf)).toBe('user_bob')
  })

  it('falls back to the id rather than rendering an empty crumb', () => {
    // A display_name can be blank; a breadcrumb segment that renders as nothing
    // reads as a broken trail rather than as a missing name.
    expect(crumbOf('user_alice', { user_id: 'user_alice', display_name: '' }, idOf, nameOf)).toBe(
      'user_alice',
    )
  })
})

const leaf = leafCrumb()

/** A stand-in detail view, wired the way the three real ones are. */
function detailView() {
  const id = ref('user_alice')
  const loaded = ref<Profile | null>(null)

  const component = defineComponent({
    setup() {
      useLeafCrumb(() => crumbOf(id.value, loaded.value, idOf, nameOf))
      return () => h('div', id.value)
    },
  })

  return { component, id, loaded }
}

describe('useLeafCrumb', () => {
  it('publishes the id immediately and the name when it arrives', async () => {
    const view = detailView()
    const wrapper = mount(view.component)

    expect(leaf.value).toBe('user_alice')

    view.loaded.value = alice
    await nextTick()
    expect(leaf.value).toBe('Alice')

    wrapper.unmount()
  })

  it('clears on unmount, so no name outlives its view', () => {
    const view = detailView()
    view.loaded.value = alice
    const wrapper = mount(view.component)
    expect(leaf.value).toBe('Alice')

    wrapper.unmount()
    expect(leaf.value).toBeNull()
  })
})
