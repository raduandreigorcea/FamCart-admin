import { fetchUserDetail } from './users'

// The little that a hover card says about a person, asked for once per id.
//
// ONE REQUEST PER PERSON, NOT PER HOVER. A table of fifty ids asks for nothing
// until one is hovered, and then asks for that person once for as long as the
// page is open, however many rows or pages show them. The promise is what is
// kept, so two cards opened at the same moment share one request.
//
// A failed request is forgotten rather than kept, so the next hover asks again
// instead of repeating a transient error until the page is reloaded.

export interface UserCard {
  id: string
  name: string
  imageUrl: string | null
  households: number
  isAdmin: boolean
}

const cards = new Map<string, Promise<UserCard | null>>()

/** Null when the account has no profile in this project any more. */
export function loadUserCard(userId: string): Promise<UserCard | null> {
  const known = cards.get(userId)
  if (known) return known

  // Its own signal, not the hover's: leaving the card must not cancel a request
  // that the next hover, a second later, would only have to make again.
  const pending = fetchUserDetail(userId, new AbortController().signal).then((detail) =>
    detail
      ? {
          id: detail.profile.user_id,
          name: detail.profile.display_name,
          imageUrl: detail.profile.image_url,
          households: detail.profile.households,
          isAdmin: detail.is_admin,
        }
      : null,
  )
  cards.set(userId, pending)
  pending.catch(() => cards.delete(userId))
  return pending
}

/** Tests only: every page load starts with an empty memory. */
export function forgetUserCards(): void {
  cards.clear()
}
