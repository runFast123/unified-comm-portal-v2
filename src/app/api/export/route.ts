import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { verifyAccountAccess } from '@/lib/api-helpers'
import { isSuperAdmin } from '@/lib/auth'

/**
 * GET /api/export?type=messages&from=2026-01-01&to=2026-12-31&account_id=...
 * Exports data as CSV for download.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(request.url)
    const type = url.searchParams.get('type') || 'messages'
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    let accountId = url.searchParams.get('account_id')

    // Get user profile to determine role and account scoping
    const { data: profile } = await supabase
      .from('users')
      .select('role, account_id, company_id')
      .eq('id', user.id)
      .maybeSingle()

    // super_admin sees everything; all other roles (admin, company_admin,
    // company_member, viewer, reviewer) are scoped to their company / their
    // single legacy account.
    const isSuper = isSuperAdmin(profile?.role)

    // Verify user has access to the requested account
    if (accountId) {
      const hasAccess = await verifyAccountAccess(user.id, accountId)
      if (!hasAccess) {
        return NextResponse.json({ error: 'Access denied to this account' }, { status: 403 })
      }
    } else if (!isSuper && profile?.account_id) {
      // Non-super users: scope to all sibling accounts (same company, different channels)
      accountId = profile.account_id
    }

    // For non-super users, expand single accountId to include sibling accounts.
    // H5 fix: filter by company_id so two companies with the same account name
    // don't cross-leak. We resolve the caller's company first (preferred) and
    // fall back to the requested account's company_id when the caller has none.
    let accountIds: string[] | null = accountId ? [accountId] : null
    if (!isSuper && accountId) {
      try {
        const adminSupa = await createServiceRoleClient()
        const { data: myAcc } = await adminSupa
          .from('accounts')
          .select('name, company_id')
          .eq('id', accountId)
          .maybeSingle()
        if (myAcc?.name) {
          const base = myAcc.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim()
          // Restrict the sibling search to the caller's own company. If the
          // caller has no company_id (legacy), fall back to the target
          // account's company_id — which still scopes the OR-by-name match.
          const scopeCompanyId = profile?.company_id ?? myAcc.company_id ?? null
          let siblingsQuery = adminSupa
            .from('accounts')
            .select('id, name, company_id')
            .eq('is_active', true)
          if (scopeCompanyId) {
            siblingsQuery = siblingsQuery.eq('company_id', scopeCompanyId)
          } else {
            // Caller has no company AND target account has no company:
            // restrict to just the requested account_id to avoid cross-leak.
            siblingsQuery = siblingsQuery.eq('id', accountId)
          }
          const { data: all } = await siblingsQuery
          if (all) accountIds = all.filter(a => a.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim() === base).map(a => a.id)
        }
      } catch { /* fallback to single account */ }
    }

    // Escape CSV values to prevent formula injection (=, +, -, @, tab, CR)
    const safeCSV = (val: string): string => {
      const escaped = val.replace(/"/g, '""')
      if (/^[=+\-@\t\r]/.test(escaped)) return `'${escaped}`
      return escaped
    }

    let csvContent = ''
    let filename = ''

    if (type === 'messages') {
      let query = supabase
        .from('messages')
        .select(`
          id, sender_name, email_subject, message_text, channel, direction,
          received_at, replied, reply_required,
          accounts!messages_account_id_fkey(name),
          message_classifications(category, sentiment, urgency, confidence)
        `)
        .eq('direction', 'inbound')
        .order('received_at', { ascending: false })
        .limit(10000)

      if (from) query = query.gte('received_at', from)
      if (to) query = query.lte('received_at', to)
      if (accountIds && accountIds.length > 0) query = query.in('account_id', accountIds)

      const { data: messages, error } = await query
      if (error) throw error

      const headers = ['Date', 'Account', 'Sender', 'Subject', 'Channel', 'Category', 'Sentiment', 'Urgency', 'Confidence', 'Replied', 'Message Preview']
      const rows = (messages || []).map((m: any) => [
        new Date(m.received_at).toISOString().split('T')[0],
        safeCSV(m.accounts?.name || ''),
        safeCSV(m.sender_name || ''),
        safeCSV(m.email_subject || ''),
        m.channel || '',
        m.message_classifications?.[0]?.category || '',
        m.message_classifications?.[0]?.sentiment || '',
        m.message_classifications?.[0]?.urgency || '',
        m.message_classifications?.[0]?.confidence != null ? Math.round(Number(m.message_classifications[0].confidence) * 100) + '%' : '--',
        m.replied ? 'Yes' : 'No',
        safeCSV((m.message_text || '').substring(0, 200).replace(/\n/g, ' ')),
      ])

      csvContent = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n')
      filename = `messages-export-${new Date().toISOString().split('T')[0]}.csv`

    } else if (type === 'ai-replies') {
      let query = supabase
        .from('ai_replies')
        .select(`
          id, status, draft_text, channel, confidence_score, created_at, sent_at,
          accounts!ai_replies_account_id_fkey(name),
          messages!ai_replies_message_id_fkey(sender_name, email_subject, received_at)
        `)
        .order('created_at', { ascending: false })
        .limit(10000)

      if (from) query = query.gte('created_at', from)
      if (to) query = query.lte('created_at', to)
      if (accountIds && accountIds.length > 0) query = query.in('account_id', accountIds)

      const { data: replies, error } = await query
      if (error) throw error

      const headers = ['Date', 'Account', 'Original Sender', 'Subject', 'Status', 'Channel', 'Response Time (min)', 'Draft Preview']
      const rows = (replies || []).map((r: any) => {
        const responseTime = r.sent_at && r.messages?.received_at
          ? Math.round((new Date(r.sent_at).getTime() - new Date(r.messages.received_at).getTime()) / 60000)
          : ''
        return [
          new Date(r.created_at).toISOString().split('T')[0],
          safeCSV(r.accounts?.name || ''),
          safeCSV(r.messages?.sender_name || ''),
          safeCSV(r.messages?.email_subject || ''),
          r.status || '',
          r.channel || '',
          responseTime,
          safeCSV((r.draft_text || '').substring(0, 200).replace(/\n/g, ' ')),
        ]
      })

      csvContent = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n')
      filename = `ai-replies-export-${new Date().toISOString().split('T')[0]}.csv`

    } else {
      return NextResponse.json({ error: 'Invalid export type. Use: messages, ai-replies' }, { status: 400 })
    }

    return new Response(csvContent, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (error) {
    console.error('Export error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Export failed' },
      { status: 500 }
    )
  }
}
