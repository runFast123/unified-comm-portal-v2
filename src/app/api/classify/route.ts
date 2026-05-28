import { NextResponse } from 'next/server'
import { createServiceRoleClient, createServerSupabaseClient } from '@/lib/supabase-server'
import { callAI, getAccountSettings, checkRateLimit } from '@/lib/api-helpers'
import { AIBudgetExceededError } from '@/lib/ai-usage'
import { CircuitBreakerOpenError } from '@/lib/ai-circuit-breaker'
import { logInfo, logError } from '@/lib/logger'
import { getRequestId } from '@/lib/request-id'
import type { Category, Sentiment, Urgency } from '@/types/database'

const DEFAULT_CLASSIFICATION_PROMPT = `You are a customer message classifier for a telecommunications company. Analyze the customer message and return a JSON object with the following fields:

- category: one of "Sales Inquiry", "Trouble Ticket", "Payment Issue", "Service Problem", "Technical Issue", "Billing Question", "Connection Issue", "Rate Issue", "General Inquiry", "Newsletter/Marketing"
- subcategory: a more specific label within the category
- sentiment: one of "positive", "neutral", "negative"
- urgency: one of "low", "medium", "high", "urgent"
- topic_summary: a brief 1-sentence summary of the customer's issue
- confidence: a number between 0 and 1 indicating your confidence in the classification

Return ONLY the JSON object, no markdown formatting or additional text.`

// ─── auto_resolve_marketing toggle cache ──────────────────────────────
// Newsletters re-classify often; reading the toggle from DB on every call
// adds an unnecessary round-trip. Cache the boolean per-company for 60s —
// long enough to matter under load, short enough that toggling in the admin
// UI takes effect quickly. Module-level state is per-Lambda instance which
// is fine: cold starts re-read from DB.
//
// Multi-tenant: ai_config has a row per company (migration
// 20260528100000_ai_config_per_company), so this lookup must be scoped by
// the calling account's company_id, NOT read the first active row globally.
const autoResolveMarketingCache = new Map<string, { value: boolean; expiresAt: number }>()
const AUTO_RESOLVE_TTL_MS = 60_000

async function isAutoResolveMarketingEnabled(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  accountId: string
): Promise<boolean> {
  const now = Date.now()
  const cached = autoResolveMarketingCache.get(accountId)
  if (cached && cached.expiresAt > now) return cached.value
  try {
    // Resolve account → company_id, then read THAT company's active ai_config.
    const { data: acct } = await supabase
      .from('accounts')
      .select('company_id')
      .eq('id', accountId)
      .maybeSingle()
    const companyId = acct?.company_id as string | null | undefined
    if (!companyId) {
      // No company context — fail closed (don't auto-resolve).
      autoResolveMarketingCache.set(accountId, { value: false, expiresAt: now + AUTO_RESOLVE_TTL_MS })
      return false
    }
    const { data } = await supabase
      .from('ai_config')
      .select('auto_resolve_marketing')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const value = !!data?.auto_resolve_marketing
    autoResolveMarketingCache.set(accountId, { value, expiresAt: now + AUTO_RESOLVE_TTL_MS })
    return value
  } catch {
    return false // fail closed: don't auto-resolve on DB error
  }
}

export async function POST(request: Request) {
  const requestId = await getRequestId()
  const startedAt = Date.now()
  try {
    // Allow internal calls (from webhook handlers) via webhook secret, or authenticated users
    const webhookSecret = request.headers.get('x-webhook-secret')
    const expectedSecret = process.env.WEBHOOK_SECRET
    const isInternalCall = !!expectedSecret && webhookSecret === expectedSecret

    let authenticatedUserId: string | null = null

    if (!isInternalCall) {
      // Check for authenticated user session
      const supabase = await createServerSupabaseClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      authenticatedUserId = user.id
    }

    const body = await request.json()
    const { message_id, message_text, channel, account_id } = body

    if (!message_id || !message_text || !account_id) {
      return NextResponse.json(
        { error: 'Missing required fields: message_id, message_text, account_id' },
        { status: 400 }
      )
    }

    // Rate limit per account
    if (!(await checkRateLimit(`classify:${account_id}`, 100, 60))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    // Verify user has access to the requested account (skip for internal/webhook calls)
    if (authenticatedUserId) {
      const { verifyAccountAccess } = await import('@/lib/api-helpers')
      const hasAccess = await verifyAccountAccess(authenticatedUserId, account_id)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Access denied to this account' }, { status: 403 })
      }
    }

    // Validate channel — reject invalid values
    const VALID_CHANNELS = ['email', 'teams', 'whatsapp'] as const
    if (!channel || !VALID_CHANNELS.includes(channel)) {
      return NextResponse.json(
        { error: `Invalid or missing channel "${channel}". Valid channels: ${VALID_CHANNELS.join(', ')}` },
        { status: 400 }
      )
    }
    const validatedChannel = channel

    const supabaseForAccount = await createServiceRoleClient()

    // Get account info for context
    let accountName = 'Unknown'
    let accountCompanyId: string | null = null
    try {
      const account = await getAccountSettings(supabaseForAccount, account_id)
      accountName = account.name || 'Unknown'
      accountCompanyId = account.company_id ?? null
    } catch { /* use default */ }

    // Call AI API for classification with account context
    const classificationPrompt = `${DEFAULT_CLASSIFICATION_PROMPT}\n\nThis message was received by the company "${accountName}". Use this context to better understand the message intent.`
    const userMessage = `Channel: ${validatedChannel}\nMessage: ${message_text}`
    let rawResponse: string
    try {
      rawResponse = await callAI(classificationPrompt, userMessage, {
        account_id,
        endpoint: 'classify',
        request_id: requestId,
      })
    } catch (err) {
      if (err instanceof AIBudgetExceededError) {
        logError('ai', 'budget_exceeded_classify', err.message, {
          request_id: requestId,
          account_id,
          monthly_total_usd: err.monthly_total_usd,
          budget_usd: err.budget_usd,
        })
        return NextResponse.json(
          {
            error: 'AI budget exceeded for this account',
            skipped: true,
            monthly_total_usd: err.monthly_total_usd,
            budget_usd: err.budget_usd,
            retry_after: 'next month',
          },
          { status: 200 }
        )
      }
      if (err instanceof CircuitBreakerOpenError) {
        // AI provider is in a known-bad state — short-circuit gracefully so
        // the webhook keeps moving. Cron retries / next inbound will reopen
        // the circuit if upstream recovers.
        logError('ai', 'breaker_open_classify', err.message, {
          request_id: requestId,
          account_id,
          message_id,
        })
        return NextResponse.json(
          {
            skipped: true,
            reason: 'ai_provider_unavailable',
          },
          { status: 200 }
        )
      }
      throw err
    }

    // Parse the JSON response from Claude
    let classification: {
      category: Category
      subcategory: string | null
      sentiment: Sentiment
      urgency: Urgency
      topic_summary: string | null
      confidence: number
    }

    try {
      // Try to extract JSON from the response (handle potential markdown wrapping)
      // Use a balanced brace matcher to find the first valid JSON object
      let jsonStr = ''
      const startIdx = rawResponse.indexOf('{')
      if (startIdx === -1) throw new Error('No JSON found in AI response')
      let depth = 0
      for (let i = startIdx; i < rawResponse.length; i++) {
        if (rawResponse[i] === '{') depth++
        if (rawResponse[i] === '}') depth--
        if (depth === 0) {
          jsonStr = rawResponse.substring(startIdx, i + 1)
          break
        }
      }
      if (!jsonStr) throw new Error('No complete JSON object found in AI response')
      classification = JSON.parse(jsonStr)
    } catch (parseError) {
      console.error('Failed to parse AI classification response:', parseError, rawResponse)
      // Return a fallback classification with low confidence so it gets flagged for review
      console.warn(`[CLASSIFY] Fallback classification used for message_id=${message_id} — AI response was unparseable`)
      classification = {
        category: 'General Inquiry',
        subcategory: null,
        sentiment: 'neutral',
        urgency: 'medium',
        topic_summary: message_text.substring(0, 100),
        confidence: 0.1, // Very low confidence to flag for human review
      }
    }

    // Validate AI output against allowed enum values
    const validCategories = ['Sales Inquiry', 'Trouble Ticket', 'Payment Issue', 'Service Problem', 'Technical Issue', 'Billing Question', 'Connection Issue', 'Rate Issue', 'General Inquiry', 'Newsletter/Marketing']
    const validSentiments = ['positive', 'neutral', 'negative']
    const validUrgencies = ['low', 'medium', 'high', 'urgent']
    if (!validCategories.includes(classification.category)) classification.category = 'General Inquiry'
    if (!validSentiments.includes(classification.sentiment)) classification.sentiment = 'neutral'
    if (!validUrgencies.includes(classification.urgency)) classification.urgency = 'medium'
    if (typeof classification.confidence !== 'number' || classification.confidence < 0 || classification.confidence > 1) classification.confidence = 0.5

    const supabase = supabaseForAccount

    // Store classification in message_classifications table
    const { data: stored, error: storeError } = await supabase
      .from('message_classifications')
      .insert({
        message_id,
        category: classification.category,
        subcategory: classification.subcategory || null,
        sentiment: classification.sentiment,
        urgency: classification.urgency,
        topic_summary: classification.topic_summary || null,
        confidence: classification.confidence,
        classified_at: new Date().toISOString(),
      })
      .select('*')
      .single()

    if (storeError) {
      console.error('Failed to store classification:', storeError)
      return NextResponse.json(
        { error: 'Failed to store classification' },
        { status: 500 }
      )
    }

    // Fetch conversation_id once for routing and escalation logic
    let routingConversationId: string | null = null
    {
      const { data: msgForRouting } = await supabase
        .from('messages')
        .select('conversation_id')
        .eq('id', message_id)
        .maybeSingle()
      routingConversationId = msgForRouting?.conversation_id || null
    }

    // AI Conversation Routing: auto-assign urgent/high messages to least-loaded admin
    if ((classification.urgency === 'urgent' || classification.urgency === 'high') && classification.category !== 'Newsletter/Marketing') {
      try {
        if (routingConversationId) {
          const msg = { conversation_id: routingConversationId }
          // Check if conversation is already assigned
          const { data: conv } = await supabase
            .from('conversations')
            .select('assigned_to')
            .eq('id', msg.conversation_id)
            .maybeSingle()

          if (conv && !conv.assigned_to) {
            // Find least-loaded active agent — scoped to the same company
            // as the originating account so we never auto-assign cross-tenant.
            let agentsQuery = supabase
              .from('users')
              .select('id, full_name')
              .eq('is_active', true)
              .in('role', ['admin', 'reviewer'])
            if (accountCompanyId) {
              agentsQuery = agentsQuery.eq('company_id', accountCompanyId)
            }
            const { data: agents } = await agentsQuery

            if (agents && agents.length > 0) {
              // Count active conversations per agent
              const agentLoads = await Promise.all(
                agents.map(async (agent: any) => {
                  const { count } = await supabase
                    .from('conversations')
                    .select('id', { count: 'exact', head: true })
                    .eq('assigned_to', agent.id)
                    .in('status', ['active', 'in_progress', 'escalated'])
                  return { id: agent.id, name: agent.full_name, load: count || 0 }
                })
              )
              const leastLoaded = agentLoads.sort((a, b) => a.load - b.load)[0]
              if (leastLoaded) {
                await supabase
                  .from('conversations')
                  .update({ assigned_to: leastLoaded.id })
                  .eq('id', msg.conversation_id)
                console.log(`[AUTO-ROUTE] Conversation ${msg.conversation_id} assigned to ${leastLoaded.name} (${leastLoaded.load} active)`)
              }
            }
          }
        }
      } catch (routeErr) {
        console.error('Auto-routing failed:', routeErr)
      }
    }

    // If AI classified as Newsletter/Marketing with high confidence, mark as spam
    if (classification.category === 'Newsletter/Marketing' && classification.confidence > 0.7) {
      const { error: spamUpdateError } = await supabase
        .from('messages')
        .update({
          is_spam: true,
          spam_reason: 'ai_classified_newsletter',
          reply_required: false,
          replied: true, // prevents message from counting as pending
        })
        .eq('id', message_id)

      if (spamUpdateError) {
        console.error('Failed to update message spam status after AI classification:', spamUpdateError)
      }

      // If ai_config.auto_resolve_marketing is enabled, also resolve the
      // conversation so it drops out of the active inbox entirely.
      try {
        if (routingConversationId && (await isAutoResolveMarketingEnabled(supabase, account_id))) {
          await supabase
            .from('conversations')
            .update({ status: 'resolved' })
            .eq('id', routingConversationId)
            .in('status', ['active', 'in_progress', 'waiting_on_customer'])
          logInfo('ai', 'auto_resolved_newsletter', `Auto-resolved conversation ${routingConversationId} (newsletter)`, { message_id, conversation_id: routingConversationId })
        }
      } catch (resErr) {
        console.error('Auto-resolve newsletter conversation failed:', resErr)
      }
    }

    // Auto-escalate: if sentiment is negative AND urgency is high/urgent, escalate the conversation
    if (classification.sentiment === 'negative' && (classification.urgency === 'high' || classification.urgency === 'urgent')) {
      try {
        if (routingConversationId) {
          const msg = { conversation_id: routingConversationId }
          // Check if conversation is already escalated
          const { data: conv } = await supabase
            .from('conversations')
            .select('status')
            .eq('id', msg.conversation_id)
            .maybeSingle()

          if (conv && conv.status !== 'escalated') {
            await supabase
              .from('conversations')
              .update({ status: 'escalated', priority: 'urgent' })
              .eq('id', msg.conversation_id)
            console.log(`[AUTO-ESCALATE] Conversation ${msg.conversation_id} escalated: negative sentiment + ${classification.urgency} urgency`)

            // Trigger urgent notification for escalation
            try {
              const { triggerNotifications } = await import('@/lib/notification-service')
              await triggerNotifications(supabase, {
                id: message_id,
                conversation_id: msg.conversation_id,
                account_id,
                account_name: accountName,
                channel: validatedChannel as 'email' | 'teams' | 'whatsapp',
                sender_name: null,
                email_subject: null,
                message_text: `[AUTO-ESCALATED] Negative sentiment detected — ${classification.topic_summary || 'Customer is unhappy'}`,
                is_spam: false,
                priority: 'urgent',
              })
            } catch { /* non-critical */ }
          }
        }
      } catch (escErr) {
        console.error('Auto-escalation failed:', escErr)
      }
    }

    logInfo('ai', 'classify', `Classified as ${classification.category} / ${classification.sentiment}`, {
      request_id: requestId,
      message_id,
      account_id,
      category: classification.category,
      sentiment: classification.sentiment,
      confidence: classification.confidence,
      duration_ms: Date.now() - startedAt,
    })
    return NextResponse.json(stored, { status: 200 })
  } catch (error) {
    logError('ai', 'classify_error', error instanceof Error ? error.message : 'Unknown error', {
      request_id: requestId,
      duration_ms: Date.now() - startedAt,
    })
    return NextResponse.json(
      { error: 'Internal server error', request_id: requestId },
      { status: 500 }
    )
  }
}
