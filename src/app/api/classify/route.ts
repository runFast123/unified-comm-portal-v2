import { NextResponse } from 'next/server'
import { createServiceRoleClient, createServerSupabaseClient } from '@/lib/supabase-server'
import { callAI, getAccountSettings, checkRateLimit } from '@/lib/api-helpers'
import type { Category, Sentiment, Urgency } from '@/types/database'

const DEFAULT_CLASSIFICATION_PROMPT = `You are a customer message classifier for a telecommunications company. Analyze the customer message and return a JSON object with the following fields:

- category: one of "Sales Inquiry", "Trouble Ticket", "Payment Issue", "Service Problem", "Technical Issue", "Billing Question", "Connection Issue", "Rate Issue", "General Inquiry", "Newsletter/Marketing"
- subcategory: a more specific label within the category
- sentiment: one of "positive", "neutral", "negative"
- urgency: one of "low", "medium", "high", "urgent"
- topic_summary: a brief 1-sentence summary of the customer's issue
- confidence: a number between 0 and 1 indicating your confidence in the classification

Return ONLY the JSON object, no markdown formatting or additional text.`

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
    const { message_id, message_text, channel, account_id } = body

    if (!message_id || !message_text || !account_id) {
      return NextResponse.json(
        { error: 'Missing required fields: message_id, message_text, account_id' },
        { status: 400 }
      )
    }

    // Rate limit per account
    if (!checkRateLimit(`classify:${account_id}`)) {
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
    try {
      const account = await getAccountSettings(supabaseForAccount, account_id)
      accountName = account.name || 'Unknown'
    } catch { /* use default */ }

    // Call AI API for classification with account context
    const classificationPrompt = `${DEFAULT_CLASSIFICATION_PROMPT}\n\nThis message was received by the company "${accountName}". Use this context to better understand the message intent.`
    const userMessage = `Channel: ${validatedChannel}\nMessage: ${message_text}`
    const rawResponse = await callAI(classificationPrompt, userMessage)

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

    // If AI classified as Newsletter/Marketing with high confidence, mark as spam
    if (classification.category === 'Newsletter/Marketing' && classification.confidence > 0.7) {
      const { error: spamUpdateError } = await supabase
        .from('messages')
        .update({
          is_spam: true,
          spam_reason: 'ai_classified_newsletter',
          reply_required: false,
        })
        .eq('id', message_id)

      if (spamUpdateError) {
        console.error('Failed to update message spam status after AI classification:', spamUpdateError)
      }
    }

    return NextResponse.json(stored, { status: 200 })
  } catch (error) {
    console.error('Classification error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
