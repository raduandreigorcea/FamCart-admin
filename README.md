# FamCart Admin

An internal desktop dashboard over FamCart's households, catalog and ingestion
pipeline. One reader, one screen size, no public audience.

## What it is for

Answering questions about live data that the app itself cannot answer, because
the app deliberately shows each household only its own rows: how many households
exist and how active they are, which accounts contribute products, what the
imported catalog actually contains, whether the three Supabase projects are
answering, and what the audit trail recorded.

It is **mostly a read-only tool**. Everything it can change, it changes through a
guarded RPC, and there are seven:

| Write | Where | Reversible |
|---|---|---|
| Grant and revoke admin access | Access | yes, by the opposite action |
| Delete and restore a household | Household detail, Trash | yes, soft delete |
| Ban and unban an account | User detail | yes, by the opposite action |
| Record, clear or bulk-approve a review verdict | Review | yes, and unconfirmed for that reason |

Every one but the last asks for confirmation first. The review verdicts do not,
deliberately: confirming four hundred approvals one at a time makes that screen
useless, and unlike a deletion a verdict is an upsert with Undo one click away.
The bulk approve is confirmed, because that one is not row-by-row reversible.

## What enforces the rules

Not this bundle. Every cross-household read goes through a `security definer`
RPC in FamCart's `008_admin.sql`, and each one calls `admin_guard()` before it
returns a row. The gate in `App.vue` decides what to *render*; the database
decides what to *answer*. An account that is not in `public.admin_users` gets a
sentence here and a `42501` from Postgres either way.

That is why the keys this tool ships are the same publishable keys FamCart's own
client ships, and why there is no service-role key anywhere in it. If a panel
appears to need one, the answer is another RPC over there, not a secret in a
browser.

## Running it

```bash
npm install
cp .env.example .env   # then fill it in
npm run dev            # http://localhost:5174
```

`.env.example` is the reference for configuration and explains each variable and
why it is optional or not. Nothing here repeats it.

```bash
npm run typecheck   # vue-tsc, strict, and it covers test/ too
npm run lint
npm test
npm run build
```

## Where the explanations live

Next to the code. This repository leans on long comments at the point of use
rather than on documents that drift from it, so the reason behind a decision is
in the file that made it:

| Question | File |
|---|---|
| Why a metric can say "unavailable" instead of returning a number | `src/lib/data/types.ts` |
| Why the catalog aggregate is computed in the browser, and when to stop | `src/lib/data/products.ts` |
| Why there is no cache, and what Refresh promises | `src/lib/useQuery.ts` |
| Why a stale chunk reloads the page after a deploy | `src/router/index.ts` |
| Why a verdict does nothing until the next importer run | `src/views/ReviewView.vue` |
| Which Supabase project holds what, and the Clerk instance | `../CLAUDE.md` |
