/**
 * Per-company logo upload / removal.
 *
 *   POST   /api/admin/companies/:id/logo  — multipart upload, super_admin only.
 *   DELETE /api/admin/companies/:id/logo  — clear logo + remove storage object.
 *
 * The bare PATCH /api/admin/companies/:id route still accepts an external
 * `logo_url` for the "host elsewhere" advanced case. This route handles
 * the common case where the operator just wants to upload a PNG.
 *
 * Bucket: `company-logos` (provisioned in 20260528140000 migration).
 *  - public read (no signed URLs at render time)
 *  - 512 KB cap
 *  - allowed MIME: png / jpeg / jpg / webp / svg+xml
 *
 * Path scheme: `<company_id>/<timestamp>-<safe-name>.<ext>`. Including the
 * timestamp prevents CDN cache poisoning when the same filename is uploaded
 * twice, and the per-company prefix makes future-housekeeping ("delete all
 * objects when a company is deleted") trivial.
 */

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin } from '@/lib/auth'

export const runtime = 'nodejs'

const BUCKET = 'company-logos'
const MAX_BYTES = 512 * 1024 // 512 KB — mirrors bucket policy
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/svg+xml',
])
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

async function requireSuperAdmin() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const profile = await getCurrentUser(user.id)
  if (!profile || !isSuperAdmin(profile.role)) {
    return { ok: false as const, status: 403, error: 'Only super_admin can manage company logos' }
  }
  return { ok: true as const, userId: user.id }
}

/**
 * Reduce a user-supplied filename to something safe for a storage path.
 * We don't trust it for security (the path is prefixed with the company id
 * and a server-stamped timestamp), but a sane name keeps URLs readable.
 */
function safeBaseName(name: string): string {
  const stripped = name.replace(/\.[^.]+$/, '') // strip extension
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'logo'
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const gate = await requireSuperAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  // Parse multipart. `request.formData()` is built into the runtime.
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 })
  }

  // MIME validation. Browsers usually set this correctly for <input type="file">.
  const mime = (file.type || '').toLowerCase()
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json(
      { error: `Unsupported mime type "${mime || 'unknown'}". Use PNG, JPEG, WebP, or SVG.` },
      { status: 415 },
    )
  }

  // Size validation (mirrors bucket policy — fail fast with a friendlier error).
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (${file.size} bytes). Max ${MAX_BYTES} bytes (512 KB).` },
      { status: 413 },
    )
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'File is empty' }, { status: 400 })
  }

  const admin = await createServiceRoleClient()

  // Confirm the company exists (and capture its old logo url so we can
  // best-effort delete the prior object after the upload succeeds).
  const { data: companyRow, error: companyErr } = await admin
    .from('companies')
    .select('id, name, logo_url')
    .eq('id', id)
    .maybeSingle()
  if (companyErr) return NextResponse.json({ error: companyErr.message }, { status: 500 })
  if (!companyRow) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

  const ext = MIME_TO_EXT[mime] ?? 'bin'
  const base = safeBaseName(file.name || 'logo')
  const path = `${id}/${Date.now()}-${base}.${ext}`

  const arrayBuffer = await file.arrayBuffer()
  const { error: uploadErr } = await admin.storage
    .from(BUCKET)
    .upload(path, arrayBuffer, {
      contentType: mime,
      cacheControl: '3600',
      upsert: false,
    })
  if (uploadErr) {
    return NextResponse.json({ error: `Upload failed: ${uploadErr.message}` }, { status: 500 })
  }

  // Resolve public URL for the just-uploaded object.
  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(path)
  const logoUrl = pub.publicUrl

  // Update company row.
  const { error: updErr } = await admin
    .from('companies')
    .update({ logo_url: logoUrl })
    .eq('id', id)
  if (updErr) {
    // Best-effort: clean up the just-uploaded object so we don't leak orphans.
    await admin.storage.from(BUCKET).remove([path]).catch(() => {})
    return NextResponse.json({ error: `DB update failed: ${updErr.message}` }, { status: 500 })
  }

  // Best-effort: drop the previous logo object if it was hosted in our bucket.
  // We only do this AFTER the new row is committed so a failed update doesn't
  // leave the company without any logo.
  if (companyRow.logo_url) {
    const prev = extractBucketPath(companyRow.logo_url)
    if (prev) await admin.storage.from(BUCKET).remove([prev]).catch(() => {})
  }

  // Audit log — non-fatal.
  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'company.logo_upload',
      entity_type: 'company',
      entity_id: id,
      details: {
        company_id: id,
        size: file.size,
        mime_type: mime,
        path,
      },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ logo_url: logoUrl })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const gate = await requireSuperAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = await createServiceRoleClient()

  const { data: companyRow, error: companyErr } = await admin
    .from('companies')
    .select('id, logo_url')
    .eq('id', id)
    .maybeSingle()
  if (companyErr) return NextResponse.json({ error: companyErr.message }, { status: 500 })
  if (!companyRow) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

  // Clear DB column first — the column going to null is the user-visible
  // change. Storage object removal is best-effort and shouldn't block.
  const { error: updErr } = await admin
    .from('companies')
    .update({ logo_url: null })
    .eq('id', id)
  if (updErr) {
    return NextResponse.json({ error: `DB update failed: ${updErr.message}` }, { status: 500 })
  }

  // Best-effort remove from storage if the URL points at our bucket.
  let removedPath: string | null = null
  if (companyRow.logo_url) {
    removedPath = extractBucketPath(companyRow.logo_url)
    if (removedPath) {
      await admin.storage.from(BUCKET).remove([removedPath]).catch(() => {})
    }
  }

  try {
    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'company.logo_delete',
      entity_type: 'company',
      entity_id: id,
      details: {
        company_id: id,
        prior_url: companyRow.logo_url,
        removed_path: removedPath,
      },
    })
  } catch { /* non-fatal */ }

  return NextResponse.json({ ok: true, logo_url: null })
}

/**
 * Extract `<company_id>/<file>` from a public URL such as
 *   https://<project>.supabase.co/storage/v1/object/public/company-logos/<company_id>/<file>
 * Returns null if the URL doesn't appear to belong to our bucket — we leave
 * those alone (operator may have hand-set an external logo_url).
 */
function extractBucketPath(url: string): string | null {
  const marker = `/storage/v1/object/public/${BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  return url.slice(idx + marker.length)
}
