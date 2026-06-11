// POST /api/admin/gdpr
//
// Data-subject rights (GDPR/CCPA) for a customer whose PII lives in this
// tenant's conversations: ACCESS (export) and ERASURE (anonymize).
//
// Body: { action: 'export' | 'erase', email?, phone?, confirm? }
//   - At least one of `email` / `phone` is required (the data-subject identifier).
//   - `erase` additionally requires `confirm: true` (it is irreversible).
//
// Tenant scope: company admins are scoped to their own company's accounts via
// `account_id` — the real tenant boundary. super_admin must SELECT a company
// (tenant switcher cookie) first: data requests always run against exactly one
// tenant, never platform-wide — an erase is irreversible. The shared
// `contacts` directory (no account_id column → global) is read-only on export
// and intentionally left untouched on erase to avoid cross-tenant impact.

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { requireCompanyAdmin, tenantAccountIds } from '@/lib/tenant-guard'
import { userIdCan } from '@/lib/permissions/server'
import { parseJsonBody } from '@/lib/validation'

const GdprSchema = z.object({
  action: z.enum(['export', 'erase']),
  email: z.string().optional(),
  phone: z.string().optional(),
  confirm: z.boolean().optional(),
})

type Row = Record<string, unknown>

// PostgREST serializes `.in()` lists into the query string; cap each batch so a
// prolific data subject (hundreds of conversations) can't overflow the URL limit.
const IN_CHUNK = 150
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}
// Escape LIKE metacharacters so an email is matched LITERALLY (but
// case-insensitively, via ilike — participant_email is stored mixed-case).
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&')
}

export async function POST(request: Request) {
  const gate = await requireCompanyAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
  const { ctx } = gate

  // RBAC: the /admin/privacy page is gated by section:admin.privacy — enforce
  // the same key here so an admin explicitly DENIED the section in the roles
  // console can't just call the API directly (erase is irreversible).
  if (!(await userIdCan(ctx.userId, 'section:admin.privacy'))) {
    return NextResponse.json({ error: 'Forbidden: missing permission' }, { status: 403 })
  }

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

  // Account scope. Company admins → their company's accounts. super_admin has
  // no company of their own: honor the tenant switcher and REQUIRE a selected
  // company — an irreversible erase across every tenant from the combined
  // view is never what anyone means.
  let allowed = await tenantAccountIds(ctx)
  if (allowed === null) {
    const selected = (await cookies()).get('selected_company_id')?.value?.trim()
    if (!selected) {
      return NextResponse.json(
        { error: 'Select a company first (top-left company switcher) — data requests run against one tenant at a time.' },
        { status: 400 }
      )
    }
    const { data: accs } = await admin.from('accounts').select('id').eq('company_id', selected)
    allowed = new Set((accs ?? []).map((a) => a.id as string))
  }
  const scoped: string[] | null = [...allowed]
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
  const matchConvs = async (
    col: 'participant_email' | 'participant_phone',
    val: string,
    caseInsensitive: boolean
  ) => {
    let q = admin.from('conversations').select('*')
    // participant_email is stored MIXED-CASE, but the request email was
    // lowercased — match case-insensitively or a subject ingested as
    // `John@X.com` is silently missed (export/erase would no-op + report success).
    q = caseInsensitive ? q.ilike(col, escapeLike(val)) : q.eq(col, val)
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
  if (email) await matchConvs('participant_email', email, true)
  if (phone) await matchConvs('participant_phone', phone, false)
  const convIds = [...seen]
  const contactIds = [
    ...new Set(convRows.map((r) => r.contact_id as string | null).filter((x): x is string => !!x)),
  ]

  if (action === 'export') {
    // Messages in the matched conversations (chunked so a heavy subject can't
    // overflow the PostgREST URL length; total capped so the response is bounded).
    const messages: Row[] = []
    let messagesTruncated = false
    for (const ids of chunk(convIds, IN_CHUNK)) {
      const { data } = await admin
        .from('messages')
        .select(
          'id, conversation_id, channel, sender_name, sender_type, direction, message_text, email_subject, whatsapp_media_url, attachments, timestamp, received_at'
        )
        .in('conversation_id', ids)
        .order('timestamp', { ascending: true })
        .limit(5000)
      messages.push(...((data ?? []) as Row[]))
      if (messages.length >= 20000) {
        messagesTruncated = true
        break
      }
    }

    // CSAT responses tied to the subject's email, within scope (case-insensitive).
    let csat: Row[] = []
    if (email) {
      let q = admin
        .from('csat_surveys')
        .select('id, conversation_id, customer_email, rating, feedback, sent_at, responded_at')
        .ilike('customer_email', escapeLike(email))
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
      truncated: messagesTruncated,
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

  // Order matters for safe re-runs: scrub MESSAGES first, THEN anonymize the
  // conversations. If we nulled the conversation email first and the message
  // update then failed, a re-run could no longer match the (now-anonymized)
  // conversation by email and would orphan its PII-bearing messages forever.
  // These are separate statements (not one transaction), so each is chunked and
  // its error surfaced — a failure stops loudly and the op is safe to re-run.
  for (const ids of chunk(convIds, IN_CHUNK)) {
    const { data: um, error: umErr } = await admin
      .from('messages')
      .update({
        sender_name: '[erased]',
        message_text: '[erased]',
        email_subject: '[erased]',
        whatsapp_media_url: null,
        attachments: [],
      })
      .in('conversation_id', ids)
      .select('id')
    if (umErr) {
      return NextResponse.json(
        { error: 'Erase failed while scrubbing messages — partial state, safe to re-run.' },
        { status: 500 }
      )
    }
    erasedMsgs += (um ?? []).length
  }

  for (const ids of chunk(convIds, IN_CHUNK)) {
    const { data: uc, error: ucErr } = await admin
      .from('conversations')
      .update({
        participant_name: '[erased]',
        participant_email: null,
        participant_phone: null,
        ai_summary: null,
      })
      .in('id', ids)
      .select('id')
    if (ucErr) {
      return NextResponse.json(
        { error: 'Erase failed while anonymizing conversations — partial state, safe to re-run.' },
        { status: 500 }
      )
    }
    erasedConvs += (uc ?? []).length
  }

  if (email) {
    let q = admin
      .from('csat_surveys')
      .update({ customer_email: null, feedback: null })
      .ilike('customer_email', escapeLike(email))
    if (scoped) q = q.in('account_id', scoped)
    const { data: us, error: usErr } = await q.select('id')
    if (usErr) {
      return NextResponse.json(
        { error: 'Erase failed while scrubbing CSAT — partial state, safe to re-run.' },
        { status: 500 }
      )
    }
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
