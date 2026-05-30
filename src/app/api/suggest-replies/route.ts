import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { callAI } from '@/lib/api-helpers'
import { AIBudgetExceededError } from '@/lib/ai-usage'
import { CircuitBreakerOpenError } from '@/lib/ai-circuit-breaker'

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { conversation_id, message_text, category } = await request.json()
    if (!conversation_id || !message_text) {
      return NextResponse.json({ error: 'Missing conversation_id or message_text' }, { status: 400 })
    }

    // Generate 3 short suggested replies using AI
    const prompt = `You are a customer support assistant. Based on the customer's message, generate exactly 3 short, professional reply options. Each should be 1-2 sentences max. Return ONLY a JSON array of 3 strings, no markdown.

Customer message: "${message_text.substring(0, 300)}"
${category ? `Category: ${category}` : ''}

Example output: ["Thank you for reaching out. I'll look into this right away.", "I understand your concern. Let me check with our team and get back to you.", "Thanks for the information. Could you provide more details about your requirements?"]`

    // Resolve the conversation's account so we can charge usage to it.
    const admin = await createServiceRoleClient()
    const { data: convRow } = await admin
      .from('conversations')
      .select('account_id')
      .eq('id', conversation_id)
      .maybeSingle()
    const accountIdForBudget = convRow?.account_id ?? undefined

    let aiResponse: string
    try {
      aiResponse = await callAI(prompt, 'Generate 3 suggested replies as a JSON array.', {
        account_id: accountIdForBudget,
        endpoint: 'suggest-replies',
      })
    } catch (err) {
      if (err instanceof AIBudgetExceededError) {
        // Soft-fall back to canned suggestions so the UI still has options
        return NextResponse.json({
          ai_suggestions: [
            'Thank you for reaching out. How can I help you?',
            "I'll look into this and get back to you shortly.",
            'Could you provide more details so I can assist you better?',
          ],
          templates: [],
          skipped: true,
          error: 'AI budget exceeded for this account',
          monthly_total_usd: err.monthly_total_usd,
          budget_usd: err.budget_usd,
        })
      }
      if (err instanceof CircuitBreakerOpenError) {
        // Provider is unavailable — fall back to the same canned suggestions
        // so the agent UI never goes empty.
        return NextResponse.json({
          ai_suggestions: [
            'Thank you for reaching out. How can I help you?',
            "I'll look into this and get back to you shortly.",
            'Could you provide more details so I can assist you better?',
          ],
          templates: [],
          skipped: true,
          reason: 'ai_provider_unavailable',
        })
      }
      throw err
    }

    let suggestions: string[] = []
    try {
      // Balanced-bracket extraction — mirrors the JSON object extractor in
      // src/app/api/classify/route.ts. The previous greedy regex
      // `/\[[\s\S]*\]/` would happily swallow content past the first array
      // close-bracket if the AI followed up with markdown or another array.
      const startIdx = aiResponse.indexOf('[')
      if (startIdx !== -1) {
        let depth = 0
        let jsonStr = ''
        for (let i = startIdx; i < aiResponse.length; i++) {
          if (aiResponse[i] === '[') depth++
          if (aiResponse[i] === ']') depth--
          if (depth === 0) {
            jsonStr = aiResponse.substring(startIdx, i + 1)
            break
          }
        }
        if (jsonStr) {
          const parsed = JSON.parse(jsonStr)
          // Defensive: ensure the parsed result is an array of strings
          // before exposing it to the UI — the AI sometimes returns an
          // array of objects or numbers.
          if (Array.isArray(parsed)) {
            suggestions = parsed.filter((s): s is string => typeof s === 'string')
          }
        }
      }
    } catch {
      suggestions = []
    }
    if (suggestions.length === 0) {
      suggestions = ['Thank you for reaching out. How can I help you?', 'I\'ll look into this and get back to you shortly.', 'Could you provide more details so I can assist you better?']
    }

    // Scope template suggestions to the conversation's OWN company so a
    // super_admin (whose RLS sees every tenant) is never offered another
    // company's reply templates in this tenant's conversation.
    let convCompanyId: string | null = null
    if (convRow?.account_id) {
      const { data: convAcct } = await admin
        .from('accounts')
        .select('company_id')
        .eq('id', convRow.account_id)
        .maybeSingle()
      convCompanyId = (convAcct as { company_id?: string | null } | null)?.company_id ?? null
    }

    // Also fetch matching templates (company-scoped).
    let tmplQuery = supabase
      .from('reply_templates')
      .select('id, title, content')
      .eq('is_active', true)
    if (convCompanyId) tmplQuery = tmplQuery.eq('company_id', convCompanyId)
    const { data: templates } = await tmplQuery
      .order('usage_count', { ascending: false })
      .limit(3)

    return NextResponse.json({
      ai_suggestions: suggestions.slice(0, 3),
      templates: (templates || []).map((t: any) => ({ id: t.id, title: t.title, content: t.content })),
    })
  } catch (error) {
    console.error('Suggest replies error:', error)
    return NextResponse.json({ error: 'Failed to generate suggestions' }, { status: 500 })
  }
}
