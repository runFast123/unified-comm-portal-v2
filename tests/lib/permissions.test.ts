import { describe, it, expect } from 'vitest'
import {
  SECTION_PERMISSIONS,
  ACTION_PERMISSIONS,
  CHANNEL_PERMISSION_KEYS,
  ALL_CATALOG_KEYS,
  ROUTE_TO_SECTION,
  isKnownCatalogKey,
} from '@/lib/permissions/catalog'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/permissions/defaults'
import { resolveEffectivePermissions, setHasPermission } from '@/lib/permissions/resolve'

describe('permission catalog', () => {
  it('routes map only to real section keys', () => {
    for (const section of Object.values(ROUTE_TO_SECTION)) {
      expect(SECTION_PERMISSIONS).toHaveProperty(section)
    }
  })

  it('ALL_CATALOG_KEYS spans sections + actions + channels', () => {
    expect(ALL_CATALOG_KEYS).toContain('section:inbox')
    expect(ALL_CATALOG_KEYS).toContain('action:message.send')
    expect(ALL_CATALOG_KEYS).toContain('channel:email')
    expect(ALL_CATALOG_KEYS.length).toBe(
      Object.keys(SECTION_PERMISSIONS).length +
        Object.keys(ACTION_PERMISSIONS).length +
        CHANNEL_PERMISSION_KEYS.length
    )
  })

  it('isKnownCatalogKey accepts catalog keys and rejects junk / prototype names', () => {
    expect(isKnownCatalogKey('section:admin.channels')).toBe(true)
    expect(isKnownCatalogKey('channel:whatsapp')).toBe(true)
    expect(isKnownCatalogKey('section:nope')).toBe(false)
    expect(isKnownCatalogKey('constructor')).toBe(false)
    expect(isKnownCatalogKey('toString')).toBe(false)
  })
})

describe('default role permissions mirror current gating (non-breaking)', () => {
  it('super_admin has everything', () => {
    const all = new Set(ALL_CATALOG_KEYS)
    for (const k of all) expect(DEFAULT_ROLE_PERMISSIONS.super_admin.has(k)).toBe(true)
  })

  it('company_admin gets all admin sections except Companies', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.company_admin.has('section:admin.channels')).toBe(true)
    expect(DEFAULT_ROLE_PERMISSIONS.company_admin.has('section:admin.users')).toBe(true)
    expect(DEFAULT_ROLE_PERMISSIONS.company_admin.has('section:admin.companies')).toBe(false)
    expect(DEFAULT_ROLE_PERMISSIONS.company_admin.has('action:credentials.manage')).toBe(true)
  })

  it('operational roles see inbox + can send, but not admin sections', () => {
    for (const role of ['supervisor', 'company_member', 'reviewer', 'viewer'] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role].has('section:inbox')).toBe(true)
      expect(DEFAULT_ROLE_PERMISSIONS[role].has('action:message.send')).toBe(true)
      expect(DEFAULT_ROLE_PERMISSIONS[role].has('channel:email')).toBe(true)
      // No admin pages or admin-only actions by default.
      expect(DEFAULT_ROLE_PERMISSIONS[role].has('section:admin.channels')).toBe(false)
      expect(DEFAULT_ROLE_PERMISSIONS[role].has('action:users.manage')).toBe(false)
    }
  })
})

describe('resolveEffectivePermissions — layered overrides', () => {
  it('returns the role baseline with no overrides', () => {
    const eff = resolveEffectivePermissions('company_member')
    expect(eff.has('section:inbox')).toBe(true)
    expect(eff.has('section:admin.users')).toBe(false)
  })

  it('a company role override can grant a section the baseline lacks', () => {
    const eff = resolveEffectivePermissions('company_member', {
      companyRole: [{ permission_key: 'section:reports', allowed: true }],
    })
    expect(eff.has('section:reports')).toBe(true)
  })

  it('a per-user deny removes a baseline permission', () => {
    const eff = resolveEffectivePermissions('company_member', {
      user: [{ permission_key: 'channel:whatsapp', effect: 'deny' }],
    })
    expect(eff.has('channel:whatsapp')).toBe(false)
    expect(eff.has('channel:email')).toBe(true)
  })

  it('per-user override beats company override beats platform override', () => {
    // platform grants, company denies, user grants -> user wins (granted).
    const eff = resolveEffectivePermissions('company_member', {
      platformRole: [{ permission_key: 'action:conversation.delete', allowed: true }],
      companyRole: [{ permission_key: 'action:conversation.delete', allowed: false }],
      user: [{ permission_key: 'action:conversation.delete', effect: 'allow' }],
    })
    expect(eff.has('action:conversation.delete')).toBe(true)

    // Without the user layer, company's deny wins over platform's grant.
    const eff2 = resolveEffectivePermissions('company_member', {
      platformRole: [{ permission_key: 'action:conversation.delete', allowed: true }],
      companyRole: [{ permission_key: 'action:conversation.delete', allowed: false }],
    })
    expect(eff2.has('action:conversation.delete')).toBe(false)
  })

  it('super_admin is all-access and ignores deny overrides', () => {
    const eff = resolveEffectivePermissions('super_admin', {
      companyRole: [{ permission_key: 'section:admin.channels', allowed: false }],
      user: [{ permission_key: 'section:admin.channels', effect: 'deny' }],
    })
    expect(eff.has('section:admin.channels')).toBe(true)
    expect(setHasPermission(eff, 'section:anything', 'super_admin')).toBe(true)
  })
})
