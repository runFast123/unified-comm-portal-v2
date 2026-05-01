import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { checkRateLimit, verifyAccountAccess } from '@/lib/api-helpers'

export const runtime = 'nodejs'

// ─── Limits / validation ──────────────────────────────────────────────

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB per file
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 // 20 MB per request
const BUCKET = 'attachments'

// Deny-list: executable / script mime types that shouldn't leave our infra
// as outbound attachments. Mirrors the bucket policy in spirit — the bucket
// enforces its own allow-list, but checking here gives a clearer 400.
const DISALLOWED_MIME = new Set<string>([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-sh',
  'application/x-bat',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
  'application/x-msi',
  'application/java-archive',
])

const DISALLOWED_EXT = new Set<string>([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'jar',
])

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function sanitizeFilename(name: string): string {
  // Keep the base name; strip path separators and control chars. Preserve
  // spaces / unicode (Storage handles them fine) but collapse weird chars.
  const base = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').trim()
  return base || 'file'
}

// ─── Handler ──────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Per-user upload cap — 20 uploads/minute is plenty for human use and
    // gates abuse of the 20 MB total-bytes limit enforced below.
    if (!(await checkRateLimit(`attachments:upload:${user.id}`, 20, 60))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const form = await request.formData()
    const conversationId = form.get('conversation_id')
    if (!conversationId || typeof conversationId !== 'string') {
      return NextResponse.json({ error: 'Missing conversation_id' }, { status: 400 })
    }

    const files = form.getAll('file').filter((v): v is File => v instanceof File)
    if (files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
    }

    // Validate file set up front — cheaper to reject before uploading.
    let total = 0
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `"${f.name}" is ${(f.size / 1024 / 1024).toFixed(1)} MB (max 10 MB per file)` },
          { status: 400 }
        )
      }
      const mime = (f.type || '').toLowerCase()
      if (DISALLOWED_MIME.has(mime) || DISALLOWED_EXT.has(extOf(f.name))) {
        return NextResponse.json(
          { error: `File type not allowed: ${f.name}` },
          { status: 400 }
        )
      }
      total += f.size
    }
    if (total > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { error: `Total upload ${(total / 1024 / 1024).toFixed(1)} MB exceeds 20 MB cap` },
        { status: 400 }
      )
    }

    const admin = await createServiceRoleClient()

    // Account scope: super_admin bypasses; everyone else (company admins,
    // company members, legacy single-account users) must have access to the
    // conversation's account via verifyAccountAccess().
    const { data: profile } = await admin
      .from('users')
      .select('role, account_id')
      .eq('id', user.id)
      .maybeSingle()
    if (!profile) return NextResponse.json({ error: 'User profile not found' }, { status: 403 })

    const { data: conv } = await admin
      .from('conversations')
      .select('id, account_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const hasAccountAccess = await verifyAccountAccess(user.id, conv.account_id)
    if (!hasAccountAccess) {
      return NextResponse.json({ error: 'Forbidden: account scope mismatch' }, { status: 403 })
    }

    // Upload each file. Path: {user.id}/{conversation_id}/{ts}-{filename}
    const uploaded: Array<{
      path: string
      filename: string
      contentType: string
      size: number
      url: string
    }> = []

    for (const f of files) {
      const filename = sanitizeFilename(f.name)
      const ts = Date.now()
      const path = `${user.id}/${conversationId}/${ts}-${filename}`
      const bytes = Buffer.from(await f.arrayBuffer())
      const contentType = f.type || 'application/octet-stream'

      const { error: upErr } = await admin.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType, upsert: false })
      if (upErr) {
        return NextResponse.json(
          { error: `Upload failed for "${filename}": ${upErr.message}` },
          { status: 500 }
        )
      }

      // Signed URL (1 hr) so the UI can show a preview chip without
      // another round-trip. Bucket is private so public URLs don't work.
      const { data: signed } = await admin.storage
        .from(BUCKET)
        .createSignedUrl(path, 3600)

      uploaded.push({
        path,
        filename,
        contentType,
        size: f.size,
        url: signed?.signedUrl || '',
      })
    }

    return NextResponse.json({ uploaded })
  } catch (err) {
    console.error('Attachment upload error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    )
  }
}
