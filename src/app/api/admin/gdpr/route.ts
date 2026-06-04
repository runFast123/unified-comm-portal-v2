// POST /api/admin/gdpr
//
// Data-subject rights (GDPR/CCPA) for a customer whose PII lives in this
// tenant's conversations: ACCESS (export) and ERASURE (anonymize).
//
// Body: { action: 'export' | 'erase', email?, phone?, confirm? }
//   - At least one of `email` / `phone` is required (the data-subject identifier).
//   - `erase` additionally requires `confirm: true` (it is irreversible).
//
// Tenant scope: company_admin only (super_admin spans all accounts). Everything
// is scoped through `account_id` — the real tenant boundary — so a company admin
// can only export/erase data inside their own company's accounts. The shared
// `contacts` directory (no account_id column → global) is read-only on export
// and intentionally left untouched on erase to avoid cross-tenant impact.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireCompanyAdmin, tenantAccountIds } from '@/lib/tenant-guard'
import { parseJsonBody } from '@/lib/validation'

const GdprSchema = z.object({
  action: z.enum(['export', 'erase']),
  email: z.string().optional(),
  phone: z.string().optional(),
  confirm: z.boolean().optional(),
})

type Row = Record<string, unknown>

export async function POST(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { ctx } = gate

  const parsed = await parseJsonBody(request, GdprSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const action = body.action
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  if (!email && !phone) {
    return NextResponse.json({ error: 'email or phone is required' }, { status: 400 })
  }
  if (action === 'erase' && body.confirm !== true) {
    return NextResponse.json(
      { error: 'erase is irreversible — resend with confirm: true' },
      { status: 400 }
    )
  }

  const admin = await createServiceRoleClient()

  // Account scope. null = super_admin (all accounts); otherwise the caller's
  // company accounts. An empty list (company with no accounts) matches nothing.
  const allowed = await tenantAccountIds(ctx)
  const scoped: string[] | null = allowed ? [...allowed] : null
  if (scoped && scoped.length === 0) {
    return NextResponse.json(
      action === 'export'
        ? { action, data_subject: { email, phone }, counts: { conversations: 0, messages: 0, csat: 0, contacts: 0 }, conversations: [], messages: [], csat: [], contacts: [] }
        : { action, data_subject: { email, phone }, erased: { conversations: 0, messages: 0, csat: 0 } }
    )
  }

  // ── Matched conversations (full rows), scoped to the caller's accounts ──
  const convRows: Row[] = []
  const seen = new Set<string>()
  const matchConvs = async (col: 'participant_email' | 'participant_phone', val: string) => {
    let q = admin.from('conversations').select('*').eq(col, val)
    if (scoped) q = q.in('account_id', scoped)
    const { data } = await q
    for (const r of (data ?? []) as Row[]) {
      const id = r.id as string
      if (!seen.has(id)) {
        seen.add(id)
        convRows.push(r)
      }
    }
  }
  if (email) await matchConvs('participant_email', email)
  if (phone) await matchConvs('participant_phone', phone)
  const convIds = [...seen]
  const contactIds = [
    ...new Set(convRows.map((r) => r.contact_id as string | null).filter((x): x is string => !!x)),
  ]

  if (action === 'export') {
    // Messages in the matched conversations.
    let messages: Row[] = []
    if (convIds.length) {
      const { data } = await admin
        .from('messages')
        .select(
          'id, conversation_id, channel, sender_name, sender_type, direction, message_text, email_subject, whatsapp_media_url, attachments, timestamp, received_at'
        )
        .in('conversation_id', convIds)
        .order('timestamp', { ascending: true })
        .limit(5000)
      messages = (data ?? []) as Row[]
    }

    // CSAT responses tied to the subject's email, within scope.
    let csat: Row[] = []
    if (email) {
      let q = admin
        .from('csat_surveys')
        .select('id, conversation_id, customer_email, rating, feedback, sent_at, responded_at')
        .eq('customer_email', email)
      if (scoped) q = q.in('account_id', scoped)
      const { data } = await q
      csat = (data ?? []) as Row[]
    }

    // Contact directory rows referenced by the matched conversations (read-only;
    // `contacts` is global so we only surface rows this tenant actually links to).
    let contacts: Row[] = []
    if (contactIds.length) {
      const { data } = await admin
        .from('contacts')
        .select('id, email, phone, display_name, notes, tags, first_seen_at, last_seen_at, is_vip')
        .in('id', contactIds)
      contacts = (data ?? []) as Row[]
    }

    await admin.from('audit_log').insert({
      user_id: ctx.userId,
      action: 'gdpr.export',
      entity_type: 'data_subject',
      entity_id: null,
      details: {
        email,
        phone,
        company_id: ctx.companyId,
        counts: { conversations: convRows.length, messages: messages.length, csat: csat.length, contacts: contacts.length },
      },
    })

    return NextResponse.json({
      action,
      data_subject: { email: email || null, phone: phone || null },
      scope: { company_id: ctx.companyId, super_admin: ctx.isSuperAdmin },
      counts: { conversations: convRows.length, messages: messages.length, csat: csat.length, contacts: contacts.length },
      conversations: convRows,
      messages,
      csat,
      contacts,
    })
  }

  // ── action === 'erase' (anonymize, irreversible) ──────────────────────
  let erasedConvs = 0
  let erasedMsgs = 0
  let erasedCsat = 0

  if (convIds.length) {
    const { data: uc } = await admin
      .from('conversations')
      .update({
        participant_name: '[erased]',
        participant_email: null,
        participant_phone: null,
        ai_summary: null,
      })
      .in('id', convIds)
      .select('id')
    erasedConvs = (uc ?? []).length

    const { data: um } = await admin
      .from('messages')
      .update({
        sender_name: '[erased]',
        message_text: '[erased]',
        email_subject: '[erased]',
        whatsapp_media_url: null,
        attachments: [],
      })
      .in('conversation_id', convIds)
      .select('id')
    erasedMsgs = (um ?? []).length
  }

  if (email) {
    let q = admin
      .from('csat_surveys')
      .update({ customer_email: null, feedback: null })
      .eq('customer_email', email)
    if (scoped) q = q.in('account_id', scoped)
    const { data: us } = await q.select('id')
    erasedCsat = (us ?? []).length
  }

  await admin.from('audit_log').insert({
    user_id: ctx.userId,
    action: 'gdpr.erase',
    entity_type: 'data_subject',
    entity_id: null,
    details: {
      email,
      phone,
      company_id: ctx.companyId,
      erased: { conversations: erasedConvs, messages: erasedMsgs, csat: erasedCsat },
    },
  })

  return NextResponse.json({
    action,
    data_subject: { email: email || null, phone: phone || null },
    erased: { conversations: erasedConvs, messages: erasedMsgs, csat: erasedCsat },
    note: 'Anonymized in place. The shared contacts directory (global, cross-tenant) was left untouched by design.',
  })
}
