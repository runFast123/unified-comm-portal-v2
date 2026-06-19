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
  | 'user_mfa_reset'
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
  | 'role_permissions_changed'
  | 'user_permissions_changed'
  | 'model_permissions_changed'
  | 'routing_rule_created'
  | 'routing_rule_updated'
  | 'routing_rule_deleted'
  | 'livechat_widget_created'
  | 'livechat_widget_updated'
  | 'livechat_widget_deleted'
  | 'data_exported'

/**
 * Writes an entry to the audit_log table.
 * Fire-and-forget — does not throw on failure.
 *
 * Tenant scoping: audit_log.company_id drives the SELECT RLS policy
 * (company admins only see rows for their own tenant; super_admin sees
 * everything). When company_id is omitted, a BEFORE-INSERT trigger
 * (audit_log_fill_company_id_trg) derives it from users.company_id via
 * the user_id linkage. Pass company_id explicitly when:
 *   - The acting user is super_admin (company_id is NULL on their
 *     profile, so without an explicit override the audit row would be
 *     visible only to other super_admins).
 *   - The action targets a different tenant than the actor's home one
 *     (e.g., super_admin deleting a company user — should be visible
 *     to that company's admins as well).
 */
export async function logAudit(params: {
  user_id?: string | null
  company_id?: string | null
  action: AuditAction
  entity_type?: string
  entity_id?: string
  details?: Record<string, unknown>
}): Promise<void> {
  try {
    const supabase = await createServiceRoleClient()
    await supabase.from('audit_log').insert({
      user_id: params.user_id || null,
      company_id: params.company_id || null,
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
