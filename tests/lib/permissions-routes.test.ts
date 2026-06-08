import { describe, it, expect } from 'vitest'
import { sectionForPath, firstAccessibleRoute, ADMIN_SECTION_KEYS } from '@/lib/permissions/routes'

describe('sectionForPath', () => {
  it('maps exact routes to their section', () => {
    expect(sectionForPath('/admin/channels')).toBe('section:admin.channels')
    expect(sectionForPath('/reports')).toBe('section:reports')
    expect(sectionForPath('/inbox')).toBe('section:inbox')
  })

  it('maps nested routes to their parent section', () => {
    expect(sectionForPath('/admin/channels/abc-123')).toBe('section:admin.channels')
  })

  it('ignores the query string (bookmarks is an inbox view)', () => {
    expect(sectionForPath('/inbox?view=bookmarks')).toBe('section:inbox')
  })

  it('returns null for routes with no gated section', () => {
    expect(sectionForPath('/conversations/abc')).toBeNull()
    expect(sectionForPath('/account/signature')).toBeNull()
  })
})

describe('firstAccessibleRoute (safe redirect target)', () => {
  it('prefers /inbox when available', () => {
    const all = new Set(['section:inbox', 'section:dashboard', 'section:reports'])
    expect(firstAccessibleRoute(all)).toBe('/inbox')
  })

  it('falls through priority when earlier sections are denied', () => {
    expect(firstAccessibleRoute(new Set(['section:dashboard']))).toBe('/dashboard')
    expect(firstAccessibleRoute(new Set(['section:reports']))).toBe('/reports')
  })

  it('returns an admin route when only admin sections are granted', () => {
    expect(firstAccessibleRoute(new Set(['section:admin.channels']))).toBe('/admin/channels')
  })

  it('falls back to /inbox when nothing is accessible (degenerate, no loop)', () => {
    expect(firstAccessibleRoute(new Set())).toBe('/inbox')
  })
})

describe('ADMIN_SECTION_KEYS', () => {
  it('contains only admin sections', () => {
    expect(ADMIN_SECTION_KEYS).toContain('section:admin.channels')
    expect(ADMIN_SECTION_KEYS).toContain('section:admin.users')
    expect(ADMIN_SECTION_KEYS).not.toContain('section:inbox')
    expect(ADMIN_SECTION_KEYS.every((k) => k.startsWith('section:admin.'))).toBe(true)
  })
})
