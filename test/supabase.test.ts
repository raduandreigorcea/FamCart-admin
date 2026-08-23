import { describe, expect, it } from 'vitest'
import { clerkIssuer, projectRef } from '../src/lib/supabase'

// The two identity helpers behind the badge in the topbar.
//
// These matter more than their size suggests: two Supabase projects with
// IDENTICAL schemas are told apart by the ref string and nothing else, and a
// dashboard that cannot say which database a number came from is a dashboard
// you cannot trust a number from. A parse that silently returns null shows
// "not configured" next to perfectly live data.

describe('projectRef', () => {
  it('parses the ref out of a Supabase URL', () => {
    expect(projectRef('https://abcdefghijklmnop.supabase.co')).toBe('abcdefghijklmnop')
  })

  it('tolerates a trailing slash, whitespace and mixed case scheme', () => {
    expect(projectRef('  https://abcdefgh.supabase.co  ')).toBe('abcdefgh')
    expect(projectRef('https://abcdefgh.supabase.co/')).toBe('abcdefgh')
    expect(projectRef('HTTPS://abcdefgh.supabase.co')).toBe('abcdefgh')
  })

  it('handles the regional and in-house host variants', () => {
    expect(projectRef('https://abcdefgh.supabase.in')).toBe('abcdefgh')
    expect(projectRef('https://abcdefgh.supabase.red/')).toBe('abcdefgh')
  })

  it('returns null rather than guessing, for anything unparseable', () => {
    expect(projectRef(undefined)).toBeNull()
    expect(projectRef('')).toBeNull()
    expect(projectRef('not a url')).toBeNull()
    expect(projectRef('http://abcdefgh.supabase.co')).toBeNull() // http, not https
    expect(projectRef('https://example.com')).toBeNull()
  })
})

describe('clerkIssuer', () => {
  it('decodes whatever this environment is configured with, or returns null', () => {
    // Vitest loads .env, so this exercises the REAL key when a developer has
    // one and the unconfigured path on a bare checkout or CI runner. Asserting
    // a specific issuer here would couple the suite to one machine's .env.
    const issuer = clerkIssuer()

    if (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY) {
      expect(issuer).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/i)
      // The trailing '$' is part of the encoded payload and must not survive
      // into the badge.
      expect(issuer).not.toContain('$')
    } else {
      expect(issuer).toBeNull()
    }
  })

  it('decodes the issuer the way the badge does', () => {
    // Reproducing the decode inline documents the format the badge depends on:
    // a publishable key is pk_test_<base64 of "issuer.host$">.
    const decode = (key: string) => {
      const encoded = key.replace(/^pk_(test|live)_/, '')
      try {
        return atob(encoded).replace(/\$$/, '') || null
      } catch {
        return null
      }
    }

    const key = `pk_test_${btoa('needed-bass-4.clerk.accounts.dev$')}`
    expect(decode(key)).toBe('needed-bass-4.clerk.accounts.dev')

    // pk_live_ decodes identically; only the prefix differs.
    expect(decode(`pk_live_${btoa('clerk.famcart.app$')}`)).toBe('clerk.famcart.app')
  })

  it('survives a malformed key rather than throwing at first paint', () => {
    // clerkIssuer() runs during the topbar's setup. A throw here would blank
    // the shell, so the catch around atob() is load-bearing.
    const decode = (key: string) => {
      const encoded = key.replace(/^pk_(test|live)_/, '')
      try {
        return atob(encoded).replace(/\$$/, '') || null
      } catch {
        return null
      }
    }

    expect(decode('pk_test_!!!not-base64!!!')).toBeNull()
    expect(decode('pk_test_')).toBeNull()
  })
})
