import crypto from 'crypto'
import { createServiceRoleClient } from '@/lib/supabase-server'
import type { Account } from '@/types/database'

// ─── Rate Limiter ───────────────────────────────────────────────────
const rateLimitStore = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX = 100 // max requests per window per key

export function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const entry = rateLimitStore.get(key)

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false // rate limited
  }

  entry.count++
  return true
}

// Clean up stale entries every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of rateLimitStore) {
      if (now > entry.resetAt) rateLimitStore.delete(key)
    }
  }, 300_000)
}

// ─── Webhook Secret Validation ──────────────────────────────────────
/**
 * Validates the X-Webhook-Secret header using timing-safe comparison.
 */
export function validateWebhookSecret(request: Request): boolean {
  const secret = request.headers.get('x-webhook-secret')
  const expectedSecret = process.env.N8N_WEBHOOK_SECRET
  if (!expectedSecret) {
    console.error('N8N_WEBHOOK_SECRET is not configured')
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
    throw new Error(`Failed to create conversation: ${error?.message}`)
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
 * Calls any OpenAI-compatible AI API with timeout and retry logic.
 */
export async function callAI(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const config = await getAIConfig()
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)

      const response = await fetch(`${config.base_url}/chat/completions`, {
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

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(`AI API error (${response.status}): ${errorBody.substring(0, 200)}`)
      }

      const data = await response.json()
      return data.choices?.[0]?.message?.content || ''
    } catch (err: any) {
      lastError = err
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

  throw lastError || new Error('AI call failed after all retries')
}

// ─── Account Access Verification ────────────────────────────────────
/**
 * Verifies that a user has access to a specific account.
 * - Admins can access all accounts.
 * - Non-admin users can only access their own account (users.account_id).
 * Returns true if access is allowed, false otherwise.
 */
export async function verifyAccountAccess(
  userId: string,
  accountId: string
): Promise<boolean> {
  const supabase = await createServiceRoleClient()
  const { data: user, error } = await supabase
    .from('users')
    .select('role, account_id')
    .eq('id', userId)
    .maybeSingle()

  if (error || !user) {
    return false
  }

  // Admins can access all accounts
  if (user.role === 'admin') {
    return true
  }

  // Non-admin users can access their own account + sibling channel accounts
  if (user.account_id === accountId) {
    return true
  }

  // Check sibling accounts (same company, different channel)
  if (user.account_id) {
    const { data: myAccount } = await supabase.from('accounts').select('name').eq('id', user.account_id).maybeSingle()
    if (myAccount?.name) {
      const baseName = myAccount.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
      const { data: targetAccount } = await supabase.from('accounts').select('name').eq('id', accountId).maybeSingle()
      if (targetAccount?.name) {
        const targetBase = targetAccount.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
        if (baseName === targetBase) return true
      }
    }
  }

  return false
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
