/**
 * Per-tenant (company-scoped) rate limiting + monthly AI-call quota.
 *
 * Why this exists
 * ---------------
 * The existing limiter (`@/lib/rate-limiter` → `checkRateLimit`) is keyed per
 * *account* (e.g. `ai-reply:${account_id}`). A company can own many accounts,
 * so a noisy tenant with N accounts effectively gets N× the budget and can
 * starve quieter tenants on shared infrastructure. This module adds a
 * COMPANY-scoped key so one tenant's burst is capped as a whole
 * (noisy-neighbor protection), plus a rolling monthly cap on how many AI calls
 * a company may make.
 *
 * Grounding (real signatures/columns verified against the live schema):
 *   - Rate limiter: `@/lib/api-helpers` re-exports a thin boolean wrapper
 *     `checkRateLimit(key, maxPerWindow=100, windowSeconds=60): Promise<boolean>`
 *     around the DB-backed limiter. Routes already use this boolean form
 *     (e.g. `if (!(await checkRateLimit(\`ai-reply:${account_id}\`, 100, 60)))`).
 *     We wrap THAT and return its boolean.
 *   - `accounts.company_id` ties accounts to companies (see
 *     `getAllowedAccountIds` in `@/lib/auth`).
 *   - `ai_usage` is ACCOUNT-scoped. Real columns:
 *       id, account_id, ts (timestamptz, default now() — this is the
 *       created-at column, NOT `created_at`), endpoint, model,
 *       input_tokens (int), output_tokens (int), estimated_cost_usd (numeric),
 *       request_id (text).
 *     The server-side `account_ai_spend_this_month` RPC sums
 *     `estimated_cost_usd` over `ts >= date_trunc('month', now() AT TIME ZONE
 *     'UTC')`; we mirror that month window here.
 *
 * Quota model
 * -----------
 * The monthly quota is a CALL COUNT (rows in `ai_usage` this UTC month for the
 * company's accounts), compared against a default constant overridable by the
 * `AI_MONTHLY_CALL_LIMIT` env var. This is config/env-driven on purpose so
 * Phase 2 can ship a per-company override WITHOUT a schema migration (see the
 * note at the bottom of this file for an optional column should a per-company
 * value later be desired).
 *
 * Fail-open policy
 * ----------------
 * Quota is telemetry-derived. If usage can't be read (DB error, schema drift,
 * anything) `checkAiQuota` returns `allowed: true`. Hard-blocking real AI
 * traffic because a stats read failed is worse than briefly not enforcing the
 * cap — this mirrors the fail-open stance already taken by the rate limiter
 * and `@/lib/ai-usage`.
 */

import { checkRateLimit } from '@/lib/api-helpers'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { logError } from '@/lib/logger'

/** Default monthly AI-call ceiling per company when the env override is unset. */
export const DEFAULT_AI_MONTHLY_CALL_LIMIT = 5000

/**
 * Resolve the configured monthly AI-call limit.
 *
 * Reads `process.env.AI_MONTHLY_CALL_LIMIT`; falls back to
 * `DEFAULT_AI_MONTHLY_CALL_LIMIT` when unset, non-numeric, or <= 0 (a
 * misconfigured zero/negative would otherwise block every call).
 */
export function getAiMonthlyCallLimit(): number {
  const raw = process.env.AI_MONTHLY_CALL_LIMIT
  if (raw == null || raw.trim() === '') return DEFAULT_AI_MONTHLY_CALL_LIMIT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AI_MONTHLY_CALL_LIMIT
  return Math.floor(parsed)
}

/**
 * Stable rate-limit key scoped to an entire company (all its accounts share
 * one bucket). Shape: `company:${companyId}:${action}`.
 *
 * Use a distinct `action` per protected operation (e.g. `'ai'`, `'ai-reply'`,
 * `'send'`) so different operations get independent budgets.
 */
export function companyRateKey(companyId: string, action: string): string {
  return `company:${companyId}:${action}`
}

/**
 * Company-scoped fixed-window rate limit. Wraps the EXISTING boolean
 * `checkRateLimit` with a company key so the budget applies to the tenant as a
 * whole rather than per account.
 *
 * Returns `true` when the request is allowed, `false` when it should be
 * rejected. Fails open (returns `true`) on any underlying error, inheriting the
 * limiter's own fail-open behaviour.
 *
 * @param companyId  Company whose shared budget to charge.
 * @param action     Operation name (becomes part of the key).
 * @param max        Max requests permitted in the window.
 * @param windowSec  Window length in seconds.
 */
export async function checkCompanyRateLimit(
  companyId: string,
  action: string,
  max: number,
  windowSec: number
): Promise<boolean> {
  return checkRateLimit(companyRateKey(companyId, action), max, windowSec)
}

/** First instant of the current UTC month, as a Date. */
function startOfThisUtcMonth(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

/** First instant of the next UTC month (= when the monthly quota resets), as a Date. */
function startOfNextUtcMonth(): Date {
  const now = new Date()
  // Date.UTC normalises month 12 → next year January, so no manual rollover.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

/**
 * Resolve the account ids belonging to a company (service-role, bypasses RLS).
 * Mirrors the company→accounts lookup used by `getAllowedAccountIds`.
 */
async function getCompanyAccountIds(companyId: string): Promise<string[]> {
  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('accounts')
    .select('id')
    .eq('company_id', companyId)
  if (error) throw error
  return ((data as Array<{ id: string }> | null) ?? []).map((a) => a.id)
}

export interface CompanyAiUsage {
  /** Number of AI calls (ai_usage rows) charged to this company this UTC month. */
  calls: number
  /** Total tokens (input + output) across those calls. */
  tokens: number
}

/**
 * Sum this company's AI usage for the current UTC month.
 *
 * Resolves the company's account ids (service-role) then aggregates `ai_usage`
 * rows where `account_id IN (...)` and `ts >= start-of-UTC-month`. `calls` is
 * the row count; `tokens` is `sum(input_tokens + output_tokens)`. Uses the real
 * `ts` timestamp column (NOT `created_at`).
 *
 * A company with no accounts (or no usage) returns `{ calls: 0, tokens: 0 }`.
 *
 * NOTE: this does NOT swallow DB errors — it throws so the caller
 * (`checkAiQuota`) can apply the fail-open policy in one place. Callers that
 * use this directly for display should guard with try/catch.
 */
export async function getCompanyAiUsageThisMonth(
  companyId: string
): Promise<CompanyAiUsage> {
  const accountIds = await getCompanyAccountIds(companyId)
  if (accountIds.length === 0) return { calls: 0, tokens: 0 }

  const admin = await createServiceRoleClient()
  const since = startOfThisUtcMonth().toISOString()
  const { data, error } = await admin
    .from('ai_usage')
    .select('input_tokens, output_tokens')
    .in('account_id', accountIds)
    .gte('ts', since)

  if (error) throw error

  const rows =
    (data as Array<{ input_tokens: number | null; output_tokens: number | null }> | null) ?? []

  let tokens = 0
  for (const row of rows) {
    tokens += (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0)
  }
  return { calls: rows.length, tokens }
}

export interface AiQuotaStatus {
  /** False only when usage was read successfully AND is at/over the limit. */
  allowed: boolean
  /** Calls used this UTC month (0 when usage couldn't be read — fail-open). */
  used: number
  /** Effective monthly call limit (env override or default constant). */
  limit: number
  /** ISO timestamp of the first instant of next UTC month (quota reset). */
  resetsAt: string
}

/**
 * Decide whether a company may make another AI call this month.
 *
 * Compares the company's month-to-date AI call count against the effective
 * limit (`AI_MONTHLY_CALL_LIMIT` env override, else
 * `DEFAULT_AI_MONTHLY_CALL_LIMIT`). Blocks (`allowed: false`) only when usage is
 * KNOWN to be at or over the limit.
 *
 * FAIL-OPEN: if usage can't be read, returns `allowed: true` with `used: 0` —
 * a telemetry outage must never hard-block real AI traffic. The incident is
 * logged.
 */
export async function checkAiQuota(companyId: string): Promise<AiQuotaStatus> {
  const limit = getAiMonthlyCallLimit()
  const resetsAt = startOfNextUtcMonth().toISOString()

  try {
    const { calls } = await getCompanyAiUsageThisMonth(companyId)
    return {
      allowed: calls < limit,
      used: calls,
      limit,
      resetsAt,
    }
  } catch (err) {
    // Fail open — never let a stats read failure block the AI flow.
    void logError(
      'ai',
      'ai_quota.read_failed',
      `checkAiQuota could not read usage for company=${companyId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { company_id: companyId, limit }
    ).catch(() => {
      /* logger is best-effort; never throw from the fail-open path */
    })
    return { allowed: true, used: 0, limit, resetsAt }
  }
}

/*
 * ─── Optional Phase-2 per-company override (NOT applied) ──────────────
 *
 * The env-driven default above needs no schema change. If/when a per-company
 * limit is desired, the smallest forward-compatible change is a nullable
 * column on `companies` (NULL = "use the env/default limit"):
 *
 *   ALTER TABLE public.companies
 *     ADD COLUMN IF NOT EXISTS ai_monthly_call_limit integer;
 *   COMMENT ON COLUMN public.companies.ai_monthly_call_limit IS
 *     'Per-company monthly AI-call ceiling. NULL = fall back to AI_MONTHLY_CALL_LIMIT env / DEFAULT_AI_MONTHLY_CALL_LIMIT.';
 *
 * `getAiMonthlyCallLimit()` would then take an optional override:
 *   getAiMonthlyCallLimit(companyOverride?: number | null)
 * preferring a positive `companyOverride`, else the env, else the default.
 *
 * Do NOT apply this migration without review — the env default is sufficient
 * for the initial rollout.
 */
