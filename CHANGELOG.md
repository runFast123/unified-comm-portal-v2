# Changelog

All notable changes to the Unified Communication Portal are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project loosely follows [SemVer](https://semver.org/).

Each "Round" below corresponds to one batch of parallel-agent work landed on `tier-5-deploy`.

---

## [Round 5] – 2026-05-01 – Production polish

Cleanup and handoff round — no new features, just rough-edge fixes.

### Added
- `CHANGELOG.md` (this file).
- README "Features" overview section at the top of the file.
- Sidebar navigation grouped into collapsible **Inbox / Customers / Reports / Admin** sections;
  expand/collapse state persisted per-section in `localStorage` (`sidebar-section:<key>`).
- One-time admin onboarding banner shown to fresh super_admins on the dashboard,
  pointing at `/admin/health` and `/admin/companies`. Dismissal persisted in `localStorage`.
- TypeScript interfaces for previously-untyped tables: `OOOReplySent`, `ConversationMerge`,
  `ApiToken`, `WebhookSubscription`, `WebhookDelivery`, `CompanyStatus`, `CompanyTag`,
  `NoteMention`, `MetricsEvent`, `ConversationTimeEntry`.

### Changed
- Empty states across Companies, Webhooks, API tokens, Templates (admin), and
  Channels now include a **primary CTA** + a styled icon chip via the shared
  `EmptyState` component.
- Admin section in the sidebar auto-collapses on viewports narrower than `lg`
  (1024px) on first load.
- README opens with a feature digest of everything shipped through Round 4.

### Removed
- Legacy flat-list sidebar layout — the long single column became unmanageable
  after Rounds 1-4 each added new admin pages.

---

## [Round 4] – 2026-05-01 – CSAT, smart inbox sidebar, API tokens, outgoing webhooks

### Added
- **CSAT surveys** (`csat_surveys` table, `companies.csat_*` config, `/csat/[token]`
  public landing page, `/admin/csat` dashboard). HMAC-signed tokens with 14-day
  expiry; auto-sent on `conversations.status -> resolved` (30-day per-conversation
  dedupe). +38 tests.
- **Smart inbox facet sidebar** (`/api/inbox/facets`, `InboxFacetsSidebar`):
  collapsible categories / sentiments / urgencies / channels / statuses / assignee
  buckets with live counts. URL-backed state (`?category=…`) survives refresh.
  +16 tests.
- **API tokens** per company (`api_tokens` table; SHA-256 hashed; plaintext shown
  ONCE at creation; soft-revoke; per-token scope array).
- **Outgoing webhooks** per company (`webhook_subscriptions`, `webhook_deliveries`):
  HMAC-signed `X-Webhook-Signature: sha256=…` header, three event types
  (`conversation.created`, `conversation.resolved`, `message.received`), webhook
  dispatcher with 3 retries (1s/5s/30s) and auto-deactivation after 5 consecutive
  failures.
- Public REST surface `/api/v1/conversations[+messages]` gated by bearer token +
  scope check (`requireToken()`).
- New admin pages: `/admin/api-tokens`, `/admin/webhooks`.

### Tests
- Suite grew **399 → 479** (+80, +7 new files).

---

## [Round 3] – 2026-05-01 – Out-of-office, conversation merging, activity timeline

### Added
- **Per-account Out-of-Office auto-replies**: `accounts.ooo_*` columns + dedup
  via `ooo_replies_sent` (UNIQUE on `conversation_id` + `ooo_window_start` so
  races can't double-reply). Variable substitution for `{{customer.name}}`,
  `{{ooo.return_date}}`, `{{company.name}}`. +49 tests. WhatsApp deferred.
- **Conversation merging** (soft merge) with `merged_into_id`/`merged_at`/
  `merged_by` columns + `conversation_merges` audit table. Atomic transactional
  RPCs (`merge_conversations`, `unmerge_conversations`) — same-company guard,
  no-double-merge guard, no-self guard. `MergeButton` + `MergeBanner` UI.
  Inbox query filters out merged secondaries on initial + load-more paths.
  +30 tests.
- **Conversation activity timeline**: `conversation_timeline(uuid)` PG function
  unions `messages` ⊕ `ai_replies` ⊕ `audit_log`. New `/api/conversations/[id]/
  {timeline,status,assign}` routes; `ActivityTimeline` component in conversation
  right rail. +22 tests.

### Tests
- Suite grew **298 → 399** (+101).

---

## [Round 2] – 2026-04-30 – Multi-tenancy UI, email templates, custom statuses & tags

### Added
- **`/admin/companies`** (super_admin) — table + create modal + per-company
  detail page (Overview / Accounts / Users / Audit tabs).
- **Company switcher** in dashboard header (hidden when the user only has access
  to one company).
- **Branding application** — `companies.{logo_url, accent_color}` flows into a
  CSS variable on the layout root and replaces the sidebar wordmark.
- **Email templates** (`reply_templates` extended with `company_id`, `subject`,
  `shortcut`, `category`, `usage_count`, `created_by`, `updated_at`; RLS scoped
  by company). Slash-command lookup (`/welcome ` expands the matching template);
  variable substitution.
- **Custom statuses + tags per company** (`secondary_status` column,
  `company_statuses` + `company_tags` catalogs). `/admin/taxonomy` UI;
  `StatusDropdown` + `ConversationTagPicker` extended.

### Tests
- Suite grew **199 → 298** (+99, +5 test files).

---

## [Round 1] – 2026-04-30 – Multi-tenancy foundation, email signatures, @-mentions

### Added
- **Multi-tenancy foundation**: `companies` extended (`slug`, `logo_url`,
  `accent_color`, `monthly_ai_budget_usd`, `settings`, `updated_at`),
  `users.company_id` (denormalized + sync trigger), three new roles
  (`super_admin`, `company_admin`, `company_member`), helper SQL functions
  (`is_super_admin()`, `current_user_company_id()`, `is_company_admin()`),
  21 RLS policies rewritten to scope by company with super_admin bypass.
  Backfill auto-grouped existing accounts by base name.
- **Email signatures** with two-level inheritance (per-user override beats
  per-company default); variable substitution; `/account/signature` editor and
  `/admin/company-signatures` company default editor.
- **@-mentions in internal notes**: `note_mentions` table + RLS, token format
  `@[Display Name](uuid)`, `/api/users/search` (company-scoped), mentions bell
  in header, best-effort SMTP notification on mention.

### Tests
- Suite grew **141 → 202** (+61, +6 test files).

---

## [Pre-Round 1] – AI provider circuit breaker + observability metrics

### Added
- **AI provider circuit breaker** (`src/lib/ai-circuit-breaker.ts`): 3-state
  CLOSED / OPEN / HALF_OPEN; opens after 5 consecutive provider failures, 60s
  cooldown before a half-open canary, auto-closes on success. All five AI route
  handlers degrade gracefully on `CircuitBreakerOpenError`.
- **Structured operational metrics** (`metrics_events` table, `recordMetric()`
  in `src/lib/metrics.ts`). Buffered (100 events or 10s flush via `after()`),
  service-role insert, never-throws guarantee. Hot paths instrumented (cron
  handlers, `callAI()`).
- **`/admin/observability` page**: SLI tiles, per-cron p50/p95 table, inline
  SVG bar charts (cron runs / AI cost / message volume), top-errors table.

---

## [Pre-Round 1] – User-friendly improvements

### Added
- **Setup wizard / health dashboard** (`/admin/health`) with 7 diagnostic
  sections; auto-detected redirect URI helper with copy buttons.
- **Undo send** (5-second buffer) — `pending_sends` table; `/api/send` accepts
  `delay_ms`; `dispatch-scheduled` cron writes the outbound row, so cancelled
  sends leave no ghost.
- **Smart Compose** — ghost-text overlay with `useSmartCompose` hook (800ms
  debounce, `AbortController`, send-in-flight gate, 30s 429 backoff). Tab to
  accept; `Ctrl+.` to toggle; persisted in `localStorage`.
- **Auto-summarize threads** — `conversations.ai_summary*` cache, invalidates on
  new messages. `ThreadSummary` component renders sticky on threads ≥5 messages.
- **Mobile-responsive** sidebar drawer + stacked inbox + table column hiding;
  44px minimum touch targets.

---

## [Tier 1-5 baseline] – Production hardening

The starting point of this changelog: AES-256-GCM envelope encryption with key
versioning, Gmail XOAUTH2 + Teams delegated OAuth (no app passwords), sharded
email + teams polling crons (4 shards × every 2m), HMAC-signed OAuth state
cookies, request-id propagation, and the must-have inbox features (routing,
round-robin, contacts, saved views, presence, snooze, AI budget cap).
