// The four time ranges every section shares, and the bucket each one implies.
//
// The bucket is derived rather than chosen separately: 24 hours of daily buckets
// is one bar, and 90 days of hourly buckets is 2,160 of them on a chart 600px
// wide. Pairing them here means no screen can pick a combination that draws
// badly, and the pairing is stated once instead of in every view.

export type RangeKey = '24h' | '7d' | '30d' | '90d'
export type Bucket = 'hour' | 'day' | 'week'

export interface TimeRange {
  key: RangeKey
  /** Short label for the segmented control. */
  label: string
  /** What the range means, for the control's title attribute. */
  description: string
  hours: number
  bucket: Bucket
}

export const TIME_RANGES: readonly TimeRange[] = [
  { key: '24h', label: '24h', description: 'The last 24 hours, by hour', hours: 24, bucket: 'hour' },
  { key: '7d', label: '7d', description: 'The last 7 days, by day', hours: 24 * 7, bucket: 'day' },
  { key: '30d', label: '30d', description: 'The last 30 days, by day', hours: 24 * 30, bucket: 'day' },
  { key: '90d', label: '90d', description: 'The last 90 days, by week', hours: 24 * 90, bucket: 'week' },
] as const

export const DEFAULT_RANGE: RangeKey = '7d'

export function resolveRange(key: string | null | undefined): TimeRange {
  return TIME_RANGES.find((r) => r.key === key) ?? TIME_RANGES[1]
}

/** The ISO timestamp the range starts at, which is what the RPCs take. */
export function sinceIso(range: TimeRange, now = Date.now()): string {
  return new Date(now - range.hours * 3600 * 1000).toISOString()
}

/**
 * The equivalent window immediately before this one, for a period-over-period
 * delta. A 7d view compares against the 7 days before it, not against all time.
 */
export function previousSinceIso(range: TimeRange, now = Date.now()): string {
  return new Date(now - 2 * range.hours * 3600 * 1000).toISOString()
}

/** How a bucket's start should be labelled on an axis, given the granularity. */
export function bucketLabel(value: string | Date, bucket: Bucket): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  if (bucket === 'hour') {
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}
