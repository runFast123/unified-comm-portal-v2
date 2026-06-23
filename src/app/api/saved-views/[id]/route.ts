// DELETE /api/saved-views/:id — owner OR admin only.

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = await createServiceRoleClient()
  const { data: existing } = await admin
    .from('saved_views')
    .select('id, user_id')
    .eq('id', id)
    .maybeSingle()
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (existing.user_id !== user.id) {
    const { data: profile } = await admin
      .from('users')
      .select('role, company_id')
      .eq('id', user.id)
      .maybeSingle()
    // isCompanyAdmin covers super_admin / admin / company_admin.
    if (!isCompanyAdmin(profile?.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    // Non-super-admins may only delete saved views owned by their OWN company
    // (mirrors the PATCH handler's cross-tenant guard so the two can't drift).
    if (!isSuperAdmin(profile?.role)) {
      const { data: ownerProfile } = await admin
        .from('users')
        .select('company_id')
        .eq('id', existing.user_id)
        .maybeSingle()
      const callerCompany = (profile?.company_id as string | null) ?? null
      if (!callerCompany || ownerProfile?.company_id !== callerCompany) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }
  }

  const { error } = await admin.from('saved_views').delete().eq('id', id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
