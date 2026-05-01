# Unified Communication Portal v4.0

A production-grade, AI-powered multi-channel customer communication platform that monitors **Email (Gmail)**, **Microsoft Teams**, and **WhatsApp** messages across multiple companies. Features intelligent message classification, automated AI reply generation, sentiment analysis, and a comprehensive admin dashboard.

**Live:** [unified-comm-portal.vercel.app](https://unified-comm-portal.vercel.app)

---

## Features
- Multi-tenant architecture (companies, super_admin / company_admin / company_member roles)
- Channels: Gmail (OAuth), Microsoft Teams (delegated OAuth), WhatsApp Business
- AI: classify, auto-reply (with budget cap + provider circuit breaker), summarize, smart compose
- Inbox: routing rules, round-robin assignment, snooze + remind, presence detection,
  custom statuses + tags per company, smart facet sidebar, conversation merging,
  activity timeline
- Compose: undo send (5s), AI smart-compose ghost text, templates with variables,
  per-user + per-company email signatures
- Customer ops: out-of-office auto-replies, CSAT surveys
- Integrations: API tokens (per company), outgoing webhooks (HMAC-signed),
  Slack notifications
- Observability: structured metrics, /admin/observability dashboard,
  per-cron SLI tracking
- Mobile responsive throughout

For a per-round breakdown of what shipped, see [`CHANGELOG.md`](./CHANGELOG.md).

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Framework** | Next.js (App Router) | 16.2.0 |
| **UI** | React + TypeScript | 19.2.4 / 5.9.3 |
| **Styling** | Tailwind CSS | 4.2.2 |
| **Database** | Supabase (PostgreSQL + Auth + Realtime + RLS) | -- |
| **AI** | NVIDIA NIM API (OpenAI-compatible) | -- |
| **Icons** | Lucide React | 0.577.0 |
| **Charts** | Recharts | 3.8.0 |
| **PDF Export** | jsPDF + AutoTable | 4.2.1 |
| **Email** | Nodemailer (Gmail SMTP) | 8.0.4 |
| **Deployment** | Vercel | -- |

---

## Features

### Multi-Channel Communication
- **Email** -- Gmail integration via inbound webhooks with SMTP reply sending
- **Microsoft Teams** -- Polling-based message monitoring via Microsoft Graph API
- **WhatsApp** -- Meta Business API webhook integration with verification
- Unified inbox with conversation threading across all channels
- Real-time updates via Supabase Realtime subscriptions

### AI-Powered Intelligence
- **Phase 1: Message Classification** -- Automatic categorization (10 categories), sentiment analysis (positive/neutral/negative), urgency detection (low to urgent), topic summarization, and confidence scoring
- **Phase 2: AI Reply Generation** -- Context-aware draft replies using company knowledge base, conversation history (last 10 messages), and imported Google Sheets records
- **Suggested Replies** -- 3 AI-generated quick replies + 3 matching templates per conversation
- **Auto-Routing** -- Urgent/high-priority messages auto-assigned to least-loaded agent
- **Auto-Escalation** -- Negative sentiment + high urgency triggers automatic escalation with Slack + email notifications
- **Contact Auto-Tagging** -- VIP, New Lead, Churning, At Risk, Sales, Support labels computed from engagement data
- **12 AI Models** -- Configurable via Admin panel (Kimi K2.5, Llama 3.3, DeepSeek V3.2, Qwen 3.5, Mistral Large, and more)

### Inbox & Conversations
- **3 View Modes** -- List, Split (preview pane), and Kanban board (5 status columns)
- **Approve & Send** / **Edit & Send** / **Manual Reply** workflows
- **Template System** -- Quick replies with category tagging and `/shortcut` autocomplete
- **Internal Notes** -- Per-conversation private notes
- **Conversation Bookmarks** -- Quick-access bookmarked conversations
- **Follow-Up Reminders** -- Banner alert when customer hasn't replied in 48h+
- **Response Time Indicators** -- Color-coded gaps between messages (green < 1h, amber < 4h, red > 4h)
- **Bulk Actions** -- Assign to Me, Smart Approve (high-confidence drafts only)
- **Agent Assignment** -- Workload-balanced assignment with unassign option
- **Spam Detection** -- Multi-signal filter (sender patterns, subject keywords, noreply prefixes, bulk platforms)
- **Load More Pagination** -- 50 messages per batch with cursor-based loading

### Dashboard
- Real-time KPI cards (messages, pending replies, AI sent, response time, sentiment score, top category)
- Channel breakdown and category breakdown visualizations
- SLA compliance tracking with breach alerts
- Company performance table with per-account metrics
- Escalated conversations panel
- Activity feed
- **Customizable Widgets** -- Show/hide 8 dashboard sections via Customize button
- **Custom Date Range** -- Today, Yesterday, 7 Days, 30 Days, or Custom from/to dates
- Account-level filtering for multi-tenant views
- KPI drill-down panels with message-level detail

### Reports & Analytics
- **Overview** -- Message volume, response times, channel stats, AI performance
- **Sentiment Analytics** -- Per-channel, per-company, per-category sentiment with 30-day trend charts
- **Advanced Analytics** -- Spam detection stats, conversation health, AI confidence metrics
- Clickable sentiment modals with filter tabs (All/Positive/Neutral/Negative) and conversation links
- Previous period comparison with trend indicators
- PDF export for all report sections
- CSV export for messages and AI replies with formula injection protection

### Knowledge Base
- Per-company KB articles with category tagging and active/inactive toggle
- Cross-channel KB sharing (Teams/Email sibling account lookup)
- **Gap Analysis** -- Identifies low-confidence AI classifications to highlight missing KB content
- **Draft Article** -- One-click template generation from gap analysis findings
- KB hit tracking for reply quality analytics
- Paginated article list (20 per page)

### Contacts
- AI-tagged contact directory with engagement scoring
- Tags: VIP, New Lead, Churning, At Risk, Sales, Support
- Conversation history per contact with category labels
- Filter by account, category, and search
- Paginated table (25 per page)

### Admin Panel
- **Account Settings** -- CRUD for company accounts with Phase 1/2 toggles, trust mode, custom AI prompts
- **AI Settings** -- Model selector (12 NVIDIA models), temperature, max tokens, system prompts per channel
- **Channels** -- Channel configuration management
- **Notifications** -- Per-account alert rules (Slack webhook + Gmail SMTP)
- **System Health** -- Connectivity checks for Supabase, AI API
- **Users** -- User management with role assignment (Admin/Reviewer/Viewer)

### Integrations
- **Google Sheets Sync** -- Import data from Google Sheets for AI context enrichment
- **Slack** -- Block Kit formatted notifications via webhook
- **Gmail SMTP** -- HTML email notifications

### Security
- **Webhook Secret Validation** -- Timing-safe comparison on all internal API calls
- **Row Level Security** -- Enabled on all Supabase tables
- **Role-Based Access** -- Admin, Reviewer, Viewer roles with account scoping
- **SSRF Protection** -- AI test endpoint blocks private IPs, localhost, cloud metadata
- **CSV Injection Prevention** -- Export escapes formula-triggering prefixes
- **Rate Limiting** -- Per-account rate limiting on all webhook endpoints
- **Input Sanitization** -- Message text truncated at 50KB, sender names cleaned

---

## Project Structure

```
src/
  app/
    (auth)/                         # Login & Signup pages
    (dashboard)/
      dashboard/                    # KPI dashboard with customizable widgets
      inbox/                        # Unified inbox (list/split/kanban + pagination)
      conversations/[id]/           # Conversation detail + AI sidebar + actions
      reports/                      # Reports & analytics (overview, sentiment, advanced)
      contacts/                     # AI-tagged contact directory + pagination
      knowledge-base/               # KB article management + gap analysis + pagination
      accounts/                     # Account overview and detail pages
      templates/                    # Reply template management
      sheets/                       # Google Sheets sync configuration
      admin/
        accounts/                   # Account CRUD + phase toggles
        ai-settings/                # AI model selector (12 NVIDIA models)
        channels/                   # Channel configuration
        notifications/              # Notification rule management
        health/                     # System health monitoring
        users/                      # User management
    api/
      webhooks/
        teams/                      # Teams inbound message webhook
        email/                      # Email inbound webhook + spam detection
        whatsapp/                   # WhatsApp webhook (Meta verification + messages)
        gmail-sent/                 # Gmail outbound sync webhook
        teams-reply/                # Teams reply delivery webhook
      classify/                     # AI message classification (Phase 1)
      ai-reply/                     # AI reply generation (Phase 2)
      suggest-replies/              # AI suggested replies
      notifications/send/           # Email + Slack notification dispatch
      export/                       # CSV export (messages, AI replies)
      sla-check/                    # SLA compliance checker
      test-ai/                      # AI connection tester
      test-connection/              # System connectivity check
      sheets-sync/                  # Google Sheets sync trigger
  components/
    dashboard/                      # Conversation thread, actions, AI sidebar, sidebar, widgets
    inbox/                          # Inbox list, row, kanban, filters, preview
    reports/                        # Advanced analytics, sentiment analytics, report card
    ui/                             # Button, Card, Badge, Toast, Pagination, Modal, etc.
  lib/
    api-helpers.ts                  # Rate limiter, callAI, findOrCreateConversation, getAIConfig
    supabase-client.ts              # Browser Supabase client
    supabase-server.ts              # Server Supabase client + service role client
    notification-service.ts         # Slack + Email notification dispatch
    utils.ts                        # Formatting helpers, cn(), timeAgo, etc.
    schema.sql                      # Complete database schema (672 lines)
  types/
    database.ts                     # All TypeScript interfaces and enums
  hooks/
    useRealtimeMessages.ts          # Supabase realtime subscription hook
  context/
    user-context.tsx                # Auth user context provider
scripts/
  create-teams-workflows.mjs       # Generate Teams monitor workflows
  update-all-teams-monitors.mjs    # Update all Teams polling workflows
```

**Stats:** 113 TypeScript files | 15 API routes | 22 pages | 51 components

---

## Database Schema

### Core Tables (14+)

| Table | Purpose |
|-------|---------|
| `users` | Authentication, roles (admin/reviewer/viewer), account assignment |
| `accounts` | Company accounts with channel config, AI phase toggles, trust mode |
| `conversations` | Multi-channel conversation tracking with status, priority, assignment |
| `messages` | Message storage with direction, channel metadata, spam detection |
| `message_classifications` | AI classification results (category, sentiment, urgency, confidence) |
| `ai_replies` | AI-generated drafts with approval workflow |
| `ai_config` | AI provider settings (model, temperature, prompts) |
| `kb_articles` | Knowledge base articles per company |
| `kb_hits` | Tracks which KB articles were used in AI replies |
| `reply_templates` | Reusable reply templates with usage tracking |
| `notification_rules` | Per-account alert configuration |
| `channel_configs` | Channel credentials |
| `google_sheets_sync` | Sheets integration configuration |
| `imported_records` | Data imported from Google Sheets for AI context |
| `conversation_notes` | Internal notes on conversations |
| `audit_log` | System audit trail |

### Key Enums

- **Channels:** `teams` | `email` | `whatsapp`
- **Conversation Status:** `active` | `in_progress` | `waiting_on_customer` | `resolved` | `escalated` | `archived`
- **Priority:** `low` | `medium` | `high` | `urgent`
- **Sentiment:** `positive` | `neutral` | `negative`
- **AI Reply Status:** `pending_approval` | `approved` | `sent` | `rejected` | `edited`
- **Categories:** Sales Inquiry, Trouble Ticket, Payment Issue, Rate Request, Technical Issue, Compliance, General Inquiry, Follow-Up, Newsletter/Marketing, Other
- **User Roles:** `admin` | `reviewer` | `viewer`

---

## AI Pipeline

```
Inbound Message (webhook)
    |
    v
Phase 1: Classification (/api/classify)
    |-- Category (10 types)
    |-- Sentiment (positive / neutral / negative)
    |-- Urgency (low / medium / high / urgent)
    |-- Topic Summary
    |-- Confidence Score (0-1)
    |-- Auto-Routing (urgent -> least-loaded agent)
    |-- Auto-Escalation (negative + urgent -> escalate + notify)
    |
    v
Phase 2: AI Reply (/api/ai-reply)
    |-- Fetch KB articles (identity + top 3 by relevance score)
    |-- Fetch conversation history (last 10 messages)
    |-- Fetch imported records (Google Sheets data)
    |-- Generate context-aware reply
    |-- Calculate confidence score (0.5 base + KB/history/classification bonuses)
    |-- Store as pending_approval or auto-send (trust mode)
    |
    v
Agent Review (UI)
    |-- Approve & Send --> /api/send --> channel API
    |-- Edit & Send   --> /api/send --> channel API
    |-- Manual Reply   --> /api/send --> channel API
    |-- Reject
```

### Supported AI Models (NVIDIA NIM)

| Model | Parameters | Best For |
|-------|-----------|----------|
| moonshotai/kimi-k2.5 (default) | 1T MoE | Best overall quality, multilingual |
| meta/llama-3.3-70b-instruct | 70B | Fast, reliable general use |
| deepseek-ai/deepseek-v3.2 | 685B MoE | Complex reasoning |
| qwen/qwen3.5-397b-a17b | 397B MoE | Multilingual + code |
| meta/llama-3.1-405b-instruct | 405B | Maximum accuracy |
| mistralai/mistral-large-3-675b | 675B | Enterprise quality |
| z-ai/glm5 | -- | Chinese + English |
| minimaxai/minimax-m2.5 | -- | Cost-effective |
| nvidia/nemotron-3-super-120b | 120B MoE | NVIDIA optimized |
| openai/gpt-oss-120b | 120B | OpenAI-compatible |
| moonshotai/kimi-k2-thinking | 1T MoE | Extended reasoning |
| z-ai/glm4.7 | -- | Compact bilingual |

---

## API Routes

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/classify` | POST | Session/Webhook | AI message classification |
| `/api/ai-reply` | POST | Session/Webhook | AI reply generation |
| `/api/suggest-replies` | POST | Session | Generate 3 AI suggested replies |
| `/api/export` | GET | Session | CSV export (messages, AI replies) |
| `/api/sla-check` | POST | Webhook | Check and escalate SLA breaches |
| `/api/test-ai` | POST | Session | Test AI provider connection |
| `/api/test-connection` | POST | Session | Test system connectivity |
| `/api/sheets-sync` | GET/POST | Session/Webhook | Google Sheets sync |
| `/api/notifications/send` | POST | Webhook | Dispatch email/Slack notifications |
| `/api/webhooks/email` | POST | Webhook | Receive inbound emails |
| `/api/webhooks/teams` | POST | Webhook | Receive Teams messages |
| `/api/webhooks/whatsapp` | GET/POST | Verify Token | WhatsApp webhook |
| `/api/webhooks/gmail-sent` | POST | Webhook | Sync outbound Gmail replies |

---

## Getting Started

### Prerequisites

- Node.js 18+
- Supabase project ([supabase.com](https://supabase.com))
- NVIDIA NIM API key ([build.nvidia.com](https://build.nvidia.com)) -- free tier available

### Installation

```bash
git clone https://github.com/runFast123/unified-comm-portal.git
cd unified-comm-portal
npm install
```

### Environment Variables

Create `.env.local` from the example:

```bash
cp .env.local.example .env.local
```

Required variables:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Webhook
WEBHOOK_SECRET=your-webhook-secret

# AI (NVIDIA NIM)
AI_BASE_URL=https://integrate.api.nvidia.com/v1
AI_API_KEY=your-nvidia-api-key
AI_MODEL=moonshotai/kimi-k2.5

# WhatsApp (optional)
WHATSAPP_VERIFY_TOKEN=your-verify-token
```

### Database Setup

Apply the schema to your Supabase project:

```bash
# Option 1: Copy src/lib/schema.sql into Supabase SQL Editor and execute
# Option 2: Use Supabase CLI
supabase db push
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Production Build & Deploy

```bash
npm run build
npm start

# Or deploy to Vercel
npx vercel --prod
```

---

## User Roles

| Role | Permissions |
|------|-------------|
| **Admin** | Full access: manage accounts, users, AI settings, channels, view all data |
| **Reviewer** | View & manage conversations for assigned company, approve/edit AI replies |
| **Viewer** | View-only access to assigned company's data |

---

## License

Private -- All rights reserved.
