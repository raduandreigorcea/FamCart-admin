// One way to turn a PostgREST failure into a thrown Error, because there were
// twenty-three.
//
// Every read in this layer ended with the same line spelled out by hand:
//
//   if (error) throw Object.assign(new Error(`admin_x: ${error.message}`), { code: error.code })
//
// Which worked, and quietly threw away the two fields worth having.
// describeError() in useQuery.ts renders `[message, details, hint]` -- it always
// has -- and neither `details` nor `hint` was ever copied onto the Error, so the
// detail line under every failed panel has been showing the message alone. The
// hint is the half of a Postgres error that tells you what to do about it.
//
// `code` is what makes this more than tidiness: 42501 is what admin_guard()
// raises, and it is the difference between "you are not an admin" and "the
// request failed", which are different screens.

export interface QueryFailure {
  message: string
  code?: string
  details?: string | null
  hint?: string | null
}

export interface WrappedQueryError extends Error {
  code?: string
  details?: string
  hint?: string
}

/**
 * Throw the failure of one named query.
 *
 * `context` is the RPC or table the request was against, and it leads the
 * message because a failure with no subject is unactionable in a dashboard that
 * makes a dozen concurrent requests to two databases.
 */
export function queryError(context: string, error: QueryFailure | null): never {
  const wrapped = new Error(`${context}: ${error?.message ?? 'unknown error'}`) as WrappedQueryError
  if (error?.code) wrapped.code = error.code
  if (error?.details) wrapped.details = error.details
  if (error?.hint) wrapped.hint = error.hint
  throw wrapped
}
