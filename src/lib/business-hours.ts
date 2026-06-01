/**
 * Timezone-aware business-hours helpers for SLA calculations.
 *
 * Zero runtime dependencies — timezone math is done with the built-in
 * `Intl.DateTimeFormat` + `timeZone` option (available in every Node/Edge
 * runtime this app targets). No `date-fns-tz`, no extra packages.
 *
 * ---------------------------------------------------------------------------
 * Config shape (stored in `companies.business_hours` jsonb, all keys optional):
 *
 *   {
 *     timezone: "America/New_York",   // IANA zone name
 *     days: {
 *       mon: [9, 17],   // [openHour, closeHour), 24h local clock
 *       tue: [9, 17],
 *       ...
 *       sat: null,      // null / missing / malformed = closed all day
 *       sun: null
 *     }
 *   }
 *
 * Backward-compatibility contract:
 *   A null / undefined / non-object config (or one missing a usable `timezone`)
 *   means "24/7 / always open". In that mode `isWithinBusinessHours` is always
 *   true and `businessMillisElapsed` is a plain wall-clock diff. This preserves
 *   the pre-business-hours SLA behavior for any company that hasn't opted in.
 *
 * Documented simplifications:
 *   - Each open day is a SINGLE CONTIGUOUS window `[open, close)` expressed in
 *     whole local hours. Split shifts (e.g. 9–12 then 13–17, a lunch break)
 *     are NOT modeled — pick the outer envelope if you need to approximate one.
 *   - `open >= close` (including 0/0) is treated as CLOSED. Overnight windows
 *     that wrap past midnight (e.g. [22, 6]) are therefore NOT supported; model
 *     them as 24/7 or split per-day if ever needed.
 *   - Hour granularity is whole hours (minutes within the boundary hour are not
 *     honored). This is intentional: SLA thresholds here are whole-hour
 *     (`sla_critical_hours`), so sub-hour precision would be false precision.
 *   - DST: because the local hour-of-week is derived fresh from the instant via
 *     `Intl` for each probe, DST transitions are handled correctly at the
 *     boundaries we sample. The elapsed-time integration samples hour-by-hour,
 *     so a DST jump shifts at most one sampled hour — acceptable for SLA.
 */

/** Lowercase 3-letter day keys, indexed to match JS `Date.getUTCDay()` /
 *  the `Intl` weekday output (0 = Sunday). */
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
type DayKey = (typeof DAY_KEYS)[number]

interface NormalizedBusinessHours {
  timezone: string
  /** Index 0..6 (Sun..Sat) -> [openHour, closeHour) or null when closed. */
  days: (readonly [number, number] | null)[]
}

/**
 * Validate + normalize an unknown config into a usable shape, or return null
 * when the config means "24/7" (absent / malformed / no timezone).
 *
 * Returning null is the signal callers use to short-circuit to wall-clock
 * behavior — keep that contract stable.
 */
function normalize(businessHours: unknown): NormalizedBusinessHours | null {
  if (!businessHours || typeof businessHours !== 'object') return null

  const raw = businessHours as Record<string, unknown>
  const timezone = raw.timezone
  if (typeof timezone !== 'string' || timezone.trim() === '') return null

  // Reject an unusable IANA zone up front so a typo degrades to 24/7 (safe,
  // backward-compatible) rather than throwing inside the SLA cron.
  if (!isValidTimeZone(timezone)) return null

  const daysRaw =
    raw.days && typeof raw.days === 'object'
      ? (raw.days as Record<string, unknown>)
      : {}

  const days: (readonly [number, number] | null)[] = DAY_KEYS.map((key) =>
    parseWindow(daysRaw[key])
  )

  return { timezone, days }
}

/** Parse one day's value into a validated `[open, close)` window or null. */
function parseWindow(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const open = Number(value[0])
  const close = Number(value[1])
  if (!Number.isFinite(open) || !Number.isFinite(close)) return null
  // Clamp into 0..24 and require a real forward window. open>=close => closed.
  if (open < 0 || open > 24 || close < 0 || close > 24) return null
  if (open >= close) return null
  return [open, close] as const
}

/** True if `tz` is a valid IANA timezone the runtime can format with. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Derive the local weekday (0=Sun..6=Sat) and hour (0..23) at instant `at`
 * in the given IANA timezone, using `Intl` (no extra deps).
 */
function localWeekdayHour(at: Date, timezone: string): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(at)

  let weekdayStr = ''
  let hourStr = ''
  for (const p of parts) {
    if (p.type === 'weekday') weekdayStr = p.value
    else if (p.type === 'hour') hourStr = p.value
  }

  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }
  const day = dayMap[weekdayStr] ?? at.getUTCDay()

  // `hour12: false` can render midnight as "24" in some engines — normalize.
  let hour = parseInt(hourStr, 10)
  if (!Number.isFinite(hour)) hour = 0
  if (hour === 24) hour = 0

  return { day, hour }
}

/**
 * Is instant `at` inside the configured business window?
 *
 * Returns TRUE when the config is null/absent/malformed (24/7 mode), so an
 * unconfigured company behaves exactly as before this feature existed.
 */
export function isWithinBusinessHours(businessHours: unknown, at: Date): boolean {
  const cfg = normalize(businessHours)
  if (!cfg) return true // 24/7

  const { day, hour } = localWeekdayHour(at, cfg.timezone)
  const window = cfg.days[day]
  if (!window) return false // closed that day
  const [open, close] = window
  return hour >= open && hour < close
}

/**
 * Business-time elapsed, in milliseconds, between two instants.
 *
 * With no usable config this is a plain `to - from` wall-clock diff (24/7),
 * preserving prior behavior. With a config, only the milliseconds that fall
 * inside open business hours are counted; nights, closed days and weekends
 * are skipped.
 *
 * Implementation: walk the interval hour-by-hour in UTC and credit each whole
 * hour whose *local* time is within the open window. Hour granularity matches
 * the whole-hour SLA thresholds (see file header). For `from > to` returns 0.
 * For sub-hour leftover at the tail end, the partial hour is credited
 * proportionally if its starting local hour is open.
 */
export function businessMillisElapsed(
  businessHours: unknown,
  from: Date,
  to: Date
): number {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  if (!(toMs > fromMs)) return 0

  const cfg = normalize(businessHours)
  if (!cfg) return toMs - fromMs // 24/7 — plain wall-clock diff

  const HOUR = 3600_000
  let elapsed = 0
  let cursor = fromMs

  while (cursor < toMs) {
    // How much of this step remains before the next whole hour boundary / end.
    const stepEnd = Math.min(cursor + HOUR, toMs)
    const stepMs = stepEnd - cursor

    // Classify the step by the local hour at its START. Steps are <= 1h, so a
    // step lives within a single local clock-hour for crediting purposes.
    const { day, hour } = localWeekdayHour(new Date(cursor), cfg.timezone)
    const window = cfg.days[day]
    if (window) {
      const [open, close] = window
      if (hour >= open && hour < close) {
        elapsed += stepMs
      }
    }

    cursor = stepEnd
  }

  return elapsed
}
