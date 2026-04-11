import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { validateWebhookSecret } from '@/lib/api-helpers'

/**
 * SLA Auto-Escalation Endpoint
 *
 * Can be called periodically via cron or n8n workflow.
 * Checks all pending inbound messages older than their account's sla_critical_hours,
 * and escalates the conversation if sla_auto_escalate is enabled.
 *
 * Authentication: requires N8N_WEBHOOK_SECRET header or valid user session.
 */
export async function POST(request: Request) {
  try {
    // Authenticate via webhook secret (for cron/n8n calls)
    const webhookSecret = request.headers.get('x-webhook-secret')
    const expectedSecret = process.env.N8N_WEBHOOK_SECRET

    if (!validateWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = await createServiceRoleClient()

    // 1. Get all accounts with SLA settings
    const { data: accounts, error: accountsError } = await supabase
      .from('accounts')
      .select('id, sla_critical_hours, sla_auto_escalate')
      .eq('is_active', true)

    if (accountsError) {
      console.error('SLA check: failed to fetch accounts', accountsError)
      return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 })
    }

    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ escalated: 0, message: 'No active accounts' })
    }

    let totalEscalated = 0
    const escalationDetails: { account_id: string; conversation_ids: string[] }[] = []

    for (const account of accounts) {
      // Skip if auto-escalate is disabled
      if (!account.sla_auto_escalate) continue

      const criticalHours = account.sla_critical_hours ?? 4
      const cutoff = new Date(Date.now() - criticalHours * 60 * 60 * 1000).toISOString()

      // 2. Find pending inbound messages older than sla_critical_hours
      const { data: breachedMessages, error: msgError } = await supabase
        .from('messages')
        .select('conversation_id')
        .eq('account_id', account.id)
        .eq('direction', 'inbound')
        .eq('reply_required', true)
        .eq('replied', false)
        .lt('received_at', cutoff)

      if (msgError) {
        console.error(`SLA check: failed to query messages for account ${account.id}`, msgError)
        continue
      }

      if (!breachedMessages || breachedMessages.length === 0) continue

      // Get unique conversation IDs
      const conversationIds = [
        ...new Set(breachedMessages.map((m: { conversation_id: string }) => m.conversation_id)),
      ]

      // 3. Escalate conversations that are not already escalated or resolved
      const { data: updated, error: updateError } = await supabase
        .from('conversations')
        .update({ status: 'escalated' })
        .in('id', conversationIds)
        // PostgREST `in` filter: parenthesized, comma-separated, no spaces
      .not('status', 'in', '(escalated,resolved,archived)')
        .select('id')

      if (updateError) {
        console.error(`SLA check: failed to escalate conversations for account ${account.id}`, updateError)
        continue
      }

      const escalatedCount = updated?.length ?? 0
      if (escalatedCount > 0) {
        totalEscalated += escalatedCount
        escalationDetails.push({
          account_id: account.id,
          conversation_ids: updated!.map((c: { id: string }) => c.id),
        })
      }
    }

    return NextResponse.json({
      escalated: totalEscalated,
      details: escalationDetails,
      checked_at: new Date().toISOString(),
    })
  } catch (err: any) {
    console.error('SLA check error:', err)
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    )
  }
}

// Also support GET for simple health checks / manual triggers
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    endpoint: '/api/sla-check',
    description: 'POST with x-webhook-secret header to trigger SLA escalation check',
  })
}
