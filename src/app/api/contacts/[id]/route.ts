import { NextResponse } from 'next/server'

import { logAudit } from '@/lib/audit'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import {
  getCurrentUser,
  isCompanyAdmin,
  isSuperAdmin,
  getAllowedAccountIds,
} from '@/lib/auth'

interface ContactPatchBody {
  display_name?: unknown
  notes?: unknown
  tags?: unknown
  is_vip?: unknown
}

interface ValidatedPatch {
  display_name?: string | null
  notes?: string | null
  tags?: string[]
  is_vip?: boolean
}

function validatePatch(body: ContactPatchBody): { ok: true; patch: ValidatedPatch } | { ok: false; error: string } {
  const patch: ValidatedPatch = {}

  if ('display_name' in body) {
    if (body.display_name === null) {
      patch.display_name = null
    } else if (typeof body.display_name === 'string') {
      patch.display_name = body.display_name.trim() || null
    } else {
      return { ok: false, error: 'display_name must be a string or null' }
    }
  }

  if ('notes' in body) {
    if (body.notes === null) {
      patch.notes = null
    } else if (typeof body.notes === 'string') {
      patch.notes = body.notes
    } else {
      return { ok: false, error: 'notes must be a string or null' }
    }
  }

  if ('tags' in body) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== 'string')) {
      return { ok: false, error: 'tags must be an array of strings' }
    }
    // Dedupe + trim, drop empties.
    const seen = new Set<string>()
    const cleaned: string[] = []
    for (const raw of body.tags as string[]) {
      const t = raw.trim()
      if (t.length === 0) continue
      const key = t.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      cleaned.push(t)
    }
    patch.tags = cleaned
  }

  if ('is_vip' in body) {
    if (typeof body.is_vip !== 'boolean') {
      return { ok: false, error: 'is_vip must be a boolean' }
    }
    patch.is_vip = body.is_vip
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'No valid fields to update' }
  }

  return { ok: true, patch }
}

/**
 * Authorise a caller to act on `contactId`.
 *
 * Rules:
 *   - super_admin → always allowed (cross-tenant).
 *   - other roles → must be (a) company-admin/admin/company-member AND
 *     (b) have at least one conversation referencing this contact whose
 *     `account_id` is in the caller's allowed account set.
 *
 * For the bare PATCH path we accept any company-scoped role that can see
 * the contact (the route used to require zero auth). DELETE additionally
 * requires `isCompanyAdmin` privilege.
 */
async function authorizeContactAccess(
  userId: string,
  contactId: string,
  opts: { requireAdmin: boolean },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const profile = await getCurrentUser(userId)
  if (!profile) return { ok: false, status: 403, error: 'Forbidden' }

  // super_admin bypass
  if (isSuperAdmin(profile.role)) return { ok: true }

  // For DELETE we additionally require company-admin.
  if (opts.requireAdmin && !isCompanyAdmin(profile.role)) {
    return { ok: false, status: 403, error: 'Forbidden: admin only' }
  }

  // Caller must have access to at least one conversation that references
  // this contact, and that conversation's account must be in their scope.
  const allowed = await getAllowedAccountIds(userId)
  // null sentinel = super_admin (already handled). Empty set = deny.
  if (!allowed || allowed.size === 0) return { ok: false, status: 403, error: 'Forbidden' }

  const admin = await createServiceRoleClient()
  const { data: hits } = await admin
    .from('conversations')
    .select('id, account_id')
    .eq('contact_id', contactId)
    .in('account_id', Array.from(allowed))
    .limit(1)

  if (!hits || hits.length === 0) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  return { ok: true }
}

/**
 * PATCH /api/contacts/:id — partial update for display_name, notes, tags, is_vip.
 *
 * SECURITY: previously anyone signed in could mutate any contact (no role
 * or scope check). Now requires the caller to share at least one
 * conversation with this contact within their company-scoped account set,
 * with super_admin bypass.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const supabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as ContactPatchBody | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const validation = validatePatch(body)
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 })
    }

    const admin = await createServiceRoleClient()

    const { data: existing } = await admin
      .from('contacts')
      .select('id')
      .eq('id', id)
      .maybeSingle()
    if (!existing) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    // FIX: gate on company-scoped conversation membership.
    const authz = await authorizeContactAccess(user.id, id, { requireAdmin: false })
    if (!authz.ok) {
      return NextResponse.json({ error: authz.error }, { status: authz.status })
    }

    const { data: updated, error } = await admin
      .from('contacts')
      .update(validation.patch)
      .eq('id', id)
      .select(
        'id, email, phone, display_name, notes, tags, first_seen_at, last_seen_at, total_conversations, is_vip'
      )
      .single()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    void logAudit({
      user_id: user.id,
      action: 'contact_updated',
      entity_type: 'contact',
      entity_id: id,
      details: { fields: Object.keys(validation.patch) },
    })

    return NextResponse.json({ contact: updated })
  } catch (err) {
    console.error('Contacts PATCH error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/contacts/:id — admin-only hard delete.
 *
 * SECURITY: previously this used the legacy `role === 'admin'` check, which
 * left out modern role names AND let a company-admin of company A delete
 * a contact belonging to company B. Now requires (super_admin) OR
 * (company-admin AND share at least one conversation with the contact in
 * the caller's allowed accounts).
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const supabase = await createServerSupabaseClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const admin = await createServiceRoleClient()

    const { data: existing } = await admin
      .from('contacts')
      .select('id, email, phone, display_name')
      .eq('id', id)
      .maybeSingle()
    if (!existing) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    // FIX: company-admin role + scoped conversation match (super_admin bypass).
    const authz = await authorizeContactAccess(user.id, id, { requireAdmin: true })
    if (!authz.ok) {
      return NextResponse.json({ error: authz.error }, { status: authz.status })
    }

    const { error } = await admin.from('contacts').delete().eq('id', id)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    void logAudit({
      user_id: user.id,
      action: 'contact_deleted',
      entity_type: 'contact',
      entity_id: id,
      details: {
        email: existing.email,
        phone: existing.phone,
        display_name: existing.display_name,
      },
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Contacts DELETE error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
