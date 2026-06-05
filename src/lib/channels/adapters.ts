import type { ChannelType } from '@/types/database'
import {
  sendEmail,
  sendTeams,
  sendWhatsApp,
  verifyEmailConfig,
  verifyTeamsConfig,
  verifyWhatsAppConfig,
  type SendResult,
  type SendEmailAttachment,
} from '@/lib/channel-sender'
import type { EmailConfig, TeamsConfig, WhatsAppConfig } from '@/lib/channel-config'

/**
 * Normalized outbound message — the channel-agnostic shape every send site
 * speaks. Each channel adapter maps it onto its provider-specific sender.
 *
 *  - `to`    the resolved recipient for the channel: an email address (email),
 *            a Teams chat id (teams), or an E.164 phone (whatsapp). The CALLER
 *            resolves which source field this comes from, because the source
 *            object differs per site (request body / scheduled row /
 *            conversation row); that resolution stays at the call site.
 *  - `body`  the final message text. For email it is already
 *            signature-augmented by the caller — adapters never mutate it.
 *  - `subject` / `replyToMessageId` / `attachments` are email-only today and
 *            are ignored by channels that don't support them.
 */
export interface OutboundMessage {
  accountId: string | null
  to: string
  body: string
  subject?: string | null
  replyToMessageId?: string | null
  attachments?: SendEmailAttachment[]
}

/**
 * Server-only channel adapter. Today it owns OUTBOUND send; inbound parsing
 * and config validation will be added to this interface as those surfaces
 * migrate onto the adapter pattern (Phase 0, later increments).
 *
 * IMPORTANT: adapters live in this server-only module, NOT in the channel
 * registry (src/lib/channels/registry.ts), because they pull in
 * channel-sender.ts (nodemailer, Graph/Meta fetches). The registry stays free
 * of server-only deps so client components can import its metadata. Both maps
 * are keyed by the same ChannelType.
 */
export interface ChannelAdapter {
  /** Send one normalized message via this channel's provider. */
  send(msg: OutboundMessage): Promise<SendResult>
  /** Verify the given credentials against the provider without sending. */
  verifyConfig(cfg: unknown): Promise<SendResult>
}

// One adapter per channel. Adding a channel = add an entry here (plus its
// registry descriptor) — the three send sites that call sendViaChannel() need
// no edit to their dispatch.
const ADAPTERS: Record<ChannelType, ChannelAdapter> = {
  email: {
    send: (m) =>
      sendEmail({
        accountId: m.accountId,
        to: m.to,
        // 'Re: Your inquiry' fallback matches the prior per-site default that
        // each send site used to apply inline.
        subject: m.subject || 'Re: Your inquiry',
        body: m.body,
        replyToMessageId: m.replyToMessageId,
        attachments: m.attachments,
      }),
    verifyConfig: (cfg) => verifyEmailConfig(cfg as EmailConfig),
  },
  teams: {
    send: (m) => sendTeams({ accountId: m.accountId, chatId: m.to, body: m.body }),
    verifyConfig: (cfg) => verifyTeamsConfig(cfg as TeamsConfig),
  },
  whatsapp: {
    send: (m) => sendWhatsApp({ accountId: m.accountId, toPhone: m.to, body: m.body }),
    verifyConfig: (cfg) => verifyWhatsAppConfig(cfg as WhatsAppConfig),
  },
}

/** Look up the adapter for a channel, or null for an unknown channel value. */
export function getAdapter(channel: string | null | undefined): ChannelAdapter | null {
  if (!channel) return null
  return (ADAPTERS as Record<string, ChannelAdapter>)[channel] ?? null
}

/**
 * Dispatch a normalized outbound message to the right channel adapter. This is
 * the single funnel that the interactive send route, the scheduled-dispatch
 * cron, and the public v1 API all go through — so a new channel is one adapter
 * entry, not an edit to three duplicated send blocks. An unknown channel value
 * returns a failed SendResult (callers already branch on `{ ok: false }`).
 */
export async function sendViaChannel(
  channel: string,
  msg: OutboundMessage
): Promise<SendResult> {
  const adapter = getAdapter(channel)
  if (!adapter) return { ok: false, error: `Unsupported channel: ${channel}` }
  return adapter.send(msg)
}
