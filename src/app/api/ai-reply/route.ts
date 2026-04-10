import { NextResponse } from 'next/server'
import { createServiceRoleClient, createServerSupabaseClient } from '@/lib/supabase-server'
import { callAI, getAccountSettings, checkRateLimit } from '@/lib/api-helpers'
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
    const { message_id, message_text, channel, account_id, conversation_id, force } = body

    if (!message_id || !message_text || !account_id || !conversation_id) {
      return NextResponse.json(
        {
          error:
            'Missing required fields: message_id, message_text, account_id, conversation_id',
        },
        { status: 400 }
      )
    }

    // Rate limit per account
    if (!checkRateLimit(`ai-reply:${account_id}`)) {
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

    // Prevent duplicate AI replies
    if (!force) {
      // 1. Skip if this exact message already has a reply
      const { data: existingReply } = await supabase
        .from('ai_replies')
        .select('id')
        .eq('message_id', message_id)
        .maybeSingle()
      if (existingReply) {
        return NextResponse.json(
          { message: 'AI reply already exists for this message', skipped: true, existing_id: existingReply.id },
          { status: 200 }
        )
      }

      // 2. Skip if there's a RECENT pending draft for this conversation (< 10 min old)
      //    (customer sent multiple messages quickly — wait for agent to handle existing draft)
      //    Older pending drafts are ignored — agent skipped them, generate a fresh one
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
      const { data: pendingDraft } = await supabase
        .from('ai_replies')
        .select('id, message_id')
        .eq('conversation_id', conversation_id)
        .in('status', ['pending_approval', 'edited'])
        .gte('created_at', tenMinAgo)
        .limit(1)
        .maybeSingle()
      if (pendingDraft) {
        return NextResponse.json(
          { message: 'Recent pending AI draft exists for this conversation — skipping to avoid duplicates', skipped: true, existing_id: pendingDraft.id },
          { status: 200 }
        )
      }
    }

    // Skip AI reply if message is spam/newsletter (unless force=true from manual Generate button)
    if (!force) {
      const { data: msgCheck } = await supabase
        .from('messages')
        .select('is_spam, spam_reason')
        .eq('id', message_id)
        .maybeSingle()

      if (msgCheck?.is_spam) {
        return NextResponse.json(
          { message: 'Skipped — message is spam/newsletter', skipped: true },
          { status: 200 }
        )
      }

      // Also check if classification already tagged it as Newsletter/Marketing
      const { data: classCheck } = await supabase
        .from('message_classifications')
        .select('category')
        .eq('message_id', message_id)
        .maybeSingle()

      if (classCheck?.category === 'Newsletter/Marketing') {
        return NextResponse.json(
          { message: 'Skipped — classified as Newsletter/Marketing', skipped: true },
          { status: 200 }
        )
      }
    }

    // Fetch account settings
    const account = await getAccountSettings(supabase, account_id)

    // Check if Phase 2 (AI Reply) is enabled for this account
    if (!account.phase2_enabled && !force) {
      return NextResponse.json(
        { message: 'Phase 2 (AI Reply) is disabled for this account', skipped: true },
        { status: 200 }
      )
    }

    // Validate channel against allowed values — reject invalid channels
    const validChannels: ChannelType[] = ['email', 'teams', 'whatsapp']
    if (!channel || !validChannels.includes(channel as ChannelType)) {
      return NextResponse.json(
        { error: `Invalid or missing channel "${channel}". Valid channels: ${validChannels.join(', ')}` },
        { status: 400 }
      )
    }
    const channelKey: ChannelType = channel as ChannelType
    let systemPrompt: string

    if (account.ai_system_prompt && account.ai_system_prompt.trim().length > 0) {
      // Admin has set a custom prompt — use it as the PRIMARY instruction
      systemPrompt = account.ai_system_prompt
    } else {
      // No custom prompt set — use the built-in channel default
      systemPrompt = CHANNEL_SYSTEM_PROMPTS[channelKey] || CHANNEL_SYSTEM_PROMPTS.email
    }

    // Add account context so AI knows which company it's responding for
    systemPrompt += `\n\nYou are replying on behalf of "${account.name}". Always maintain this company identity in your response. CRITICAL: You MUST follow the company's Knowledge Base rules and tone. Never mention other companies. Never use information from outside the Knowledge Base.`

    // Fetch ALL Knowledge Base articles for this company
    // For Teams accounts (e.g. "Mycountrymobile Teams"), KB may be linked to the
    // email account ("Mycountrymobile"). Find sibling account by base company name.
    const baseName = account.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
    let kbAccountIds = [account_id]

    // Find sibling accounts with same base name (e.g. email version of a Teams account)
    const { data: siblingAccounts } = await supabase
      .from('accounts')
      .select('id, name')
      .eq('is_active', true)
    if (siblingAccounts) {
      for (const sib of siblingAccounts) {
        const sibBase = sib.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
        if (sibBase === baseName && !kbAccountIds.includes(sib.id)) kbAccountIds.push(sib.id)
      }
    }

    const kbFilter = kbAccountIds.map(id => `account_id.eq.${id}`).join(',')
    const { data: kbArticles } = await supabase
      .from('kb_articles')
      .select('id, title, content, category')
      .eq('is_active', true)
      .or(`${kbFilter},account_id.is.null`)
      .order('title')

    let kbContext = ''
    const matchedKbIds: string[] = []
    if (kbArticles && kbArticles.length > 0) {
      // Include ALL company KB articles — they are the company's sales playbook
      // Prioritize: first include the Sales Chatbot Identity (most important),
      // then find best matching articles based on message content
      const msgLower = (message_text || '').toLowerCase()

      // Always include the chatbot identity/rules article first (it has response rules)
      const identityArticle = kbArticles.find((kb: any) =>
        kb.title?.toLowerCase().includes('chatbot identity') || kb.title?.toLowerCase().includes('sales chatbot')
      )

      // Score remaining articles by keyword relevance
      const scoredArticles = kbArticles
        .filter((kb: any) => kb.id !== identityArticle?.id)
        .map((kb: any) => {
          let score = 0
          const content = (kb.content || '').toLowerCase()
          // Check for key terms from the customer message
          const msgWords = msgLower.split(/\s+/).filter((w: string) => w.length > 4)
          for (const word of msgWords) {
            if (content.includes(word)) score += 1
          }
          // Boost articles whose category/title matches message keywords
          const titleLower = (kb.title || '').toLowerCase()
          if (msgLower.includes('route') || msgLower.includes('rate') || msgLower.includes('pricing')) {
            if (titleLower.includes('route') || titleLower.includes('pricing')) score += 10
          }
          if (msgLower.includes('ucaas') || msgLower.includes('phone') || msgLower.includes('dialer') || msgLower.includes('sms')) {
            if (titleLower.includes('ucaas') || titleLower.includes('sms') || titleLower.includes('dialer')) score += 10
          }
          if (msgLower.includes('compliance') || msgLower.includes('billing') || msgLower.includes('refund') || msgLower.includes('support')) {
            if (titleLower.includes('compliance') || titleLower.includes('billing') || titleLower.includes('support')) score += 10
          }
          return { ...kb, score }
        })
        .sort((a: any, b: any) => b.score - a.score)

      // Build KB context: identity article (full) + top 2 scored articles (more content)
      kbContext = '\n\n--- Company Knowledge Base ---\nYou MUST use ONLY the following knowledge base to answer. Do NOT use any external knowledge. If the answer is not in the KB, say you will connect them with the commercial team.\n\n'

      if (identityArticle) {
        kbContext += `[COMPANY IDENTITY & RULES]\n${(identityArticle.content || '').substring(0, 4000)}\n\n`
        matchedKbIds.push(identityArticle.id)
      }

      // Include top scored articles with more content (up to 6000 chars each)
      const topArticles = scoredArticles.slice(0, 3)
      topArticles.forEach((kb: any, i: number) => {
        kbContext += `[${kb.title}]\n${(kb.content || '').substring(0, 6000)}\n\n`
        matchedKbIds.push(kb.id)
      })

      kbContext += '--- End Knowledge Base ---\n'
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

    // Calculate AI confidence score (0.0 to 1.0)
    let confidenceScore = 0.5 // Base confidence

    // +0.15 if KB articles were matched (AI has company knowledge)
    if (matchedKbIds.length > 0) confidenceScore += 0.15
    // +0.05 per additional KB article (max +0.15 for 3)
    confidenceScore += Math.min(Math.max(matchedKbIds.length - 1, 0), 3) * 0.05

    // +0.1 if conversation history exists (AI has context)
    if (recentMessages && recentMessages.length > 2) confidenceScore += 0.1

    // +0.1 if classification confidence was high
    const { data: classData } = await supabase
      .from('message_classifications')
      .select('confidence')
      .eq('message_id', message_id)
      .maybeSingle()
    if (classData?.confidence && classData.confidence > 0.8) confidenceScore += 0.1

    // Cap at 0.98
    confidenceScore = Math.min(Math.round(confidenceScore * 100) / 100, 0.98)

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
        confidence_score: confidenceScore,
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
