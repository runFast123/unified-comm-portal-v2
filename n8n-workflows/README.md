# n8n Workflows — Unified Communication Portal

## Workflow Inventory

Each company has its own dedicated Email Monitor + Email Reply workflow pair.

### Email Monitor Workflows (All Active)

| Company | n8n Workflow ID | Domain Filter | Account UUID |
|---------|----------------|---------------|--------------|
| Acepeak | `VO7El0vTModa83KD` | acepeak | `539ebfdd-8d9c-41bc-81fa-0cf78a5220b3` |
| Ajoxi | `n1IFm2DjMHEWeuqz` | ajoxi | `ee83d772-0350-4ca5-9cd8-91285bf3ff7e` |
| Letsdial | `ctpXe3pZylPGUyzY` | letsdial | `081fb6ce-96b7-4407-8ceb-7cf80202fccf` |
| Meratalk | `a4JLRT3XibBDQsI5` | meratalk | `e3c161e1-8ccd-4789-a03a-a9698ae8d3b2` |
| Mycountrymobile | `QTImfSytmm50F3y5` | mycountrymobile | `552ded86-9ed2-4ae3-979f-ce4910774d86` |
| Rozper | `kS4KPdnpYYbozDcW` | rozper | `7cfeb742-86c6-4a43-bcd9-41f5d00b9a53` |
| Softtop | `9TFPn1qoF3DxyJrK` | softtop | `49d00b10-aae9-4422-85ee-d571d4f8e760` |
| Techopensystems | `MdiDnBWztvqFPfOA` | techopensystems | `a45ab224-1dff-4c74-a3d4-07684186c51b` |
| Teloz | `R5nUyZp8MAwcbYt2` | teloz | `277ad954-8a07-46d8-80f2-d024b95fae04` |
| Twiching | `yYWrayZo4rxAmiPQ` | twiching | `c0e1b30a-b581-4c5f-a6a4-26bd14f963a7` |

### Email Reply Workflows (All Active)

| Company | n8n Workflow ID | Webhook Path |
|---------|----------------|--------------|
| Acepeak | `tRim2FOTkXCupPxU` | `/webhook/email-reply-acepeak` |
| Ajoxi | `emRT8PPVlrcKcqIA` | `/webhook/email-reply-ajoxi` |
| Letsdial | `THZxzEjq0bEjiPJ5` | `/webhook/email-reply-letsdial` |
| Meratalk | `yqHejm2y4nuyqPLo` | `/webhook/email-reply-meratalk` |
| Mycountrymobile | `WDPxf3vskOwexYca` | `/webhook/email-reply-mycountrymobile` |
| Rozper | `XNrF25HL43fz2sgs` | `/webhook/email-reply-rozper` |
| Softtop | `IunjuKAJTD4UAHFL` | `/webhook/email-reply-softtop` |
| Techopensystems | `Yj11lEK7wFWV7Gwo` | `/webhook/email-reply-techopensystems` |
| Teloz | `ByytYIsFEELrmnSa` | `/webhook/email-reply-teloz` |
| Twiching | `V32MQS2pP6nQSRZs` | `/webhook/email-reply-twiching` |

### Legacy Workflows (Deactivated)

| Workflow | ID | Status |
|----------|-----|--------|
| Unified Portal - Gmail Monitor | `ZruDGJF6WxYi7Tzj` | INACTIVE — replaced by per-company monitors |
| Unified Portal - Gmail Reply Sender | `UtHJGFiXP5JIiIvP` | INACTIVE — replaced by per-company replies |
| Unified Portal - Teams Monitor | `ciUQHgfGIgqWtzVk` | INACTIVE — needs M365 provisioning |
| Unified Portal - Teams Reply Sender | `n6yxSo7tzcwzRVgp` | INACTIVE — needs M365 provisioning |

## How It Works

### Email Monitor Flow
```
Gmail Trigger (every minute, unread)
  → Filter (sender contains company domain keyword)
  → Map Email Fields (sender, subject, body, thread_id, account_id)
  → POST to https://unified-comm-portal.vercel.app/api/webhooks/email
```

### Email Reply Flow
```
Webhook receives reply request (POST /webhook/email-reply-{company})
  → Gmail Send Reply (to, subject, message, thread_id)
  → Return {status: "sent"}
```

## Credentials

| Credential | ID | Type |
|-----------|-----|------|
| SmartelCredentialMail | `ARRNrllXKhhiNILy` | Gmail OAuth2 |
| Microsoft Teams OAuth2 | `czc5W08z3sCXs8Fu` | MS Teams OAuth2 (not yet authorized) |

## Teams Setup (Pending)

To activate Teams workflows:
1. Get Microsoft 365 subscription (or free Developer Program)
2. Add API permissions: `Chat.Read`, `ChatMessage.Read`, `User.Read`
3. Grant admin consent in Azure Portal
4. Complete OAuth sign-in in n8n credentials
5. Activate Teams Monitor and Teams Reply workflows
