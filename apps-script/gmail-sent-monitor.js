/**
 * Gmail Sent Monitor - Google Apps Script
 *
 * Detects when you reply to emails from Gmail directly (outside the portal)
 * and syncs the reply back to the Unified Communication Portal so the
 * conversation shows both sides.
 *
 * SETUP:
 * 1. Open https://script.google.com
 * 2. Create a new project
 * 3. Paste this entire script
 * 4. Update the CONFIG section below with your values
 * 5. Run setupTrigger() once to create the automatic trigger
 * 6. Authorize the script when prompted
 *
 * HOW IT WORKS:
 * - Runs every 2 minutes via a time-based trigger
 * - Checks the Gmail Sent folder for emails sent in the last 3 minutes
 * - For each sent email, sends the data to the portal webhook
 * - The portal matches the thread_id to existing conversations
 * - Creates an outbound message record so the reply shows in the thread
 * - Marks the inbound messages as replied so pending count updates
 */

// ============================================================================
// CONFIG - Update these values for your setup
// ============================================================================

const CONFIG = {
  // Your portal URL (no trailing slash)
  PORTAL_URL: 'https://unified-comm-portal.vercel.app',

  // Webhook secret (must match N8N_WEBHOOK_SECRET in your portal's .env)
  WEBHOOK_SECRET: 'my-webhook-secret-123',

  // How often to check (in minutes) - the trigger runs this often
  CHECK_INTERVAL_MINUTES: 2,

  // How far back to look for sent emails (in minutes) - should be slightly
  // more than CHECK_INTERVAL to avoid missing emails
  LOOKBACK_MINUTES: 3,
};

// ============================================================================
// MAIN FUNCTION - Called by the trigger every N minutes
// ============================================================================

function checkSentEmails() {
  const lookbackMs = CONFIG.LOOKBACK_MINUTES * 60 * 1000;
  const since = new Date(Date.now() - lookbackMs);

  // Search for sent emails in the lookback window
  const query = `in:sent after:${Math.floor(since.getTime() / 1000)}`;
  const threads = GmailApp.search(query, 0, 20);

  if (threads.length === 0) return;

  const processedKey = 'processed_message_ids';
  const processedStr = PropertiesService.getScriptProperties().getProperty(processedKey) || '[]';
  let processedIds;
  try {
    processedIds = JSON.parse(processedStr);
  } catch (e) {
    processedIds = [];
  }

  const newProcessedIds = [];

  for (const thread of threads) {
    const messages = thread.getMessages();

    for (const message of messages) {
      // Only process messages sent by us (not received)
      if (!message.getFrom().includes(Session.getActiveUser().getEmail())) continue;

      // Only process messages sent within the lookback window
      if (message.getDate().getTime() < since.getTime()) continue;

      const messageId = message.getId();

      // Skip if already processed
      if (processedIds.includes(messageId)) {
        newProcessedIds.push(messageId);
        continue;
      }

      // Extract email data
      const payload = {
        sender: message.getFrom(),
        to: message.getTo(),
        subject: message.getSubject(),
        body: message.getPlainBody() || message.getBody(),
        thread_id: thread.getId(),
        message_id: messageId,
        sent_at: message.getDate().toISOString(),
        // The "from" address helps the portal match to the right account
        from_address: Session.getActiveUser().getEmail(),
      };

      // Send to portal webhook
      try {
        const response = UrlFetchApp.fetch(
          CONFIG.PORTAL_URL + '/api/webhooks/gmail-sent',
          {
            method: 'post',
            contentType: 'application/json',
            headers: {
              'x-webhook-secret': CONFIG.WEBHOOK_SECRET,
            },
            payload: JSON.stringify(payload),
            muteHttpExceptions: true,
          }
        );

        const status = response.getResponseCode();
        if (status >= 200 && status < 300) {
          Logger.log('Synced sent email: ' + payload.subject);
          newProcessedIds.push(messageId);
        } else {
          Logger.log('Failed to sync (HTTP ' + status + '): ' + payload.subject);
          Logger.log('Response: ' + response.getContentText());
        }
      } catch (error) {
        Logger.log('Error syncing email: ' + error.message);
      }
    }
  }

  // Keep only the last 200 processed IDs to avoid growing forever
  const allProcessed = [...new Set([...processedIds, ...newProcessedIds])].slice(-200);
  PropertiesService.getScriptProperties().setProperty(processedKey, JSON.stringify(allProcessed));
}

// ============================================================================
// SETUP - Run this ONCE to create the automatic trigger
// ============================================================================

function setupTrigger() {
  // Remove any existing triggers
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'checkSentEmails') {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  // Create new trigger
  ScriptApp.newTrigger('checkSentEmails')
    .timeDriven()
    .everyMinutes(CONFIG.CHECK_INTERVAL_MINUTES)
    .create();

  Logger.log('Trigger created! checkSentEmails will run every ' + CONFIG.CHECK_INTERVAL_MINUTES + ' minutes.');
  Logger.log('You can verify in Edit > Current project\'s triggers');
}

// ============================================================================
// UTILITY - Run this to remove the trigger
// ============================================================================

function removeTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'checkSentEmails') {
      ScriptApp.deleteTrigger(trigger);
      Logger.log('Trigger removed.');
    }
  }
}

// ============================================================================
// TEST - Run this manually to test the connection
// ============================================================================

function testConnection() {
  try {
    const response = UrlFetchApp.fetch(
      CONFIG.PORTAL_URL + '/api/webhooks/gmail-sent',
      {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'x-webhook-secret': CONFIG.WEBHOOK_SECRET,
        },
        payload: JSON.stringify({
          sender: 'test@example.com',
          to: 'customer@example.com',
          subject: 'Test - Apps Script Connection',
          body: 'This is a test message to verify the Apps Script connection.',
          thread_id: 'test-thread-' + Date.now(),
          message_id: 'test-msg-' + Date.now(),
          sent_at: new Date().toISOString(),
          from_address: Session.getActiveUser().getEmail(),
          _test: true,
        }),
        muteHttpExceptions: true,
      }
    );

    Logger.log('Status: ' + response.getResponseCode());
    Logger.log('Response: ' + response.getContentText());
  } catch (error) {
    Logger.log('Connection failed: ' + error.message);
  }
}
