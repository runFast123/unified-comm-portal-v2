import { createServiceRoleClient } from '@/lib/supabase-server'

type AuditAction =
  | 'reply_approved'
  | 'reply_sent'
  | 'reply_edited'
  | 'conversation_escalated'
  | 'conversation_resolved'
  | 'account_updated'
  | 'user_created'
  | 'user_role_changed'
  | 'ai_config_updated'
  | 'phase_toggled'
  | 'message_archived'
  | 'kb_article_deleted'
  | 'notification_rule_changed'
  | 'contact_updated'
  | 'contact_deleted'
  | 'ai_budget.threshold_crossed'
  | 'company_status_created'
  | 'company_status_updated'
  | 'company_status_deleted'
  | 'company_tag_created'
  | 'company_tag_updated'
  | 'company_tag_deleted'

/**
 * Writes an entry to the audit_log table.
 * Fire-and-forget — does not throw on failure.
 */
export async function logAudit(params: {
  user_id?: string | null
  action: AuditAction
  entity_type?: string
  entity_id?: string
  details?: Record<string, unknown>
}): Promise<void> {
  try {
    const supabase = await createServiceRoleClient()
    await supabase.from('audit_log').insert({
      user_id: params.user_id || null,
      action: params.action,
      entity_type: params.entity_type || null,
      entity_id: params.entity_id || null,
      details: params.details || {},
    })
  } catch (err) {
    // Audit logging should never break the main flow
    console.error('Audit log failed:', err)
  }
}
