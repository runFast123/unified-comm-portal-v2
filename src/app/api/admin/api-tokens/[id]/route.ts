/**
 * Per-token admin operations.
 *
 *   DELETE /api/admin/api-tokens/[id] → revoke (sets `revoked_at = now()`)
 *
 * Soft-revoke rather than DELETE FROM — revoked tokens still appear in the
 * list (greyed out) so admins can see what was disabled and when.
 *
 * Privilege model is the same as the collection endpoint:
 *   - super_admin can revoke any token.
 *   - admin / company_admin can revoke tokens within their own company.
 *   - everyone else → 403.
 */

import { NextResponse } from 'next/server'

import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: tokenId } = await context.params
  if (!tokenId) {
    return NextResponse.json({ error: 'Missing token id' }, { status: 400 })
  }

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const profile = await getCurrentUser(user.id)
  if (!profile) return NextResponse.json({ error: 'No profile found' }, { status: 403 })
  if (!isSuperAdmin(profile.role) && !isCompanyAdmin(profile.role)) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const admin = await createServiceRoleClient()

  const { data: token, error: lookupErr } = await admin
    .from('api_tokens')
    .select('id, company_id, name, prefix, revoked_at')
    .eq('id', tokenId)
    .maybeSingle()

  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  if (!token) return NextResponse.json({ error: 'Token not found' }, { status: 404 })

  // Cross-company check for non-super-admin admins.
  if (!isSuperAdmin(profile.role) && token.company_id !== profile.company_id) {
    return NextResponse.json({ error: 'Token belongs to another company' }, { status: 403 })
  }

  // Idempotent revoke — re-revoking is a no-op success.
  if (token.revoked_at) {
    return NextResponse.json({ success: true, revoked_at: token.revoked_at })
  }

  const nowIso = new Date().toISOString()
  const { error: updateErr } = await admin
    .from('api_tokens')
    .update({ revoked_at: nowIso })
    .eq('id', tokenId)
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  try {
    await admin.from('audit_log').insert({
      user_id: user.id,
      action: 'api_token.revoked',
      entity_type: 'api_token',
      entity_id: tokenId,
      details: { name: token.name, prefix: token.prefix, company_id: token.company_id },
    })
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({ success: true, revoked_at: nowIso })
}
