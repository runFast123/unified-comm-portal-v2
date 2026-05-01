import crypto from 'crypto'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { checkRateLimit as checkRateLimitDb } from '@/lib/rate-limiter'
import { findOrCreateContact } from '@/lib/contacts'
import { logError } from '@/lib/logger'
import { recordMetric } from '@/lib/metrics'
import {
  assertWithinBudget,
  recordAIUsage,
  approxTokensFromText,
  type AIEndpoint,
} from '@/lib/ai-usage'
import { withCircuitBreaker, CircuitBreakerOpenError as _CircuitBreakerOpenError } from '@/lib/ai-circuit-breaker'
import type { Account } from '@/types/database'

// Re-export so callers can `import { AIBudgetExceededError } from '@/lib/api-helpers'`
export { AIBudgetExceededError } from '@/lib/ai-usage'
// Re-export so callers can `import { CircuitBreakerOpenError } from '@/lib/api-helpers'`
export { CircuitBreakerOpenError } from '@/lib/ai-circuit-breaker'

// ─── Rate Limiter ───────────────────────────────────────────────────
//
// Thin boolean wrapper around the DB-backed limiter in `@/lib/rate-limiter`.
// Kept here so existing callers keep the familiar shape — they just need to
// `await` the result. For new code prefer importing `checkRateLimit` (or the
// `RATE_LIMITS` presets) directly from `@/lib/rate-limiter` to get the full
// `{ allowed, remaining, reset_at }` result.

/**
 * Returns `true` if the request is allowed, `false` if it should be rejected.
 *
 * Defaults mirror the original in-process limiter: 100 requests per 60s.
 * Fails open on DB errors — see `@/lib/rate-limiter` for details.
 */
export async function checkRateLimit(
  key: string,
  maxPerWindow = 100,
  windowSeconds = 60
): Promise<boolean> {
  const result = await checkRateLimitDb(key, maxPerWindow, windowSeconds)
  return result.allowed
}

// ─── Webhook Secret Validation ──────────────────────────────────────
/**
 * Validates the X-Webhook-Secret header using timing-safe comparison.
 */
export function validateWebhookSecret(request: Request): boolean {
  const secret = request.headers.get('x-webhook-secret')
  const expectedSecret = process.env.WEBHOOK_SECRET
  if (!expectedSecret) {
    // M7 fix: surface this to structured logging + Sentry so a misconfigured
    // deployment is alertable. Previously the silent `console.error` meant
    // every cron 401'd indefinitely with no operator-visible signal.
    void logError(
      'system',
      'webhook_secret_missing',
      'WEBHOOK_SECRET env var is unset — every cron will 401 until this is fixed',
      {}
    ).catch(() => { /* never throw from a logger */ })
    return false
  }
  if (!secret) return false

  // Timing-safe comparison to prevent timing attacks
  try {
    const secretBuf = Buffer.from(secret, 'utf8')
    const expectedBuf = Buffer.from(expectedSecret, 'utf8')
    if (secretBuf.length !== expectedBuf.length) return false
    return crypto.timingSafeEqual(secretBuf, expectedBuf)
  } catch {
    return false
  }
}

// ─── Conversation Management ────────────────────────────────────────
/**
 * Finds an existing conversation or creates a new one.
 */
export async function findOrCreateConversation(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  params: {
    account_id: string
    channel: 'teams' | 'email' | 'whatsapp'
    teams_chat_id?: string | null
    email_thread_id?: string | null
    participant_name?: string | null
    participant_email?: string | null
    participant_phone?: string | null
  }
): Promise<string> {
  let query = supabase
    .from('conversations')
    .select('id, status')
    .eq('account_id', params.account_id)
    .eq('channel', params.channel)
    .in('status', ['active', 'in_progress', 'escalated', 'waiting_on_customer', 'resolved'])

  if (params.channel === 'teams' && params.teams_chat_id) {
    query = query.eq('teams_chat_id', params.teams_chat_id)
  } else if (params.channel === 'email' && params.participant_email) {
    query = query.eq('participant_email', params.participant_email)
  } else if (params.channel === 'whatsapp' && params.participant_phone) {
    query = query.eq('participant_phone', params.participant_phone)
  }

  const { data: existing, error: lookupError } = await query.limit(1).maybeSingle()

  if (lookupError) {
    throw new Error(`Failed to look up conversation: ${lookupError.message}`)
  }

  if (existing) {
    // Reactivate conversation if it was resolved/waiting — customer sent a new message
    const updateFields: Record<string, unknown> = { last_message_at: new Date().toISOString() }
    // Auto-reactivate resolved or waiting conversations on new inbound
    const reactivateStatuses = ['resolved', 'waiting_on_customer']
    if (existing.status && reactivateStatuses.includes(existing.status)) {
      updateFields.status = 'active'
    }
    await supabase
      .from('conversations')
      .update(updateFields)
      .eq('id', existing.id)
    return existing.id
  }

  const { data: newConv, error } = await supabase
    .from('conversations')
    .insert({
      account_id: params.account_id,
      channel: params.channel,
      teams_chat_id: params.teams_chat_id || null,
      participant_name: params.participant_name || null,
      participant_email: params.participant_email || null,
      participant_phone: params.participant_phone || null,
      status: 'active',
      priority: 'medium',
      tags: [],
      first_message_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error || !newConv) {
    // Race-condition safety: if a parallel webhook just created the same
    // conversation, re-run the lookup and return whichever row won.
    // Postgres unique-violation code is 23505.
    //
    // Currently only the `teams` channel has a unique partial index
    // (`conversations_teams_unique_chat` on account_id + teams_chat_id).
    // If you add similar unique indexes for email or whatsapp, list the
    // matching lookup key in CHANNEL_UNIQUE_KEY below and the recovery will
    // automatically extend to those channels.
    const isUniqueViolation =
      (error as { code?: string } | null)?.code === '23505' ||
      /duplicate key|unique constraint/i.test(error?.message || '')
    if (isUniqueViolation) {
      type UniqueKey = { col: 'teams_chat_id' | 'email_thread_id' | 'participant_phone'; value: string | null | undefined }
      const CHANNEL_UNIQUE_KEY: Record<typeof params.channel, UniqueKey | null> = {
        teams: { col: 'teams_chat_id', value: params.teams_chat_id },
        email: null, // no unique index yet — add to this map when introduced
        whatsapp: null,
      }
      const key = CHANNEL_UNIQUE_KEY[params.channel]
      if (key && key.value) {
        const { data: raceWinner } = await supabase
          .from('conversations')
          .select('id')
          .eq('account_id', params.account_id)
          .eq('channel', params.channel)
          .eq(key.col, key.value)
          .limit(1)
          .maybeSingle()
        if (raceWinner) return raceWinner.id
      }
    }
    throw new Error(`Failed to create conversation: ${error?.message}`)
  }

  // ─── Contact link (best-effort, fire-and-forget on failure) ─────────
  // For NEW conversations only — existing rows already have contact_id set
  // either by the backfill or by a previous run of this function. We don't
  // want to disturb that. A failure here must NEVER break webhook ingest,
  // so we wrap in try/catch and log via the structured logger.
  try {
    const contactId = await findOrCreateContact(supabase, {
      email: params.participant_email,
      phone: params.participant_phone,
      display_name: params.participant_name,
    })
    if (contactId) {
      await supabase
        .from('conversations')
        .update({ contact_id: contactId })
        .eq('id', newConv.id)
    }
  } catch (contactErr) {
    logError(
      'webhook',
      'contact_link_failed',
      contactErr instanceof Error ? contactErr.message : 'unknown contact upsert failure',
      {
        conversation_id: newConv.id,
        account_id: params.account_id,
        channel: params.channel,
      }
    )
  }

  return newConv.id
}

// ─── Account Settings ───────────────────────────────────────────────
export async function getAccountSettings(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  accountId: string
): Promise<Account> {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .single()

  if (error || !data) {
    throw new Error(`Account not found: ${error?.message}`)
  }

  return data as Account
}

// ─── AI Configuration ───────────────────────────────────────────────
interface AIConfig {
  base_url: string
  api_key: string
  model: string
  max_tokens: number
  temperature: number
}

async function getAIConfig(): Promise<AIConfig> {
  try {
    const supabase = await createServiceRoleClient()
    const { data } = await supabase
      .from('ai_config')
      .select('base_url, api_key, model, max_tokens, temperature')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (data?.api_key) {
      return {
        base_url: data.base_url,
        api_key: data.api_key,
        model: data.model,
        max_tokens: data.max_tokens,
        temperature: Number(data.temperature),
      }
    }
  } catch {
    // Fall through to env vars
  }

  const apiKey = process.env.AI_API_KEY
  if (!apiKey) {
    throw new Error('No AI provider configured. Set up AI in Admin > AI Settings or add AI_API_KEY to environment.')
  }

  return {
    base_url: process.env.AI_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    api_key: apiKey,
    model: process.env.AI_MODEL || 'moonshotai/kimi-k2.5',
    max_tokens: Number(process.env.AI_MAX_TOKENS) || 4096,
    temperature: Number(process.env.AI_TEMPERATURE) || 1.0,
  }
}

// ─── AI Call with Timeout + Retry ───────────────────────────────────
const AI_TIMEOUT_MS = 30_000 // 30 seconds
const AI_MAX_RETRIES = 2
const AI_RETRY_DELAYS = [1000, 3000] // exponential backoff

/**
 * Optional context for budget tracking. When `account_id` is supplied:
 *   1. The per-account monthly budget is checked BEFORE the AI call;
 *      throws `AIBudgetExceededError` when over.
 *   2. After a successful call, usage is recorded into `ai_usage` so
 *      the running monthly total stays current.
 *
 * `account_id` is OPTIONAL so existing callers don't break — the
 * budget machinery is a no-op when omitted.
 */
export interface CallAIContext {
  account_id?: string
  endpoint?: AIEndpoint
  request_id?: string
}

/**
 * Calls any OpenAI-compatible AI API with timeout and retry logic.
 *
 * When `ctx.account_id` is provided, the call is gated by the account's
 * monthly AI budget and usage is recorded after success. Routes should
 * catch `AIBudgetExceededError` and return a graceful 200 "skipped" response.
 */
export async function callAI(
  systemPrompt: string,
  userMessage: string,
  ctx: CallAIContext = {}
): Promise<string> {
  // ── Budget gate (BEFORE the AI call) ───────────────────────────────
  // Skipped when no account_id is supplied. Throws AIBudgetExceededError
  // when the cap is reached — caller is expected to catch + skip gracefully.
  if (ctx.account_id) {
    await assertWithinBudget(ctx.account_id)
  }

  const config = await getAIConfig()
  let lastError: Error | null = null
  // Metrics envelope around the retry loop. We measure END-TO-END duration
  // (including retries + backoff sleeps) so the operational dashboard reflects
  // user-perceived latency, not raw upstream RTT. The model + endpoint labels
  // line up with `ai_usage` for cross-referencing operational vs cost views.
  const aiCallStartedAt = Date.now()
  const metricLabels = {
    endpoint: ctx.endpoint ?? 'classify',
    model: config.model,
  }

  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    try {
      // Wrap the upstream fetch in the circuit breaker — short-circuits with
      // CircuitBreakerOpenError when NVIDIA has been failing repeatedly.
      // The breaker classifies failures internally (network/5xx/timeouts =
      // failures; 4xx bad-request and AIBudgetExceededError are not).
      const { content, data } = await withCircuitBreaker(async () => {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)

        let response: Response
        try {
          response = await fetch(`${config.base_url}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.api_key}`,
            },
            body: JSON.stringify({
              model: config.model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
              ],
              temperature: config.temperature,
              max_tokens: config.max_tokens,
            }),
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timeoutId)
        }

        if (!response.ok) {
          const errorBody = await response.text()
          throw new Error(`AI API error (${response.status}): ${errorBody.substring(0, 200)}`)
        }

        const data = await response.json()
        const content = data.choices?.[0]?.message?.content || ''
        return { content, data }
      })

      // ── Usage recording (AFTER successful AI call) ─────────────────
      // Best-effort — recordAIUsage swallows DB errors internally.
      if (ctx.account_id) {
        const inputTokens =
          Number(data.usage?.prompt_tokens) ||
          approxTokensFromText(systemPrompt) + approxTokensFromText(userMessage)
        const outputTokens =
          Number(data.usage?.completion_tokens) || approxTokensFromText(content)
        try {
          await recordAIUsage({
            account_id: ctx.account_id,
            endpoint: ctx.endpoint ?? 'classify',
            model: config.model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            request_id: ctx.request_id,
          })
        } catch (recErr) {
          // Belt-and-braces: recordAIUsage is supposed to swallow its own
          // errors but if anything escapes we eat it here so AI flow continues.
          logError(
            'ai',
            'usage_record_unexpected_error',
            recErr instanceof Error ? recErr.message : 'unknown',
            { account_id: ctx.account_id }
          )
        }
      }

      recordMetric(
        'ai.call_duration_ms',
        Date.now() - aiCallStartedAt,
        { ...metricLabels, success: true, attempts: attempt + 1 },
        ctx.request_id ?? null
      )
      return content
    } catch (err: any) {
      lastError = err
      // Breaker tripped — don't retry, don't wait, just bubble up. The
      // breaker has already decided the upstream is dead; piling on with
      // backoff sleeps in this loop would just delay the graceful skip.
      if (err instanceof _CircuitBreakerOpenError) {
        recordMetric(
          'ai.call_duration_ms',
          Date.now() - aiCallStartedAt,
          { ...metricLabels, success: false, reason: 'circuit_open' },
          ctx.request_id ?? null
        )
        recordMetric('ai.call_errors', 1, { ...metricLabels, reason: 'circuit_open' }, ctx.request_id ?? null)
        throw err
      }
      const isTimeout = err.name === 'AbortError'
      const isRetryable = isTimeout || (err.message && /\b5\d{2}\b/.test(err.message))

      if (attempt < AI_MAX_RETRIES && isRetryable) {
        console.warn(`AI call attempt ${attempt + 1} failed (${isTimeout ? 'timeout' : err.message}), retrying in ${AI_RETRY_DELAYS[attempt]}ms...`)
        await new Promise(r => setTimeout(r, AI_RETRY_DELAYS[attempt]))
        continue
      }
      break
    }
  }

  recordMetric(
    'ai.call_duration_ms',
    Date.now() - aiCallStartedAt,
    { ...metricLabels, success: false, reason: 'exhausted_retries' },
    ctx.request_id ?? null
  )
  recordMetric('ai.call_errors', 1, { ...metricLabels, reason: 'exhausted_retries' }, ctx.request_id ?? null)
  throw lastError || new Error('AI call failed after all retries')
}

// ─── Account Access Verification ────────────────────────────────────
/**
 * Verifies that a user has access to a specific account.
 *   - super_admin → always true (cross-tenant).
 *   - admin / company_admin / company_member → access any account in the
 *     same `company_id`.
 *   - users with no company_id but an account_id → only their own account
 *     (legacy single-account users).
 *   - everyone else → false.
 *
 * Backed by `companies.company_id`; the old name-substring heuristic is gone.
 * If you see denials post-migration, verify the backfill ran by inspecting
 * `accounts.company_id` (every row should be non-null).
 */
export async function verifyAccountAccess(
  userId: string,
  accountId: string
): Promise<boolean> {
  const supabase = await createServiceRoleClient()
  const { data: user, error } = await supabase
    .from('users')
    .select('role, account_id, company_id')
    .eq('id', userId)
    .maybeSingle()

  if (error || !user) {
    return false
  }

  // super_admin bypasses company scope entirely.
  if (user.role === 'super_admin') {
    return true
  }

  // Same account is always allowed (covers legacy users with no company_id).
  if (user.account_id && user.account_id === accountId) {
    return true
  }

  // Without a company_id, scope is just user.account_id (already checked above).
  if (!user.company_id) {
    return false
  }

  // Company-scoped access: target account must share company_id with the user.
  const { data: target } = await supabase
    .from('accounts')
    .select('id, company_id')
    .eq('id', accountId)
    .maybeSingle()

  if (!target) return false
  return target.company_id === user.company_id
}

// ─── HTML Stripping ─────────────────────────────────────────────────
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
