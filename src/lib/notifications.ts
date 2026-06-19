/**
 * Persisted in-app notifications.
 *
 * Writes a row to `public.notifications` for the dashboard bell to read.
 * INSERTs are SERVICE-ROLE only (RLS has no insert policy for authenticated
 * users), so this MUST run server-side with the service-role client. Callers
 * fire this off ingest/AI-reply paths, so it is strictly FAIL-SOFT: the insert
 * is wrapped in try/catch and this never throws — a failed notification must
 * never break message ingest or AI reply delivery.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase-server'

/** The four notification kinds the bell renders. */
export type NotificationType =
  | 'new_message'
  | 'ai_reply_ready'
  | 'escalation'
  | 'system_alert'

export interface CreateNotificationArgs {
  /** Recipient (FK users.id / auth.uid). Required. */
  user_id: string
  /** Owning company (FK companies.id). Optional — pass when known. */
  company_id?: string | null
  type: NotificationType
  title: string
  body?: string | null
  /** Portal path, e.g. `/conversations/<id>`. */
  link?: string | null
  conversation_id?: string | null
}

/**
 * Insert a persisted notification. FAIL-SOFT — resolves to `void` and never
 * throws or rejects.
 *
 * Pass `client` to reuse the caller's service-role client (avoids spinning up
 * a second one inside an already-server-side path); otherwise one is created.
 * A browser/anon client will be silently rejected by RLS (no insert policy) —
 * always pass the service-role client.
 */
export async function createNotification(
  args: CreateNotificationArgs,
  client?: SupabaseClient
): Promise<void> {
  try {
    if (!args.user_id) return
    const supabase = client ?? (await createServiceRoleClient())
    const { error } = await supabase.from('notifications').insert({
      user_id: args.user_id,
      company_id: args.company_id ?? null,
      type: args.type,
      title: args.title,
      body: args.body ?? null,
      link: args.link ?? null,
      conversation_id: args.conversation_id ?? null,
    })
    if (error) {
      console.error('createNotification insert failed:', error.message)
    }
  } catch (err) {
    // Fail-soft: a notification must never break the caller (ingest / AI reply).
    console.error('createNotification error:', err instanceof Error ? err.message : err)
  }
}
