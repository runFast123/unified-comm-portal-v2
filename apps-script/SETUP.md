# Gmail Sent Monitor - Apps Script Setup

Automatically detects when users reply to customer emails directly from Gmail (outside the portal) and syncs the reply back to the portal conversation thread.

## What It Does

- Runs every 2 minutes in the background
- Checks the Gmail Sent folder for recent outbound emails
- Sends the reply data to the portal webhook
- Portal matches the `thread_id` to find the existing conversation
- Creates an outbound message record so both sides show in the thread
- Marks pending inbound messages as replied (fixes pending count)

## Setup Steps (Per Company Gmail Account)

### 1. Open Google Apps Script

Go to [script.google.com](https://script.google.com) while logged into the company Gmail account.

### 2. Create New Project

- Click **New Project**
- Name it: `Unified Portal - Sent Monitor`

### 3. Paste the Script

- Delete the default `myFunction` code
- Copy the entire contents of `gmail-sent-monitor.js` and paste it

### 4. Update Config

Update the `CONFIG` object at the top:

```javascript
const CONFIG = {
  PORTAL_URL: 'https://unified-comm-portal.vercel.app',
  WEBHOOK_SECRET: 'my-webhook-secret-123',  // Must match your N8N_WEBHOOK_SECRET
  CHECK_INTERVAL_MINUTES: 2,
  LOOKBACK_MINUTES: 3,
};
```

### 5. Run Setup

1. Select `setupTrigger` from the function dropdown (top toolbar)
2. Click **Run**
3. **Authorize** the script when prompted:
   - Click "Review Permissions"
   - Select your Google account
   - Click "Advanced" > "Go to Unified Portal - Sent Monitor (unsafe)"
   - Click "Allow"
4. Check the Execution Log - should say "Trigger created!"

### 6. Test

1. Select `testConnection` from the function dropdown
2. Click **Run**
3. Check the log - should show `Status: 200` or `Status: 201`

### 7. Verify

1. Send a reply to a customer email from Gmail
2. Wait 2-3 minutes
3. Check the portal - the conversation should now show your reply and be marked as replied

## Accounts to Set Up

| Company | Gmail Account | Status |
|---------|--------------|--------|
| Ajoxi | sham@ajoxi.com | Pending |
| Letsdial | elsa@letsdial.com | Pending |
| Meratalk | monica@meratalk.com | Pending |
| Rozper | mia@rozper.com | Pending |
| Softtop | saniya@softtop.tech | Pending |
| Techopensystems | amelia@techopensystems.co.za | Pending |
| Teloz | kyle@teloz.com | Pending |
| Twiching | adela@twichinggeneraltrading.com | Pending |

## Troubleshooting

**Script not detecting emails:**
- Check the trigger exists: Edit > Current project's triggers
- Verify the Gmail account has sent emails in the last 3 minutes
- Check Execution Log for errors

**401 Unauthorized:**
- Verify `WEBHOOK_SECRET` matches your portal's `N8N_WEBHOOK_SECRET` environment variable

**Portal not showing the reply:**
- Check the portal's conversation - the reply should appear as an outbound message
- Verify the `thread_id` matches (Gmail and portal must use the same thread ID)

**Remove the trigger:**
- Run `removeTrigger()` function, or
- Go to Edit > Current project's triggers and delete manually
