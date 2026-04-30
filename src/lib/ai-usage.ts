/**
 * AI Usage Tracker — per-account cost budget + monthly cap.
 *
 * Records every AI call into `public.ai_usage`, computes a coarse cost
 * estimate per model, and gates calls against the per-account
 * `accounts.monthly_ai_budget_usd` ceiling.
 *
 * Design notes:
 * - Cost estimation is COARSE — per-1k-token rates from a small static
 *   table. Good enough to spot runaway accounts; not authoritative billing.
 * - Monthly totals are cached in-process for ~30s per account_id to avoid
 *   hammering the RPC on every AI call. The cache is best-effort only —
 *   cold-starting a new instance just re-reads from DB on first hit.
 * - Threshold-crossed alerts dedupe via a process-level Set keyed
 *   `${accountId}:${YYYY-MM}`. Fresh process = fresh alert window, which
 *   is fine — duplicate alerts are an annoyance, not a correctness bug.
 */

import { createServiceRoleClient } from '@/lib/supabase-server'
import { logError, logWarn } from '@/lib/logger'
import { logAudit } from '@/lib/audit'

// ─── Public types ───────────────────────────────────────────────────
export type AIEndpoint =
  | 'classify'
  | 'ai-reply'
  | 'ai-summarize'
  | 'suggest-replies'
  | 'ai-compose'
  | 'test-ai'

export interface UsageRecord {
  account_id: string
  endpoint: AIEndpoint
  model: string
  input_tokens?: number
  output_tokens?: number
  request_id?: string
}

export interface UsageStatus {
  monthly_total_usd: number
  budget_usd: number
  pct_of_budget: number
  over_budget: boolean
  near_budget: boolean
}

export interface RecordResult extends UsageStatus {
  cost_usd: number
}

export class AIBudgetExceededError extends Error {
  constructor(
    public account_id: string,
    public monthly_total_usd: number,
    public budget_usd: number
  ) {
    super(
      `AI budget exceeded for account ${account_id}: $${monthly_total_usd.toFixed(
        4
      )} / $${budget_usd.toFixed(2)}`
    )
    this.name = 'AIBudgetExceededError'
  }
}

// ─── Cost rate table ────────────────────────────────────────────────
// Per-1k-token rates in USD. `combined` means the same rate applies to
// input+output tokens summed. Coarse on purpose — we want a useful signal
// for runaway-cost detection, not authoritative billing accuracy.
//
// Rates are matched in declaration order: the first regex that matches the
// model name wins. Add new entries above the catchall default.
const RATE_TABLE: Array<{
  match: RegExp
  input_per_1k?: number
  output_per_1k?: number
  combined_per_1k?: number
}> = [
  // OpenAI
  { match: /^openai\/gpt-4(o|-turbo)/i, input_per_1k: 0.005, output_per_1k: 0.015 },
  { match: /^openai\/gpt-4/i, input_per_1k: 0.06, output_per_1k: 0.06 },
  { match: /^openai\/gpt-3\.5/i, input_per_1k: 0.0005, output_per_1k: 0.0015 },
  // Anthropic (priced for transparency even though we route through NIM today)
  { match: /^anthropic\/claude-3-opus/i, input_per_1k: 0.015, output_per_1k: 0.075 },
  { match: /^anthropic\/claude-3-sonnet/i, input_per_1k: 0.003, output_per_1k: 0.015 },
  { match: /^anthropic\/claude-3-haiku/i, input_per_1k: 0.00025, output_per_1k: 0.00125 },
  // NVIDIA NIM hosted models — cheap / often free
  { match: /^nvidia\//i, combined_per_1k: 0.0005 },
  { match: /^moonshotai\//i, combined_per_1k: 0.0005 },
  { match: /^meta\//i, combined_per_1k: 0.0005 },
  { match: /^mistralai\//i, combined_per_1k: 0.0005 },
]

const DEFAULT_COMBINED_PER_1K = 0.001

/**
 * Estimate cost in USD for a single AI call. Falls back to a conservative
 * default rate when the model is unknown — must NEVER throw.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const safeIn = Math.max(0, Number(inputTokens) || 0)
  const safeOut = Math.max(0, Number(outputTokens) || 0)
  const m = (model || '').trim()

  for (const row of RATE_TABLE) {
    if (!row.match.test(m)) continue
    if (row.combined_per_1k != null) {
      return ((safeIn + safeOut) / 1000) * row.combined_per_1k
    }
    const inRate = row.input_per_1k ?? 0
    const outRate = row.output_per_1k ?? 0
    return (safeIn / 1000) * inRate + (safeOut / 1000) * outRate
  }

  return ((safeIn + safeOut) / 1000) * DEFAULT_COMBINED_PER_1K
}

// ─── Caches ─────────────────────────────────────────────────────────
const CACHE_TTL_MS = 30_000

interface CachedUsage {
  status: UsageStatus
  expiresAt: number
}

const monthlyUsageCache = new Map<string, CachedUsage>()

/** Process-level dedup for "near-budget" threshold-crossed alerts.
 *  Keyed by `${account_id}:${YYYY-MM}`. */
const alertedThisMonth = new Set<string>()

function monthKey(accountId: string): string {
  const now = new Date()
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  return `${accountId}:${ym}`
}

function invalidateCache(accountId: string): void {
  monthlyUsageCache.delete(accountId)
}

function deriveStatus(
  monthly_total_usd: number,
  budget_usd: number,
  alert_at_pct: number
): UsageStatus {
  const safeBudget = budget_usd > 0 ? budget_usd : 0
  const pct = safeBudget > 0 ? (monthly_total_usd / safeBudget) * 100 : 0
  const safePct = Number.isFinite(pct) ? pct : 0
  return {
    monthly_total_usd,
    budget_usd: safeBudget,
    pct_of_budget: Math.round(safePct * 10) / 10,
    over_budget: safeBudget > 0 && monthly_total_usd >= safeBudget,
    near_budget: safeBudget > 0 && safePct >= alert_at_pct,
  }
}

/**
 * Fetch the current monthly spend + per-account budget configuration.
 * Hits the cache when fresh, otherwise reads from the
 * `account_ai_spend_this_month` RPC + `accounts` row.
 */
async function loadUsageFromDb(accountId: string): Promise<UsageStatus> {
  try {
    const supabase = await createServiceRoleClient()
    const [{ data: account }, { data: total }] = await Promise.all([
      supabase
        .from('accounts')
        .select('monthly_ai_budget_usd, ai_budget_alert_at_pct')
        .eq('id', accountId)
        .maybeSingle(),
      supabase.rpc('account_ai_spend_this_month', { p_account_id: accountId }),
    ])

    const budget = Number(account?.monthly_ai_budget_usd ?? 50)
    const alertPct = Number(account?.ai_budget_alert_at_pct ?? 90)
    const monthlyTotal = Number(total ?? 0) || 0

    const status = deriveStatus(monthlyTotal, budget, alertPct)
    monthlyUsageCache.set(accountId, {
      status,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
    return status
  } catch (err) {
    // Fail open — return a "safe to proceed" zero-spend status so a transient
    // DB error never blocks the AI flow. The incident is logged so we know.
    logWarn(
      'ai',
      'usage_load_failed',
      err instanceof Error ? err.message : 'unknown error',
      { account_id: accountId }
    )
    return deriveStatus(0, 0, 90)
  }
}

/**
 * Cheap-cached read of current month spend for budget gating.
 */
export async function getMonthlyUsage(accountId: string): Promise<UsageStatus> {
  if (!accountId) return deriveStatus(0, 0, 90)
  const cached = monthlyUsageCache.get(accountId)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.status
  }
  return loadUsageFromDb(accountId)
}

/**
 * Insert a usage row + return the (possibly cached) running monthly total.
 *
 * Failures here MUST NOT crash the caller — the underlying AI call already
 * succeeded, and we don't want a stats-table outage to look like an AI
 * outage. All errors are swallowed + logged.
 */
export async function recordAIUsage(record: UsageRecord): Promise<RecordResult> {
  const inputTokens = Math.max(0, Number(record.input_tokens) || 0)
  const outputTokens = Math.max(0, Number(record.output_tokens) || 0)
  const cost = estimateCostUsd(record.model, inputTokens, outputTokens)

  // Whether the previous cached read had `near_budget` already set — used
  // for the threshold-crossed dedup below.
  const previousNearBudget = monthlyUsageCache.get(record.account_id)?.status.near_budget ?? false

  // Insert is best-effort. If it fails we still return a status derived from
  // the previous read so the caller can keep going.
  try {
    const supabase = await createServiceRoleClient()
    await supabase.from('ai_usage').insert({
      account_id: record.account_id,
      endpoint: record.endpoint,
      model: record.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: Number(cost.toFixed(6)),
      request_id: record.request_id ?? null,
    })
  } catch (err) {
    logError(
      'ai',
      'usage_insert_failed',
      err instanceof Error ? err.message : 'unknown error',
      { account_id: record.account_id, endpoint: record.endpoint }
    )
  }

  // Force a fresh monthly read so callers see the just-inserted cost.
  invalidateCache(record.account_id)
  const status = await loadUsageFromDb(record.account_id)

  // Threshold-crossing alert: just crossed `near_budget` AND haven't alerted
  // for this account this month yet.
  if (status.near_budget && !previousNearBudget) {
    const key = monthKey(record.account_id)
    if (!alertedThisMonth.has(key)) {
      alertedThisMonth.add(key)
      try {
        await logAudit({
          action: 'ai_budget.threshold_crossed',
          entity_type: 'account',
          entity_id: record.account_id,
          details: {
            monthly_total_usd: status.monthly_total_usd,
            budget_usd: status.budget_usd,
            pct_of_budget: status.pct_of_budget,
          },
        })
      } catch {
        /* logAudit is already best-effort */
      }
      logWarn(
        'ai',
        'budget_threshold_crossed',
        `Account ${record.account_id} crossed ${status.pct_of_budget}% of monthly AI budget`,
        {
          account_id: record.account_id,
          monthly_total_usd: status.monthly_total_usd,
          budget_usd: status.budget_usd,
        }
      )
    }
  }

  return { ...status, cost_usd: Number(cost.toFixed(6)) }
}

/**
 * Convenience for routes: throws AIBudgetExceededError when over budget.
 * Routes catch this and return a graceful 200 "skipped" response.
 */
export async function assertWithinBudget(accountId: string): Promise<UsageStatus> {
  const status = await getMonthlyUsage(accountId)
  if (status.over_budget) {
    throw new AIBudgetExceededError(
      accountId,
      status.monthly_total_usd,
      status.budget_usd
    )
  }
  return status
}

/**
 * Rough character-to-token estimate when the AI provider doesn't return
 * a usage block. ~4 chars/token is the standard OpenAI rule of thumb.
 */
export function approxTokensFromText(text: string | null | undefined): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

// ─── Test-only helpers ──────────────────────────────────────────────
/** Reset in-process caches. EXPORTED FOR TESTS — do not call in product code. */
export function __resetUsageCachesForTests(): void {
  monthlyUsageCache.clear()
  alertedThisMonth.clear()
}
