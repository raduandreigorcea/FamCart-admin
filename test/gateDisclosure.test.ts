import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// What the gate screens are allowed to tell somebody who is not an admin.
//
// This dashboard authenticates against the SAME Clerk instance as the consumer
// app, so anybody with a FamCart account who finds the URL gets past sign-in and
// lands on "Not authorised". That screen used to name public.admin_users and
// print a ready-to-run insert seeding the reader's own Clerk id as an owner.
//
// It was never an escalation anybody could perform: admin_users has RLS, a
// signed-in account cannot insert into it, and the app repo's pgTAP suite
// asserts exactly that. The problem was the audience. A statement that only
// works with a service-role key is not a vulnerability, but printing it to every
// user of the product is free reconnaissance for the day one leaks.
//
// A grep rather than a mounted component on purpose. Mounting App.vue means
// standing up Clerk, the router, the Supabase bridge and the admin check, and
// the property worth holding is not "this renders" -- it is that the string
// never comes back, in any branch, however the screen is later restructured.

const app = readFileSync('src/App.vue', 'utf8')

/** Everything before <style>, since a selector named for a table is not a leak. */
const markup = app.slice(0, app.indexOf('<style'))

/**
 * The comments explaining all this name the table on purpose; the markup must
 * not. All three comment syntaxes, because the script block uses two of them and
 * a stripper that missed one would fail on prose rather than on a leak.
 */
const withoutComments = markup
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

describe('what the gate tells a non-admin', () => {
  it('does not name the table that decides access', () => {
    expect(withoutComments).not.toMatch(/admin_users/)
  })

  it('does not print SQL', () => {
    // `insert into`, `grant`, `on conflict` -- any of them on this screen is a
    // recipe rather than an explanation.
    expect(withoutComments.toLowerCase()).not.toMatch(/insert\s+into/)
    expect(withoutComments.toLowerCase()).not.toMatch(/on\s+conflict/)
  })

  it('does not put the reader’s own Clerk id into a statement they could reuse', () => {
    // The id itself is theirs and appears in the "signed in as" line, which is
    // fine. What must not come back is it being interpolated into something
    // shaped like a command.
    const risky = /(insert|update|grant|values)[^<]{0,80}user\?\.id/i
    expect(withoutComments).not.toMatch(risky)
  })

  // The screen still has to be useful, or the next person to read it will helpfully
  // paste the instructions back in.
  it('still says how to actually get access', () => {
    expect(markup).toMatch(/Access page/)
  })

  // The other gate a non-admin can reach. It rendered the raw admin-check
  // failure, and a PostgREST error names the function it could not resolve and
  // often the schema around it. Same audience, same argument.
  it('does not render the raw admin-check failure', () => {
    expect(withoutComments).not.toMatch(/\{\{\s*adminError\s*\}\}/)
  })

  it('sends that failure somewhere it can still be read', () => {
    const check = readFileSync('src/lib/useAdminCheck.ts', 'utf8')
    expect(check).toMatch(/console\.error/)
  })
})
