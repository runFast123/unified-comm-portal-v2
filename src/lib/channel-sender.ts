import nodemailer from 'nodemailer'
import {
  getChannelConfig,
  type EmailConfig,
  type TeamsConfig,
  type WhatsAppConfig,
  type SmsConfig,
  type TelegramConfig,
  type MessengerConfig,
  type InstagramConfig,
} from '@/lib/channel-config'

export type SendResult =
  | { ok: true; provider_message_id?: string }
  | { ok: false; error: string }

export interface SendEmailAttachment {
  /** Supabase Storage path inside the `attachments` bucket. */
  path: string
  filename: string
  contentType?: string
}

export interface SendEmailInput {
  accountId: string | null
  to: string
  subject: string
  body: string
  replyToMessageId?: string | null
  configOverride?: EmailConfig
  /**
   * Optional file attachments. Files are fetched from Supabase Storage at
   * send time using the service-role client, then passed to nodemailer.
   */
  attachments?: SendEmailAttachment[]
}

export interface SendTeamsInput {
  accountId: string | null
  chatId: string
  body: string
  configOverride?: TeamsConfig
}

export interface SendWhatsAppInput {
  accountId: string | null
  toPhone: string
  body: string
  configOverride?: WhatsAppConfig
}

export interface SendSmsInput {
  accountId: string | null
  toPhone: string
  body: string
  configOverride?: SmsConfig
}

export interface SendTelegramInput {
  accountId: string | null
  chatId: string
  body: string
  configOverride?: TelegramConfig
}

export interface SendMessengerInput {
  accountId: string | null
  /** The recipient's page-scoped id (PSID). */
  recipientId: string
  body: string
  configOverride?: MessengerConfig
}

export interface SendInstagramInput {
  accountId: string | null
  /** The recipient's Instagram-scoped id (IGSID). */
  recipientId: string
  body: string
  configOverride?: InstagramConfig
}

// ─── HTML escaping (anti-XSS for outbound email) ─────────────────────
/**
 * Escape HTML special chars so user-supplied strings are safe to inline
 * into the HTML `<body>` of an outgoing email. Without this, a reply
 * containing e.g. `<script>` would be delivered as live HTML.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─── Retry helper ─────────────────────────────────────────────────────

/**
 * A thrown error is transient if the predicate says so, OR if it looks
 * like a low-level fetch/network glitch (DNS, reset, aborted) — those
 * surface as TypeError or AbortError from fetch and are almost always
 * worth retrying rather than bubbling up as a permanent send failure.
 */
function isTransientError(err: unknown, predicate: (e: Error) => boolean): boolean {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (err instanceof TypeError) return true // fetch network failure
    return predicate(err)
  }
  return false
}

/**
 * Retry an HTTP-ish operation on transient failures (429, 5xx, network errors).
 * Exponential backoff: 500ms, 1500ms, 4000ms. Max 3 attempts total.
 */
async function withRetry<T>(
  op: () => Promise<T>,
  isTransient: (result: T | Error) => boolean
): Promise<T> {
  const delays = [500, 1500, 4000]
  let lastError: unknown = null
  for (let i = 0; i < delays.length; i++) {
    try {
      const result = await op()
      if (!isTransient(result)) return result
      // Final attempt returned a transient result — return it anyway so
      // the caller can surface the upstream status.
      if (i === delays.length - 1) return result
      await new Promise((r) => setTimeout(r, delays[i]))
    } catch (err) {
      lastError = err
      const transient = isTransientError(err, (e) => isTransient(e))
      if (!transient || i === delays.length - 1) throw err
      await new Promise((r) => setTimeout(r, delays[i]))
    }
  }
  // Unreachable in normal flow — loop always returns or throws above.
  // Fall-through safety net if the logic changes later.
  if (lastError) throw lastError
  throw new Error('Retry attempts exhausted')
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

// ─── Email (SMTP) ─────────────────────────────────────────────────────

export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
  try {
    const cfg = input.configOverride ?? (await getChannelConfig(input.accountId, 'email'))
    if (!cfg) return { ok: false, error: 'SMTP is not configured for this account' }

    // Gmail OAuth (XOAUTH2) vs. classic SMTP-with-password. XOAUTH2 still
    // uses the SMTP protocol — only the auth mechanism changes — so we
    // keep using nodemailer with the same host/port, just a different
    // auth block.
    const isGmailOAuth = cfg.auth_mode === 'gmail_oauth' && !!cfg.google_refresh_token

    let transporter: nodemailer.Transporter
    let fromUser: string

    if (isGmailOAuth) {
      const { getGmailAccessToken, GmailOAuthExpiredError } = await import('@/lib/gmail-oauth')
      let token: string
      try {
        token = await getGmailAccessToken(cfg, input.accountId)
      } catch (err) {
        if (err instanceof GmailOAuthExpiredError) {
          return { ok: false, error: err.message }
        }
        throw err
      }
      const oauthUser = cfg.google_user_email || cfg.smtp_user
      transporter = nodemailer.createTransport({
        host: cfg.smtp_host || 'smtp.gmail.com',
        port: cfg.smtp_port || 465,
        secure: cfg.smtp_secure ?? true,
        auth: {
          type: 'OAuth2',
          user: oauthUser,
          clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
          refreshToken: cfg.google_refresh_token,
          accessToken: token,
        },
      })
      // From address must be the OAuthed user — Gmail rejects XOAUTH2
      // sends with a mismatched envelope sender.
      fromUser = oauthUser
    } else {
      transporter = nodemailer.createTransport({
        host: cfg.smtp_host,
        port: cfg.smtp_port,
        secure: cfg.smtp_secure,
        auth: { user: cfg.smtp_user, pass: cfg.smtp_password },
      })
      fromUser = cfg.smtp_user
    }

    // Resolve attachments: fetch each file out of Supabase Storage (the
    // bucket is private, so we need the service role client). Build the
    // nodemailer attachments array only if the caller actually passed any.
    let mailAttachments: Array<{ filename: string; content: Buffer; contentType?: string }> | undefined
    if (input.attachments && input.attachments.length > 0) {
      const { createServiceRoleClient } = await import('@/lib/supabase-server')
      const admin = await createServiceRoleClient()
      mailAttachments = []
      for (const att of input.attachments) {
        const { data, error } = await admin.storage.from('attachments').download(att.path)
        if (error || !data) {
          return {
            ok: false,
            error: `Failed to fetch attachment "${att.filename}": ${error?.message || 'not found'}`,
          }
        }
        const buf = Buffer.from(await data.arrayBuffer())
        mailAttachments.push({
          filename: att.filename,
          content: buf,
          contentType: att.contentType,
        })
      }
    }

    // Escape HTML before turning newlines into <br/>. Newlines are the only
    // "formatting" we want to preserve; everything else must be inert text.
    const safeBody = escapeHtml(input.body).replace(/\n/g, '<br/>')

    const info = await transporter.sendMail({
      from: `"${cfg.smtp_from_name}" <${fromUser}>`,
      to: input.to,
      subject: input.subject,
      text: input.body,
      html: safeBody,
      inReplyTo: input.replyToMessageId ?? undefined,
      references: input.replyToMessageId ?? undefined,
      attachments: mailAttachments,
    })
    return { ok: true, provider_message_id: info.messageId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'SMTP send failed' }
  }
}

/** Verify SMTP credentials without sending a message. */
export async function verifyEmailConfig(cfg: EmailConfig): Promise<SendResult> {
  try {
    const transporter = nodemailer.createTransport({
      host: cfg.smtp_host,
      port: cfg.smtp_port,
      secure: cfg.smtp_secure,
      auth: { user: cfg.smtp_user, pass: cfg.smtp_password },
    })
    await transporter.verify()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'SMTP verify failed' }
  }
}

// ─── Microsoft Graph (Teams) ──────────────────────────────────────────

// LRU-ish token cache. Capped so many tenants don't leak memory.
const GRAPH_TOKEN_CACHE_MAX = 50
const graphTokenCache = new Map<string, { token: string; expiresAt: number }>()

function cacheGraphToken(key: string, value: { token: string; expiresAt: number }) {
  graphTokenCache.delete(key)
  graphTokenCache.set(key, value)
  while (graphTokenCache.size > GRAPH_TOKEN_CACHE_MAX) {
    const oldest = graphTokenCache.keys().next().value
    if (oldest) graphTokenCache.delete(oldest)
    else break
  }
}

async function getGraphToken(cfg: TeamsConfig): Promise<string> {
  const key = `${cfg.azure_tenant_id}:${cfg.azure_client_id}`
  const cached = graphTokenCache.get(key)
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    // Touch LRU
    graphTokenCache.delete(key)
    graphTokenCache.set(key, cached)
    return cached.token
  }

  const res = await fetch(`https://login.microsoftonline.com/${cfg.azure_tenant_id}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.azure_client_id,
      client_secret: cfg.azure_client_secret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }),
  })
  if (!res.ok) throw new Error(`Graph token failed: ${res.status} ${await res.text()}`)
  const json = (await res.json()) as { access_token: string; expires_in: number }
  cacheGraphToken(key, {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  })
  return json.access_token
}

export async function sendTeams(input: SendTeamsInput): Promise<SendResult> {
  try {
    const cfg = input.configOverride ?? (await getChannelConfig(input.accountId, 'teams'))
    if (!cfg) return { ok: false, error: 'Teams is not configured for this account' }

    // Delegated (user-OAuth) vs. application (client-credentials) flow.
    // Delegated mode uses /me/chats and bypasses Protected API Access.
    const isDelegated = cfg.auth_mode === 'delegated' && !!cfg.delegated_refresh_token
    let token: string
    let url: string
    if (isDelegated) {
      const { getDelegatedAccessToken } = await import('@/lib/teams-delegated')
      token = await getDelegatedAccessToken(cfg, input.accountId)
      url = `https://graph.microsoft.com/v1.0/me/chats/${encodeURIComponent(input.chatId)}/messages`
    } else {
      token = await getGraphToken(cfg)
      url = `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(input.chatId)}/messages`
    }

    const res = await withRetry(
      () =>
        fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: { contentType: 'text', content: input.body } }),
        }),
      (r) => r instanceof Response && isTransientStatus(r.status)
    )
    if (!res.ok) return { ok: false, error: `Graph ${res.status}: ${await res.text()}` }
    const json = (await res.json()) as { id?: string }
    return { ok: true, provider_message_id: json.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Graph send failed' }
  }
}

export async function verifyTeamsConfig(cfg: TeamsConfig): Promise<SendResult> {
  try {
    await getGraphToken(cfg)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Graph verify failed' }
  }
}

// ─── WhatsApp (Meta Cloud API) ────────────────────────────────────────

export async function sendWhatsApp(input: SendWhatsAppInput): Promise<SendResult> {
  try {
    const cfg = input.configOverride ?? (await getChannelConfig(input.accountId, 'whatsapp'))
    if (!cfg) return { ok: false, error: 'WhatsApp is not configured for this account' }

    const version = cfg.graph_version || 'v21.0'
    const res = await withRetry(
      () =>
        fetch(`https://graph.facebook.com/${version}/${cfg.phone_number_id}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: input.toPhone,
            type: 'text',
            text: { body: input.body },
          }),
        }),
      (r) => r instanceof Response && isTransientStatus(r.status)
    )
    if (!res.ok) return { ok: false, error: `Meta ${res.status}: ${await res.text()}` }
    const json = (await res.json()) as { messages?: Array<{ id: string }> }
    return { ok: true, provider_message_id: json.messages?.[0]?.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'WhatsApp send failed' }
  }
}

export async function verifyWhatsAppConfig(cfg: WhatsAppConfig): Promise<SendResult> {
  try {
    const version = cfg.graph_version || 'v21.0'
    const res = await fetch(`https://graph.facebook.com/${version}/${cfg.phone_number_id}`, {
      headers: { Authorization: `Bearer ${cfg.access_token}` },
    })
    if (!res.ok) return { ok: false, error: `Meta ${res.status}: ${await res.text()}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'WhatsApp verify failed' }
  }
}

// ─── SMS (Twilio) ─────────────────────────────────────────────────────

export async function sendSms(input: SendSmsInput): Promise<SendResult> {
  try {
    const cfg = input.configOverride ?? (await getChannelConfig(input.accountId, 'sms'))
    if (!cfg) return { ok: false, error: 'SMS is not configured for this account' }

    // Twilio REST API: HTTP Basic auth (AccountSid:AuthToken), form-encoded body.
    const auth = Buffer.from(`${cfg.account_sid}:${cfg.auth_token}`).toString('base64')
    const res = await withRetry(
      () =>
        fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.account_sid)}/Messages.json`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ From: cfg.from_number, To: input.toPhone, Body: input.body }),
          }
        ),
      (r) => r instanceof Response && isTransientStatus(r.status)
    )
    if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${await res.text()}` }
    const json = (await res.json()) as { sid?: string }
    return { ok: true, provider_message_id: json.sid }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'SMS send failed' }
  }
}

export async function verifySmsConfig(cfg: SmsConfig): Promise<SendResult> {
  try {
    const auth = Buffer.from(`${cfg.account_sid}:${cfg.auth_token}`).toString('base64')
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.account_sid)}.json`,
      { headers: { Authorization: `Basic ${auth}` } }
    )
    if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${await res.text()}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'SMS verify failed' }
  }
}

// ─── Telegram (Bot API) ───────────────────────────────────────────────

export async function sendTelegram(input: SendTelegramInput): Promise<SendResult> {
  try {
    const cfg = input.configOverride ?? (await getChannelConfig(input.accountId, 'telegram'))
    if (!cfg) return { ok: false, error: 'Telegram is not configured for this account' }

    const res = await withRetry(
      () =>
        fetch(`https://api.telegram.org/bot${cfg.bot_token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: input.chatId, text: input.body }),
        }),
      (r) => r instanceof Response && isTransientStatus(r.status)
    )
    if (!res.ok) return { ok: false, error: `Telegram ${res.status}: ${await res.text()}` }
    const json = (await res.json()) as { ok?: boolean; result?: { message_id?: number }; description?: string }
    if (!json.ok) return { ok: false, error: json.description || 'Telegram API returned ok:false' }
    return {
      ok: true,
      provider_message_id: json.result?.message_id != null ? String(json.result.message_id) : undefined,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Telegram send failed' }
  }
}

export async function verifyTelegramConfig(cfg: TelegramConfig): Promise<SendResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.bot_token}/getMe`)
    if (!res.ok) return { ok: false, error: `Telegram ${res.status}: ${await res.text()}` }
    const json = (await res.json()) as { ok?: boolean; description?: string }
    if (!json.ok) return { ok: false, error: json.description || 'Invalid bot token' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Telegram verify failed' }
  }
}

// ─── Facebook Messenger (Meta Graph API) ──────────────────────────────

export async function sendMessenger(input: SendMessengerInput): Promise<SendResult> {
  try {
    const cfg = input.configOverride ?? (await getChannelConfig(input.accountId, 'messenger'))
    if (!cfg) return { ok: false, error: 'Messenger is not configured for this account' }

    const version = cfg.graph_version || 'v21.0'
    const res = await withRetry(
      () =>
        fetch(`https://graph.facebook.com/${version}/me/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.page_access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient: { id: input.recipientId },
            messaging_type: 'RESPONSE',
            message: { text: input.body },
          }),
        }),
      (r) => r instanceof Response && isTransientStatus(r.status)
    )
    if (!res.ok) return { ok: false, error: `Meta ${res.status}: ${await res.text()}` }
    const json = (await res.json()) as { message_id?: string }
    return { ok: true, provider_message_id: json.message_id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Messenger send failed' }
  }
}

export async function verifyMessengerConfig(cfg: MessengerConfig): Promise<SendResult> {
  try {
    const version = cfg.graph_version || 'v21.0'
    const res = await fetch(
      `https://graph.facebook.com/${version}/${encodeURIComponent(cfg.page_id)}?fields=id,name`,
      { headers: { Authorization: `Bearer ${cfg.page_access_token}` } }
    )
    if (!res.ok) return { ok: false, error: `Meta ${res.status}: ${await res.text()}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Messenger verify failed' }
  }
}

// ─── Instagram DM (Meta Graph API) ────────────────────────────────────
// Uses the same /me/messages endpoint as Messenger via the linked Page token;
// the recipient is an Instagram-scoped id (IGSID).

export async function sendInstagram(input: SendInstagramInput): Promise<SendResult> {
  try {
    const cfg = input.configOverride ?? (await getChannelConfig(input.accountId, 'instagram'))
    if (!cfg) return { ok: false, error: 'Instagram is not configured for this account' }

    const version = cfg.graph_version || 'v21.0'
    const res = await withRetry(
      () =>
        fetch(`https://graph.facebook.com/${version}/me/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.page_access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient: { id: input.recipientId },
            messaging_type: 'RESPONSE',
            message: { text: input.body },
          }),
        }),
      (r) => r instanceof Response && isTransientStatus(r.status)
    )
    if (!res.ok) return { ok: false, error: `Meta ${res.status}: ${await res.text()}` }
    const json = (await res.json()) as { message_id?: string }
    return { ok: true, provider_message_id: json.message_id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Instagram send failed' }
  }
}

export async function verifyInstagramConfig(cfg: InstagramConfig): Promise<SendResult> {
  try {
    const version = cfg.graph_version || 'v21.0'
    const res = await fetch(
      `https://graph.facebook.com/${version}/${encodeURIComponent(cfg.page_id)}?fields=id,name`,
      { headers: { Authorization: `Bearer ${cfg.page_access_token}` } }
    )
    if (!res.ok) return { ok: false, error: `Meta ${res.status}: ${await res.text()}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Instagram verify failed' }
  }
}
