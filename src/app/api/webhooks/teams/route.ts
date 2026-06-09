import { NextResponse, after } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { logInfo, logError } from '@/lib/logger'
import {
  validateWebhookSecret,
  checkRateLimit,
  findOrCreateConversation,
  getAccountSettings,
} from '@/lib/api-helpers'
import { evaluateRouting, applyRoutingResult } from '@/lib/routing-engine'
import { getRequestId, REQUEST_ID_HEADER } from '@/lib/request-id'
import { isAccountOOO, shouldSendOOOReply, recordOOOReply, substituteOOOVariables } from '@/lib/ooo'
import { sendTeams } from '@/lib/channel-sender'
import { parseTeamsInbound } from '@/lib/channels/inbound'

export async function POST(request: Request) {
  const requestId = await getRequestId()
  try {
    // Validate webhook secret
    if (!validateWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 })
    }

    const body = await request.json()

    // Accept webhook payload format
    const {
      account_id,
      sender_name,
      sender_email,
      message_text,
      teams_message_id,
      teams_chat_id,
      team_name,
      channel_name,
      message_type,
      timestamp,
      attachments,
      is_reply,
      parent_message_id,
      is_agent_message,
    } = body

    if (!account_id) {
      return NextResponse.json(
        { error: 'Missing required field: account_id', request_id: requestId },
        { status: 400 }
      )
    }

    // Rate limit per account
    if (!(await checkRateLimit(`teams_${account_id}`, 100, 60))) {
      return NextResponse.json(
        { error: 'Rate limit exceeded', request_id: requestId },
        { status: 429 }
      )
    }

    if (!sender_name || (typeof sender_name === 'string' && sender_name.trim().length === 0)) {
      return NextResponse.json(
        { error: 'Missing or empty required field: sender_name', request_id: requestId },
        { status: 400 }
      )
    }

    if (!message_text || (typeof message_text === 'string' && message_text.trim().length === 0)) {
      return NextResponse.json(
        { error: 'Missing or empty required field: message_text', request_id: requestId },
        { status: 400 }
      )
    }

    // Guard the conversation-grouping key: without teams_chat_id,
    // findOrCreateConversation falls back to "any active Teams conversation" and
    // would mis-group this message into an unrelated thread. All real Teams
    // payloads carry it (matches the Telegram/Messenger/Instagram guards).
    if (!teams_chat_id || (typeof teams_chat_id === 'string' && teams_chat_id.trim().length === 0)) {
      return NextResponse.json(
        { error: 'Missing or empty required field: teams_chat_id', request_id: requestId },
        { status: 400 }
      )
    }

    // Normalize into the canonical InboundMessage (truncation, message_type,
    // agent/customer role -> sender_type/direction/replied). The per-channel
    // parse lives in src/lib/channels/inbound.ts; messageText is aliased so the
    // dedup / dispatch below read the same value as before.
    const inbound = parseTeamsInbound({
      account_id,
      sender_name,
      sender_email,
      message_text,
      teams_message_id,
      teams_chat_id,
      message_type,
      timestamp,
      attachments,
      is_agent_message,
    })
    const messageText = inbound.message_text

    const supabase = await createServiceRoleClient()

    // Verify account exists and is active
    const { data: accountRow, error: accountError } = await supabase
      .from('accounts')
      .select('id, name, company_id, is_active, ooo_enabled, ooo_starts_at, ooo_ends_at, ooo_subject, ooo_body')
      .eq('id', account_id)
      .single()

    if (accountError || !accountRow) {
      return NextResponse.json(
        { error: 'Account not found', request_id: requestId },
        { status: 404 }
      )
    }

    if (!accountRow.is_active) {
      return NextResponse.json(
        { error: 'Account is not active', request_id: requestId },
        { status: 403 }
      )
    }

    // Dedup check 1: skip if this teams_message_id already exists for this account
    if (teams_message_id) {
      const { data: existingMsg } = await supabase
        .from('messages')
        .select('id')
        .eq('account_id', account_id)
        .eq('teams_message_id', teams_message_id)
        .limit(1)
        .maybeSingle()

      if (existingMsg) {
        return NextResponse.json(
          { message: 'Duplicate - already processed', message_id: existingMsg.id },
          { status: 200 }
        )
      }
    }

    // Dedup check 2: skip if an outbound message with same text exists in same
    // conversation recently (prevents re-capturing portal-sent replies from Teams)
    if (messageText && teams_chat_id) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      const { data: recentOutbound } = await supabase
        .from('messages')
        .select('id')
        .eq('account_id', account_id)
        .eq('direction', 'outbound')
        .like('message_text', messageText.substring(0, 100).replace(/%/g, '\\%').replace(/_/g, '\\_') + '%')
        .gte('timestamp', fiveMinAgo)
        .limit(1)
        .maybeSingle()

      if (recentOutbound) {
        return NextResponse.json(
          { message: 'Duplicate - outbound reply already recorded', message_id: recentOutbound.id },
          { status: 200 }
        )
      }
    }

    // Find or create conversation using teams_chat_id + sender_email for lookup
    const conversationId = await findOrCreateConversation(supabase, {
      account_id,
      channel: 'teams',
      teams_chat_id: teams_chat_id || null,
      participant_name: sender_name || null,
      participant_email: sender_email || null,
    })

    // Agent (company user replying in Teams) vs customer — already derived in
    // the parser; the agent short-circuit below still needs the boolean.
    const isAgent = inbound.sender_type === 'agent'

    // Store message in messages table
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        account_id,
        channel: inbound.channel,
        teams_message_id: inbound.teams_message_id,
        sender_name: inbound.sender_name,
        sender_type: inbound.sender_type,
        message_text: inbound.message_text,
        message_type: inbound.message_type,
        direction: inbound.direction,
        attachments: inbound.attachments,
        replied: inbound.replied,
        reply_required: inbound.reply_required,
        timestamp: inbound.timestamp || new Date().toISOString(),
        received_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (msgError || !message) {
      logError('webhook', 'teams_store_failed', msgError?.message || 'unknown insert failure', {
        request_id: requestId,
        account_id,
      })
      return NextResponse.json(
        { error: 'Failed to store message', request_id: requestId },
        { status: 500 }
      )
    }

    // Stamp the account so /admin/channels shows a current "Last synced"
    // for Teams accounts whose mail mostly arrives via Graph subscription
    // webhooks rather than the polling cron. Mirrors email-ingest's
    // bumpLastPolledAt() — fire-and-forget; never block the webhook.
    void supabase
      .from('accounts')
      .update({
        last_polled_at: new Date().toISOString(),
        consecutive_poll_failures: 0,
        last_poll_error: null,
        last_poll_error_at: null,
      })
      .eq('id', account_id)
      .then(() => undefined, () => undefined)

    // Skip AI processing and notifications for agent messages
    if (isAgent) {
      // If agent message, also mark the inbound messages in this conversation as replied
      await supabase
        .from('messages')
        .update({ replied: true })
        .eq('conversation_id', conversationId)
        .eq('direction', 'inbound')
        .eq('replied', false)

      return NextResponse.json(
        { message_id: message.id, conversation_id: conversationId, is_agent: true, request_id: requestId },
        { status: 201 }
      )
    }

    // Routing rules — only for inbound (customer) messages, before AI dispatch.
    // Fail-soft: a routing-engine error must NOT block the webhook from
    // returning success.
    try {
      const routingResult = await evaluateRouting({
        channel: 'teams',
        account_id,
        sender_email: sender_email || null,
        sender_phone: null,
        subject: null,
        message_text: messageText,
      })
      if (routingResult.matched_rule_ids.length > 0) {
        const applied = await applyRoutingResult(supabase, conversationId, routingResult)
        logInfo('webhook', 'rule_matched', `Routing matched ${routingResult.matched_rule_ids.length} rule(s)`, {
          request_id: requestId,
          account_id,
          message_id: message.id,
          conversation_id: conversationId,
          matched_rule_ids: routingResult.matched_rule_ids,
          applied,
        })
      }
    } catch (routingErr) {
      logError('webhook', 'routing_failed', routingErr instanceof Error ? routingErr.message : 'unknown', {
        request_id: requestId,
        account_id,
        message_id: message.id,
      })
    }

    // Trigger notifications for customer messages only (async, non-blocking)
    try {
      const { triggerNotifications } = await import('@/lib/notification-service')
      triggerNotifications(supabase, {
        id: message.id,
        conversation_id: conversationId,
        account_id: account_id,
        account_name: accountRow.name || 'Unknown',
        channel: 'teams',
        sender_name: sender_name || sender_email || null,
        email_subject: null,
        message_text: messageText?.substring(0, 200) || null,
        is_spam: false,
      }).catch(err => console.error('Notification trigger failed:', err))
    } catch (notifErr) {
      console.error('Failed to load notification service:', notifErr)
    }

    // ── Out-of-office auto-reply ────────────────────────────────────
    // Mirrors the email-ingest hook. Fires at most once per conversation
    // per OOO window; only for inbound (customer) messages — agent messages
    // already short-circuited above. Send is fire-and-forget via after()
    // so the webhook stays fast.
    if (isAccountOOO(accountRow) && teams_chat_id) {
      const windowStart = accountRow.ooo_starts_at ?? null
      const isFirst = await shouldSendOOOReply(supabase, account_id, conversationId, windowStart)
      if (isFirst) {
        let companyName: string | null = null
        if (accountRow.company_id) {
          const { data: companyRow } = await supabase
            .from('companies')
            .select('name')
            .eq('id', accountRow.company_id)
            .maybeSingle()
          companyName = companyRow?.name ?? null
        }
        const bodyText = substituteOOOVariables(accountRow.ooo_body || '', {
          customer: { name: sender_name, email: sender_email },
          company: { name: companyName },
          ooo: { ends_at: accountRow.ooo_ends_at },
        })
        const reserved = await recordOOOReply(supabase, account_id, conversationId, windowStart)
        if (reserved) {
          after(async () => {
            try {
              const result = await sendTeams({
                accountId: account_id,
                chatId: teams_chat_id,
                body: bodyText || 'I am currently out of office and will respond when I return.',
              })
              if (!result.ok) {
                logError('webhook', 'ooo_reply_send_failed', result.error, {
                  request_id: requestId,
                  account_id,
                  conversation_id: conversationId,
                })
              } else {
                logInfo('webhook', 'ooo_reply_sent', `OOO auto-reply sent to chat ${teams_chat_id}`, {
                  request_id: requestId,
                  account_id,
                  conversation_id: conversationId,
                  provider_message_id: result.provider_message_id,
                })
              }
            } catch (sendErr) {
              logError('webhook', 'ooo_reply_send_failed', sendErr instanceof Error ? sendErr.message : 'unknown', {
                request_id: requestId,
                account_id,
                conversation_id: conversationId,
              })
            }
          })
        }
      }
    }

    // Get account settings for phase flags
    const account = await getAccountSettings(supabase, account_id)
    const origin = new URL(request.url).origin
    // Forward request id to classify + ai-reply so the full pipeline shares
    // one correlation id (see email webhook for the same pattern).
    const headers = {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
      [REQUEST_ID_HEADER]: requestId,
    }

    // Phase 1 + 2 fire asynchronously via `after()` so the webhook returns in
    // ~100ms and the poller can move to the next chat message instead of
    // blocking 30s per message on AI calls. Same pattern used in the email
    // webhook. Trade-off: phase-2 may run even if phase-1 would have labelled
    // the message Newsletter/Marketing — the AI reply just sits as
    // pending_approval; admin can reject. Not worth serialising phases.
    if (account.phase1_enabled) {
      after(() =>
        fetch(`${origin}/api/classify`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message_id: message.id,
            message_text: messageText,
            channel: 'teams',
            account_id,
          }),
        }).catch((err) =>
          console.error(
            `Phase 1 classify dispatch failed [message_id=${message.id}]:`,
            err instanceof Error ? err.message : err
          )
        )
      )
    }

    if (account.phase2_enabled) {
      after(() =>
        fetch(`${origin}/api/ai-reply`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message_id: message.id,
            message_text: messageText,
            channel: 'teams',
            account_id,
            conversation_id: conversationId,
          }),
        }).catch((err) =>
          console.error(
            `Phase 2 AI reply dispatch failed [message_id=${message.id}]:`,
            err instanceof Error ? err.message : err
          )
        )
      )
    }

    logInfo('webhook', 'teams_received', `Teams message from ${sender_name}`, {
      request_id: requestId,
      account_id,
      message_id: message.id,
    })
    return NextResponse.json(
      { message_id: message.id, conversation_id: conversationId, request_id: requestId },
      { status: 201 }
    )
  } catch (error) {
    logError('webhook', 'teams_inbound', error instanceof Error ? error.message : 'Unknown error', {
      request_id: requestId,
    })
    return NextResponse.json(
      { error: 'Internal server error', request_id: requestId },
      { status: 500 }
    )
  }
}
