// Unit tests for `src/lib/business-hours.ts`.
//
// Pure, no DB, no mocks. We pin instants as explicit UTC ISO strings and assert
// the timezone-aware classification/integration. Hours config is the documented
// jsonb shape: { timezone, days: { mon:[9,17], ..., sun: null } }.

import { describe, it, expect } from 'vitest'

import {
  isWithinBusinessHours,
  businessMillisElapsed,
} from '@/lib/business-hours'

const HOUR = 3600_000

// A standard Mon–Fri 9am–5pm desk in US Eastern time.
const NY_9_5 = {
  timezone: 'America/New_York',
  days: {
    mon: [9, 17],
    tue: [9, 17],
    wed: [9, 17],
    thu: [9, 17],
    fri: [9, 17],
    sat: null,
    sun: null,
  },
}

describe('isWithinBusinessHours — 24/7 fallback (backward compat)', () => {
  it('returns true when config is null (unconfigured = always open)', () => {
    expect(isWithinBusinessHours(null, new Date('2026-06-06T03:00:00Z'))).toBe(true)
  })

  it('returns true when config is undefined', () => {
    expect(isWithinBusinessHours(undefined, new Date('2026-06-06T03:00:00Z'))).toBe(true)
  })

  it('returns true for a non-object / garbage config', () => {
    expect(isWithinBusinessHours('nonsense', new Date())).toBe(true)
    expect(isWithinBusinessHours(42, new Date())).toBe(true)
    expect(isWithinBusinessHours([], new Date())).toBe(true)
  })

  it('falls back to 24/7 when timezone is missing or empty', () => {
    expect(isWithinBusinessHours({ days: { mon: [9, 17] } }, new Date())).toBe(true)
    expect(isWithinBusinessHours({ timezone: '   ', days: {} }, new Date())).toBe(true)
  })

  it('falls back to 24/7 when timezone is not a real IANA zone', () => {
    expect(
      isWithinBusinessHours({ timezone: 'Mars/Olympus_Mons', days: { mon: [9, 17] } }, new Date())
    ).toBe(true)
  })
})

describe('isWithinBusinessHours — inside / outside the daily window', () => {
  // 2026-06-03 is a Wednesday.
  it('is true at midday on a weekday', () => {
    // 14:00Z == 10:00 EDT (UTC-4 in June) -> within 9–17.
    expect(isWithinBusinessHours(NY_9_5, new Date('2026-06-03T14:00:00Z'))).toBe(true)
  })

  it('is false before opening', () => {
    // 12:00Z == 08:00 EDT -> before 9.
    expect(isWithinBusinessHours(NY_9_5, new Date('2026-06-03T12:00:00Z'))).toBe(false)
  })

  it('is true exactly at the open boundary (inclusive)', () => {
    // 13:00Z == 09:00 EDT -> hour 9 >= open 9.
    expect(isWithinBusinessHours(NY_9_5, new Date('2026-06-03T13:00:00Z'))).toBe(true)
  })

  it('is false exactly at the close boundary (exclusive)', () => {
    // 21:00Z == 17:00 EDT -> hour 17 is NOT < close 17.
    expect(isWithinBusinessHours(NY_9_5, new Date('2026-06-03T21:00:00Z'))).toBe(false)
  })

  it('is true in the last open hour just before close', () => {
    // 20:30Z == 16:30 EDT -> hour 16 < 17.
    expect(isWithinBusinessHours(NY_9_5, new Date('2026-06-03T20:30:00Z'))).toBe(true)
  })

  it('is false late at night', () => {
    // 02:00Z Wed == 22:00 EDT Tue -> outside.
    expect(isWithinBusinessHours(NY_9_5, new Date('2026-06-03T02:00:00Z'))).toBe(false)
  })
})

describe('isWithinBusinessHours — weekend / closed days', () => {
  it('is false on Saturday (null window)', () => {
    // 2026-06-06 is a Saturday; 16:00Z == 12:00 EDT but Sat is closed.
    expect(isWithinBusinessHours(NY_9_5, new Date('2026-06-06T16:00:00Z'))).toBe(false)
  })

  it('is false on Sunday (null window)', () => {
    // 2026-06-07 is a Sunday.
    expect(isWithinBusinessHours(NY_9_5, new Date('2026-06-07T16:00:00Z'))).toBe(false)
  })

  it('treats a missing day key as closed', () => {
    const noFri = { timezone: 'America/New_York', days: { mon: [9, 17] } }
    // 2026-06-05 is a Friday, midday EDT, but fri key absent -> closed.
    expect(isWithinBusinessHours(noFri, new Date('2026-06-05T15:00:00Z'))).toBe(false)
  })

  it('treats a malformed window (open>=close) as closed', () => {
    const bad = { timezone: 'America/New_York', days: { wed: [17, 9] } }
    expect(isWithinBusinessHours(bad, new Date('2026-06-03T15:00:00Z'))).toBe(false)
    const zero = { timezone: 'America/New_York', days: { wed: [0, 0] } }
    expect(isWithinBusinessHours(zero, new Date('2026-06-03T15:00:00Z'))).toBe(false)
  })
})

describe('isWithinBusinessHours — timezone correctness', () => {
  it('classifies the SAME instant differently across zones', () => {
    // 2026-06-03T23:00:00Z:
    //   - New York (EDT, UTC-4): 19:00 -> closed (after 17:00)
    //   - Tokyo (JST, UTC+9):    08:00 next day (Thu) -> before 9, closed too
    //   - Dubai (GST, UTC+4):    03:00 next day (Thu) -> closed
    const instant = new Date('2026-06-03T23:00:00Z')
    const ny = { timezone: 'America/New_York', days: { wed: [9, 17], thu: [9, 17] } }
    const dubai = { timezone: 'Asia/Dubai', days: { wed: [9, 17], thu: [9, 17] } }
    expect(isWithinBusinessHours(ny, instant)).toBe(false)
    expect(isWithinBusinessHours(dubai, instant)).toBe(false)

    // 2026-06-03T13:30:00Z:
    //   - New York: 09:30 EDT Wed -> OPEN
    //   - Dubai:    17:30 GST Wed -> closed (>=17)
    const instant2 = new Date('2026-06-03T13:30:00Z')
    expect(isWithinBusinessHours(ny, instant2)).toBe(true)
    expect(isWithinBusinessHours(dubai, instant2)).toBe(false)
  })

  it('respects a UTC+ zone window (Asia/Dubai 8–17)', () => {
    const dubai = {
      timezone: 'Asia/Dubai',
      days: { wed: [8, 17], thu: [8, 17] },
    }
    // 06:00Z == 10:00 GST Wed -> open.
    expect(isWithinBusinessHours(dubai, new Date('2026-06-03T06:00:00Z'))).toBe(true)
    // 03:00Z == 07:00 GST Wed -> before 8 -> closed.
    expect(isWithinBusinessHours(dubai, new Date('2026-06-03T03:00:00Z'))).toBe(false)
  })
})

describe('businessMillisElapsed — 24/7 fallback (backward compat)', () => {
  it('returns plain wall-clock diff with no config', () => {
    const from = new Date('2026-06-06T00:00:00Z')
    const to = new Date('2026-06-08T00:00:00Z') // 48h across a weekend
    expect(businessMillisElapsed(null, from, to)).toBe(48 * HOUR)
    expect(businessMillisElapsed(undefined, from, to)).toBe(48 * HOUR)
  })

  it('returns 0 when from >= to', () => {
    const a = new Date('2026-06-03T15:00:00Z')
    const b = new Date('2026-06-03T10:00:00Z')
    expect(businessMillisElapsed(NY_9_5, a, b)).toBe(0)
    expect(businessMillisElapsed(NY_9_5, a, a)).toBe(0)
    expect(businessMillisElapsed(null, a, b)).toBe(0)
  })
})

describe('businessMillisElapsed — counts only open hours', () => {
  it('counts a full single business day as 8 hours', () => {
    // Wed 13:00Z (09:00 EDT open) -> Wed 21:00Z (17:00 EDT close) = 8 business h.
    const from = new Date('2026-06-03T13:00:00Z')
    const to = new Date('2026-06-03T21:00:00Z')
    expect(businessMillisElapsed(NY_9_5, from, to)).toBe(8 * HOUR)
  })

  it('counts only the open slice when spanning a closed evening', () => {
    // Wed 19:00Z (15:00 EDT) -> Wed 23:00Z (19:00 EDT).
    // Open portion is 15:00–17:00 EDT = 2h; 17:00–19:00 is closed.
    const from = new Date('2026-06-03T19:00:00Z')
    const to = new Date('2026-06-03T23:00:00Z')
    expect(businessMillisElapsed(NY_9_5, from, to)).toBe(2 * HOUR)
  })

  it('skips overnight: Wed 16:00 EDT -> Thu 11:00 EDT = 1h(Wed) + 2h(Thu) = 3h', () => {
    // Wed 20:00Z == 16:00 EDT -> open until 17:00 EDT (1h).
    // Overnight closed.
    // Thu 15:00Z == 11:00 EDT -> counts 09:00–11:00 EDT (2h).
    const from = new Date('2026-06-03T20:00:00Z')
    const to = new Date('2026-06-04T15:00:00Z')
    expect(businessMillisElapsed(NY_9_5, from, to)).toBe(3 * HOUR)
  })

  it('skips a full closed weekend entirely', () => {
    // Fri 22:00Z (18:00 EDT, already closed) -> Mon 12:00Z (08:00 EDT, before open).
    // Nothing in between is open: Fri after 17, Sat/Sun closed, Mon before 9.
    const from = new Date('2026-06-05T22:00:00Z')
    const to = new Date('2026-06-08T12:00:00Z')
    expect(businessMillisElapsed(NY_9_5, from, to)).toBe(0)
  })

  it('elapsed across a closed window: Fri 15:00 EDT -> Mon 11:00 EDT = 2h + 2h = 4h', () => {
    // Fri 19:00Z == 15:00 EDT -> open 15:00–17:00 EDT = 2h.
    // Sat+Sun closed.
    // Mon 15:00Z == 11:00 EDT -> open 09:00–11:00 EDT = 2h.
    const from = new Date('2026-06-05T19:00:00Z')
    const to = new Date('2026-06-08T15:00:00Z')
    expect(businessMillisElapsed(NY_9_5, from, to)).toBe(4 * HOUR)
  })

  it('credits a sub-hour tail proportionally when inside open hours', () => {
    // Wed 14:00Z (10:00 EDT) -> Wed 14:30Z (10:30 EDT): 30 min, fully open.
    const from = new Date('2026-06-03T14:00:00Z')
    const to = new Date('2026-06-03T14:30:00Z')
    expect(businessMillisElapsed(NY_9_5, from, to)).toBe(HOUR / 2)
  })

  it('does not credit a sub-hour tail that falls in a closed hour', () => {
    // Wed 02:00Z (22:00 EDT Tue) -> +30 min, both closed.
    const from = new Date('2026-06-03T02:00:00Z')
    const to = new Date('2026-06-03T02:30:00Z')
    expect(businessMillisElapsed(NY_9_5, from, to)).toBe(0)
  })

  it('matches wall-clock only within continuous open hours', () => {
    // Entirely inside Wed 9–17 EDT: 13:30Z(09:30)→20:30Z(16:30) = 7h, all open.
    const from = new Date('2026-06-03T13:30:00Z')
    const to = new Date('2026-06-03T20:30:00Z')
    expect(businessMillisElapsed(NY_9_5, from, to)).toBe(7 * HOUR)
  })
})

describe('businessMillisElapsed — SLA breach semantics', () => {
  it('a Friday-evening ticket is NOT 4 business hours overdue by Saturday', () => {
    // received Fri 21:00Z (17:00 EDT, desk just closed).
    // "now" Sat 18:00Z. Business ms elapsed should be 0, so a 4h SLA is NOT
    // breached — this is the whole point of the feature.
    const received = new Date('2026-06-05T21:00:00Z')
    const now = new Date('2026-06-06T18:00:00Z')
    const fourHoursMs = 4 * HOUR
    expect(businessMillisElapsed(NY_9_5, received, now)).toBeLessThan(fourHoursMs)
    expect(businessMillisElapsed(NY_9_5, received, now)).toBe(0)
  })

  it('the same ticket DOES breach 4h once Monday business time passes', () => {
    // received Fri 19:00Z (15:00 EDT) -> 2 business h available Friday.
    // now Mon 16:00Z (12:00 EDT) -> +3 business h Monday (09:00–12:00).
    // total 5 business h > 4h SLA -> breached.
    const received = new Date('2026-06-05T19:00:00Z')
    const now = new Date('2026-06-08T16:00:00Z')
    expect(businessMillisElapsed(NY_9_5, received, now)).toBeGreaterThan(4 * HOUR)
  })
})
