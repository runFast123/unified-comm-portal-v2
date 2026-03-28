-- ============================================================================
-- Unified Communication Portal v4 — Complete Database Schema
-- Run this migration in the Supabase SQL Editor
-- ============================================================================

-- ============================================================================
-- 1. CUSTOM TYPES / ENUMS
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE channel_type AS ENUM ('teams', 'email', 'whatsapp');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE sender_type AS ENUM ('customer', 'agent', 'ai');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE message_type_enum AS ENUM ('text', 'attachment', 'card', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE direction_type AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE conversation_status AS ENUM ('active', 'in_progress', 'waiting_on_customer', 'resolved', 'escalated', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE priority_type AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE sentiment_type AS ENUM ('positive', 'neutral', 'negative');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE urgency_type AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE ai_reply_status AS ENUM ('pending_approval', 'approved', 'sent', 'rejected', 'edited');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE sync_status_type AS ENUM ('active', 'paused', 'error', 'syncing');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'reviewer', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ============================================================================
-- 2. HELPER: updated_at TRIGGER FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 3. TABLES
-- ============================================================================

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email      text NOT NULL,
  full_name  text,
  role       user_role NOT NULL DEFAULT 'viewer',
  avatar_url text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- ---------- accounts (30 MCM accounts) ----------
CREATE TABLE IF NOT EXISTS accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    varchar(100) NOT NULL,
  channel_type            channel_type NOT NULL,
  teams_tenant_id         text,
  teams_user_id           text,
  gmail_address           text,
  whatsapp_phone          text,
  phase1_enabled          boolean NOT NULL DEFAULT false,
  phase2_enabled          boolean NOT NULL DEFAULT false,
  ai_auto_reply           boolean NOT NULL DEFAULT false,
  ai_trust_mode           boolean NOT NULL DEFAULT false,
  ai_system_prompt        text,
  ai_confidence_threshold decimal(3,2) NOT NULL DEFAULT 0.85,
  working_hours_start     time,
  working_hours_end       time,
  working_timezone        varchar(50),
  is_active               boolean NOT NULL DEFAULT true,
  make_scenario_id        varchar(100),
  n8n_workflow_id         varchar(100),
  teams_reply_webhook_url text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT phase2_requires_phase1
    CHECK (phase2_enabled = false OR phase1_enabled = true)
);

CREATE TRIGGER accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- conversations ----------
CREATE TABLE IF NOT EXISTS conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel          channel_type NOT NULL,
  teams_chat_id    text,
  participant_name  text,
  participant_email text,
  participant_phone text,
  status           conversation_status NOT NULL DEFAULT 'active',
  priority         priority_type NOT NULL DEFAULT 'medium',
  tags             text[],
  assigned_to      uuid REFERENCES users (id) ON DELETE SET NULL,
  first_message_at timestamptz,
  last_message_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sla_target_minutes integer,
  first_response_at  timestamptz,
  sla_breached       boolean
);

-- ---------- messages ----------
CREATE TABLE IF NOT EXISTS messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel           channel_type NOT NULL,
  teams_message_id  text,
  sender_name       text,
  sender_type       sender_type NOT NULL,
  message_text      text,
  message_type      message_type_enum NOT NULL DEFAULT 'text',
  direction         direction_type NOT NULL,
  email_subject     varchar(500),
  email_thread_id   text,
  whatsapp_media_url text,
  attachments       jsonb,
  replied           boolean NOT NULL DEFAULT false,
  reply_required    boolean NOT NULL DEFAULT true,
  is_spam           boolean DEFAULT false,
  spam_reason       text,
  timestamp         timestamptz,
  received_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------- message_classifications (NEW v4) ----------
CREATE TABLE IF NOT EXISTS message_classifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     uuid NOT NULL UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
  category       varchar(50),
  subcategory    varchar(100),
  sentiment      sentiment_type,
  urgency        urgency_type,
  topic_summary  varchar(500),
  confidence     decimal(3,2),
  classified_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- ai_replies ----------
CREATE TABLE IF NOT EXISTS ai_replies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  draft_text        text NOT NULL,
  edited_text       text,
  final_text        text,
  status            ai_reply_status NOT NULL DEFAULT 'pending_approval',
  confidence_score  decimal(3,2),
  channel           channel_type NOT NULL,
  system_prompt_used text,
  reviewed_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  edit_notes        text,
  sent_at           timestamptz,
  delivery_status   varchar(50),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------- kb_articles ----------
CREATE TABLE IF NOT EXISTS kb_articles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid REFERENCES accounts(id) ON DELETE CASCADE,
  title           varchar(500) NOT NULL,
  content         text,
  category        varchar(100),
  tags            text[],
  source_url      text,
  github_path     text,
  github_sha      varchar(40),
  is_active       boolean NOT NULL DEFAULT true,
  last_synced_at  timestamptz,
  word_count      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_articles_account_id ON kb_articles (account_id);

CREATE TRIGGER kb_articles_updated_at
  BEFORE UPDATE ON kb_articles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- kb_hits ----------
CREATE TABLE IF NOT EXISTS kb_hits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_article_id   uuid NOT NULL REFERENCES kb_articles (id) ON DELETE CASCADE,
  ai_reply_id     uuid NOT NULL REFERENCES ai_replies (id) ON DELETE CASCADE,
  relevance_score decimal(3,2),
  chunk_text      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- google_sheets_sync (NEW v4) ----------
CREATE TABLE IF NOT EXISTS google_sheets_sync (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid REFERENCES accounts(id) ON DELETE CASCADE,
  sheet_id        varchar(255),
  sheet_name      varchar(255),
  sheet_url       text,
  last_sync_at    timestamptz,
  sync_status     sync_status_type NOT NULL DEFAULT 'paused',
  row_count       integer NOT NULL DEFAULT 0,
  sync_schedule   varchar(50) NOT NULL DEFAULT 'daily',
  column_mapping  jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_google_sheets_sync_account_id ON google_sheets_sync(account_id);

-- ---------- imported_records (NEW v4) ----------
CREATE TABLE IF NOT EXISTS imported_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_sheet_id uuid NOT NULL REFERENCES google_sheets_sync (id) ON DELETE CASCADE,
  account_id      uuid REFERENCES accounts(id) ON DELETE CASCADE,
  external_id     varchar(255),
  entity_name     varchar(255),
  category        varchar(100),
  data_json       jsonb,
  imported_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_imported_records_account_id ON imported_records(account_id);

-- ---------- channel_configs ----------
CREATE TABLE IF NOT EXISTS channel_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel     channel_type NOT NULL,
  config_data jsonb,  -- encrypted API credentials
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER channel_configs_updated_at
  BEFORE UPDATE ON channel_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- audit_log ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  action      varchar(100) NOT NULL,
  entity_type varchar(50),
  entity_id   uuid,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- notification_rules ----------
CREATE TABLE IF NOT EXISTS notification_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid REFERENCES accounts (id) ON DELETE CASCADE,  -- nullable, null = all accounts
  channel             channel_type,                                      -- nullable
  min_priority        priority_type NOT NULL DEFAULT 'medium',
  notify_email        boolean NOT NULL DEFAULT true,
  notify_in_portal    boolean NOT NULL DEFAULT true,
  notify_slack        boolean NOT NULL DEFAULT false,
  slack_webhook_url   text,
  escalation_minutes  integer NOT NULL DEFAULT 30,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
-- 4. INDEXES
-- ============================================================================

-- conversations
CREATE INDEX IF NOT EXISTS idx_conversations_account_id ON conversations (account_id);
CREATE INDEX IF NOT EXISTS idx_conversations_channel    ON conversations (channel);
CREATE INDEX IF NOT EXISTS idx_conversations_status     ON conversations (status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_msg   ON conversations (last_message_at DESC);

-- messages
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_account_id      ON messages (account_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel         ON messages (channel);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp       ON messages (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_received_at     ON messages (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_reply_required  ON messages (reply_required) WHERE reply_required = true;

-- message_classifications
CREATE INDEX IF NOT EXISTS idx_classifications_category ON message_classifications (category);
CREATE INDEX IF NOT EXISTS idx_classifications_sentiment ON message_classifications (sentiment);
CREATE INDEX IF NOT EXISTS idx_classifications_urgency  ON message_classifications (urgency);

-- ai_replies
CREATE INDEX IF NOT EXISTS idx_ai_replies_message_id      ON ai_replies (message_id);
CREATE INDEX IF NOT EXISTS idx_ai_replies_account_id      ON ai_replies (account_id);
CREATE INDEX IF NOT EXISTS idx_ai_replies_conversation_id ON ai_replies (conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_replies_status          ON ai_replies (status);

-- kb_articles
CREATE INDEX IF NOT EXISTS idx_kb_articles_category ON kb_articles (category);

-- kb_hits
CREATE INDEX IF NOT EXISTS idx_kb_hits_article_id  ON kb_hits (kb_article_id);
CREATE INDEX IF NOT EXISTS idx_kb_hits_ai_reply_id ON kb_hits (ai_reply_id);

-- imported_records
CREATE INDEX IF NOT EXISTS idx_imported_records_sheet ON imported_records (source_sheet_id);
CREATE INDEX IF NOT EXISTS idx_imported_records_category ON imported_records (category);

-- channel_configs
CREATE INDEX IF NOT EXISTS idx_channel_configs_account ON channel_configs (account_id);

-- audit_log
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id    ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity     ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);

-- notification_rules
CREATE INDEX IF NOT EXISTS idx_notification_rules_account ON notification_rules (account_id);


-- ============================================================================
-- 5. ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE users                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages               ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_replies             ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_articles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_hits                ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_sheets_sync     ENABLE ROW LEVEL SECURITY;
ALTER TABLE imported_records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_configs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log              ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_rules     ENABLE ROW LEVEL SECURITY;

-- Helper: check if the current user is an admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ---- SELECT policies: authenticated users can read everything ----
-- TODO [SECURITY]: The SELECT policies below use USING(true) which allows any
-- authenticated user to read ALL rows in every table. This is overly permissive.
-- A separate Supabase migration should tighten these policies as follows:
--
-- accounts: Keep USING(true) — account names are not sensitive and admins need to see all.
--
-- conversations: Should be scoped to user's account:
--   USING (auth.uid() IN (
--     SELECT id FROM users WHERE role = 'admin' OR account_id = conversations.account_id
--   ))
--
-- messages: Should be scoped through conversation's account_id:
--   USING (auth.uid() IN (
--     SELECT id FROM users WHERE role = 'admin' OR account_id = messages.account_id
--   ))
--
-- message_classifications: Should be scoped through message -> account_id:
--   USING (auth.uid() IN (
--     SELECT u.id FROM users u
--     JOIN messages m ON m.id = message_classifications.message_id
--     WHERE u.role = 'admin' OR u.account_id = m.account_id
--   ))
--
-- ai_replies: Should be scoped to user's account:
--   USING (auth.uid() IN (
--     SELECT id FROM users WHERE role = 'admin' OR account_id = ai_replies.account_id
--   ))
--
-- channel_configs: Should be admin-only or scoped to account:
--   USING (is_admin() OR auth.uid() IN (
--     SELECT id FROM users WHERE account_id = channel_configs.account_id
--   ))
--
-- audit_log: Should be admin-only:
--   USING (is_admin())
--
-- The remaining tables (kb_articles, kb_hits, google_sheets_sync, imported_records,
-- notification_rules) can stay USING(true) or be scoped similarly depending on requirements.
--
-- IMPORTANT: Apply these changes as a separate migration to avoid breaking production.
-- Test thoroughly with both admin and non-admin users before deploying.

CREATE POLICY "Authenticated users can read users"
  ON users FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read accounts"
  ON accounts FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read conversations"
  ON conversations FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read messages"
  ON messages FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read message_classifications"
  ON message_classifications FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read ai_replies"
  ON ai_replies FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read kb_articles"
  ON kb_articles FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read kb_hits"
  ON kb_hits FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read google_sheets_sync"
  ON google_sheets_sync FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read imported_records"
  ON imported_records FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read channel_configs"
  ON channel_configs FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read audit_log"
  ON audit_log FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read notification_rules"
  ON notification_rules FOR SELECT TO authenticated USING (true);

-- ---- INSERT / UPDATE / DELETE: admin-only for sensitive tables ----

-- accounts
CREATE POLICY "Admins can insert accounts"
  ON accounts FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "Admins can update accounts"
  ON accounts FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admins can delete accounts"
  ON accounts FOR DELETE TO authenticated USING (is_admin());

-- channel_configs
CREATE POLICY "Admins can insert channel_configs"
  ON channel_configs FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "Admins can update channel_configs"
  ON channel_configs FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admins can delete channel_configs"
  ON channel_configs FOR DELETE TO authenticated USING (is_admin());

-- notification_rules
CREATE POLICY "Admins can insert notification_rules"
  ON notification_rules FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "Admins can update notification_rules"
  ON notification_rules FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admins can delete notification_rules"
  ON notification_rules FOR DELETE TO authenticated USING (is_admin());

-- ---- General write policies for non-restricted tables ----

CREATE POLICY "Authenticated users can insert conversations"
  ON conversations FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update conversations"
  ON conversations FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can insert messages"
  ON messages FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update messages"
  ON messages FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can insert message_classifications"
  ON message_classifications FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update message_classifications"
  ON message_classifications FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can insert ai_replies"
  ON ai_replies FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update ai_replies"
  ON ai_replies FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can insert kb_articles"
  ON kb_articles FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update kb_articles"
  ON kb_articles FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can insert kb_hits"
  ON kb_hits FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can insert google_sheets_sync"
  ON google_sheets_sync FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update google_sheets_sync"
  ON google_sheets_sync FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can insert imported_records"
  ON imported_records FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can insert audit_log"
  ON audit_log FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Users can update own profile"
  ON users FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE POLICY "Users can insert own profile"
  ON users FOR INSERT TO authenticated WITH CHECK (id = auth.uid());

-- Admin policies for users table (non-recursive - uses direct subquery instead of is_admin())
CREATE POLICY "Admins can update any user"
  ON users FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin'));

CREATE POLICY "Admins can delete users"
  ON users FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin'));


-- ============================================================================
-- 6. ENABLE REALTIME
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE ai_replies;
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE message_classifications;


-- ============================================================================
-- 7. DASHBOARD KPI FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION get_dashboard_kpis()
RETURNS json AS $$
DECLARE
  _total_messages     bigint;
  _pending_replies    bigint;
  _ai_replies_sent    bigint;
  _avg_response_mins  numeric;
BEGIN
  -- Total messages received today
  SELECT count(*)
    INTO _total_messages
    FROM messages
   WHERE received_at >= date_trunc('day', now() AT TIME ZONE 'UTC');

  -- AI replies pending approval
  SELECT count(*)
    INTO _pending_replies
    FROM ai_replies
   WHERE status = 'pending_approval';

  -- AI replies sent today
  SELECT count(*)
    INTO _ai_replies_sent
    FROM ai_replies
   WHERE status = 'sent'
     AND sent_at >= date_trunc('day', now() AT TIME ZONE 'UTC');

  -- Average response time (minutes) for AI replies sent today
  SELECT coalesce(
           round(avg(EXTRACT(EPOCH FROM (ar.sent_at - m.received_at)) / 60.0), 1),
           0
         )
    INTO _avg_response_mins
    FROM ai_replies ar
    JOIN messages m ON m.id = ar.message_id
   WHERE ar.status = 'sent'
     AND ar.sent_at >= date_trunc('day', now() AT TIME ZONE 'UTC');

  RETURN json_build_object(
    'total_messages_today',   _total_messages,
    'pending_replies',        _pending_replies,
    'ai_replies_sent_today',  _ai_replies_sent,
    'avg_response_time_mins', _avg_response_mins
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;


-- ============================================================================
-- 8. SEED DATA: 30 SAMPLE ACCOUNTS (10 per channel)
-- ============================================================================

INSERT INTO accounts (name, channel_type, teams_tenant_id, teams_user_id, phase1_enabled, working_hours_start, working_hours_end, working_timezone)
VALUES
  ('MCM-1',  'teams', 'tenant-mcm-1',  'user-mcm-1',  true, '08:00', '17:00', 'Asia/Dubai'),
  ('MCM-2',  'teams', 'tenant-mcm-2',  'user-mcm-2',  true, '08:00', '17:00', 'Asia/Dubai'),
  ('MCM-3',  'teams', 'tenant-mcm-3',  'user-mcm-3',  true, '08:00', '17:00', 'Asia/Dubai'),
  ('MCM-4',  'teams', 'tenant-mcm-4',  'user-mcm-4',  true, '08:00', '17:00', 'Asia/Dubai'),
  ('MCM-5',  'teams', 'tenant-mcm-5',  'user-mcm-5',  true, '08:00', '17:00', 'Asia/Dubai'),
  ('MCM-6',  'teams', 'tenant-mcm-6',  'user-mcm-6',  false, '08:00', '17:00', 'Asia/Dubai'),
  ('MCM-7',  'teams', 'tenant-mcm-7',  'user-mcm-7',  false, '08:00', '17:00', 'Asia/Dubai'),
  ('MCM-8',  'teams', 'tenant-mcm-8',  'user-mcm-8',  false, '08:00', '17:00', 'Asia/Dubai'),
  ('MCM-9',  'teams', 'tenant-mcm-9',  'user-mcm-9',  false, '08:00', '17:00', 'Asia/Dubai'),
  ('MCM-10', 'teams', 'tenant-mcm-10', 'user-mcm-10', false, '08:00', '17:00', 'Asia/Dubai');

INSERT INTO accounts (name, channel_type, gmail_address, phase1_enabled, working_hours_start, working_hours_end, working_timezone)
VALUES
  ('Email-1',  'email', 'email1@company.com',  true,  '08:00', '17:00', 'Asia/Dubai'),
  ('Email-2',  'email', 'email2@company.com',  true,  '08:00', '17:00', 'Asia/Dubai'),
  ('Email-3',  'email', 'email3@company.com',  true,  '08:00', '17:00', 'Asia/Dubai'),
  ('Email-4',  'email', 'email4@company.com',  true,  '08:00', '17:00', 'Asia/Dubai'),
  ('Email-5',  'email', 'email5@company.com',  true,  '08:00', '17:00', 'Asia/Dubai'),
  ('Email-6',  'email', 'email6@company.com',  false, '08:00', '17:00', 'Asia/Dubai'),
  ('Email-7',  'email', 'email7@company.com',  false, '08:00', '17:00', 'Asia/Dubai'),
  ('Email-8',  'email', 'email8@company.com',  false, '08:00', '17:00', 'Asia/Dubai'),
  ('Email-9',  'email', 'email9@company.com',  false, '08:00', '17:00', 'Asia/Dubai'),
  ('Email-10', 'email', 'email10@company.com', false, '08:00', '17:00', 'Asia/Dubai');

INSERT INTO accounts (name, channel_type, whatsapp_phone, phase1_enabled, working_hours_start, working_hours_end, working_timezone)
VALUES
  ('WA-1',  'whatsapp', '+971501000001', true,  '08:00', '17:00', 'Asia/Dubai'),
  ('WA-2',  'whatsapp', '+971501000002', true,  '08:00', '17:00', 'Asia/Dubai'),
  ('WA-3',  'whatsapp', '+971501000003', true,  '08:00', '17:00', 'Asia/Dubai'),
  ('WA-4',  'whatsapp', '+971501000004', true,  '08:00', '17:00', 'Asia/Dubai'),
  ('WA-5',  'whatsapp', '+971501000005', true,  '08:00', '17:00', 'Asia/Dubai'),
  ('WA-6',  'whatsapp', '+971501000006', false, '08:00', '17:00', 'Asia/Dubai'),
  ('WA-7',  'whatsapp', '+971501000007', false, '08:00', '17:00', 'Asia/Dubai'),
  ('WA-8',  'whatsapp', '+971501000008', false, '08:00', '17:00', 'Asia/Dubai'),
  ('WA-9',  'whatsapp', '+971501000009', false, '08:00', '17:00', 'Asia/Dubai'),
  ('WA-10', 'whatsapp', '+971501000010', false, '08:00', '17:00', 'Asia/Dubai');


-- ============================================================================
-- Done. Schema is ready.
-- ============================================================================
