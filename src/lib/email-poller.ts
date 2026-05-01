import { createHash } from 'crypto'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { getChannelConfig, type EmailConfig } from '@/lib/channel-config'
import { getGmailAccessToken, GmailOAuthExpiredError } from '@/lib/gmail-oauth'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { mintRequestId } from '@/lib/request-id'
import { ingestInboundEmail } from '@/lib/email-ingest'
import { logError } from '@/lib/logger'

// ─── Sharding + circuit breaker shared across the email/teams pollers ──
// Shard math: stable hash of account id → 32-bit int → modulo total. Same
// account always lands on the same shard for a given `total`, so a fanned-
// out cron schedule (4 entries with shard=0..3, total=4) covers all accounts
// with no overlap. Exported so the teams poller (and tests) reuse it.
export function simpleHash(id: string): number {
  // crypto is already a Node builtin — no new dep. md5 is overkill for
  // distribution but cheap and gives a uniform spread. Fold the first 4
  // bytes of the digest into an unsigned 32-bit int.
  const buf = createHash('md5').update(id).digest()
  return buf.readUInt32BE(0)
}

// Open the breaker after 5 consecutive failures. Auto-resets on next success.
export const CIRCUIT_BREAKER_THRESHOLD = 5

export interface EmailPollResult {
  account_id: string
  fetched: number
  forwarded: number
  errors: string[]
  highest_uid?: number | null
  sent_reconciled?: number
  sent_highest_uid?: number | null
}

interface WebhookPayload {
  account_id: string
  sender: string
  subject: string
  body: string
  thread_id: string | null
  attachments: Array<{ filename: string | undefined; contentType: string | undefined; size: number }>
}

// First-run backfill window (how far back to go when last_imap_uid is null)
const BACKFILL_DAYS = 7
// Per-run cap so a huge mailbox doesn't exhaust the request timeout
const MAX_MESSAGES_PER_RUN = 100

/**
 * Hand a parsed inbound email to the ingest pipeline.
 *
 * Originally this was an HTTP POST to `/api/webhooks/email` against the
 * deployment's own origin. That broke whenever Vercel Deployment Protection
 * was enabled — the protection layer intercepts the internal request with
 * an HTML auth wall, the poller sees a 401, and every polled message is
 * silently dropped while the IMAP cursor still advances.
 *
 * Now we call `ingestInboundEmail()` directly. Same behavior (auth was the
 * only thing skipped, and the poller's cron-route caller already
 * authenticated against `WEBHOOK_SECRET` upstream), one fewer network hop,
 * cursor advance + message store happen in the same lambda.
 */
async function ingestPolledEmail(
  origin: string,
  payload: WebhookPayload,
  requestId: string
): Promise<void> {
  const supabase = await createServiceRoleClient()
  const result = await ingestInboundEmail(supabase, payload, { origin, request_id: requestId })
  if (!result.ok) {
    // Surface failures to the caller exactly the way the old fetch-based
    // helper did — they bubble up into the per-message try/catch in
    // pollEmailAccount and end up in `result.errors`.
    throw new Error(`ingest failed (${result.status}): ${result.error}`)
  }
}

/**
 * Poll one account's IMAP inbox using a UID cursor.
 *
 *   First run  (last_imap_uid is null)  → fetch messages received in the last
 *                                         BACKFILL_DAYS, so the user sees recent
 *                                         real mail, not just future arrivals.
 *   Ongoing   (last_imap_uid is a num) → fetch UIDs strictly greater than it.
 *
 * Does NOT modify the message's \Seen flag — we leave the user's read state alone.
 * After a successful run, persists the highest UID seen so the next run resumes.
 */
export async function pollEmailAccount(
  accountId: string,
  origin: string
): Promise<EmailPollResult> {
  const result: EmailPollResult = { account_id: accountId, fetched: 0, forwarded: 0, errors: [] }

  const cfg = (await getChannelConfig(accountId, 'email')) as EmailConfig | null
  if (!cfg) {
    result.errors.push('IMAP not configured for account')
    return result
  }

  // Gmail OAuth skips the app-password guard — we auth with a bearer token
  // instead. Otherwise we need the full host+user+password triple.
  const isGmailOAuth = cfg.auth_mode === 'gmail_oauth' && !!cfg.google_refresh_token
  if (!isGmailOAuth) {
    if (!cfg.imap_host || !cfg.imap_user || !cfg.imap_password) {
      result.errors.push('IMAP not configured for account')
      return result
    }
  } else if (!cfg.google_user_email && !cfg.imap_user) {
    result.errors.push('Gmail OAuth config missing user email')
    return result
  }

  const supabase = await createServiceRoleClient()
  const { data: accountRow } = await supabase
    .from('accounts')
    .select('last_imap_uid, last_imap_sent_uid, consecutive_poll_failures')
    .eq('id', accountId)
    .maybeSingle()

  // Circuit breaker: if this account has failed 5+ polls in a row, skip it
  // entirely until ops fixes the underlying issue. Prevents the cron run
  // from hammering a permanently-broken mailbox every 2 minutes (and from
  // burning Lambda time on it). The next successful poll resets the counter.
  const failures = (accountRow?.consecutive_poll_failures as number | null | undefined) ?? 0
  if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
    result.errors.push('skipped: circuit breaker open')
    return result
  }

  const lastUid = accountRow?.last_imap_uid as number | null | undefined
  const lastSentUid = accountRow?.last_imap_sent_uid as number | null | undefined

  // Build ImapFlow auth: bearer token for Gmail OAuth, plain password otherwise.
  let imapAuth: { user: string; pass?: string; accessToken?: string }
  if (isGmailOAuth) {
    try {
      const token = await getGmailAccessToken(cfg, accountId)
      imapAuth = {
        user: cfg.google_user_email || cfg.imap_user!,
        accessToken: token,
      }
    } catch (err) {
      // Token refresh failed — surface reconnect-required as a non-fatal
      // poll error. The per-account cursor stays put, so nothing is lost.
      result.errors.push(
        err instanceof GmailOAuthExpiredError
          ? err.message
          : `Gmail token fetch failed: ${err instanceof Error ? err.message : 'unknown'}`
      )
      return result
    }
  } else {
    imapAuth = { user: cfg.imap_user!, pass: cfg.imap_password! }
  }

  const client = new ImapFlow({
    host: cfg.imap_host || (isGmailOAuth ? 'imap.gmail.com' : ''),
    port: cfg.imap_port ?? (isGmailOAuth ? 993 : 993),
    secure: cfg.imap_secure ?? true,
    auth: imapAuth,
    logger: false,
  })

  let highestUid = lastUid ?? 0
  let highestSentUid = lastSentUid ?? 0
  let sentReconciled = 0

  try {
    await client.connect()

    // Locate the Sent folder via IMAP SPECIAL-USE flag. Path varies by provider
    // (Gmail: "[Gmail]/Sent Mail", Office365: "Sent Items", etc.) so we ask the
    // server rather than hardcoding.
    let sentPath: string | null = null
    try {
      const mailboxes = await client.list()
      const sent = mailboxes.find((m) => m.specialUse === '\\Sent')
      sentPath = sent?.path ?? null
    } catch { /* ignore — will skip Sent pass */ }

    // ─── Pass 1: INBOX (inbound mail) ────────────────────────────────
    {
      const lock = await client.getMailboxLock('INBOX')
      try {
        const searchCriteria: Record<string, unknown> =
          lastUid && lastUid > 0
            ? { uid: `${lastUid + 1}:*` }
            : { since: new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000) }

        const uids = (await client.search(searchCriteria, { uid: true })) as number[] | false
        if (uids && uids.length > 0) {
          const sorted = [...uids].sort((a, b) => a - b)
          const toFetch =
            sorted.length > MAX_MESSAGES_PER_RUN ? sorted.slice(-MAX_MESSAGES_PER_RUN) : sorted

          for await (const msg of client.fetch(
            toFetch,
            { source: true, envelope: true, uid: true },
            { uid: true }
          )) {
            result.fetched++
            try {
              if (!msg.source) continue
              const parsed = await simpleParser(msg.source)
              const fromAddr = parsed.from?.value?.[0]
              const senderStr = fromAddr
                ? `${fromAddr.name || ''} <${fromAddr.address || ''}>`.trim()
                : parsed.from?.text || ''
              const attachments = (parsed.attachments || []).map((a) => ({
                filename: a.filename,
                contentType: a.contentType,
                size: a.size,
              }))
              // One request id per fetched message. End-to-end traceability:
              // the webhook propagates this to classify + ai-reply, so a
              // single polled email = a single correlation thread.
              const messageRequestId = mintRequestId()
              await ingestPolledEmail(
                origin,
                {
                  account_id: accountId,
                  sender: senderStr,
                  subject: parsed.subject || '',
                  body: parsed.html || parsed.text || '',
                  thread_id:
                    (parsed.headers.get('references') as string | undefined) ||
                    parsed.messageId ||
                    null,
                  attachments,
                },
                messageRequestId
              )
              result.forwarded++
              if (msg.uid && msg.uid > highestUid) highestUid = msg.uid
            } catch (innerErr) {
              const errMsg = innerErr instanceof Error ? innerErr.message : 'parse/forward failed'
              result.errors.push(errMsg)
              // M3 fix: surface per-message failures to logs/Sentry. Previously
              // these only landed in the in-memory `result.errors` array and
              // never reached observability — silent ingest gaps were invisible.
              // `messageRequestId` may not exist if we threw before mintRequestId().
              void logError('system', 'email_poller_message_failed', errMsg, {
                account_id: accountId,
                uid: msg.uid ?? null,
              }).catch(() => { /* never break the poll loop */ })
            }
          }
        }
      } finally {
        lock.release()
      }
    }

    // ─── Pass 2: Sent folder (reconcile replies the agent sent OUTSIDE the portal) ──
    // When an agent answers from Gmail directly, the reply lands in Sent but the
    // portal never hears about it. We mirror those into messages as outbound so
    // the conversation stops showing "pending" and duplicate AI drafts don't fire.
    if (sentPath) {
      const lock = await client.getMailboxLock(sentPath)
      try {
        const sentCriteria: Record<string, unknown> =
          lastSentUid && lastSentUid > 0
            ? { uid: `${lastSentUid + 1}:*` }
            : { since: new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000) }

        const sentUids = (await client.search(sentCriteria, { uid: true })) as number[] | false
        if (sentUids && sentUids.length > 0) {
          const sortedSent = [...sentUids].sort((a, b) => a - b)
          const toFetchSent =
            sortedSent.length > MAX_MESSAGES_PER_RUN
              ? sortedSent.slice(-MAX_MESSAGES_PER_RUN)
              : sortedSent

          for await (const msg of client.fetch(
            toFetchSent,
            { source: true, envelope: true, uid: true },
            { uid: true }
          )) {
            try {
              if (!msg.source) continue
              const parsed = await simpleParser(msg.source)
              const toAddrs = parsed.to
                ? Array.isArray(parsed.to)
                  ? parsed.to.flatMap((t) => t.value || [])
                  : parsed.to.value || []
                : []
              const recipientEmail = toAddrs[0]?.address?.toLowerCase()
              if (!recipientEmail) continue

              // Find the conversation by recipient email
              const { data: convo } = await supabase
                .from('conversations')
                .select('id')
                .eq('account_id', accountId)
                .eq('channel', 'email')
                .eq('participant_email', recipientEmail)
                .limit(1)
                .maybeSingle()

              if (!convo) continue // no matching convo — skip

              const bodyText = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ') : '')
              const sentAt = parsed.date ? parsed.date.toISOString() : new Date().toISOString()

              // Dedup: if a matching outbound message already exists (same subject
              // OR body prefix within the last 2 hours) this is probably a
              // portal-sent reply that's also in the Sent folder — skip.
              // We run two sequential queries rather than a single `.or()` because
              // PostgREST's `.or()` filter syntax is brittle with special chars
              // (parens, commas, operators) that show up in real subjects/bodies.
              const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
              let existing: { id: string } | null = null

              const subjectTrimmed = (parsed.subject || '').trim()
              if (subjectTrimmed) {
                const { data: bySubject } = await supabase
                  .from('messages')
                  .select('id')
                  .eq('conversation_id', convo.id)
                  .eq('direction', 'outbound')
                  .gte('received_at', twoHoursAgo)
                  .eq('email_subject', subjectTrimmed)
                  .limit(1)
                  .maybeSingle()
                if (bySubject) existing = bySubject as { id: string }
              }

              if (!existing) {
                const bodyPrefix = bodyText.slice(0, 80).trim()
                if (bodyPrefix) {
                  // .ilike() handles % and _ escaping safely via parameter binding.
                  const { data: byBody } = await supabase
                    .from('messages')
                    .select('id')
                    .eq('conversation_id', convo.id)
                    .eq('direction', 'outbound')
                    .gte('received_at', twoHoursAgo)
                    .ilike('message_text', `${bodyPrefix}%`)
                    .limit(1)
                    .maybeSingle()
                  if (byBody) existing = byBody as { id: string }
                }
              }

              if (existing) {
                if (msg.uid && msg.uid > highestSentUid) highestSentUid = msg.uid
                continue
              }

              // Auto-reject any pending AI drafts in this conversation — the
              // agent already replied via Gmail directly, so showing a stale
              // draft in the portal would be confusing.
              await supabase
                .from('ai_replies')
                .update({
                  status: 'rejected',
                  edit_notes: 'Auto-rejected: agent replied via Gmail directly',
                  reviewed_at: new Date().toISOString(),
                })
                .eq('conversation_id', convo.id)
                .eq('status', 'pending_approval')

              // Insert the sent message as an outbound agent message
              await supabase.from('messages').insert({
                conversation_id: convo.id,
                account_id: accountId,
                channel: 'email',
                sender_name: 'Agent (via Gmail)',
                sender_type: 'agent',
                message_text: bodyText,
                email_subject: parsed.subject || null,
                direction: 'outbound',
                replied: true,
                reply_required: false,
                timestamp: sentAt,
                received_at: sentAt,
              })

              // Flip conversation state: inbound messages are now "replied",
              // conversation is waiting_on_customer.
              await supabase
                .from('messages')
                .update({ replied: true })
                .eq('conversation_id', convo.id)
                .eq('direction', 'inbound')
                .eq('replied', false)

              await supabase
                .from('conversations')
                .update({ status: 'waiting_on_customer' })
                .eq('id', convo.id)
                .neq('status', 'resolved')

              sentReconciled++
              if (msg.uid && msg.uid > highestSentUid) highestSentUid = msg.uid
            } catch (innerErr) {
              result.errors.push(
                'sent reconcile: ' +
                  (innerErr instanceof Error ? innerErr.message : 'unknown')
              )
            }
          }
        }
      } finally {
        lock.release()
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'IMAP error'
    // ImapFlow reports XOAUTH2 auth failures with "authentication failed"
    // text. Re-label as reconnect-required when we were in OAuth mode so
    // the admin UI can steer the user back to the Connect button.
    if (isGmailOAuth && /auth/i.test(msg)) {
      result.errors.push(`Gmail OAuth expired — reconnect required (${msg})`)
    } else {
      result.errors.push(msg)
    }
  } finally {
    try { await client.logout() } catch { /* ignore */ }
  }

  result.sent_reconciled = sentReconciled
  result.sent_highest_uid = highestSentUid
  result.highest_uid = highestUid

  // Persist cursors + polled timestamp. Only bump `last_polled_at` when the
  // poll was fully successful (no errors) — that way a failing account stays
  // flagged as stale instead of quietly marking itself healthy. UID cursors
  // still advance on partial success so we don't re-fetch messages we already
  // ingested before the error.
  //
  // Circuit-breaker bookkeeping is tied to the same patch: a clean run resets
  // the failure counter + clears last_poll_error, an erroring run increments
  // and stores the first error message so /admin/channels can surface it.
  try {
    const patch: Record<string, unknown> = {}
    if (highestUid > (lastUid ?? 0)) patch.last_imap_uid = highestUid
    if (highestSentUid > (lastSentUid ?? 0)) patch.last_imap_sent_uid = highestSentUid
    if (result.errors.length === 0) {
      patch.last_polled_at = new Date().toISOString()
      patch.consecutive_poll_failures = 0
      patch.last_poll_error = null
      patch.last_poll_error_at = null
    } else {
      patch.consecutive_poll_failures = failures + 1
      patch.last_poll_error = result.errors[0]
      patch.last_poll_error_at = new Date().toISOString()
    }
    await supabase.from('accounts').update(patch).eq('id', accountId)
  } catch { /* ignore */ }

  return result
}

/**
 * Poll all active email accounts. Called by the cron route and /api/inbox-sync.
 *
 * Sharding: pass `{ shard, total }` to limit this run to a slice of accounts
 * (e.g. shard=2, total=4 only processes accounts whose id hashes to bucket 2).
 * Defaults `shard=0, total=1` preserve the original "process everything"
 * behavior, so non-cron callers don't need to change.
 */
export async function pollAllEmailAccounts(
  origin: string,
  opts?: { shard?: number; total?: number },
  // Poll-level request id: forwarded only via logs/Sentry so each cron run
  // shows up as a single thread. Per-message ids are minted inside
  // pollEmailAccount → postToEmailWebhook so the downstream pipeline gets
  // its own correlation id per email. The poll id parameter is currently
  // accepted but not threaded into per-account work — pass it through to
  // your logs at the call site if you want one umbrella id.
  _pollRequestId?: string
): Promise<EmailPollResult[]> {
  const total = Math.max(1, opts?.total ?? 1)
  const shard = Math.max(0, Math.min(total - 1, opts?.shard ?? 0))

  const supabase = await createServiceRoleClient()
  const { data: accounts } = await supabase
    .from('accounts')
    .select('id')
    .eq('channel_type', 'email')
    .eq('is_active', true)

  const all = accounts || []
  // Stable hash sharding — same id → same shard for a given `total`. When
  // total=1 this is a no-op (every id hashes to bucket 0).
  const list = total === 1 ? all : all.filter((a) => simpleHash(a.id) % total === shard)

  // Poll accounts in parallel. Each account uses its own IMAP connection,
  // so one slow/failing mailbox no longer blocks the rest of the cron run.
  const settled = await Promise.allSettled(
    list.map((a) => pollEmailAccount(a.id, origin))
  )

  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value
    const reason = s.reason
    const msg = reason instanceof Error ? reason.message : String(reason)
    return {
      account_id: list[i].id,
      fetched: 0,
      forwarded: 0,
      errors: [`poll crashed: ${msg}`],
    }
  })
}

/**
 * Poll email accounts filtered by a list of account IDs. Used by /api/inbox-sync
 * to restrict non-admin users to their own account(s), so a customer click
 * doesn't spin up IMAP connections to other tenants' mailboxes.
 */
export async function pollEmailAccountsFor(
  accountIds: string[],
  origin: string
): Promise<EmailPollResult[]> {
  if (!accountIds || accountIds.length === 0) return []
  const supabase = await createServiceRoleClient()
  const { data: accounts } = await supabase
    .from('accounts')
    .select('id')
    .eq('channel_type', 'email')
    .eq('is_active', true)
    .in('id', accountIds)

  const list = accounts || []
  const settled = await Promise.allSettled(
    list.map((a) => pollEmailAccount(a.id, origin))
  )

  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value
    const reason = s.reason
    const msg = reason instanceof Error ? reason.message : String(reason)
    return {
      account_id: list[i].id,
      fetched: 0,
      forwarded: 0,
      errors: [`poll crashed: ${msg}`],
    }
  })
}
