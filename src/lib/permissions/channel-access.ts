import { userIdCan } from './server'

/**
 * Channel-segmentation guard for conversation-mutation routes that load the
 * conversation with the service-role client (RLS OFF). A channel-restricted
 * user must not be able to mutate a conversation on a channel they aren't
 * granted — this mirrors the read-path RLS (`user_allowed_channels`) and the
 * /api/send channel check, which the service-role mutation routes would
 * otherwise bypass. An unscoped conversation (null/unset channel) stays
 * accessible. Users with all channels (the default) always pass.
 */
export async function userCanAccessConversationChannel(
  userId: string,
  channel: string | null | undefined,
): Promise<boolean> {
  if (channel == null) return true
  return userIdCan(userId, `channel:${channel}`)
}
