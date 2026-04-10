import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

/**
 * GET /api/user-accounts
 * Returns the sibling account IDs for the current authenticated user's company.
 * Uses the service role key via direct REST API call to bypass any RLS restrictions.
 */
export async function GET() {
  try {
    // Authenticate user via session
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ accountIds: [] }, { status: 401 })
    }

    // Get user profile
    const { data: profile } = await supabase
      .from('users')
      .select('role, account_id')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile?.account_id || profile.role === 'admin') {
      return NextResponse.json({ accountIds: [], isAdmin: profile?.role === 'admin' })
    }

    // Use service role key via direct REST API to bypass RLS completely
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json({ accountIds: [profile.account_id] })
    }

    // Fetch ALL active accounts using service role (bypasses RLS)
    const allAccountsRes = await fetch(
      `${supabaseUrl}/rest/v1/accounts?select=id,name&is_active=eq.true&order=name`,
      {
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
        },
      }
    )

    if (!allAccountsRes.ok) {
      console.error('[user-accounts] Failed to fetch accounts:', allAccountsRes.status)
      return NextResponse.json({ accountIds: [profile.account_id] })
    }

    const allAccounts: { id: string; name: string }[] = await allAccountsRes.json()

    // Find the user's account name
    const myAccount = allAccounts.find(a => a.id === profile.account_id)
    if (!myAccount) {
      return NextResponse.json({ accountIds: [profile.account_id] })
    }

    // Find siblings by base name match
    const baseName = myAccount.name
      .replace(/\s+Teams$/i, '')
      .replace(/\s+WhatsApp$/i, '')
      .trim()

    const siblingIds = allAccounts
      .filter(a => a.name.replace(/\s+Teams$/i, '').replace(/\s+WhatsApp$/i, '').trim() === baseName)
      .map(a => a.id)

    return NextResponse.json({
      accountIds: siblingIds.length > 0 ? siblingIds : [profile.account_id],
      debug: { baseName, found: siblingIds.length, myName: myAccount.name }
    })
  } catch (err) {
    console.error('[user-accounts] Error:', err)
    return NextResponse.json({ accountIds: [] }, { status: 500 })
  }
}
