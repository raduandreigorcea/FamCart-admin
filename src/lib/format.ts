// Formatting, in one place, because a dashboard that renders the same kind of
// value two ways is a dashboard whose numbers look like they disagree.
//
// Everything here is locale-aware through Intl but pinned to one locale on
// purpose: this is an internal tool with one reader, and a table whose thousands
// separator changes with the machine it is opened on is a table you cannot
// compare against a screenshot.

const LOCALE = 'en-GB'

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })
const decimal = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 })
const percent = new Intl.NumberFormat(LOCALE, {
  style: 'percent',
  maximumFractionDigits: 1,
})

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '--'
  return integer.format(value)
}

/**
 * Big numbers shortened for a stat tile, where the exact figure is available on
 * hover and the shape is what matters at a glance. 10,833 becomes 10.8k.
 *
 * Not used in tables: a column of 10.8k / 9.2k / 11k cannot be compared by eye
 * the way a column of right-aligned digits can.
 */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '--'
  const abs = Math.abs(value)
  if (abs < 1000) return integer.format(value)
  if (abs < 1_000_000) return `${decimal.format(value / 1000)}k`
  return `${decimal.format(value / 1_000_000)}M`
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '--'
  return percent.format(value)
}

/** A share of a total, guarding the division by zero that would render NaN%. */
export function formatShare(part: number, total: number): string {
  if (!total) return '--'
  return percent.format(part / total)
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '--'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${decimal.format(value)} ${units[unit]}`
}

const dateTime = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const dateOnly = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

const timeOnly = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' })

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const date = toDate(value)
  return date ? dateTime.format(date) : '--'
}

export function formatDate(value: string | Date | null | undefined): string {
  const date = toDate(value)
  return date ? dateOnly.format(date) : '--'
}

export function formatTime(value: string | Date | null | undefined): string {
  const date = toDate(value)
  return date ? timeOnly.format(date) : '--'
}

/**
 * "3 hours ago". Rendered next to the absolute timestamp rather than instead of
 * it: relative time is how you read a feed, absolute time is how you correlate
 * one against a log, and a dashboard needs both.
 *
 * Deliberately not live-updating. A ticking clock on forty table rows is forty
 * timers and a re-render a second, to move a number that nobody is watching.
 */
export function formatRelative(value: string | Date | null | undefined, now = Date.now()): string {
  const date = toDate(value)
  if (!date) return 'never'
  const seconds = Math.round((now - date.getTime()) / 1000)
  const future = seconds < 0
  const abs = Math.abs(seconds)

  const pick = (): [number, Intl.RelativeTimeFormatUnit] => {
    if (abs < 45) return [abs, 'second']
    if (abs < 3600) return [Math.round(abs / 60), 'minute']
    if (abs < 86_400) return [Math.round(abs / 3600), 'hour']
    if (abs < 2_592_000) return [Math.round(abs / 86_400), 'day']
    if (abs < 31_536_000) return [Math.round(abs / 2_592_000), 'month']
    return [Math.round(abs / 31_536_000), 'year']
  }

  const [amount, unit] = pick()
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' })
  return rtf.format(future ? amount : -amount, unit)
}

/** Milliseconds, for the latency readouts on the health page. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '--'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${decimal.format(ms / 1000)} s`
  return `${decimal.format(ms / 60_000)} min`
}

/**
 * A Clerk user id, shortened for a table cell. The prefix is constant and the
 * tail is what distinguishes one account from another, so the tail is what a
 * truncation has to keep.
 */
export function shortUserId(userId: string | null | undefined): string {
  if (!userId) return '--'
  if (userId.length <= 14) return userId
  return `${userId.slice(0, 5)}…${userId.slice(-6)}`
}

/** An event kind like `invite_code_failed` as "Invite code failed". */
export function humanizeKind(kind: string | null | undefined): string {
  if (!kind) return '--'
  const spaced = kind.replace(/[_.]/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function initialOf(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim()
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?'
}
