import { NextResponse } from 'next/server'
import { createServiceRoleClient, createServerSupabaseClient } from '@/lib/supabase-server'
import { callAI, getAccountSettings } from '@/lib/api-helpers'
import type { ChannelType, AIReplyStatus } from '@/types/database'

const CHANNEL_SYSTEM_PROMPTS: Record<ChannelType, string> = {
  email: `You are a professional customer service agent replying to a customer email for a telecommunications company.
Write your reply in formal business email format. Be thorough, polite, and address all points raised.
Include a proper greeting and sign-off. Provide specific next steps when applicable.`,

  teams: `You are a professional customer service agent replying via Microsoft Teams for a telecommunications company.
Write in a professional but conversational tone. Be concise yet helpful.
Use short paragraphs. No need for formal email sign-offs.`,

  whatsapp: `You are a friendly customer service agent replying via WhatsApp for a telecommunications company.
Keep your reply short, friendly, and under 200 words. Use simple language.
Be direct and helpful. You can use a warm but professional tone.`,
}

export async function POST(request: Request) {
  try {
    // Allow internal calls (from webhook handlers) via webhook secret, or authenticated users
    const webhookSecret = request.headers.get('x-webhook-secret')
    const expectedSecret = process.env.N8N_WEBHOOK_SECRET
    const isInternalCall = webhookSecret === expectedSecret

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
    const { message_id, message_text, channel, account_id, conversation_id } = body

    if (!message_id || !message_text || !account_id || !conversation_id) {
      return NextResponse.json(
        {
          error:
            'Missing required fields: message_id, message_text, account_id, conversation_id',
        },
        { status: 400 }
      )
    }

    // Verify user has access to the requested account (skip for internal/webhook calls)
    if (authenticatedUserId) {
      const { verifyAccountAccess } = await import('@/lib/api-helpers')
      const hasAccess = await verifyAccountAccess(authenticatedUserId, account_id)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Access denied to this account' }, { status: 403 })
      }
    }

    const supabase = await createServiceRoleClient()

    // Verify conversation belongs to the given account
    const { data: convCheck, error: convCheckError } = await supabase
      .from('conversations')
      .select('account_id')
      .eq('id', conversation_id)
      .maybeSingle()

    if (convCheckError) {
      console.error('Failed to verify conversation ownership:', convCheckError)
      return NextResponse.json({ error: 'Failed to verify conversation' }, { status: 500 })
    }

    if (!convCheck) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    if (convCheck.account_id !== account_id) {
      return NextResponse.json({ error: 'Conversation does not belong to this account' }, { status: 403 })
    }

    // Fetch account settings
    const account = await getAccountSettings(supabase, account_id)

    // Build system prompt: admin's custom prompt takes priority, falls back to channel default
    const channelKey = (channel as ChannelType) || 'email'
    let systemPrompt: string

    if (account.ai_system_prompt && account.ai_system_prompt.trim().length > 0) {
      // Admin has set a custom prompt — use it as the PRIMARY instruction
      systemPrompt = account.ai_system_prompt
    } else {
      // No custom prompt set — use the built-in channel default
      systemPrompt = CHANNEL_SYSTEM_PROMPTS[channelKey] || CHANNEL_SYSTEM_PROMPTS.email
    }

    // Add account context so AI knows which company it's responding for
    systemPrompt += `\n\nYou are replying on behalf of "${account.name}". Always maintain this company identity in your response.`

    // Fetch relevant Knowledge Base articles scoped to this account + general articles
    const { data: kbArticles } = await supabase
      .from('kb_articles')
      .select('id, title, content, category')
      .eq('is_active', true)
      .or(`account_id.eq.${account_id},account_id.is.null`)
      .limit(10)

    let kbContext = ''
    const matchedKbIds: string[] = []
    if (kbArticles && kbArticles.length > 0) {
      // Simple keyword matching — find articles relevant to the message
      const msgLower = (message_text || '').toLowerCase()
      const relevantArticles = kbArticles.filter((kb: any) => {
        if (!kb.title || !kb.content) return false
        const titleWords = kb.title.toLowerCase().split(/\s+/)
        const contentWords = kb.content.toLowerCase().substring(0, 500).split(/\s+/)
        const allWords = [...titleWords, ...contentWords]
        // Match if any significant word (>3 chars) from the article appears in the message
        return allWords.some((w: string) => w.length > 3 && msgLower.includes(w))
      }).slice(0, 3) // Max 3 articles to avoid prompt overflow

      if (relevantArticles.length > 0) {
        kbContext = '\n\n--- Knowledge Base Reference ---\nUse the following knowledge base articles to inform your reply. Prefer information from these articles over general knowledge:\n\n'
        relevantArticles.forEach((kb: any, i: number) => {
          kbContext += `[Article ${i + 1}: ${kb.title}]\n${kb.content.substring(0, 1000)}\n\n`
          matchedKbIds.push(kb.id)
        })
        kbContext += '--- End Knowledge Base ---\n'
      }
    }

    systemPrompt += kbContext

    // Fetch company-specific imported data from Google Sheets
    let sheetContext = ''
    try {
      const { data: importedRecords } = await supabase
        .from('imported_records')
        .select('entity_name, category, data_json')
        .or(`account_id.eq.${account_id},account_id.is.null`)
        .order('imported_at', { ascending: false })
        .limit(20)

      if (importedRecords && importedRecords.length > 0) {
        // Simple keyword matching — find records relevant to the message
        const msgLower = (message_text || '').toLowerCase()
        const relevantRecords = importedRecords.filter((rec: any) => {
          const nameWords = (rec.entity_name || '').toLowerCase().split(/\s+/)
          const catWords = (rec.category || '').toLowerCase().split(/\s+/)
          const dataStr = JSON.stringify(rec.data_json || {}).toLowerCase().substring(0, 500)
          const allWords = [...nameWords, ...catWords]
          return allWords.some((w: string) => w.length > 3 && msgLower.includes(w)) ||
            dataStr.split(/\s+/).some((w: string) => w.length > 4 && msgLower.includes(w))
        }).slice(0, 5) // Max 5 records

        if (relevantRecords.length > 0) {
          sheetContext = '\n\n--- Company Data Reference ---\nUse the following company data records to inform your reply:\n\n'
          relevantRecords.forEach((rec: any, i: number) => {
            const dataEntries = Object.entries(rec.data_json || {})
              .filter(([, v]) => v != null && v !== '')
              .map(([k, v]) => `  ${k}: ${String(v).substring(0, 200)}`)
              .join('\n')
            sheetContext += `[Record ${i + 1}: ${rec.entity_name || rec.category || 'Data'}]\n${dataEntries}\n\n`
          })
          sheetContext += '--- End Company Data ---\n'
        }
      }
    } catch (sheetError) {
      console.warn('Failed to fetch imported records for AI context:', sheetError)
    }

    systemPrompt += sheetContext

    // Fetch recent conversation history for context
    const { data: recentMessages } = await supabase
      .from('messages')
      .select('sender_name, sender_type, message_text, direction, timestamp')
      .eq('conversation_id', conversation_id)
      .order('timestamp', { ascending: false })
      .limit(10)

    let conversationContext = ''
    if (recentMessages && recentMessages.length > 0) {
      const history = recentMessages
        .reverse()
        .map(
          (m) =>
            `[${m.direction === 'inbound' ? 'Customer' : 'Agent'}] ${m.message_text}`
        )
        .join('\n')
      conversationContext = `\nConversation history:\n${history}\n\n`
    }

    const userMessage = `${conversationContext}Please reply to the following customer message:\n${message_text}`

    // Call AI API for reply generation
    const replyText = await callAI(systemPrompt, userMessage)

    if (!replyText) {
      return NextResponse.json(
        { error: 'AI generated empty reply' },
        { status: 500 }
      )
    }

    // Determine reply status based on trust mode
    const replyStatus: AIReplyStatus = account.ai_trust_mode
      ? 'sent'
      : 'pending_approval'

    // Store the AI reply
    const { data: aiReply, error: replyError } = await supabase
      .from('ai_replies')
      .insert({
        message_id,
        account_id,
        conversation_id,
        draft_text: replyText,
        channel: channelKey,
        status: replyStatus,
        system_prompt_used: systemPrompt,
        created_at: new Date().toISOString(),
        ...(replyStatus === 'sent' ? { sent_at: new Date().toISOString() } : {}),
      })
      .select('*')
      .single()

    if (replyError) {
      console.error('Failed to store AI reply:', replyError)
      return NextResponse.json(
        { error: 'Failed to store AI reply' },
        { status: 500 }
      )
    }

    // Store KB article hits for tracking
    if (matchedKbIds.length > 0 && aiReply) {
      const kbHits = matchedKbIds.map(kbId => ({
        ai_reply_id: aiReply.id,
        kb_article_id: kbId,
        relevance_score: 0.8,
      }))
      try { await supabase.from('kb_hits').insert(kbHits) } catch { /* ignore */ }
    }

    // If trust mode is on, trigger n8n to send the reply through the channel
    if (account.ai_trust_mode && aiReply) {
      try {
        const origin = new URL(request.url).origin
        await fetch(`${origin}/api/n8n`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': process.env.N8N_WEBHOOK_SECRET || '',
          },
          body: JSON.stringify({
            action: `send_${channelKey}_reply`,
            account_id,
            data: {
              reply_id: aiReply.id,
              reply_text: replyText,
              conversation_id,
              message_id,
            },
          }),
        })
      } catch (sendError) {
        console.error('Failed to trigger n8n reply workflow:', sendError)
      }
    }

    return NextResponse.json(aiReply, { status: 200 })
  } catch (error) {
    console.error('AI reply generation error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
