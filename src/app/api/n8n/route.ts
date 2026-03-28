import { NextResponse } from 'next/server'
import { createServiceRoleClient, createServerSupabaseClient } from '@/lib/supabase-server'

const N8N_BASE_URL = (process.env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/+$/, '')
const N8N_API_KEY = process.env.N8N_API_KEY || ''

type ReplyAction = 'send_teams_reply' | 'send_email_reply' | 'send_whatsapp_reply'

const REPLY_ACTION_WEBHOOK_PREFIXES: Record<ReplyAction, string> = {
  send_teams_reply: '/webhook/teams-reply',
  send_email_reply: '/webhook/email-reply',
  send_whatsapp_reply: '/webhook/whatsapp-reply',
}

/** Build per-company webhook path: /webhook/email-reply-acepeak */
function buildWebhookPath(action: ReplyAction, accountName: string): string {
  const prefix = REPLY_ACTION_WEBHOOK_PREFIXES[action]
  if (!prefix) return ''
  const slug = accountName.toLowerCase().replace(/[^a-z0-9]/g, '')
  return `${prefix}-${slug}`
}

/**
 * GET handler: returns status of all n8n workflows mapped to accounts.
 */
export async function GET() {
  try {
    // Require authenticated user session
    const authSupabase = await createServerSupabaseClient()
    const { data: { user } } = await authSupabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = await createServiceRoleClient()

    // Fetch accounts with n8n workflow IDs
    const { data: accounts, error: accountsError } = await supabase
      .from('accounts')
      .select('id, name, channel_type, make_scenario_id, is_active')
      .not('make_scenario_id', 'is', null)

    if (accountsError) {
      console.error('Failed to fetch accounts:', accountsError)
      return NextResponse.json(
        { error: 'Failed to fetch accounts' },
        { status: 500 }
      )
    }

    // Fetch workflow statuses from n8n API
    const workflows: Array<{
      account_id: string
      account_name: string
      channel: string
      make_scenario_id: string
      n8n_status: string | null
      error?: string
    }> = []

    for (const account of accounts || []) {
      if (!account.make_scenario_id) continue

      let n8nStatus: string | null = null
      let fetchError: string | undefined

      try {
        const response = await fetch(
          `${N8N_BASE_URL}/api/v1/workflows/${account.make_scenario_id}`,
          {
            headers: {
              'X-N8N-API-KEY': N8N_API_KEY,
              Accept: 'application/json',
            },
          }
        )

        if (response.ok) {
          const workflow = await response.json()
          n8nStatus = workflow.active ? 'active' : 'inactive'
        } else {
          fetchError = `n8n API returned ${response.status}`
        }
      } catch (err) {
        fetchError =
          err instanceof Error ? err.message : 'Failed to reach n8n'
      }

      workflows.push({
        account_id: account.id,
        account_name: account.name,
        channel: account.channel_type,
        make_scenario_id: account.make_scenario_id,
        n8n_status: n8nStatus,
        ...(fetchError ? { error: fetchError } : {}),
      })
    }

    return NextResponse.json({ workflows }, { status: 200 })
  } catch (error) {
    console.error('n8n GET error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST handler: triggers a specific n8n workflow.
 * Body: { action, account_id, data }
 * Actions: 'send_teams_reply', 'send_email_reply', 'send_whatsapp_reply'
 */
export async function POST(request: Request) {
  try {
    // Allow internal calls via webhook secret, or authenticated users
    const webhookSecret = request.headers.get('x-webhook-secret')
    const expectedSecret = process.env.N8N_WEBHOOK_SECRET
    const isInternalCall = webhookSecret === expectedSecret

    if (!isInternalCall) {
      // Check for authenticated user session
      const authSupabase = await createServerSupabaseClient()
      const { data: { user } } = await authSupabase.auth.getUser()
      if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      )
    }
    const { action, account_id, data } = body as {
      action: ReplyAction
      account_id: string
      data: Record<string, unknown>
    }

    if (!action || !account_id) {
      return NextResponse.json(
        { error: 'Missing required fields: action, account_id' },
        { status: 400 }
      )
    }

    // Validate action
    if (!REPLY_ACTION_WEBHOOK_PREFIXES[action]) {
      return NextResponse.json(
        {
          error: `Invalid action: ${action}. Valid actions: ${Object.keys(REPLY_ACTION_WEBHOOK_PREFIXES).join(', ')}`,
        },
        { status: 400 }
      )
    }

    const supabase = await createServiceRoleClient()

    // Fetch account to get n8n workflow context
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, name, channel_type, make_scenario_id')
      .eq('id', account_id)
      .single()

    if (accountError || !account) {
      return NextResponse.json(
        { error: 'Account not found' },
        { status: 404 }
      )
    }

    // Build per-company webhook path (e.g., /webhook/email-reply-acepeak)
    const webhookPath = buildWebhookPath(action, account.name)
    const webhookUrl = `${N8N_BASE_URL}${webhookPath}`
    const payload = {
      account_id,
      account_name: account.name,
      channel: account.channel_type,
      make_scenario_id: account.make_scenario_id,
      ...data,
    }

    const n8nResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': N8N_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000), // 30s timeout to prevent hanging
    })

    if (!n8nResponse.ok) {
      const errorBody = await n8nResponse.text()
      console.error(`n8n webhook error (${n8nResponse.status}):`, errorBody)
      return NextResponse.json(
        { error: `n8n workflow trigger failed: ${n8nResponse.status}` },
        { status: 502 }
      )
    }

    let n8nResult: Record<string, unknown> = {}
    try {
      const responseText = await n8nResponse.text()
      n8nResult = responseText ? JSON.parse(responseText) : {}
    } catch (parseError) {
      console.error('Failed to parse n8n webhook response as JSON:', parseError)
      return NextResponse.json(
        { error: 'n8n webhook returned invalid JSON response' },
        { status: 502 }
      )
    }

    return NextResponse.json(
      {
        message: `Successfully triggered ${action}`,
        n8n_response: n8nResult,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error('n8n POST error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
