#!/usr/bin/env node
/**
 * Updates all 10 Teams Monitor workflows to use Schedule Trigger + poll ALL chats.
 * Pattern: Schedule (1min) → List Chats → Filter Active → Loop → Fetch Messages → Parse → POST to Portal
 */

const N8N_BASE_URL = 'https://mcmflow.app.n8n.cloud'
const N8N_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MTU4ZmM1MC05NTVhLTRiOTAtODA0OC1mYzNkOGZlYTgzZjUiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiMjgxNDIwNzItZDgwYi00YjAxLWFhNDktYzRkMDY1OGYwMzIwIiwiaWF0IjoxNzczOTk4MjQ1fQ.5kD4PR6AUbCijxwkn9U3D_fm3wG9HAfldC6qyTUUYQo'
const PORTAL_URL = 'https://unified-comm-portal.vercel.app'
const WEBHOOK_SECRET = 'my-webhook-secret-123'
const TEAMS_CRED_ID = '0lLW5CbkT2yJCDAB'
const TEAMS_CRED_NAME = 'Aman testing'

const ALL_MONITORS = [
  { workflowId: 'sucs1ZLEavpABdKb', company: 'Acepeak', accountId: '34e534a7-1c9e-490c-8dbb-439c70100a84' },
  { workflowId: 'iW0oDEwboQtNPdOq', company: 'Ajoxi', accountId: '25f5a260-5f11-4455-8f36-d51469f10d94' },
  { workflowId: 'S4zWnBefyxovZd7Y', company: 'Letsdial', accountId: '29990b03-d910-4239-a526-a6d8a4f15097' },
  { workflowId: 'u4VjutmcPLFvASZa', company: 'Meratalk', accountId: '0d196b33-10b4-4379-bed6-baf2338f358e' },
  { workflowId: 'cfdynMu1JeQ08F5S', company: 'Mycountrymobile', accountId: '723d0a65-e6d7-4c4b-998a-edea742cabd5' },
  { workflowId: 'bJmG3GrMBysUv6jV', company: 'Rozper', accountId: '34af951b-016d-4333-86c1-dfaa8fdd6d19' },
  { workflowId: 'habuxJINjsQRDxDF', company: 'Softtop', accountId: '339bd9da-d269-4d9e-ab3b-7c4e65d82b2b' },
  { workflowId: '6bte7CNp3SZcJuS8', company: 'Techopensystems', accountId: 'b9f831b9-b543-4fdd-a173-0e4dd637eb0b' },
  { workflowId: 'rKTNyqxKTvtE45wi', company: 'Teloz', accountId: '3de4b1cd-bf2c-49ef-b368-90a1a9a89b68' },
  { workflowId: 'nQvg9bZ2VstxiXOA', company: 'Twiching', accountId: '0b27be5c-4799-4da7-adde-afe967420647' },
]

function buildPollingWorkflow(company, accountId) {
  return {
    name: `${company} - Teams Monitor`,
    nodes: [
      // 1. Schedule Trigger — every 1 minute
      {
        parameters: {
          rule: {
            interval: [{ field: 'minutes', minutesInterval: 1 }],
          },
        },
        name: 'Every 1 Minute',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [220, 300],
        id: 'sched1',
      },

      // 2. Get authenticated user ID + last poll time
      {
        parameters: {
          jsCode: `// Pass through to Get My User ID — the poll time is read later in Cache node
return [{ json: { trigger: true } }];`,
        },
        name: 'Get Last Poll Time',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [420, 300],
        id: 'glp1',
      },

      // 2b. Fetch own user ID (only if not cached)
      {
        parameters: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/me?$select=id,displayName',
          authentication: 'predefinedCredentialType',
          nodeCredentialType: 'microsoftTeamsOAuth2Api',
          options: {},
        },
        name: 'Get My User ID',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [420, 480],
        id: 'gmu1',
        credentials: {
          microsoftTeamsOAuth2Api: { id: TEAMS_CRED_ID, name: TEAMS_CRED_NAME },
        },
      },

      // 2c. Cache user ID in static data
      {
        parameters: {
          jsCode: `const staticData = $getWorkflowStaticData('global');
const meData = $input.first().json;
if (meData.id) {
  staticData.myUserId = meData.id;
  staticData.myDisplayName = meData.displayName || '';
}
const lastPoll = staticData.lastPollTime || new Date(Date.now() - 2 * 60 * 1000).toISOString();
return [{ json: { lastPollTime: lastPoll, myUserId: staticData.myUserId || '', myDisplayName: staticData.myDisplayName || '' } }];`,
        },
        name: 'Cache My User ID',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [420, 380],
        id: 'cmu1',
      },

      // 3. List all chats with last message preview
      {
        parameters: {
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/me/chats?$expand=lastMessagePreview&$top=50&$orderby=lastMessagePreview/createdDateTime desc',
          authentication: 'predefinedCredentialType',
          nodeCredentialType: 'microsoftTeamsOAuth2Api',
          options: { response: { response: { fullResponse: false } } },
        },
        name: 'List All Chats',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [640, 300],
        id: 'lac1',
        credentials: {
          microsoftTeamsOAuth2Api: { id: TEAMS_CRED_ID, name: TEAMS_CRED_NAME },
        },
      },

      // 4. Filter to chats with new messages since last poll
      {
        parameters: {
          jsCode: `const pollData = $('Cache My User ID').first().json;
const lastPollMs = new Date(pollData.lastPollTime).getTime();
const chats = $input.first().json.value || [];
const activeChats = [];

for (const chat of chats) {
  const preview = chat.lastMessagePreview;
  if (!preview || !preview.createdDateTime) continue;

  const msgTime = new Date(preview.createdDateTime).getTime();
  if (msgTime > lastPollMs) {
    activeChats.push({
      chatId: chat.id,
      chatType: chat.chatType || 'unknown',
      topic: chat.topic || null,
      lastMsgTime: preview.createdDateTime,
    });
  }
}

if (activeChats.length === 0) {
  // No new messages — update poll time and stop
  const staticData = $getWorkflowStaticData('global');
  staticData.lastPollTime = new Date().toISOString();
  return [];
}

return activeChats.map(c => ({ json: c }));`,
        },
        name: 'Filter Active Chats',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [860, 300],
        id: 'fac1',
      },

      // 5. Fetch recent messages from each active chat
      {
        parameters: {
          method: 'GET',
          url: '=https://graph.microsoft.com/v1.0/chats/{{ $json.chatId }}/messages?$top=10&$orderby=createdDateTime desc',
          authentication: 'predefinedCredentialType',
          nodeCredentialType: 'microsoftTeamsOAuth2Api',
          options: {},
        },
        name: 'Fetch Chat Messages',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [1080, 300],
        id: 'fcm1',
        credentials: {
          microsoftTeamsOAuth2Api: { id: TEAMS_CRED_ID, name: TEAMS_CRED_NAME },
        },
      },

      // 6. Parse messages, filter new ones, skip bots/system, format for portal
      {
        parameters: {
          jsCode: `const pollData = $('Cache My User ID').first().json;
const lastPollMs = new Date(pollData.lastPollTime).getTime();
const myUserId = pollData.myUserId || '';
const myDisplayName = pollData.myDisplayName || '';
const chatId = $('Filter Active Chats').item.json.chatId;
const chatType = $('Filter Active Chats').item.json.chatType;
const topic = $('Filter Active Chats').item.json.topic;
const messages = $input.first().json.value || [];
const results = [];

for (const msg of messages) {
  // Skip if older than last poll
  const msgTime = new Date(msg.createdDateTime).getTime();
  if (msgTime <= lastPollMs) continue;

  // Skip system/event messages
  if (msg.messageType !== 'message') continue;

  // Skip bot/application messages
  if (msg.from && msg.from.application) continue;

  // Skip empty messages
  if (!msg.body || !msg.body.content) continue;

  // Strip HTML
  const text = (msg.body.content || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\s+/g, ' ')
    .trim();

  if (!text || text.length < 2) continue;

  // Detect if this message is from the agent (our own user)
  const senderUserId = msg.from?.user?.id || '';
  const senderName = msg.from?.user?.displayName || msg.from?.displayName || '';
  const isAgent = (myUserId && senderUserId === myUserId) || (myDisplayName && senderName === myDisplayName);

  results.push({
    account_id: '${accountId}',
    sender_name: msg.from?.user?.displayName || msg.from?.displayName || 'Unknown',
    sender_email: msg.from?.user?.email || msg.from?.user?.id || '',
    message_text: text,
    teams_message_id: msg.id,
    teams_chat_id: chatId,
    team_name: topic || chatType || null,
    channel_name: topic || null,
    timestamp: msg.createdDateTime,
    message_type: 'message',
    is_agent_message: isAgent,
  });
}

return results.map(r => ({ json: r }));`,
        },
        name: 'Parse & Filter Messages',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1300, 300],
        id: 'pfm1',
      },

      // 7. POST each message to portal
      {
        parameters: {
          method: 'POST',
          url: `${PORTAL_URL}/api/webhooks/teams`,
          sendHeaders: true,
          headerParameters: {
            parameters: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'X-Webhook-Secret', value: WEBHOOK_SECRET },
            ],
          },
          sendBody: true,
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify({ account_id: $json.account_id, sender_name: $json.sender_name, sender_email: $json.sender_email, message_text: $json.message_text, teams_message_id: $json.teams_message_id, teams_chat_id: $json.teams_chat_id, team_name: $json.team_name, channel_name: $json.channel_name, timestamp: $json.timestamp, message_type: $json.message_type, is_agent_message: $json.is_agent_message }) }}',
          options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: 500 } } },
        },
        name: 'Send to Portal',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [1520, 300],
        id: 'stp1',
      },

      // 8. Update poll time after all processing
      {
        parameters: {
          jsCode: `const staticData = $getWorkflowStaticData('global');
staticData.lastPollTime = new Date().toISOString();
return [{ json: { updated: true, lastPollTime: staticData.lastPollTime } }];`,
        },
        name: 'Update Poll Time',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1740, 300],
        id: 'upt1',
      },
    ],
    connections: {
      'Every 1 Minute': { main: [[{ node: 'Get Last Poll Time', type: 'main', index: 0 }]] },
      'Get Last Poll Time': { main: [[{ node: 'Get My User ID', type: 'main', index: 0 }]] },
      'Get My User ID': { main: [[{ node: 'Cache My User ID', type: 'main', index: 0 }]] },
      'Cache My User ID': { main: [[{ node: 'List All Chats', type: 'main', index: 0 }]] },
      'List All Chats': { main: [[{ node: 'Filter Active Chats', type: 'main', index: 0 }]] },
      'Filter Active Chats': { main: [[{ node: 'Fetch Chat Messages', type: 'main', index: 0 }]] },
      'Fetch Chat Messages': { main: [[{ node: 'Parse & Filter Messages', type: 'main', index: 0 }]] },
      'Parse & Filter Messages': { main: [[{ node: 'Send to Portal', type: 'main', index: 0 }]] },
      'Send to Portal': { main: [[{ node: 'Update Poll Time', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  }
}

async function n8nPut(path, body) {
  const res = await fetch(`${N8N_BASE_URL}/api/v1${path}`, {
    method: 'PUT',
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`PUT ${path} failed (${res.status}): ${text.substring(0, 200)}`)
  }
  return res.json()
}

async function n8nPost(path) {
  const res = await fetch(`${N8N_BASE_URL}/api/v1${path}`, {
    method: 'POST',
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { ok: res.ok } }
}

async function main() {
  console.log('=== Updating All Teams Monitor Workflows to Poll-All-Chats Pattern ===\n')

  for (const wf of ALL_MONITORS) {
    try {
      // Deactivate
      await n8nPost(`/workflows/${wf.workflowId}/deactivate`)

      // Update with new polling workflow
      const workflow = buildPollingWorkflow(wf.company, wf.accountId)
      await n8nPut(`/workflows/${wf.workflowId}`, workflow)

      console.log(`  [OK] ${wf.company.padEnd(20)} - Updated to polling pattern (${wf.workflowId})`)
    } catch (err) {
      console.error(`  [ERROR] ${wf.company}: ${err.message}`)
    }
  }

  // Activate only Mycountrymobile for testing
  console.log('\n--- Activating Mycountrymobile for testing ---')
  try {
    await n8nPost('/workflows/cfdynMu1JeQ08F5S/activate')
    console.log('  [OK] Mycountrymobile - Teams Monitor activated')
  } catch (err) {
    console.error(`  [ERROR] Activation: ${err.message}`)
  }

  console.log('\n=== Done ===')
  console.log('Mycountrymobile activated for testing. Other 9 remain inactive.')
  console.log('Test: send a message in any Teams chat → should appear in portal within 1 minute.')
}

main().catch(console.error)
