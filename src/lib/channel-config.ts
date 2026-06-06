import { createServiceRoleClient } from '@/lib/supabase-server'
import { encrypt, decrypt } from '@/lib/encryption'
import { logError } from '@/lib/logger'

export type Channel = 'email' | 'teams' | 'whatsapp' | 'sms' | 'telegram' | 'messenger' | 'instagram'

// ─── Config shapes per channel ────────────────────────────────────────

export interface EmailConfig {
  smtp_host: string
  smtp_port: number
  smtp_secure: boolean
  smtp_user: string
  smtp_password: string
  smtp_from_name: string
  // IMAP (inbound polling). Optional — if absent, this account is send-only.
  imap_host?: string
  imap_port?: number
  imap_secure?: boolean
  imap_user?: string
  imap_password?: string
  // Gmail OAuth (optional). When auth_mode === 'gmail_oauth', the app uses
  // XOAUTH2 (nodemailer) for SMTP send and ImapFlow accessToken for IMAP
  // receive — no app password needed. Protocol stays SMTP+IMAP, only the
  // authentication mechanism changes. Default (undefined) = 'smtp'.
  auth_mode?: 'smtp' | 'gmail_oauth'
  google_refresh_token?: string
  google_access_token?: string // optional cache
  google_access_token_expires_at?: number // epoch ms
  google_user_email?: string // display ("Connected as X") + XOAUTH2 user
  google_user_id?: string // sub claim from userinfo
  google_connected_at?: number // epoch ms
}

export interface TeamsConfig {
  azure_tenant_id: string
  azure_client_id: string
  azure_client_secret: string
  // Delegated (OAuth) fields — optional. If present, the app uses the
  // delegated flow (user-scoped Graph, e.g. /me/chats) instead of the
  // client-credentials flow. This is opt-in per account and bypasses the
  // "Protected API Access" gate on chat messages.
  auth_mode?: 'app' | 'delegated'
  delegated_refresh_token?: string
  delegated_access_token?: string // optional cache
  delegated_access_token_expires_at?: number // epoch ms
  delegated_user_email?: string // display only ("Connected as X")
  delegated_user_id?: string // Graph user id of the connected user
  delegated_connected_at?: number // epoch ms
}

export interface WhatsAppConfig {
  phone_number_id: string
  access_token: string
  verify_token: string
  graph_version: string
}

export interface SmsConfig {
  account_sid: string
  auth_token: string
  /** The Twilio sending number in E.164, e.g. +14155552671. */
  from_number: string
}

export interface TelegramConfig {
  /** Bot token from @BotFather, e.g. 123456:ABC-DEF... */
  bot_token: string
}

export interface MessengerConfig {
  /** Facebook Page ID the bot replies as. */
  page_id: string
  /** Page Access Token from the Meta app (needs pages_messaging). */
  page_access_token: string
  graph_version?: string
}

export interface InstagramConfig {
  /** Facebook Page ID linked to the Instagram professional account. */
  page_id: string
  /** Page Access Token (needs instagram_manage_messages). */
  page_access_token: string
  graph_version?: string
}

export type ChannelConfigMap = {
  email: EmailConfig
  teams: TeamsConfig
  whatsapp: WhatsAppConfig
  sms: SmsConfig
  telegram: TelegramConfig
  messenger: MessengerConfig
  instagram: InstagramConfig
}

// Fields that should never be returned to the UI in clear text
const SECRET_FIELDS: Record<Channel, string[]> = {
  email: ['smtp_password', 'imap_password', 'google_refresh_token', 'google_access_token'],
  teams: ['azure_client_secret', 'delegated_refresh_token', 'delegated_access_token'],
  whatsapp: ['access_token', 'verify_token'],
  sms: ['auth_token'],
  telegram: ['bot_token'],
  messenger: ['page_access_token'],
  instagram: ['page_access_token'],
}

// Fields that MUST be present (non-empty) before a channel config can be saved.
// Drives POST /api/channels/config so a new channel declares its required
// credentials here in ONE place instead of a per-channel branch in the route.
export const REQUIRED_CONFIG_FIELDS: Record<Channel, string[]> = {
  email: ['smtp_host', 'smtp_user', 'smtp_password'],
  teams: ['azure_tenant_id', 'azure_client_id', 'azure_client_secret'],
  whatsapp: ['phone_number_id', 'access_token'],
  sms: ['account_sid', 'auth_token', 'from_number'],
  telegram: ['bot_token'],
  messenger: ['page_id', 'page_access_token'],
  instagram: ['page_id', 'page_access_token'],
}

/**
 * Return the first required field that is missing/empty from a candidate
 * config, or null when all are present. Mirrors the prior per-channel
 * `if (!c[f]) ...` loop exactly — same falsiness check (empty string / 0 /
 * false all count as missing).
 */
export function firstMissingConfigField(
  channel: Channel,
  config: Record<string, unknown>
): string | null {
  for (const f of REQUIRED_CONFIG_FIELDS[channel]) {
    if (!config[f]) return f
  }
  return null
}

// ─── Env fallback ─────────────────────────────────────────────────────

function envEmailConfig(): EmailConfig | null {
  const host = process.env.SMTP_HOST
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASSWORD
  if (!host || !user || !pass) return null
  const imapHost = process.env.IMAP_HOST
  const imapUser = process.env.IMAP_USER || user
  const imapPass = process.env.IMAP_PASSWORD || pass
  return {
    smtp_host: host,
    smtp_port: Number(process.env.SMTP_PORT || 465),
    smtp_secure: process.env.SMTP_SECURE !== 'false',
    smtp_user: user,
    smtp_password: pass,
    smtp_from_name: process.env.SMTP_FROM_NAME || 'Unified Comm Portal',
    imap_host: imapHost || undefined,
    imap_port: imapHost ? Number(process.env.IMAP_PORT || 993) : undefined,
    imap_secure: imapHost ? process.env.IMAP_SECURE !== 'false' : undefined,
    imap_user: imapHost ? imapUser : undefined,
    imap_password: imapHost ? imapPass : undefined,
  }
}

function envTeamsConfig(): TeamsConfig | null {
  const tenant = process.env.AZURE_TENANT_ID
  const clientId = process.env.AZURE_CLIENT_ID
  const secret = process.env.AZURE_CLIENT_SECRET
  if (!tenant || !clientId || !secret) return null
  return { azure_tenant_id: tenant, azure_client_id: clientId, azure_client_secret: secret }
}

function envWhatsAppConfig(): WhatsAppConfig | null {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  if (!phoneId || !token) return null
  return {
    phone_number_id: phoneId,
    access_token: token,
    verify_token: process.env.WHATSAPP_VERIFY_TOKEN || '',
    graph_version: process.env.WHATSAPP_GRAPH_VERSION || 'v21.0',
  }
}

function envSmsConfig(): SmsConfig | null {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_FROM_NUMBER
  if (!sid || !token || !from) return null
  return { account_sid: sid, auth_token: token, from_number: from }
}

function envTelegramConfig(): TelegramConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return null
  return { bot_token: token }
}

function envMessengerConfig(): MessengerConfig | null {
  const pageId = process.env.MESSENGER_PAGE_ID
  const token = process.env.MESSENGER_PAGE_ACCESS_TOKEN
  if (!pageId || !token) return null
  return { page_id: pageId, page_access_token: token, graph_version: process.env.MESSENGER_GRAPH_VERSION || 'v21.0' }
}

function envInstagramConfig(): InstagramConfig | null {
  const pageId = process.env.INSTAGRAM_PAGE_ID
  const token = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN
  if (!pageId || !token) return null
  return { page_id: pageId, page_access_token: token, graph_version: process.env.INSTAGRAM_GRAPH_VERSION || 'v21.0' }
}

function envConfig<C extends Channel>(channel: C): ChannelConfigMap[C] | null {
  if (channel === 'email') return envEmailConfig() as ChannelConfigMap[C] | null
  if (channel === 'teams') return envTeamsConfig() as ChannelConfigMap[C] | null
  if (channel === 'whatsapp') return envWhatsAppConfig() as ChannelConfigMap[C] | null
  if (channel === 'sms') return envSmsConfig() as ChannelConfigMap[C] | null
  if (channel === 'telegram') return envTelegramConfig() as ChannelConfigMap[C] | null
  if (channel === 'messenger') return envMessengerConfig() as ChannelConfigMap[C] | null
  return envInstagramConfig() as ChannelConfigMap[C] | null
}

// ─── DB lookup (with env fallback) ────────────────────────────────────

/**
 * Resolve credentials for an account+channel. Order of precedence:
 *   1. channel_configs row (decrypted) for this account+channel
 *   2. env vars (global default)
 * Returns null if neither is configured.
 */
export async function getChannelConfig<C extends Channel>(
  accountId: string | null,
  channel: C
): Promise<ChannelConfigMap[C] | null> {
  if (accountId) {
    const supabase = await createServiceRoleClient()
    const { data } = await supabase
      .from('channel_configs')
      .select('config_encrypted')
      .eq('account_id', accountId)
      .eq('channel', channel)
      .maybeSingle()

    if (data?.config_encrypted) {
      try {
        const cfg = JSON.parse(decrypt(data.config_encrypted)) as ChannelConfigMap[C]
        // Honour the UI promise that IMAP user/password default to SMTP values
        // when left blank. Applies only to email configs.
        if (channel === 'email') {
          const e = cfg as unknown as EmailConfig
          if (e.imap_host) {
            if (!e.imap_user) e.imap_user = e.smtp_user
            // Only inherit the SMTP password when (a) we're in SMTP auth
            // mode (Gmail OAuth legitimately has no IMAP password — it uses
            // the token instead) AND (b) the IMAP host is the same server
            // as the SMTP host. Copying a Gmail app password to a
            // third-party IMAP server would silently leak credentials to
            // somewhere they weren't issued for.
            if (
              !e.imap_password &&
              e.auth_mode !== 'gmail_oauth' &&
              e.imap_host === e.smtp_host
            ) {
              e.imap_password = e.smtp_password
            }
            if (e.imap_port === undefined || e.imap_port === null) e.imap_port = 993
            if (e.imap_secure === undefined || e.imap_secure === null) e.imap_secure = true
          }
        }
        return cfg
      } catch (err) {
        // Loud decrypt failure — a broken DB row is NOT the same as "no
        // row", and falling back to env defaults silently has masked
        // encryption-key rotations in the past. Emit an audit log so an
        // admin notices, then fall through to env as a last-resort.
        console.error(`Failed to decrypt channel config for ${accountId}/${channel}:`, err)
        try {
          await logError(
            'system',
            'channel_config.decrypt_failed',
            `Could not decrypt channel config — encryption key may have rotated`,
            {
              account_id: accountId,
              channel,
              error: err instanceof Error ? err.message : String(err),
            }
          )
        } catch { /* never break caller on logging failure */ }
        // fall through to env
      }
    }
  }
  return envConfig(channel)
}

/** Upsert encrypted credentials for an account+channel. */
export async function saveChannelConfig<C extends Channel>(
  accountId: string,
  channel: C,
  config: ChannelConfigMap[C]
): Promise<void> {
  const supabase = await createServiceRoleClient()
  const ciphertext = encrypt(JSON.stringify(config))
  const { error } = await supabase
    .from('channel_configs')
    .upsert(
      {
        account_id: accountId,
        channel,
        config_encrypted: ciphertext,
        // New/updated credentials are unverified until re-tested — clear any
        // prior Test-Connection result so the gate badge reflects the new secret.
        last_tested_at: null,
        last_test_ok: null,
        last_test_error: null,
      },
      { onConflict: 'account_id,channel' }
    )
  if (error) throw new Error(`Failed to save channel config: ${error.message}`)
}

/** Fetch config with secrets masked, for display in the admin UI. */
export async function getMaskedChannelConfig<C extends Channel>(
  accountId: string,
  channel: C
): Promise<{
  source: 'db' | 'env' | 'none' | 'db_broken'
  config: Partial<ChannelConfigMap[C]> | null
  lastTestedAt: string | null
  lastTestOk: boolean | null
}> {
  const supabase = await createServiceRoleClient()
  const { data } = await supabase
    .from('channel_configs')
    .select('config_encrypted, last_tested_at, last_test_ok')
    .eq('account_id', accountId)
    .eq('channel', channel)
    .maybeSingle()

  // Test-status only exists on a saved (db) row; null for env/none.
  const lastTestedAt = (data as { last_tested_at?: string | null } | null)?.last_tested_at ?? null
  const lastTestOk = (data as { last_test_ok?: boolean | null } | null)?.last_test_ok ?? null

  let raw: ChannelConfigMap[C] | null = null
  let source: 'db' | 'env' | 'none' | 'db_broken' = 'none'
  let dbBroken = false
  if (data?.config_encrypted) {
    try {
      raw = JSON.parse(decrypt(data.config_encrypted)) as ChannelConfigMap[C]
      source = 'db'
    } catch (err) {
      // Row exists but we can't decrypt it (encryption key rotated, corrupted
      // ciphertext, etc). Don't silently mask this as "env" — that hides
      // a real problem the admin needs to see.
      dbBroken = true
      console.error(`Masked config decrypt failed for ${accountId}/${channel}:`, err)
      try {
        await logError(
          'system',
          'channel_config.decrypt_failed',
          `Admin UI hit undecryptable channel_config row`,
          {
            account_id: accountId,
            channel,
            error: err instanceof Error ? err.message : String(err),
          }
        )
      } catch { /* ignore */ }
    }
  }
  if (!raw) {
    raw = envConfig(channel)
    if (raw) source = 'env'
  }
  // If there's a broken DB row, surface that even when env fallback would
  // otherwise apply — the admin should repair the row, not silently run
  // against stale env defaults.
  if (dbBroken) source = 'db_broken'
  if (!raw) return { source, config: null, lastTestedAt, lastTestOk }

  const masked: Record<string, unknown> = { ...raw }
  for (const f of SECRET_FIELDS[channel]) {
    if (masked[f]) masked[f] = '••••••••'
  }
  return { source, config: masked as Partial<ChannelConfigMap[C]>, lastTestedAt, lastTestOk }
}

/**
 * Persist the result of a Test-Connection against an account+channel's SAVED
 * credentials, so the admin UI can show a verified/failed gate. No-op when the
 * account has no own (db) row — env/platform defaults aren't per-tenant tested.
 */
export async function recordChannelConfigTest(
  accountId: string,
  channel: Channel,
  ok: boolean,
  error?: string | null
): Promise<void> {
  const supabase = await createServiceRoleClient()
  await supabase
    .from('channel_configs')
    .update({
      last_tested_at: new Date().toISOString(),
      last_test_ok: ok,
      last_test_error: ok ? null : (error ?? 'Test failed'),
    })
    .eq('account_id', accountId)
    .eq('channel', channel)
}

export async function deleteChannelConfig(accountId: string, channel: Channel): Promise<void> {
  const supabase = await createServiceRoleClient()
  const { error } = await supabase
    .from('channel_configs')
    .delete()
    .eq('account_id', accountId)
    .eq('channel', channel)
  if (error) throw new Error(`Failed to delete channel config: ${error.message}`)
}
