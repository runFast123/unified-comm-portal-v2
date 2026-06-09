// ─── Cross-tenant tripwire ───────────────────────────────────────────────
// Every API route that uses the service-role Supabase client (which BYPASSES
// row-level security) must visibly scope to the caller's tenant — or be on the
// justified allowlist below. This converts the one-time cross-tenant audit into
// a permanent CI guarantee: a NEW service-role route that forgets to scope
// fails here instead of leaking another tenant's data in production.
//
// "Visibly scope" = the file references one of SCOPING_SIGNALS: a tenant-guard
// call, verifyAccountAccess / getAllowedAccountIds, a company_id filter, a
// webhook-secret / API-token / super-admin gate, or an owner (auth.uid()) check.
// This is a heuristic tripwire, NOT a proof — but it reliably catches the
// "reached for the service-role client and forgot to scope" class of bug, which
// is exactly the cluster fixed in the cross-tenant security pass.
//
// Going forward: prefer adding `requireCompanyAdmin()` + `assertAccountAccess()`
// from `@/lib/tenant-guard` to a new route over adding it to the ALLOWLIST.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'

const API_DIR = join(process.cwd(), 'src', 'app', 'api')

const SERVICE_ROLE = /createServiceRoleClient|supabaseAdmin/

const SCOPING_SIGNALS = [
  // tenant-guard (the standard going forward)
  'requireUser',
  'requireCompanyAdmin',
  'requireSupervisor',
  'assertAccountAccess',
  'tenantAccountIds',
  // older, equivalent helpers
  'verifyAccountAccess',
  'getAllowedAccountIds',
  'getCurrentUser',
  'isSuperAdmin',
  'isCompanyAdmin',
  // explicit column / cookie scope
  'company_id',
  'current_user_company_id',
  'selected_company_id',
  // auth gates that establish trust without a per-account check
  'validateWebhookSecret',
  'requireToken',
  'requireSuperAdmin',
  'requireCompanyAdminFor',
  'requireIntegrationsAdmin',
  // owner (auth.uid()) ownership checks
  'created_by',
  'mentioned_user_id',
  'user_id',
]

// Pre-existing routes that use the service-role client but scope by a mechanism
// the keyword scan can't see (verified individually). This is the FROZEN
// baseline — do not add to it without a real justification; add a tenant-guard
// call to the route instead.
const ALLOWLIST: Record<string, string> = {
  'admin/health/accounts/route.ts': 'admin health diagnostics — aggregate counts, no per-tenant rows returned',
  'admin/health/crons/route.ts': 'system cron health, not tenant data',
  'admin/health/db-latency/route.ts': 'system DB latency probe, not tenant data',
  'admin/health/deployment-protection/route.ts': 'deployment/env health, not tenant data',
  'admin/health/env/route.ts': 'env-presence health, not tenant data',
  'attachments/delete/route.ts': 'owner-scoped by storage path prefix (`${user.id}/`)',
  'auth/gmail/callback/route.ts': 'OAuth callback — state/code is the auth; no tenant query keyed on request input',
  'auth/teams/callback/route.ts': 'OAuth callback — state/code is the auth; no tenant query keyed on request input',
  'conversations/[id]/time/end/route.ts': 'user-scoped time entry (user_id = auth.uid())',
  'conversations/[id]/time/heartbeat/route.ts': 'user-scoped time entry (user_id = auth.uid())',
  'csat/[token]/route.ts': 'public CSAT — the HMAC token in the URL is the auth',
  'mentions/route.ts': 'user-scoped (mentioned_user_id = auth.uid())',
  'send/cancel/route.ts': 'owner-scoped (pending_sends.created_by = auth.uid() → 403 on mismatch)',
  'widget/config/route.ts': 'public live-chat widget — the widget_key in the request is the auth; resolves to its account (no user session)',
  'widget/loader/route.ts': 'public live-chat widget loader — widget_key is the auth; serves the embed JS for its account',
  'widget/message/route.ts': 'public live-chat widget — widget_key is the auth; writes are pinned to the key\'s account',
  'widget/poll/route.ts': 'public live-chat widget — widget_key + unguessable session_id are the auth; reads scoped to the account + session',
  'widget/transcript/route.ts': 'public live-chat widget — widget_key + session_id are the auth; emails ONLY the conversation\'s stored participant_email (never a request-supplied address), rate-limited',
}

function listRouteFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listRouteFiles(full))
    else if (entry.name === 'route.ts' || entry.name === 'route.tsx') out.push(full)
  }
  return out
}

function rel(file: string): string {
  return file.slice(API_DIR.length + 1).split(sep).join('/')
}

describe('service-role routes are tenant-scoped', () => {
  const files = listRouteFiles(API_DIR)

  it('discovers a meaningful number of API routes', () => {
    expect(files.length).toBeGreaterThan(40)
  })

  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    if (!SERVICE_ROLE.test(src)) continue
    const name = rel(file)
    it(`${name} scopes to the tenant (or is an allowlisted exception)`, () => {
      if (name in ALLOWLIST) return // justified, verified baseline
      const hasSignal = SCOPING_SIGNALS.some((s) => src.includes(s))
      expect(
        hasSignal,
        `\n${name} uses the service-role client (which BYPASSES RLS) but shows no tenant-scoping signal.\n` +
          `Add a tenant-guard check — requireCompanyAdmin() + assertAccountAccess() from @/lib/tenant-guard —\n` +
          `or, if the route is genuinely not tenant-scoped, add it to ALLOWLIST in this file with a justification.\n`,
      ).toBe(true)
    })
  }
})
