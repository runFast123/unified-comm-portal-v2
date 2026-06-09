// Admin management of the live-chat widget.
//   GET   → the company's widget (+ account), or null
//   POST  → enable: create a livechat account + widget (idempotent)
//   PATCH → update title/color/welcome/is_enabled
// requireCompanyAdmin + service-role with TS company scoping (super_admin may
// target another company via the switcher cookie / ?company_id=).
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireCompanyAdmin } from '@/lib/tenant-guard'
import { generateWidgetKey } from '@/lib/livechat'

async function resolveTargetCompanyId(
  request: Request,
  ctx: { companyId: string | null; isSuperAdmin: boolean }
): Promise<string> {
  let target = ctx.companyId || ''
  if (ctx.isSuperAdmin) {
    const q = new URL(request.url).searchParams.get('company_id')
    if (q) target = q
    else target = (await cookies()).get('selected_company_id')?.value?.trim() || ctx.companyId || ''
  }
  return target
}

const WIDGET_COLS = 'id, account_id, widget_key, title, color, welcome_message, subtitle, launcher_text, position, prechat_enabled, business_hours_enabled, business_hours, offline_message, proactive_delay, is_enabled'

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// Validate the business_hours JSON. Returns a clean object, null (clear it), or
// undefined (not provided / not an object → leave the column unchanged).
function sanitizeBusinessHours(v: unknown): { tz: string; days: string[]; open: string; close: string } | null | undefined {
  if (v === null) return null
  if (typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const tz = typeof o.tz === 'string' && o.tz.length <= 64 ? o.tz : 'UTC'
  const days = Array.isArray(o.days) ? (o.days.filter((d) => typeof d === 'string' && DAY_KEYS.includes(d)) as string[]) : []
  const open = typeof o.open === 'string' && TIME_RE.test(o.open) ? o.open : '09:00'
  const close = typeof o.close === 'string' && TIME_RE.test(o.close) ? o.close : '17:00'
  return { tz, days, open, close }
}

async function findWidget(admin: Awaited<ReturnType<typeof createServiceRoleClient>>, companyId: string) {
  const { data: acct } = await admin
    .from('accounts')
    .select('id')
    .eq('channel_type', 'livechat')
    .eq('company_id', companyId)
    .limit(1)
    .maybeSingle()
  if (!acct) return null
  const accountId = (acct as { id: string }).id
  const { data: widget } = await admin
    .from('livechat_widgets')
    .select(WIDGET_COLS)
    .eq('account_id', accountId)
    .maybeSingle()
  return widget ?? null
}

export async function GET(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const companyId = await resolveTargetCompanyId(request, gate.ctx)
  if (!companyId) return NextResponse.json({ widget: null })
  const admin = await createServiceRoleClient()
  return NextResponse.json({ widget: await findWidget(admin, companyId) })
}

export async function POST(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { ctx } = gate
  const companyId = await resolveTargetCompanyId(request, ctx)
  if (!companyId) return NextResponse.json({ error: 'No company scope' }, { status: 400 })

  const admin = await createServiceRoleClient()
  const existing = await findWidget(admin, companyId)
  if (existing) return NextResponse.json({ widget: existing })

  // Create the livechat account (rest of accounts columns default).
  const { data: acct, error: acctErr } = await admin
    .from('accounts')
    .insert({ name: 'Live Chat', channel_type: 'livechat', company_id: companyId, is_active: true })
    .select('id')
    .single()
  if (acctErr || !acct) {
    return NextResponse.json({ error: acctErr?.message || 'Failed to create account' }, { status: 500 })
  }

  const { data: widget, error: wErr } = await admin
    .from('livechat_widgets')
    .insert({ account_id: (acct as { id: string }).id, widget_key: generateWidgetKey(), created_by: ctx.userId })
    .select(WIDGET_COLS)
    .single()
  if (wErr || !widget) {
    return NextResponse.json({ error: wErr?.message || 'Failed to create widget' }, { status: 500 })
  }
  return NextResponse.json({ widget }, { status: 201 })
}

export async function PATCH(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { ctx } = gate
  const companyId = await resolveTargetCompanyId(request, ctx)
  if (!companyId) return NextResponse.json({ error: 'No company scope' }, { status: 400 })

  let body: { title?: string; color?: string; welcome_message?: string; subtitle?: string; launcher_text?: string; position?: string; prechat_enabled?: boolean; business_hours_enabled?: boolean; business_hours?: unknown; offline_message?: string; proactive_delay?: number; is_enabled?: boolean }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()
  const existing = await findWidget(admin, companyId)
  if (!existing) return NextResponse.json({ error: 'Widget not found' }, { status: 404 })

  const patch: Record<string, unknown> = {}
  if (typeof body.title === 'string') patch.title = body.title.slice(0, 80)
  if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) patch.color = body.color
  if (typeof body.welcome_message === 'string') patch.welcome_message = body.welcome_message.slice(0, 500)
  if (typeof body.subtitle === 'string') patch.subtitle = body.subtitle.slice(0, 120)
  if (typeof body.launcher_text === 'string') patch.launcher_text = body.launcher_text.slice(0, 40)
  if (body.position === 'left' || body.position === 'right') patch.position = body.position
  if (typeof body.prechat_enabled === 'boolean') patch.prechat_enabled = body.prechat_enabled
  if (typeof body.business_hours_enabled === 'boolean') patch.business_hours_enabled = body.business_hours_enabled
  if (typeof body.offline_message === 'string') patch.offline_message = body.offline_message.slice(0, 500)
  const bh = sanitizeBusinessHours(body.business_hours)
  if (bh !== undefined) patch.business_hours = bh
  if (typeof body.proactive_delay === 'number' && Number.isFinite(body.proactive_delay)) patch.proactive_delay = Math.min(600, Math.max(0, Math.round(body.proactive_delay)))
  if (typeof body.is_enabled === 'boolean') patch.is_enabled = body.is_enabled
  if (Object.keys(patch).length === 0) return NextResponse.json({ widget: existing })

  const { data: widget, error } = await admin
    .from('livechat_widgets')
    .update(patch)
    .eq('id', (existing as { id: string }).id)
    .select(WIDGET_COLS)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ widget })
}
