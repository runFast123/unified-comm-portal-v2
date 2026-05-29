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
 * Normalize an email subject for thread matching: strip leading reply/forward
 * prefixes (Re:, Fwd:, RE :, AW:, etc.), collapse whitespace, lowercase.
 * Returns null when nothing meaningful remains.
 */
export function normalizeEmailSubject(subject: string | null | undefined): string | null {
  if (!subject) return null
  let s = subject.trim()
  // Repeatedly strip a leading reply/forward token (handles "Re: Fwd: ...").
  // Covers common locales: Re, Fwd/Fw, AW (de), SV (sv), VS (fi), Antwort.
  const prefix = /^(re|fwd?|aw|sv|vs|antwort|wg)\s*(\[\d+\])?\s*:\s*/i
  let prev: string
  do {
    prev = s
    s = s.replace(prefix, '').trim()
  } while (s !== prev && s.length > 0)
  s = s.replace(/\s+/g, ' ').trim().toLowerCase()
  return s.length > 0 ? s : null
}

/**
 * Fallback email match: find the sender's most-recent active conversation whose
 * LATEST message shares the normalized subject. Subject isn't stored on
 * `conversations`, so we look it up via the latest message. Conservative by
 * design — scoped to one sender and confirmed against the real stored subject —
 * so it can only ever re-join a thread the same person already started.
 */
async function matchEmailBySubject(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  accountId: string,
  participantEmail: string,
  subject: string,
): Promise<{ id: string; status?: string } | null> {
  const normalized = normalizeEmailSubject(subject)
  if (!normalized) return null

  // Candidate conversations for this sender, newest activity first. Small cap —
  // we only need the few most recent to find a subject match.
  const { data: candidates } = await supabase
    .from('conversations')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('channel', 'email')
    .eq('participant_email', participantEmail)
    .in('status', ['active', 'in_progress', 'escalated', 'waiting_on_customer', 'resolved'])
    .order('last_message_at', { ascending: false })
    .limit(10)

  const list = (candidates as Array<{ id: string; status?: string }> | null) ?? []
  for (const conv of list) {
    const { data: lastMsg } = await supabase
      .from('messages')
      .select('email_subject')
      .eq('conversation_id', conv.id)
      .eq('channel', 'email')
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastSubject = normalizeEmailSubject(
      (lastMsg as { email_subject?: string | null } | null)?.email_subject ?? null,
    )
    if (lastSubject && lastSubject === normalized) {
      return { id: conv.id, status: conv.status }
    }
  }
  return null
}

/**
 * Resolve the RFC 5322 Message-ID that an outbound email reply should thread
 * against. Returns the most recent INBOUND email message's `email_message_id`
 * for the conversation (the message we're replying to), or null when there is
 * no inbound email with a stored Message-ID.
 *
 * Setting In-Reply-To / References to this value (RFC 5322 §3.6.4) makes the
 * recipient's mail client file our reply under the original thread, and lets
 * our own Sent-folder reconcile re-attach the sent copy to the correct
 * conversation by thread root instead of falling back to sender-only matching.
 * Pure read; never throws (degrades to null so sends are never blocked).
 */
export async function getReplyToMessageId(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  conversationId: string,
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('messages')
      .select('email_message_id')
      .eq('conversation_id', conversationId)
      .eq('channel', 'email')
      .eq('direction', 'inbound')
      .not('email_message_id', 'is', null)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as { email_message_id?: string | null } | null)?.email_message_id ?? null
  } catch {
    return null
  }
}

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
    /** Email subject — used for the fallback subject+sender match. */
    subject?: string | null
    participant_name?: string | null
    participant_email?: string | null
    participant_phone?: string | null
  }
): Promise<string> {
  // ── Email matching strategy (industry standard, like Gmail/Front) ──────
  // Emails are grouped by a STABLE thread root, NOT by sender. Matching order:
  //   1. (account_id, email_thread_id) — the RFC/Gmail thread root.
  //   2. normalized-subject + participant_email (optional; skipped if no
  //      subject) — catches replies whose client stripped References.
  //   3. participant_email (legacy) — last resort ONLY when no thread id was
  //      supplied at all. When a thread id IS present but doesn't match an
  //      existing row, we deliberately DO NOT fall back to sender — we create a
  //      new conversation so distinct threads stay distinct.
  const baseSelect = () =>
    supabase
      .from('conversations')
      .select('id, status')
      .eq('account_id', params.account_id)
      .eq('channel', params.channel)
      .in('status', ['active', 'in_progress', 'escalated', 'waiting_on_customer', 'resolved'])

  let existing: { id: string; status?: string } | null = null

  if (params.channel === 'email') {
    if (params.email_thread_id) {
      // 1. Match by stable thread root.
      const { data, error } = await baseSelect()
        .eq('email_thread_id', params.email_thread_id)
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(`Failed to look up conversation: ${error.message}`)
      existing = data ?? null

      // 2. Fallback: normalized-subject + sender. Only when we have both a
      // subject and a sender, and the thread-root lookup missed. This rescues
      // replies whose client dropped the References/In-Reply-To headers but
      // kept a recognizable "Re: <subject>". Subject is not stored on
      // conversations, so we confirm the match against the candidate's latest
      // message subject. Scoped to the same sender, so no cross-sender risk.
      if (!existing && params.subject && params.participant_email) {
        existing = await matchEmailBySubject(
          supabase,
          params.account_id,
          params.participant_email,
          params.subject,
        )
      }
    } else if (params.participant_email) {
      // 3. Legacy last-resort: no thread id at all → match by sender.
      const { data, error } = await baseSelect()
        .eq('participant_email', params.participant_email)
        .order('last_message_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(`Failed to look up conversation: ${error.message}`)
      existing = data ?? null
    }
  } else {
    // Non-email channels keep their original single-key lookup.
    let query = baseSelect()
    if (params.channel === 'teams' && params.teams_chat_id) {
      query = query.eq('teams_chat_id', params.teams_chat_id)
    } else if (params.channel === 'whatsapp' && params.participant_phone) {
      query = query.eq('participant_phone', params.participant_phone)
    }
    const { data, error: lookupError } = await query.limit(1).maybeSingle()
    if (lookupError) {
      throw new Error(`Failed to look up conversation: ${lookupError.message}`)
    }
    existing = data ?? null
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
      // Stamp the stable thread root so subsequent messages in this thread
      // match here (and the partial unique index enforces one row per thread).
      email_thread_id: params.email_thread_id || null,
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
    // Unique partial indexes per channel that a concurrent insert can collide
    // with. On a 23505 we re-select by the SAME key the unique index covers and
    // return the row the other writer won:
    //   teams → `conversations_teams_unique_chat` (account_id, teams_chat_id)
    //   email → `uniq_conversations_email_thread`  (account_id, email_thread_id)
    //           [migration 20260529120000 — the old sender-unique index is gone]
    // whatsapp has a unique index on participant_phone but its lookup key here
    // mirrors that column.
    const isUniqueViolation =
      (error as { code?: string } | null)?.code === '23505' ||
      /duplicate key|unique constraint/i.test(error?.message || '')
    if (isUniqueViolation) {
      type UniqueKey = { col: 'teams_chat_id' | 'email_thread_id' | 'participant_phone'; value: string | null | undefined }
      const CHANNEL_UNIQUE_KEY: Record<typeof params.channel, UniqueKey | null> = {
        teams: { col: 'teams_chat_id', value: params.teams_chat_id },
        // Email is keyed off the stable thread root now (NOT the sender).
        email: { col: 'email_thread_id', value: params.email_thread_id },
        whatsapp: { col: 'participant_phone', value: params.participant_phone },
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

/**
 * Resolves the active AI provider config for the account's company.
 *
 * Lookup order:
 *   1. `ai_config` row scoped to the account's `company_id` with `is_active=true`.
 *   2. Legacy global `ai_config` row (`company_id IS NULL AND is_active=true`)
 *      — kept as a read-only fallback for callers without a company context.
 *   3. Environment variables (`AI_API_KEY`, `AI_BASE_URL`, …).
 *
 * Any DB error is swallowed so the call falls through to env vars and the
 * caller still gets a usable config. Throws only when neither DB nor env
 * provides an API key.
 */
async function getAIConfig(accountId?: string): Promise<AIConfig> {
  try {
    const supabase = await createServiceRoleClient()

    // 1. Per-company row — only attempted when we can resolve a company_id
    // from the supplied account. Callers without an accountId fall straight
    // through to step 2 (legacy global fallback).
    let companyId: string | null = null
    if (accountId) {
      const { data: account } = await supabase
        .from('accounts')
        .select('company_id')
        .eq('id', accountId)
        .maybeSingle()
      companyId = (account as { company_id?: string | null } | null)?.company_id ?? null
    }

    if (companyId) {
      const { data: scoped } = await supabase
        .from('ai_config')
        .select('base_url, api_key, model, max_tokens, temperature')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (scoped?.api_key) {
        return {
          base_url: scoped.base_url,
          api_key: scoped.api_key,
          model: scoped.model,
          max_tokens: scoped.max_tokens,
          temperature: Number(scoped.temperature),
        }
      }
    }

    // 2. Legacy global fallback. We use `.is('company_id', null)` so the
    // result excludes per-company rows — important because the partial
    // unique index allows exactly ONE active global row.
    const { data: legacy } = await supabase
      .from('ai_config')
      .select('base_url, api_key, model, max_tokens, temperature')
      .is('company_id', null)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (legacy?.api_key) {
      return {
        base_url: legacy.base_url,
        api_key: legacy.api_key,
        model: legacy.model,
        max_tokens: legacy.max_tokens,
        temperature: Number(legacy.temperature),
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

  const config = await getAIConfig(ctx.account_id)
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
      // Prefer the structured status field if the upstream client surfaced
      // one. The previous \b5\d{2}\b text-match would falsely flag any
      // error message that happened to contain a 3-digit run starting with
      // 5 (e.g. "502abc" in a body excerpt, request ids, etc.) as retryable.
      const errStatus =
        typeof err?.status === 'number'
          ? err.status
          : typeof err?.statusCode === 'number'
            ? err.statusCode
            : null
      const isHttp5xxByStatus = errStatus !== null && errStatus >= 500 && errStatus < 600
      // Fallback to a tighter text match for callers (like the fetch wrapper
      // below) that fold the status into the error message text. The shape
      // we throw upstream is `AI API error (NNN): ...` — anchor on that.
      const isHttp5xxByMessage =
        !!err.message && /\bAI API error \(5\d{2}\)|\bHTTP\s?5\d{2}\b|status[\s:]+5\d{2}\b/i.test(err.message)
      const isRetryable = isTimeout || isHttp5xxByStatus || isHttp5xxByMessage

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
