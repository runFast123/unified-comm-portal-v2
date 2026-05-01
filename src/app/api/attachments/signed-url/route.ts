import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getCurrentUser, isSuperAdmin, isCompanyAdmin } from '@/lib/auth'
import { verifyAccountAccess } from '@/lib/api-helpers'

export const runtime = 'nodejs'

const BUCKET = 'attachments'
const EXPIRES_SECONDS = 3600 // 1 hour

/**
 * GET /api/attachments/signed-url?path=<storage path>
 * Returns { url } for a short-lived signed URL. Used by the conversation
 * thread UI when rendering outbound attachment chips (bucket is private).
 *
 * Access control (defense in depth):
 *   1. Path layout MUST be `{owner_user_id}/{conversation_id}/{filename...}`.
 *   2. For non-super_admin callers, the first segment MUST equal the caller's
 *      auth user id — this prevents crafted paths that point at someone
 *      else's owner-prefix from being signed.
 *   3. The conversation must exist AND the caller must have account access
 *      to it (super_admin / company_admin / company-scoped membership).
 *   4. The object must actually exist at the requested path — we list the
 *      parent prefix and verify the filename appears, so signing is gated
 *      on storage existence too (defends against path-traversal-style
 *      crafting where the segment-shape matches but the file is elsewhere).
 */
export async function GET(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(request.url)
    const path = url.searchParams.get('path')
    if (!path) {
      return NextResponse.json({ error: 'Missing path' }, { status: 400 })
    }

    // Parse {user_id}/{conversation_id}/{rest...}
    const segments = path.split('/')
    if (segments.length < 3) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }
    const conversationId = segments[1]

    const profile = await getCurrentUser(user.id)
    if (!profile) return NextResponse.json({ error: 'User profile not found' }, { status: 403 })

    const isPriv = isSuperAdmin(profile.role) || isCompanyAdmin(profile.role)

    // FIX: For non-super_admin, the path MUST belong to the caller — reject
    // paths whose owner segment is some other user's id.
    if (!isSuperAdmin(profile.role) && segments[0] !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const admin = await createServiceRoleClient()

    const { data: conv } = await admin
      .from('conversations')
      .select('id, account_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    // FIX: account-scope check via verifyAccountAccess (covers super_admin,
    // company_admin, and company-scoped members alike). Privileged role alone
    // is no longer sufficient — they still need access to *this* account.
    const allowed = await verifyAccountAccess(user.id, conv.account_id as string)
    if (!allowed && !isPriv) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    // Even privileged callers must have account access (super_admin always
    // does via verifyAccountAccess). company_admin scoped to a different
    // company should not be able to sign.
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // FIX: Verify the object actually exists at this exact path. We list the
    // parent "directory" and check that the filename is present.
    const lastSlash = path.lastIndexOf('/')
    const dirPrefix = path.slice(0, lastSlash)
    const fileName = path.slice(lastSlash + 1)
    if (!fileName) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }
    const { data: listing, error: listErr } = await admin.storage
      .from(BUCKET)
      .list(dirPrefix, { limit: 1000, search: fileName })
    if (listErr) {
      return NextResponse.json(
        { error: listErr.message || 'Failed to verify object' },
        { status: 500 }
      )
    }
    const exists = (listing ?? []).some((entry) => entry.name === fileName)
    if (!exists) {
      return NextResponse.json({ error: 'Object not found' }, { status: 404 })
    }

    const { data: signed, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(path, EXPIRES_SECONDS)
    if (error || !signed?.signedUrl) {
      return NextResponse.json(
        { error: error?.message || 'Failed to sign URL' },
        { status: 500 }
      )
    }

    return NextResponse.json({ url: signed.signedUrl })
  } catch (err) {
    console.error('Signed-url error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Signed URL failed' },
      { status: 500 }
    )
  }
}
