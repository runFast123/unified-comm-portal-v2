/**
 * /api/webhooks/email — external HTTP entry point for inbound email.
 *
 * The IMAP poller used to call this over HTTP from inside the same Vercel
 * deployment, which broke whenever Vercel Deployment Protection was on
 * (the protection layer intercepts internal requests with an HTML auth
 * wall). The poller now invokes `ingestInboundEmail()` directly in-process,
 * so this route is now reserved for genuine external callers (e.g. a
 * third-party webhook forwarder).
 *
 * Behavior is preserved exactly — same auth, same dedup, same status codes,
 * same response shapes. The only difference is that the message-handling
 * logic now lives in `src/lib/email-ingest.ts`.
 */
import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { logError } from '@/lib/logger'
import { validateWebhookSecret } from '@/lib/api-helpers'
import { ingestInboundEmail, type InboundEmailPayload } from '@/lib/email-ingest'
import { getRequestId } from '@/lib/request-id'

export async function POST(request: Request) {
  const requestId = await getRequestId()
  try {
    // External callers must present the shared webhook secret. In-process
    // callers bypass this check by calling ingestInboundEmail() directly.
    if (!validateWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized', request_id: requestId }, { status: 401 })
    }

    const body = (await request.json()) as InboundEmailPayload
    const supabase = await createServiceRoleClient()
    const origin = new URL(request.url).origin

    const result = await ingestInboundEmail(supabase, body, { origin, request_id: requestId })

    if (result.ok) {
      if (result.status === 'created') {
        return NextResponse.json(
          { message_id: result.message_id, is_spam: result.is_spam, request_id: requestId },
          { status: 201 }
        )
      }
      // duplicate
      return NextResponse.json(
        { message: 'Duplicate - already processed', message_id: result.message_id, request_id: requestId },
        { status: 200 }
      )
    }

    // Error path — http_code on the result drives the response status
    return NextResponse.json(
      { error: result.error, request_id: requestId },
      { status: result.http_code }
    )
  } catch (error) {
    logError('webhook', 'email_error', error instanceof Error ? error.message : 'Unknown error', {
      request_id: requestId,
    })
    return NextResponse.json(
      { error: 'Internal server error', request_id: requestId },
      { status: 500 }
    )
  }
}
