// Unit tests for the pure role predicates and the role-name lists that DB
// `.in('role', …)` queries depend on. These guard the contract that modern
// (company_admin / supervisor / company_member) and legacy (admin / reviewer /
// viewer) role names both resolve correctly — the regression behind the
// broken conversation auto-assignment.

import { describe, it, expect } from 'vitest'
import {
  isSuperAdmin,
  isCompanyAdmin,
  isSupervisor,
  isAssignableAgent,
  COMPANY_ADMIN_ROLE_NAMES,
  ASSIGNABLE_AGENT_ROLE_NAMES,
} from '@/lib/roles'

describe('isSuperAdmin', () => {
  it('only super_admin is super', () => {
    expect(isSuperAdmin('super_admin')).toBe(true)
    expect(isSuperAdmin('admin')).toBe(false)
    expect(isSuperAdmin('company_admin')).toBe(false)
    expect(isSuperAdmin(null)).toBe(false)
    expect(isSuperAdmin(undefined)).toBe(false)
  })
})

describe('isCompanyAdmin', () => {
  it('legacy admin, company_admin and super_admin are company admins', () => {
    expect(isCompanyAdmin('admin')).toBe(true)
    expect(isCompanyAdmin('company_admin')).toBe(true)
    expect(isCompanyAdmin('super_admin')).toBe(true)
  })
  it('supervisor / member / viewer / null are not company admins', () => {
    expect(isCompanyAdmin('supervisor')).toBe(false)
    expect(isCompanyAdmin('company_member')).toBe(false)
    expect(isCompanyAdmin('reviewer')).toBe(false)
    expect(isCompanyAdmin('viewer')).toBe(false)
    expect(isCompanyAdmin(null)).toBe(false)
  })
})

describe('isSupervisor', () => {
  it('supervisor and all company-admin roles are supervisor-or-above', () => {
    expect(isSupervisor('supervisor')).toBe(true)
    expect(isSupervisor('company_admin')).toBe(true)
    expect(isSupervisor('admin')).toBe(true)
    expect(isSupervisor('super_admin')).toBe(true)
  })
  it('member / viewer / null are below supervisor', () => {
    expect(isSupervisor('company_member')).toBe(false)
    expect(isSupervisor('reviewer')).toBe(false)
    expect(isSupervisor('viewer')).toBe(false)
    expect(isSupervisor(null)).toBe(false)
  })
})

describe('isAssignableAgent', () => {
  it('includes every modern staff tier that works tickets', () => {
    expect(isAssignableAgent('company_admin')).toBe(true)
    expect(isAssignableAgent('supervisor')).toBe(true)
    expect(isAssignableAgent('company_member')).toBe(true)
  })
  it('includes the legacy admin/reviewer tiers for back-compat', () => {
    expect(isAssignableAgent('admin')).toBe(true)
    expect(isAssignableAgent('reviewer')).toBe(true)
  })
  it('excludes read-only viewer and cross-tenant super_admin', () => {
    expect(isAssignableAgent('viewer')).toBe(false)
    expect(isAssignableAgent('super_admin')).toBe(false)
  })
  it('rejects null / undefined / unknown roles', () => {
    expect(isAssignableAgent(null)).toBe(false)
    expect(isAssignableAgent(undefined)).toBe(false)
    expect(isAssignableAgent('hacker')).toBe(false)
  })
})

describe('role-name lists stay in sync with their predicates', () => {
  it('COMPANY_ADMIN_ROLE_NAMES matches isCompanyAdmin exactly', () => {
    for (const r of COMPANY_ADMIN_ROLE_NAMES) expect(isCompanyAdmin(r)).toBe(true)
    // and the modern member roles are NOT in it
    expect(COMPANY_ADMIN_ROLE_NAMES).not.toContain('supervisor')
    expect(COMPANY_ADMIN_ROLE_NAMES).not.toContain('company_member')
  })
  it('ASSIGNABLE_AGENT_ROLE_NAMES matches isAssignableAgent exactly', () => {
    for (const r of ASSIGNABLE_AGENT_ROLE_NAMES) expect(isAssignableAgent(r)).toBe(true)
    // the three modern role names the tenants actually use must all be present
    expect(ASSIGNABLE_AGENT_ROLE_NAMES).toContain('company_admin')
    expect(ASSIGNABLE_AGENT_ROLE_NAMES).toContain('supervisor')
    expect(ASSIGNABLE_AGENT_ROLE_NAMES).toContain('company_member')
    expect(ASSIGNABLE_AGENT_ROLE_NAMES).not.toContain('viewer')
    expect(ASSIGNABLE_AGENT_ROLE_NAMES).not.toContain('super_admin')
  })
})
