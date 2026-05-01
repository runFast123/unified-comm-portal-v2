// CRUD for `public.saved_views` — user-scoped smart inboxes. Session-auth only.
//
// GET   /api/saved-views          → list user's own + shared views, ordered by sort_order, created_at
// POST  /api/saved-views          → create view (user_id = current user)
// PATCH /api/saved-views          → update view (owner OR admin)
//
// View `filters` is a JSONB blob of UI-only filter fields (see
// SavedViewFilters in `@/types/database`). The server doesn't apply them —
// the inbox client reads + applies them when navigating to ?view=ID.

import { NextResponse } from 'next/server'
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from '@/lib/supabase-server'
import type { SavedViewFilters } from '@/types/database'
import { isCompanyAdmin, isSuperAdmin } from '@/lib/auth'

interface SavedViewBody {
  id?: string
  name?: string
  icon?: string | null
  filters?: SavedViewFilters
  is_shared?: boolean
  sort_order?: number
}

// Whitelist for filter keys we'll accept from clients. Anything else is dropped.
const ALLOWED_FILTER_KEYS: ReadonlySet<keyof SavedViewFilters> = new Set([
  'channel',
  'account_ids',
  'status',
  'priority',
  'sentiment',
  'category',
  'assignee',
  'age_hours_gt',
  'search',
  'unread_only',
])

function sanitizeFilters(input: unknown): SavedViewFilters {
  if (!input || typeof input !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!ALLOWED_FILTER_KEYS.has(key as keyof SavedViewFilters)) continue
    if (value === undefined || value === null) continue
    if (key === 'account_ids') {
      if (Array.isArray(value)) {
        out[key] = value.filter((v) => typeof v === 'string')
      }
      continue
    }
    if (key === 'age_hours_gt') {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) out[key] = n
      continue
    }
    if (key === 'unread_only') {
      out[key] = !!value
      continue
    }
    if (typeof value === 'string') out[key] = value
  }
  return out as SavedViewFilters
}

async function getSession(): Promise<
  | {
      ok: true
      userId: string
      isSuper: boolean
      isAdmin: boolean
      companyId: string | null
    }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }

  const admin = await createServiceRoleClient()
  const { data: profile } = await admin
    .from('users')
    .select('role, company_id')
    .eq('id', user.id)
    .maybeSingle()
  return {
    ok: true,
    userId: user.id,
    isSuper: isSuperAdmin(profile?.role),
    // isCompanyAdmin covers super_admin / admin / company_admin (post-migration).
    isAdmin: isCompanyAdmin(profile?.role),
    companyId: (profile?.company_id as string | null) ?? null,
  }
}

export async function GET() {
  const gate = await getSession()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()
  // super_admin sees everything cross-tenant. Everyone else (including
  // company-level admins) sees own views + views shared by users in the SAME
  // company. (H4 fix: the previous `.or('is_shared.eq.true')` query leaked
  // shared views from other companies.)
  if (gate.isSuper) {
    const { data, error } = await admin
      .from('saved_views')
      .select('id, user_id, name, icon, filters, is_shared, sort_order, created_at')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ views: data || [] })
  }

  // Resolve the set of user_ids in the caller's company so we can constrain
  // the "shared" branch of the OR. Without a company_id, "shared" collapses
  // to just the caller's own views.
  let companyUserIds: string[] = []
  if (gate.companyId) {
    const { data: users } = await admin
      .from('users')
      .select('id')
      .eq('company_id', gate.companyId)
    companyUserIds = (users ?? []).map((u: { id: string }) => u.id)
  }
  if (!companyUserIds.includes(gate.userId)) {
    companyUserIds.push(gate.userId)
  }

  // Pull rows where (a) the caller owns it, OR (b) it's shared AND the owner
  // is in the caller's company.
  const { data, error } = await admin
    .from('saved_views')
    .select('id, user_id, name, icon, filters, is_shared, sort_order, created_at')
    .in('user_id', companyUserIds)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  // In-memory final filter: own OR (shared AND owner in same company).
  // The .in() above already restricts to same-company users, so any row that
  // isn't owned by the caller MUST be shared to be returned.
  const filtered = (data || []).filter(
    (row: { user_id: string; is_shared: boolean }) =>
      row.user_id === gate.userId || row.is_shared
  )
  return NextResponse.json({ views: filtered })
}

export async function POST(request: Request) {
  const gate = await getSession()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: SavedViewBody
  try {
    body = (await request.json()) as SavedViewBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const insert = {
    user_id: gate.userId,
    name: name.slice(0, 100),
    icon: typeof body.icon === 'string' ? body.icon.slice(0, 50) : null,
    filters: sanitizeFilters(body.filters),
    is_shared: !!body.is_shared,
    sort_order: Number.isFinite(body.sort_order) ? Number(body.sort_order) : 0,
  }

  const admin = await createServiceRoleClient()
  const { data, error } = await admin
    .from('saved_views')
    .insert(insert)
    .select('id, user_id, name, icon, filters, is_shared, sort_order, created_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ view: data }, { status: 201 })
}

export async function PATCH(request: Request) {
  const gate = await getSession()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  let body: SavedViewBody
  try {
    body = (await request.json()) as SavedViewBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const id = body.id
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const admin = await createServiceRoleClient()
  const { data: existing } = await admin
    .from('saved_views')
    .select('id, user_id')
    .eq('id', id)
    .maybeSingle()
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  // Owner can always edit. super_admin can edit anything. Company admins
  // can edit views owned by users in their own company (but not cross-tenant).
  if (existing.user_id !== gate.userId) {
    if (!gate.isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (!gate.isSuper) {
      const { data: ownerProfile } = await admin
        .from('users')
        .select('company_id')
        .eq('id', existing.user_id)
        .maybeSingle()
      if (!gate.companyId || ownerProfile?.company_id !== gate.companyId) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }
  }

  const patch: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = String(body.name).trim()
    if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    patch.name = name.slice(0, 100)
  }
  if (body.icon !== undefined) {
    patch.icon = body.icon === null ? null : String(body.icon).slice(0, 50)
  }
  if (body.filters !== undefined) patch.filters = sanitizeFilters(body.filters)
  if (body.is_shared !== undefined) patch.is_shared = !!body.is_shared
  if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order) || 0

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  const { data, error } = await admin
    .from('saved_views')
    .update(patch)
    .eq('id', id)
    .select('id, user_id, name, icon, filters, is_shared, sort_order, created_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ view: data })
}
