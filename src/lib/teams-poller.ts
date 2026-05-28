import { getChannelConfig, type TeamsConfig } from '@/lib/channel-config'
import { simpleHash, CIRCUIT_BREAKER_THRESHOLD } from '@/lib/email-poller'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { getDelegatedAccessToken, TeamsOAuthExpiredError } from '@/lib/teams-delegated'
import { mintRequestId, REQUEST_ID_HEADER } from '@/lib/request-id'

export interface TeamsPollResult {
  account_id: string
  fetched: number
  forwarded: number
  errors: string[]
}

// Minimal shapes from Graph. Graph returns far more fields; we only use these.
interface GraphMessage {
  id: string
  messageType?: string
  createdDateTime?: string
  from?: { user?: { id?: string; displayName?: string } }
  body?: { content?: string; contentType?: string }
  attachments?: Array<{ name?: string; contentType?: string }>
}

interface GraphChat {
  id: string
  topic?: string
  chatType?: string
}

// Cache per-account Graph tokens (same shape as channel-sender but local to avoid import cycle)
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

async function graphToken(cfg: TeamsConfig): Promise<string> {
  const key = `${cfg.azure_tenant_id}:${cfg.azure_client_id}`
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
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
  tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 })
  return json.access_token
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

async function postToTeamsWebhook(
  origin: string,
  payload: Record<string, unknown>,
  requestId: string
): Promise<void> {
  // Per-message correlation id — webhook re-uses it for classify + ai-reply
  // so each Teams message ingestion is one trace.
  const res = await fetch(`${origin}/api/webhooks/teams`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
      [REQUEST_ID_HEADER]: requestId,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`webhook responded ${res.status}: ${text.slice(0, 200)}`)
  }
}

/**
 * Poll one Teams account for new messages across all its chats.
 * Uses account.last_polled_at as the since cursor.
 */
export async function pollTeamsAccount(
  accountId: string,
  origin: string
): Promise<TeamsPollResult> {
  const result: TeamsPollResult = { account_id: accountId, fetched: 0, forwarded: 0, errors: [] }

  // Read account state up-front so the fail() helper below can record
  // the failure on every error exit. Mirrors the email-poller refactor —
  // before this, four early returns left the DB untouched (silent zombie
  // state where last_poll_error stayed NULL even though every poll
  // attempt was failing on a config check).
  const supabase = await createServiceRoleClient()
  const { data: account } = await supabase
    .from('accounts')
    .select('teams_user_id, last_polled_at, consecutive_poll_failures')
    .eq('id', accountId)
    .maybeSingle()

  const failures = (account?.consecutive_poll_failures as number | null | undefined) ?? 0

  // Persist a failure and return. Replaces the "result.errors.push();
  // return result" snippets that bypassed the persist block at the
  // bottom of this function. Best-effort — never throws, never blocks.
  const fail = async (errMsg: string): Promise<TeamsPollResult> => {
    result.errors.push(errMsg)
    try {
      await supabase
        .from('accounts')
        .update({
          consecutive_poll_failures: failures + 1,
          last_poll_error: errMsg,
          last_poll_error_at: new Date().toISOString(),
        })
        .eq('id', accountId)
    } catch {
      /* observability write must never break the caller */
    }
    return result
  }

  // Circuit breaker: same logic as email-poller — stop hammering an account
  // that's been failing 5+ runs in a row. Returns WITHOUT incrementing
  // failures (a skip isn't a fresh failure). The next successful poll
  // resets the counter via the persist block at the bottom.
  if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
    result.errors.push('skipped: circuit breaker open')
    return result
  }

  const cfg = (await getChannelConfig(accountId, 'teams')) as TeamsConfig | null
  if (!cfg) return fail('Teams not configured')

  const isDelegated = cfg.auth_mode === 'delegated' && !!cfg.delegated_refresh_token

  // In delegated mode the authenticated user IS /me — teams_user_id on the
  // account row becomes optional, we self-check against delegated_user_id.
  const selfUserId = isDelegated ? cfg.delegated_user_id : account?.teams_user_id
  if (!isDelegated && !account?.teams_user_id) {
    return fail('teams_user_id missing on account')
  }

  // Default: 7-day backfill on first run (matches email poller) so the user
  // sees recent chats immediately. Subsequent runs use last_polled_at as cursor.
  const TEAMS_BACKFILL_DAYS = 7
  const since = account?.last_polled_at
    ? new Date(account.last_polled_at)
    : new Date(Date.now() - TEAMS_BACKFILL_DAYS * 24 * 60 * 60 * 1000)
  const sinceIso = since.toISOString()
  // Capture ONE timestamp before the Graph request so the value we write to
  // last_polled_at on success equals the upper bound of what we just fetched.
  // Previously last_polled_at was set to a fresh now() at persist time,
  // leaving a race window: messages arriving between the Graph request and
  // the persist were silently skipped on the next run.
  const pollStartedAtIso = new Date().toISOString()
  // Per-chat pagination cap so a runaway chat doesn't exhaust the cron budget.
  const MAX_MESSAGES_PER_CHAT = 200

  try {
    let token: string
    try {
      token = isDelegated ? await getDelegatedAccessToken(cfg, accountId) : await graphToken(cfg)
    } catch (tokenErr) {
      if (tokenErr instanceof TeamsOAuthExpiredError) {
        return fail(tokenErr.message)
      }
      throw tokenErr
    }
    const authHeaders = { Authorization: `Bearer ${token}` }

    // 1) List user's chats — /me/chats in delegated mode, /users/{id}/chats
    //    in application mode (requires Protected API Access).
    const chatsUrl = isDelegated
      ? `https://graph.microsoft.com/v1.0/me/chats?$top=50`
      : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(account!.teams_user_id!)}/chats?$top=50`
    const chatsRes = await fetch(chatsUrl, { headers: authHeaders })
    if (!chatsRes.ok) {
      return fail(`Graph /chats ${chatsRes.status}: ${(await chatsRes.text()).slice(0, 200)}`)
    }
    const chatsJson = (await chatsRes.json()) as { value?: GraphChat[] }
    const chats = chatsJson.value || []

    // 2) For each chat, fetch messages newer than `since`.
    //    Graph returns at most $top per page and an @odata.nextLink for the
    //    rest. Previously we only read the first page ($top=20) — anything
    //    older than that on a busy chat was silently dropped. Follow the
    //    nextLink until we either run out of pages, hit a message at or
    //    before the cursor (results are ordered desc), or hit the per-chat
    //    cap to keep cron runs bounded.
    for (const chat of chats) {
      try {
        let pageUrl: string | null = isDelegated
          ? `https://graph.microsoft.com/v1.0/me/chats/${encodeURIComponent(chat.id)}/messages?$top=50&$orderby=createdDateTime desc`
          : `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chat.id)}/messages?$top=50&$orderby=createdDateTime desc`

        const messages: GraphMessage[] = []
        let reachedCursor = false
        while (pageUrl && messages.length < MAX_MESSAGES_PER_CHAT && !reachedCursor) {
          const msgsRes = await fetch(pageUrl, { headers: authHeaders })
          if (!msgsRes.ok) {
            result.errors.push(`chat ${chat.id} messages ${msgsRes.status}`)
            break
          }
          const msgsJson = (await msgsRes.json()) as {
            value?: GraphMessage[]
            '@odata.nextLink'?: string
          }
          const page = msgsJson.value || []
          for (const m of page) {
            // Because results are ordered desc, the first message at or
            // below `since` means the rest of the pages can't be newer.
            if (m.createdDateTime && new Date(m.createdDateTime) <= since) {
              reachedCursor = true
              break
            }
            if (!m.createdDateTime) continue
            // Skip agent's own messages. In delegated mode the self-id comes
            // from delegated_user_id; in app mode it's account.teams_user_id.
            if (selfUserId && m.from?.user?.id === selfUserId) continue
            // Skip system/control messages
            if (m.messageType && m.messageType !== 'message') continue
            messages.push(m)
            if (messages.length >= MAX_MESSAGES_PER_CHAT) break
          }
          pageUrl = msgsJson['@odata.nextLink'] || null
        }

        for (const m of messages) {
          result.fetched++
          try {
            const rawBody = m.body?.content || ''
            const text = m.body?.contentType === 'html' ? stripHtml(rawBody) : rawBody
            const messageRequestId = mintRequestId()
            await postToTeamsWebhook(
              origin,
              {
                account_id: accountId,
                teams_message_id: m.id,
                teams_chat_id: chat.id,
                team_name: null,
                channel_name: chat.topic || null,
                sender_name: m.from?.user?.displayName || 'Unknown',
                sender_email: null,
                message_text: text,
                message_type: 'text',
                timestamp: m.createdDateTime,
                attachments: m.attachments || null,
                is_agent_message: false,
              },
              messageRequestId
            )
            result.forwarded++
          } catch (innerErr) {
            result.errors.push(innerErr instanceof Error ? innerErr.message : 'forward failed')
          }
        }
      } catch (chatErr) {
        result.errors.push(chatErr instanceof Error ? chatErr.message : 'chat fetch failed')
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : 'Graph error')
  }

  // Only advance last_polled_at when the poll was fully successful. If
  // any error occurred mid-poll we want to retry the same window on the
  // next run rather than quietly marking the account as healthy. Mirrors
  // the email-poller pattern.
  //
  // Circuit-breaker bookkeeping: clean run resets the failure counter +
  // clears last_poll_error; an erroring run increments and stores the
  // first error message so /admin/channels can surface it.
  try {
    const patch: Record<string, unknown> =
      result.errors.length === 0
        ? {
            // Use the timestamp captured BEFORE the Graph request so the
            // cursor equals the upper bound of what we just fetched — no
            // race window for messages arriving mid-poll.
            last_polled_at: pollStartedAtIso,
            consecutive_poll_failures: 0,
            last_poll_error: null,
            last_poll_error_at: null,
          }
        : {
            consecutive_poll_failures: failures + 1,
            last_poll_error: result.errors[0],
            last_poll_error_at: new Date().toISOString(),
          }
    await supabase.from('accounts').update(patch).eq('id', accountId)
  } catch { /* ignore */ }

  // Suppress unused warning — sinceIso is informational for future debugging
  void sinceIso

  return result
}

/**
 * Poll all active Teams accounts. Sharding works the same as the email
 * poller — pass `{ shard, total }` to process only the slice of accounts
 * whose id hashes into bucket `shard` (0 ≤ shard < total). Defaults
 * (shard=0, total=1) preserve the original "process everything" behavior.
 */
export async function pollAllTeamsAccounts(
  origin: string,
  opts?: { shard?: number; total?: number },
  // Poll-level request id, accepted for symmetry with the email poller and
  // for the cron route to log under one umbrella id. Per-message ids are
  // minted inside pollTeamsAccount → postToTeamsWebhook.
  _pollRequestId?: string
): Promise<TeamsPollResult[]> {
  const total = Math.max(1, opts?.total ?? 1)
  const shard = Math.max(0, Math.min(total - 1, opts?.shard ?? 0))

  const supabase = await createServiceRoleClient()
  const { data: accounts } = await supabase
    .from('accounts')
    .select('id')
    .eq('channel_type', 'teams')
    .eq('is_active', true)

  const all = accounts || []
  const list = total === 1 ? all : all.filter((a) => simpleHash(a.id) % total === shard)

  const results: TeamsPollResult[] = []
  for (const a of list) {
    results.push(await pollTeamsAccount(a.id, origin))
  }
  return results
}

/**
 * Poll Teams accounts filtered by a list of account IDs. Used by /api/inbox-sync
 * so non-admin users only trigger polling for their own tenant(s).
 */
export async function pollTeamsAccountsFor(
  accountIds: string[],
  origin: string
): Promise<TeamsPollResult[]> {
  if (!accountIds || accountIds.length === 0) return []
  const supabase = await createServiceRoleClient()
  const { data: accounts } = await supabase
    .from('accounts')
    .select('id')
    .eq('channel_type', 'teams')
    .eq('is_active', true)
    .in('id', accountIds)

  const results: TeamsPollResult[] = []
  for (const a of accounts || []) {
    results.push(await pollTeamsAccount(a.id, origin))
  }
  return results
}
