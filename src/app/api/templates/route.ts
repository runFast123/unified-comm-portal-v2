// Reply-templates API (collection).
//
//   GET   /api/templates    list this user's company-scoped templates
//   POST  /api/templates    create one (company_admin / super_admin only)
//
// All requests require an authenticated session. The server resolves the
// caller's company from `users.company_id` and scopes reads/writes to that
// company - mirrors the RLS policy at the DB layer for defence-in-depth.

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import { getCurrentUser, isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

interface CreateBody {
  name?: string
  subject?: string | null
  body?: string
  shortcut?: string | null
  category?: string | null
}

async function getSession(): Promise<
  | { ok: true; userId: string; companyId: string | null; role: string }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }

  const profile = await getCurrentUser(user.id)
  if (!profile) {
    return { ok: false, status: 403, error: 'No profile found for user' }
  }
  return {
    ok: true,
    userId: user.id,
    companyId: profile.company_id ?? null,
    role: profile.role || '',
  }
}

export async function GET() {
  const gate = await getSession()
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  const admin = await createServiceRoleClient()
  let query = admin
    .from('reply_templates')
    .select(
      'id, company_id, account_id, title, subject, content, category, shortcut, usage_count, is_active, created_by, created_at, updated_at'
    )
    .order('updated_at', { ascending: false })

  if (!isSuperAdmin(gate.role)) {
    if (!gate.companyId) {
      // Non-super-admin without a company sees nothing - matches RLS.
      return NextResponse.json({ templates: [] })
    }
    query = query.eq('company_id', gate.companyId)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ templates: data || [] })
}

export async function POST(request: Request) {
  const gate = await getSession()
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  // Only company_admin / super_admin can create templates - mirrors the
  // RLS WITH CHECK clause but lets us return a friendlier 403.
  if (!isSuperAdmin(gate.role) && !isCompanyAdmin(gate.role)) {
    return NextResponse.json(
      { error: 'Only company admins can create templates' },
      { status: 403 }
    )
  }

  let body: CreateBody
  try {
    body = (await request.json()) as CreateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const content = typeof body.body === 'string' ? body.body : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (!content.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 })
  }

  // Non-super-admins are pinned to their own company.
  if (!isSuperAdmin(gate.role) && !gate.companyId) {
    return NextResponse.json(
      { error: 'User has no company assigned' },
      { status: 403 }
    )
  }

  // Normalize shortcut: drop a leading "/" and lowercase. Empty -> null.
  const shortcutRaw =
    typeof body.shortcut === 'string' ? body.shortcut.trim() : ''
  const shortcut = shortcutRaw
    ? shortcutRaw.replace(/^\//, '').toLowerCase().slice(0, 64) || null
    : null

  const insert = {
    company_id: gate.companyId, // super_admin still gets their own company; cross-company writes via /admin
    title: name.slice(0, 200),
    subject:
      typeof body.subject === 'string' && body.subject.trim()
        ? body.subject.trim().slice(0, 500)
        : null,
    content,
    category:
      typeof body.category === 'string' && body.category.trim()
        ? body.category.trim().slice(0, 64)
        : null,
    shortcut,
    is_active: true,
    usage_count: 0,
    created_by: gate.userId,
  }

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('reply_templates')
    .insert(insert)
    .select(
      'id, company_id, account_id, title, subject, content, category, shortcut, usage_count, is_active, created_by, created_at, updated_at'
    )
    .single()

  if (error) {
    // Surface the unique-shortcut-per-company violation as a friendlier 409.
    const isUnique =
      (error as { code?: string }).code === '23505' ||
      /unique/i.test(error.message)
    if (isUnique) {
      return NextResponse.json(
        { error: 'A template with that shortcut already exists' },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ template: data }, { status: 201 })
}
