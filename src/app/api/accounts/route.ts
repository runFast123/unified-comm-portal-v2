import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase-server'
import { getChannelConfig, saveChannelConfig } from '@/lib/channel-config'
import { verifyAccountAccess } from '@/lib/api-helpers'
import { getAzureOAuth } from '@/lib/integration-settings'
import { getRequestId } from '@/lib/request-id'
import { logError } from '@/lib/logger'

type Channel = 'email' | 'teams' | 'whatsapp'

async function requireAdmin() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  const admin = await createServiceRoleClient()
  const { data: profile } = await admin.from('users').select('role, company_id').eq('id', user.id).maybeSingle()
  if (!['admin','super_admin','company_admin'].includes(profile?.role ?? '')) return { ok: false as const, status: 403, error: 'Admin only' }
  return { ok: true as const, userId: user.id, companyId: (profile?.company_id as string | null) ?? null }
}

// POST /api/accounts  { name, channel_type, setup_mode?, gmail_address?, teams_user_id?, teams_tenant_id?, whatsapp_phone?, reuse_tenant_from_account_id? }
export async function POST(request: Request) {
  const requestId = await getRequestId()
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error, request_id: requestId }, { status: gate.status })

  try {
    const body = await request.json() as {
      name?: string
      channel_type?: Channel
      setup_mode?: 'oauth' | 'manual'
      gmail_address?: string
      teams_tenant_id?: string
      teams_user_id?: string
      whatsapp_phone?: string
      reuse_tenant_from_account_id?: string
    }
    const { name, channel_type, reuse_tenant_from_account_id, setup_mode } = body
    if (!name?.trim()) return NextResponse.json({ error: 'name required', request_id: requestId }, { status: 400 })
    if (!channel_type || !['email', 'teams', 'whatsapp'].includes(channel_type)) {
      return NextResponse.json({ error: 'channel_type must be email|teams|whatsapp', request_id: requestId }, { status: 400 })
    }
    if (setup_mode && !['oauth', 'manual'].includes(setup_mode)) {
      return NextResponse.json({ error: 'setup_mode must be oauth|manual', request_id: requestId }, { status: 400 })
    }
    // OAuth-only setup is not available for WhatsApp (Meta has no OAuth flow
    // for the Business Platform). Reject explicitly so the UI can surface
    // the right message rather than silently creating a half-configured row.
    if (setup_mode === 'oauth' && channel_type === 'whatsapp') {
      return NextResponse.json(
        { error: 'OAuth setup is not supported for WhatsApp accounts' },
        { status: 400 }
      )
    }
    // In OAuth mode the identifier (gmail_address / teams_user_id) is
    // populated by the provider callback from the signed-in user's profile,
    // so we skip the identifier requirement at create time.
    const skipIdentifier = setup_mode === 'oauth'

    // Channel-specific identifier validation
    if (!skipIdentifier && channel_type === 'email' && !body.gmail_address) {
      return NextResponse.json({ error: 'gmail_address required for email accounts' }, { status: 400 })
    }
    if (!skipIdentifier && channel_type === 'teams' && !body.teams_user_id) {
      return NextResponse.json({ error: 'teams_user_id required for teams accounts' }, { status: 400 })
    }
    if (channel_type === 'whatsapp' && !body.whatsapp_phone) {
      return NextResponse.json({ error: 'whatsapp_phone required for whatsapp accounts' }, { status: 400 })
    }

    // Tenant-reuse validation (Teams only).
    let reusedTenantConfig: { azure_tenant_id: string; azure_client_id: string; azure_client_secret: string } | null = null
    if (reuse_tenant_from_account_id) {
      if (channel_type !== 'teams') {
        return NextResponse.json({ error: 'reuse_tenant_from_account_id only valid for Teams accounts' }, { status: 400 })
      }
      const admin = await createServiceRoleClient()
      const { data: source } = await admin
        .from('accounts')
        .select('id, channel_type, is_active')
        .eq('id', reuse_tenant_from_account_id)
        .maybeSingle()
      if (!source || source.channel_type !== 'teams' || !source.is_active) {
        return NextResponse.json({ error: 'Source account not found or not a Teams account' }, { status: 400 })
      }
      // Tenant scope: only copy Azure credentials from an account the caller's
      // company owns (super_admin may copy across tenants). Without this a
      // company_admin could clone another tenant's Teams app secret.
      if (!(await verifyAccountAccess(gate.userId, reuse_tenant_from_account_id))) {
        return NextResponse.json({ error: 'Forbidden: source account scope mismatch' }, { status: 403 })
      }
      const srcCfg = await getChannelConfig(source.id, 'teams')
      if (!srcCfg?.azure_tenant_id || !srcCfg.azure_client_id || !srcCfg.azure_client_secret) {
        return NextResponse.json({ error: 'Source account has no Azure credentials to copy' }, { status: 400 })
      }
      reusedTenantConfig = {
        azure_tenant_id: srcCfg.azure_tenant_id,
        azure_client_id: srcCfg.azure_client_id,
        azure_client_secret: srcCfg.azure_client_secret,
      }
    }

    // For Teams OAuth create-flow we need the shared Azure app creds up
    // front: they pre-populate teams_tenant_id on the row AND get written
    // into channel_configs before the user is redirected to consent (the
    // callback reads them back to exchange the auth code). Reads DB first,
    // env second, via the integration-settings helper.
    //
    // OAuth client creds are PER-COMPANY — resolve which company to look
    // up. For super_admin the active company comes from the switcher
    // cookie (`selected_company_id`); for company_admin it's their own
    // company. We refuse to proceed without a resolved company because
    // we'd otherwise pick the wrong tenant's Azure app.
    let sharedAzureCreds: Awaited<ReturnType<typeof getAzureOAuth>> = null
    if (setup_mode === 'oauth' && channel_type === 'teams' && !reusedTenantConfig) {
      const cookieStore = await cookies()
      const cookieCompanyId = cookieStore.get('selected_company_id')?.value ?? null
      const azureCompanyId = cookieCompanyId || gate.companyId
      if (!azureCompanyId) {
        return NextResponse.json(
          {
            error:
              'No active company selected — pick a tenant in the company switcher before creating a Teams OAuth account.',
          },
          { status: 400 }
        )
      }
      sharedAzureCreds = await getAzureOAuth(azureCompanyId)
      if (!sharedAzureCreds) {
        return NextResponse.json(
          {
            error:
              'Azure OAuth not configured — either configure at /admin/integrations or use Manual setup',
          },
          { status: 400 }
        )
      }
    }

    // Resolve which company this new account belongs to: super_admin uses the
    // active company from the switcher cookie; company_admin uses their own.
    // Without this the row lands with company_id = null — invisible to the
    // company-scoped RLS views that power the UI.
    const companyCookie = await cookies()
    const targetCompanyId =
      (companyCookie.get('selected_company_id')?.value || gate.companyId) ?? null

    const admin = await createServiceRoleClient()
    const insertRow: Record<string, unknown> = {
      name: name.trim(),
      channel_type,
      phase1_enabled: true,
      is_active: true,
      ...(targetCompanyId ? { company_id: targetCompanyId } : {}),
    }
    // Identifier fields: only set when actually provided. OAuth create flow
    // leaves these null; the provider callback fills them in from the
    // signed-in user's profile (google_user_email / UPN from /me).
    if (channel_type === 'email' && body.gmail_address) insertRow.gmail_address = body.gmail_address
    if (channel_type === 'teams') {
      if (body.teams_user_id) insertRow.teams_user_id = body.teams_user_id
      // Prefer explicit teams_tenant_id; fall back to the reused tenant, or
      // the shared Azure app tenant resolved above for OAuth.
      const tenantId =
        body.teams_tenant_id ||
        reusedTenantConfig?.azure_tenant_id ||
        sharedAzureCreds?.tenant_id
      if (tenantId) insertRow.teams_tenant_id = tenantId
    }
    if (channel_type === 'whatsapp') insertRow.whatsapp_phone = body.whatsapp_phone

    const { data, error } = await admin.from('accounts').insert(insertRow).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Copy tenant creds server-side (never crosses the wire to the client).
    // Don't copy delegated OAuth tokens — those are user-specific.
    //
    // All-or-nothing invariant: if credential write fails we DELETE the
    // just-inserted account row so we don't leave an orphan with no
    // credentials sitting in the DB.
    if (reusedTenantConfig) {
      try {
        await saveChannelConfig(data.id, 'teams', reusedTenantConfig)
      } catch (copyErr) {
        console.error('Tenant credential copy failed — rolling back account row:', copyErr)
        try {
          await admin.from('accounts').delete().eq('id', data.id)
        } catch (rollbackErr) {
          console.error('Rollback of orphan account failed:', rollbackErr)
        }
        return NextResponse.json(
          { error: `Failed to copy tenant credentials: ${(copyErr as Error).message}` },
          { status: 500 }
        )
      }
    }

    // For Teams OAuth create-flow with a shared Azure app, seed the
    // channel_configs row BEFORE the user is redirected to consent — the
    // callback needs azure_tenant_id/client_id/client_secret to exchange
    // the auth code. `sharedAzureCreds` was resolved earlier (DB → env) and
    // we would have already 400'd if it was null.
    if (sharedAzureCreds) {
      try {
        await saveChannelConfig(data.id, 'teams', {
          azure_tenant_id: sharedAzureCreds.tenant_id,
          azure_client_id: sharedAzureCreds.client_id,
          azure_client_secret: sharedAzureCreds.client_secret,
        })
      } catch (seedErr) {
        console.error('Teams OAuth seed save failed — rolling back account row:', seedErr)
        try {
          await admin.from('accounts').delete().eq('id', data.id)
        } catch (rollbackErr) {
          console.error('Rollback of orphan account failed:', rollbackErr)
        }
        return NextResponse.json(
          { error: `Failed to seed Teams OAuth config: ${(seedErr as Error).message}` },
          { status: 500 }
        )
      }
    }

    await admin.from('audit_log').insert({
      user_id: gate.userId,
      action: 'account.create',
      entity_type: 'account',
      entity_id: data.id,
      details: {
        name: data.name,
        channel_type: data.channel_type,
        reused_tenant_from: reuse_tenant_from_account_id || undefined,
        setup_mode: setup_mode || 'manual',
      },
    })

    return NextResponse.json({
      success: true,
      account: data,
      credentials_copied: Boolean(reusedTenantConfig),
      request_id: requestId,
    })
  } catch (err) {
    logError('system', 'account_create_error', err instanceof Error ? err.message : 'Internal error', {
      request_id: requestId,
      user_id: gate.userId,
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error', request_id: requestId },
      { status: 500 }
    )
  }
}

// DELETE /api/accounts?id=...
export async function DELETE(request: Request) {
  const requestId = await getRequestId()
  const gate = await requireAdmin()
  if (!gate.ok) return NextResponse.json({ error: gate.error, request_id: requestId }, { status: gate.status })

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required', request_id: requestId }, { status: 400 })

  const admin = await createServiceRoleClient()
  const { data: existing } = await admin.from('accounts').select('name, channel_type').eq('id', id).maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Account not found', request_id: requestId }, { status: 404 })

  // Tenant scope: a company_admin may only delete accounts in their own
  // company (super_admin may delete any). Without this, deleting by id alone
  // lets one tenant destroy another tenant's account (cascading data).
  if (!(await verifyAccountAccess(gate.userId, id))) {
    return NextResponse.json({ error: 'Forbidden: account scope mismatch', request_id: requestId }, { status: 403 })
  }

  const { error } = await admin.from('accounts').delete().eq('id', id)
  if (error) {
    logError('system', 'account_delete_error', error.message, {
      request_id: requestId,
      user_id: gate.userId,
      account_id: id,
    })
    return NextResponse.json({ error: error.message, request_id: requestId }, { status: 500 })
  }

  await admin.from('audit_log').insert({
    user_id: gate.userId,
    action: 'account.delete',
    entity_type: 'account',
    entity_id: id,
    details: { name: existing.name, channel_type: existing.channel_type },
  })

  return NextResponse.json({ success: true })
}
