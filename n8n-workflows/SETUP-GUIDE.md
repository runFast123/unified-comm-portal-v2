# n8n Workflow Setup Guide — Unified Communication Portal

## Overview

You have 4 workflow files to import into n8n:

| File | Purpose | Direction |
|---|---|---|
| `gmail-monitor.json` | Watches Gmail for new emails → sends to portal | n8n → Portal |
| `gmail-reply.json` | Receives approved reply from portal → sends via Gmail | Portal → n8n → Gmail |
| `teams-monitor.json` | Watches Teams for new messages → sends to portal | n8n → Portal |
| `teams-reply.json` | Receives approved reply from portal → sends via Teams | Portal → n8n → Teams |

```
FLOW DIAGRAM:

Gmail Inbox ──→ [gmail-monitor] ──→ POST /api/webhooks/email ──→ Portal stores + AI classifies
                                                                         │
                                                                    (user approves reply)
                                                                         │
Portal ──→ POST n8n/webhook/email-reply ──→ [gmail-reply] ──→ Gmail sends reply

Teams Chat ──→ [teams-monitor] ──→ POST /api/webhooks/teams ──→ Portal stores + AI classifies
                                                                         │
                                                                    (user approves reply)
                                                                         │
Portal ──→ POST n8n/webhook/teams-reply ──→ [teams-reply] ──→ Teams sends reply
```

---

## PREREQUISITES

Before starting, you need:

1. **Portal deployed publicly** (n8n cloud can't reach localhost)
   - Option A: Deploy to Vercel → `vercel deploy`
   - Option B: Use ngrok → `ngrok http 3000` → gives temporary public URL

2. **Your portal's public URL** (e.g., `https://your-app.vercel.app` or `https://abc123.ngrok.io`)

3. **Google account** for Gmail (with OAuth credentials)

4. **Microsoft 365 account** for Teams (with Azure AD app registration)

---

## STEP 1: Create Accounts in Supabase

Before importing workflows, create real accounts in your database.

### For Gmail Account:
Go to your Supabase Dashboard → SQL Editor and run:
```sql
-- First, get an existing email account ID to reuse (or create new)
UPDATE accounts
SET
  name = 'YOUR ACCOUNT NAME',           -- e.g., 'MCM Support Email'
  gmail_address = 'your@gmail.com',      -- your actual Gmail
  phase1_enabled = true,                 -- enable AI classification
  phase2_enabled = false,                -- enable later after testing
  is_active = true,
  working_hours_start = '08:00',
  working_hours_end = '17:00',
  working_timezone = 'Asia/Dubai'
WHERE name = 'Email-1 (sk3group)';       -- reuse first email account slot
```

### For Teams Account:
```sql
UPDATE accounts
SET
  name = 'YOUR ACCOUNT NAME',           -- e.g., 'MCM Teams Main'
  teams_tenant_id = 'your-tenant-id',   -- from Azure Portal
  teams_user_id = 'your-user-id',       -- from Azure AD
  phase1_enabled = true,
  phase2_enabled = false,
  is_active = true,
  working_hours_start = '08:00',
  working_hours_end = '17:00',
  working_timezone = 'Asia/Dubai'
WHERE name = 'MCM-1';                   -- reuse first Teams account slot
```

**Save the account UUIDs** — you'll need them in the workflow configuration:
```sql
SELECT id, name, channel_type FROM accounts WHERE is_active = true;
```

---

## STEP 2: Set Up Gmail Credentials in n8n

1. Go to your n8n instance: https://mcmflow.app.n8n.cloud
2. Click **Credentials** (left sidebar) → **Add Credential**
3. Search for **Gmail OAuth2**
4. Click **Sign in with Google** and authorize with your Gmail account
5. Save — **note the credential name** (e.g., "Gmail Account")

### Google Cloud Console Setup (if needed):
If n8n asks for Client ID/Secret:
1. Go to https://console.cloud.google.com
2. Create a project (or select existing)
3. Enable **Gmail API** (APIs & Services → Library → search "Gmail API")
4. Create OAuth 2.0 credentials:
   - Application type: Web application
   - Authorized redirect URI: `https://mcmflow.app.n8n.cloud/rest/oauth2-credential/callback`
5. Copy Client ID and Client Secret into n8n

---

## STEP 3: Set Up Teams Credentials in n8n (if using Teams)

1. Go to https://portal.azure.com → **Azure Active Directory** → **App registrations**
2. Click **New registration**:
   - Name: "Unified Portal n8n"
   - Supported account types: "Accounts in this organizational directory only"
   - Redirect URI: Web → `https://mcmflow.app.n8n.cloud/rest/oauth2-credential/callback`
3. After creation, note:
   - **Application (client) ID**
   - **Directory (tenant) ID**
4. Go to **Certificates & Secrets** → New client secret → copy the **Value**
5. Go to **API permissions** → Add:
   - `ChannelMessage.Read.All`
   - `ChannelMessage.Send`
   - `Chat.Read`
   - `Chat.ReadWrite`
   - `User.Read`
6. Click **Grant admin consent**

In n8n:
1. **Credentials** → **Add Credential** → **Microsoft Teams OAuth2**
2. Paste Client ID, Client Secret, Tenant ID
3. Click **Sign in** and authorize

---

## STEP 4: Import Workflows into n8n

### 4A: Import Gmail Monitor
1. In n8n, click **Add Workflow** (+ button)
2. Click the **three dots (⋮)** menu → **Import from File**
3. Select `gmail-monitor.json` from `Unified_com/n8n-workflows/`
4. **EDIT these placeholders** in the workflow:
   - **Gmail Trigger node**: Select your Gmail credential
   - **Map Email Fields → account_id**: Replace `REPLACE_WITH_YOUR_EMAIL_ACCOUNT_UUID` with your actual account UUID from Step 1
   - **Send to Portal Webhook → url**: Replace `YOUR_PORTAL_URL` with your actual portal URL (e.g., `https://your-app.vercel.app`)
5. **Save** and **Activate** the workflow

### 4B: Import Gmail Reply
1. Import `gmail-reply.json`
2. **EDIT**:
   - **Gmail Send node**: Select your Gmail credential
3. **Save** and **Activate**
4. **Copy the webhook URL** shown in the "Webhook - Receive Reply" node (e.g., `https://mcmflow.app.n8n.cloud/webhook/email-reply`)

### 4C: Import Teams Monitor
1. Import `teams-monitor.json`
2. **EDIT**:
   - **Teams Trigger node**: Select your Teams credential, Team, and Channel
   - **Map Teams Fields → account_id**: Replace with Teams account UUID
   - **Send to Portal Webhook → url**: Replace `YOUR_PORTAL_URL`
3. **Save** and **Activate**

### 4D: Import Teams Reply
1. Import `teams-reply.json`
2. **EDIT**:
   - **Teams Send node**: Select your Teams credential
3. **Save** and **Activate**
4. **Copy the webhook URL** from the Webhook node

---

## STEP 5: Update Portal Environment

Update your `.env.local` with the n8n webhook base URL (already done if using n8n cloud):

```env
N8N_BASE_URL=https://mcmflow.app.n8n.cloud
N8N_API_KEY=your-n8n-api-key
N8N_WEBHOOK_SECRET=my-webhook-secret-123
```

---

## STEP 6: Test the Flow

### Test Gmail Monitor:
1. Send a test email to your configured Gmail address from another account
2. Wait ~1 minute (Gmail Trigger polls every minute)
3. Check n8n executions → should show the email was received and forwarded
4. Check your portal → Dashboard should show 1 new message
5. Check Inbox → the email should appear with AI classification

### Test Teams Monitor:
1. Send a message in your configured Teams channel
2. The Teams Trigger fires immediately (webhook-based)
3. Check n8n executions → should show the message was forwarded
4. Check your portal → message appears in Inbox

### Test Reply Flow:
1. In the portal, approve an AI-generated reply
2. The portal calls n8n webhook (`/webhook/email-reply` or `/webhook/teams-reply`)
3. n8n sends the reply via Gmail/Teams
4. Check the recipient received the reply

---

## TROUBLESHOOTING

| Issue | Solution |
|---|---|
| n8n can't reach portal | Make sure portal is deployed publicly (not localhost) |
| 401 Unauthorized on webhook | Check `X-Webhook-Secret` header matches `N8N_WEBHOOK_SECRET` in `.env.local` |
| Gmail Trigger not firing | Check Gmail credential is valid, check n8n execution log |
| Teams Trigger not firing | Verify Azure AD permissions are granted, check webhook subscription |
| Reply not sending | Check n8n execution log for the reply workflow, verify credential |
| Classification not working | Make sure `ANTHROPIC_API_KEY` is set in `.env.local` for Claude AI |

---

## QUICK REFERENCE: API Endpoints

| Endpoint | Method | Purpose | Called by |
|---|---|---|---|
| `/api/webhooks/email` | POST | Receive new emails | n8n Gmail Monitor |
| `/api/webhooks/teams` | POST | Receive new Teams messages | n8n Teams Monitor |
| `/api/classify` | POST | AI classification (Phase 1) | Internal (auto) |
| `/api/ai-reply` | POST | AI reply generation (Phase 2) | Internal (auto) |
| `/api/n8n` | POST | Trigger n8n reply workflows | Portal (on approve) |
| `/webhook/email-reply` | POST | n8n receives reply to send | Portal via n8n |
| `/webhook/teams-reply` | POST | n8n receives reply to send | Portal via n8n |

## Webhook Payload Formats

### Email Webhook (POST /api/webhooks/email)
```json
{
  "sender": "customer@example.com",
  "subject": "Need help with SIP trunk setup",
  "body": "Plain text email body...",
  "thread_id": "thread-abc123",
  "account_id": "uuid-of-email-account"
}
```

### Teams Webhook (POST /api/webhooks/teams)
```json
{
  "sender": "John Doe",
  "text": "Message text content...",
  "chat_id": "19:abc123@thread.tacv2",
  "timestamp": "2026-03-20T10:00:00Z",
  "account_id": "uuid-of-teams-account"
}
```

### Reply Webhook (POST to n8n /webhook/email-reply or /webhook/teams-reply)
```json
{
  "account_id": "uuid-of-account",
  "reply_text": "The AI-generated reply text...",
  "to": "customer@example.com",
  "subject": "Re: Need help with SIP trunk setup",
  "thread_id": "thread-abc123",
  "chat_id": "19:abc123@thread.tacv2"
}
```
