export type ChannelType = 'teams' | 'email' | 'whatsapp'
export type SenderType = 'customer' | 'agent' | 'ai'
export type MessageType = 'text' | 'attachment' | 'card' | 'system'
export type Direction = 'inbound' | 'outbound'
export type ConversationStatus = 'active' | 'in_progress' | 'waiting_on_customer' | 'resolved' | 'escalated' | 'archived'
export type Priority = 'low' | 'medium' | 'high' | 'urgent'
export type Sentiment = 'positive' | 'neutral' | 'negative'
export type Urgency = 'low' | 'medium' | 'high' | 'urgent'
export type AIReplyStatus = 'pending_approval' | 'approved' | 'sent' | 'rejected' | 'edited' | 'auto_sent'
export type SyncStatus = 'active' | 'paused' | 'error' | 'syncing'

export interface AccountOverview {
  id: string
  name: string
  channel_type: ChannelType
  phase1_enabled: boolean
  phase2_enabled: boolean
  pendingCount: number
  lastMessageTime: string
}
export type UserRole = 'admin' | 'reviewer' | 'viewer'

export type Category =
  | 'Sales Inquiry'
  | 'Trouble Ticket'
  | 'Payment Issue'
  | 'Service Problem'
  | 'Technical Issue'
  | 'Billing Question'
  | 'Connection Issue'
  | 'Rate Issue'
  | 'General Inquiry'
  | 'Newsletter/Marketing'

export interface Company {
  id: string
  name: string
  created_at: string
}

export interface Account {
  id: string
  name: string
  company_id: string | null
  channel_type: ChannelType
  teams_tenant_id: string | null
  teams_user_id: string | null
  gmail_address: string | null
  whatsapp_phone: string | null
  phase1_enabled: boolean
  phase2_enabled: boolean
  ai_auto_reply: boolean
  ai_trust_mode: boolean
  ai_system_prompt: string | null
  ai_confidence_threshold: number
  working_hours_start: string | null
  working_hours_end: string | null
  working_timezone: string | null
  is_active: boolean
  teams_reply_webhook_url: string | null
  sla_warning_hours: number
  sla_critical_hours: number
  sla_auto_escalate: boolean
  spam_detection_enabled: boolean
  spam_allowlist: string[]
  // Poller health (added for shard fanout + circuit breaker — see
  // src/lib/email-poller.ts). Counter increments on each erroring poll
  // and resets to 0 on the next clean run; >= 5 trips the breaker.
  last_poll_error: string | null
  last_poll_error_at: string | null
  consecutive_poll_failures: number
  // Per-account AI cost controls. `monthly_ai_budget_usd` is a hard cap;
  // `ai_budget_alert_at_pct` is the % of budget at which an audit alert
  // (`ai_budget.threshold_crossed`) is emitted. See `src/lib/ai-usage.ts`.
  monthly_ai_budget_usd: number
  ai_budget_alert_at_pct: number
  created_at: string
  updated_at: string
}

/**
 * One row per AI call. Powers the per-account monthly spend RPC + admin
 * "AI spend overview" widget. See `src/lib/ai-usage.ts` for the writer.
 */
export interface AIUsage {
  id: string
  account_id: string
  ts: string
  endpoint: 'classify' | 'ai-reply' | 'ai-summarize' | 'suggest-replies' | 'ai-compose' | 'test-ai'
  model: string
  input_tokens: number | null
  output_tokens: number | null
  estimated_cost_usd: number
  request_id: string | null
}

export interface Conversation {
  id: string
  account_id: string
  channel: ChannelType
  teams_chat_id: string | null
  participant_name: string | null
  participant_email: string | null
  participant_phone: string | null
  status: ConversationStatus
  priority: Priority
  tags: string[]
  assigned_to: string | null
  first_message_at: string | null
  last_message_at: string | null
  created_at: string
  /** FK to public.contacts. Backfilled for existing rows; new inbound rows get
   *  this set in `findOrCreateConversation` after the contact is upserted. */
  contact_id: string | null
  /** ISO timestamp when this conversation should auto-resurface. NULL means
   *  not snoozed. Cron `/api/cron/wake-snoozed` clears this when due. */
  snoozed_until: string | null
  /** User who put it on snooze (FK users.id). NULL when not snoozed. */
  snoozed_by: string | null
  // Joined data
  account?: Account
  messages?: Message[]
  latest_classification?: MessageClassification
  contact?: Contact
}

/**
 * Unified contact / customer profile. One row per unique (email | phone) seen
 * across all accounts and channels. Conversations FK into this via
 * `conversations.contact_id`.
 */
export interface Contact {
  id: string
  email: string | null
  phone: string | null
  display_name: string | null
  notes: string | null
  tags: string[]
  first_seen_at: string
  last_seen_at: string
  total_conversations: number
  is_vip: boolean
}

export interface Message {
  id: string
  conversation_id: string
  account_id: string
  channel: ChannelType
  teams_message_id: string | null
  sender_name: string | null
  sender_type: SenderType
  message_text: string
  message_type: MessageType
  direction: Direction
  email_subject: string | null
  email_thread_id: string | null
  whatsapp_media_url: string | null
  attachments: Record<string, unknown> | null
  replied: boolean
  reply_required: boolean
  is_spam: boolean
  spam_reason: string | null
  timestamp: string
  received_at: string
  // Joined data
  classification?: MessageClassification
  ai_reply?: AIReply
}

export interface AIReply {
  id: string
  message_id: string
  account_id: string
  conversation_id: string
  draft_text: string
  edited_text: string | null
  final_text: string | null
  channel: ChannelType
  status: AIReplyStatus
  confidence_score: number | null
  system_prompt_used: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  edit_notes: string | null
  sent_at: string | null
  delivery_status: string | null
  created_at: string
  updated_at: string
}

export interface MessageClassification {
  id: string
  message_id: string
  category: Category
  subcategory: string | null
  sentiment: Sentiment
  urgency: Urgency
  topic_summary: string | null
  confidence: number
  classified_at: string
}

export interface GoogleSheetsSync {
  id: string
  account_id: string | null
  sheet_id: string
  sheet_name: string
  sheet_url: string
  last_sync_at: string | null
  sync_status: SyncStatus
  row_count: number
  sync_schedule: string
  column_mapping: Record<string, string> | null
  created_at: string
}

export interface ImportedRecord {
  id: string
  source_sheet_id: string
  account_id: string | null
  external_id: string | null
  entity_name: string | null
  category: string | null
  data_json: Record<string, unknown>
  imported_at: string
}

export interface KBArticle {
  id: string
  account_id: string | null
  title: string
  content: string
  category: string
  tags: string[] | null
  source_url: string | null
  github_path: string | null
  github_sha: string | null
  last_synced_at: string | null
  word_count: number | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AuditLog {
  id: string
  user_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  details: Record<string, unknown> | null
  created_at: string
}

export interface User {
  id: string
  email: string
  full_name: string | null
  role: UserRole
  avatar_url: string | null
  is_active: boolean
  created_at: string
  last_login_at: string | null
  account_id: string | null
}

export interface ChannelConfig {
  id: string
  account_id: string
  channel: ChannelType
  config_data: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ReplyTemplate {
  id: string
  account_id: string | null
  title: string
  content: string
  category: string | null
  shortcut: string | null
  usage_count: number
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

// Dashboard KPI types
export interface DashboardKPIs {
  totalMessagesToday: number
  pendingReplies: number
  aiRepliesSent: number
  avgResponseTime: number
  sentimentScore: { positive: number; neutral: number; negative: number }
  topCategory: { name: string; count: number }
}

// ─── Routing rules ──────────────────────────────────────────────────
export type RoutingMatchMode = 'all' | 'any'
export type RoutingOperator =
  | 'equals'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'matches_regex'
  | 'in'

export type RoutingField =
  | 'channel'
  | 'account_id'
  | 'sender_email'
  | 'sender_phone'
  | 'subject'
  | 'body'
  | 'sentiment'
  | 'category'

export interface RoutingCondition {
  field: RoutingField | string
  op: RoutingOperator | string
  value: unknown
}

export interface RoutingRule {
  id: string
  name: string
  is_active: boolean
  priority: number
  conditions: RoutingCondition[]
  match_mode: RoutingMatchMode
  set_priority: Priority | null
  set_status: ConversationStatus | string | null
  add_tags: string[] | null
  assign_to_team: string | null
  assign_to_user: string | null
  use_round_robin: boolean
  account_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AssignmentState {
  scope: string // 'account:UUID' or 'team:NAME'
  last_assigned_user_id: string | null
  updated_at: string
}

// ─── Saved views (smart inboxes) ────────────────────────────────────
// `filters` is a SUBSET of `InboxFilters` (the UI's filter bar shape) so a
// view can be applied to the inbox state without translation. Server-side
// filtering doesn't need to know about views — the existing inbox query
// already does the work. See `src/components/inbox/saved-view-modal.tsx`.
export interface SavedViewFilters {
  channel?: 'all' | 'email' | 'teams' | 'whatsapp'
  account_ids?: string[]
  status?: 'all' | 'active' | 'in_progress' | 'waiting_on_customer' | 'resolved' | 'escalated'
  priority?: 'all' | 'low' | 'medium' | 'high' | 'urgent'
  sentiment?: 'all' | 'positive' | 'neutral' | 'negative'
  category?: string
  assignee?: 'me' | 'unassigned' | 'all' | string  // user_id
  age_hours_gt?: number  // older-than-N-hours
  search?: string
  unread_only?: boolean
}

export interface SavedView {
  id: string
  user_id: string
  name: string
  icon: string | null
  filters: SavedViewFilters
  is_shared: boolean
  sort_order: number
  created_at: string
}

// Inbox item (joined from multiple tables)
export interface InboxItem {
  id: string
  channel: ChannelType
  sender_name: string | null
  account_name: string
  account_id: string
  subject_or_preview: string
  body_preview?: string | null
  category: Category | null
  sentiment: Sentiment | null
  urgency: Urgency | null
  time_waiting: string
  priority: Priority
  ai_status: 'draft_ready' | 'no_draft' | 'auto_sent' | 'classify_only'
  ai_confidence: number | null
  message_id: string
  conversation_id: string
  conversation_status: ConversationStatus | null
  assigned_to: string | null
  timestamp: string
  tags?: string[] | null
  is_spam?: boolean
  spam_reason?: string | null
  /** ISO timestamp the conversation is snoozed until. NULL/missing = not snoozed.
   *  Surfaced on the inbox row so users can see a "Snoozed until …" badge. */
  snoozed_until?: string | null
}
