import { NextResponse } from 'next/server'
import nodemailer from 'nodemailer'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { parseMentions, dedupeMentionUserIds } from '@/lib/mentions'
import { verifyAccountAccess } from '@/lib/api-helpers'
import { getAllowedAccountIds } from '@/lib/auth'

interface CreateNoteBody {
  conversation_id?: string
  note_text?: string
  author_name?: string | null
  is_pinned?: boolean
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render a note body into plain text by replacing mention tokens with
 * `@<display name>` — used in email/UI previews where the markdown form
 * would be ugly.
 */
function noteToPlainText(text: string): string {
  return text.replace(/@\[([^\]\n]+)\]\(([0-9a-fA-F-]{36})\)/g, '@$1')
}

/**
 * POST /api/notes
 *
 * Body: { conversation_id, note_text, author_name?, is_pinned? }
 *
 * Inserts the note, parses any `@[Name](uuid)` mentions, writes a
 * `note_mentions` row per unique mentioned user, and (best-effort) emails
 * each mentioned user. Returns the new note row.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()
  if (!authUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: CreateNoteBody
  try {
    body = (await request.json()) as CreateNoteBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const conversationId = body.conversation_id?.trim()
  const noteText = body.note_text?.trim()
  if (!conversationId) {
    return NextResponse.json({ error: 'conversation_id required' }, { status: 400 })
  }
  if (!noteText) {
    return NextResponse.json({ error: 'note_text required' }, { status: 400 })
  }
  if (noteText.length > 10000) {
    return NextResponse.json({ error: 'note_text too long (max 10k chars)' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // FIX: ALWAYS enforce account scope. Previously we relied on the UI gating
  // access — that's not enough; the route is reachable directly. Look up
  // account_id and check via verifyAccountAccess (super_admin / company /
  // legacy single-account scope all handled).
  const { data: conv } = await admin
    .from('conversations')
    .select('id, account_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const hasAccountAccess = await verifyAccountAccess(
    authUser.id,
    conv.account_id as string,
  )
  if (!hasAccountAccess) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Insert the note
  const { data: note, error: noteErr } = await admin
    .from('conversation_notes')
    .insert({
      conversation_id: conversationId,
      note_text: noteText,
      author_name: body.author_name ?? null,
      author_id: authUser.id,
      is_pinned: body.is_pinned === true,
    })
    .select('id, conversation_id, note_text, author_name, is_pinned, created_at')
    .single()

  if (noteErr || !note) {
    return NextResponse.json(
      { error: noteErr?.message || 'Failed to create note' },
      { status: 500 }
    )
  }

  // Parse mentions and persist them (best-effort — if this fails, we still
  // return success because the note itself is saved).
  const mentions = parseMentions(noteText)
  const uniqueUserIds = dedupeMentionUserIds(mentions)
  let createdMentions: Array<{ id: string; mentioned_user_id: string }> = []

  if (uniqueUserIds.length > 0) {
    // Validate each mentioned user actually exists — silently drop any that
    // don't (the autocomplete should never produce bogus IDs but defense in
    // depth is cheap).
    const { data: validUsersRaw } = await admin
      .from('users')
      .select('id, full_name, email, account_id')
      .in('id', uniqueUserIds)

    // FIX: Restrict mentions to users whose account_id resolves to a company
    // in the caller's allowed account list. Cross-company mentions are
    // silently dropped (treated as if the user does not exist) — same
    // shape as the autocomplete, which already filters by company scope.
    const callerAllowed = await getAllowedAccountIds(authUser.id)
    const validUsers = (validUsersRaw || []).filter((u) => {
      // null sentinel = super_admin → no scope restriction.
      if (callerAllowed === null) return true
      const acct = (u as { account_id?: string | null }).account_id
      // Users with no account_id are out-of-scope for non-super_admin.
      if (!acct) return false
      return callerAllowed.has(acct)
    })

    const validIds = new Set(validUsers.map((u) => u.id as string))
    const rows = uniqueUserIds
      .filter((uid) => validIds.has(uid) && uid !== authUser.id) // don't notify self
      .map((uid) => ({
        note_id: note.id,
        mentioned_user_id: uid,
        conversation_id: conversationId,
      }))

    if (rows.length > 0) {
      const { data: inserted, error: mentionErr } = await admin
        .from('note_mentions')
        .insert(rows)
        .select('id, mentioned_user_id')
      if (!mentionErr && inserted) {
        createdMentions = inserted as Array<{ id: string; mentioned_user_id: string }>
      } else if (mentionErr) {
        console.error('note_mentions insert failed:', mentionErr.message)
      }
    }

    // Fire email notifications (best-effort, fully non-blocking on failure).
    const smtpUser = process.env.SMTP_USER
    const smtpPassword = process.env.SMTP_PASSWORD
    if (smtpUser && smtpPassword && createdMentions.length > 0) {
      const portalUrl =
        process.env.NEXT_PUBLIC_SITE_URL || 'https://unified-comm-portal.vercel.app'
      const conversationUrl = `${portalUrl}/conversations/${conversationId}`
      const authorLabel = body.author_name || 'A teammate'
      const plainPreview = noteToPlainText(noteText).slice(0, 280)
      const usersById = new Map(
        (validUsers || []).map((u) => [
          u.id as string,
          { email: u.email as string | null, full_name: u.full_name as string | null },
        ])
      )

      try {
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: { user: smtpUser, pass: smtpPassword },
        })

        await Promise.allSettled(
          createdMentions.map(async (m) => {
            const target = usersById.get(m.mentioned_user_id)
            if (!target?.email) return
            await transporter.sendMail({
              from: `"Unified Comms Portal" <${smtpUser}>`,
              to: target.email,
              subject: `${authorLabel} mentioned you in a note`,
              html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
  <div style="background:#0d9488;padding:16px 24px;"><h1 style="margin:0;color:#fff;font-size:16px;">You were mentioned</h1></div>
  <div style="padding:20px 24px;">
    <p style="margin:0 0 12px;font-size:14px;color:#1e293b;"><strong>${escapeHtml(authorLabel)}</strong> mentioned you in an internal note:</p>
    <div style="background:#f0fdfa;border-left:3px solid #14b8a6;padding:10px 14px;margin:12px 0;border-radius:0 4px 4px 0;">
      <p style="margin:0;font-size:13px;color:#334155;line-height:1.5;white-space:pre-wrap;">${escapeHtml(plainPreview)}</p>
    </div>
    <a href="${conversationUrl}" style="display:inline-block;background:#0d9488;color:#fff;text-decoration:none;padding:8px 20px;border-radius:6px;font-size:13px;font-weight:500;">Open Conversation</a>
  </div>
  <div style="padding:12px 24px;border-top:1px solid #e2e8f0;"><p style="margin:0;font-size:11px;color:#94a3b8;">Unified Communication Portal · You can mute these in your notification rules.</p></div>
</div>`.trim(),
            })
          })
        )
      } catch (err) {
        console.error('mention email send failed:', err instanceof Error ? err.message : err)
      }
    }
  }

  return NextResponse.json({
    success: true,
    note,
    mentioned_user_ids: createdMentions.map((m) => m.mentioned_user_id),
  })
}
