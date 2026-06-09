import { describe, it, expect } from 'vitest'
import { isWidgetOnline, type BusinessHours } from '@/lib/livechat'

const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

describe('isWidgetOnline (business hours)', () => {
  it('returns true when the feature is disabled (no banner)', () => {
    expect(isWidgetOnline(false, { tz: 'UTC', days: ALL_DAYS, open: '09:00', close: '17:00' })).toBe(true)
  })

  it('fails OPEN (online) on null / malformed schedule so a misconfig never blocks chat', () => {
    expect(isWidgetOnline(true, null)).toBe(true)
    expect(isWidgetOnline(true, {} as unknown as BusinessHours)).toBe(true)
    expect(isWidgetOnline(true, { tz: 'UTC', days: ALL_DAYS, open: '', close: '' } as BusinessHours)).toBe(true)
  })

  it('is OFFLINE when no days are configured open (no weekday can match)', () => {
    expect(isWidgetOnline(true, { tz: 'UTC', days: [], open: '09:00', close: '17:00' })).toBe(false)
  })

  it('is ONLINE for an all-week 24h schedule (open === close → overnight/full-day window)', () => {
    expect(isWidgetOnline(true, { tz: 'UTC', days: ALL_DAYS, open: '00:00', close: '00:00' })).toBe(true)
  })

  it('tolerates an unknown timezone by failing open', () => {
    expect(isWidgetOnline(true, { tz: 'Not/AZone', days: ALL_DAYS, open: '09:00', close: '17:00' })).toBe(true)
  })
})
