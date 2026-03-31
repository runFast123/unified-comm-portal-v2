import { NextResponse } from 'next/server'
import nodemailer from 'nodemailer'
import { validateWebhookSecret } from '@/lib/api-helpers'

interface NotificationPayload {
  to: string
  sender_name: string
  account_name: string
  channel: string
  subject: string | null
  message_preview: string
  conversation_id: string
  priority: string
}

export async function POST(request: Request) {
  try {
    // Validate webhook secret (same as other internal endpoints)
    if (!validateWebhookSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body: NotificationPayload = await request.json()
    const {
      to,
      sender_name,
      account_name,
      channel,
      subject,
      message_preview,
      conversation_id,
      priority,
    } = body

    if (!to || !conversation_id) {
      return NextResponse.json(
        { error: 'Missing required fields: to, conversation_id' },
        { status: 400 }
      )
    }

    const smtpUser = process.env.SMTP_USER
    const smtpPassword = process.env.SMTP_PASSWORD

    if (!smtpUser || !smtpPassword) {
      console.error('SMTP_USER or SMTP_PASSWORD not configured')
      return NextResponse.json(
        { error: 'Email service not configured' },
        { status: 500 }
      )
    }

    // Create nodemailer transporter with Gmail SMTP
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: smtpUser,
        pass: smtpPassword,
      },
    })

    const priorityLabel = (priority || 'medium').toUpperCase()
    const channelLabel = (channel || 'unknown').charAt(0).toUpperCase() + (channel || 'unknown').slice(1)
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
      || process.env.NEXTAUTH_URL
      || 'http://localhost:3000'
    const conversationUrl = `${baseUrl}/conversations/${conversation_id}`

    const emailSubject = `[${priorityLabel}] New message from ${sender_name} — ${account_name}`

    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color:#1e293b;padding:20px 24px;">
              <h1 style="margin:0;color:#ffffff;font-size:18px;font-weight:600;">
                Unified Comms Portal
              </h1>
            </td>
          </tr>
          <!-- Priority Badge -->
          <tr>
            <td style="padding:20px 24px 0;">
              <span style="display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600;text-transform:uppercase;color:#ffffff;background-color:${getPriorityColor(priority || 'medium')};">
                ${priorityLabel} Priority
              </span>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:16px 24px;">
              <h2 style="margin:0 0 16px;font-size:16px;color:#1e293b;">
                New message received
              </h2>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;width:120px;">From</td>
                  <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:14px;font-weight:500;">${escapeHtml(sender_name)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;">Account</td>
                  <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:14px;">${escapeHtml(account_name)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;">Channel</td>
                  <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:14px;">${channelLabel}</td>
                </tr>
                ${subject ? `
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;">Subject</td>
                  <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:14px;">${escapeHtml(subject)}</td>
                </tr>
                ` : ''}
              </table>
              <!-- Message Preview -->
              <div style="background-color:#f8fafc;border-left:3px solid #3b82f6;padding:12px 16px;border-radius:0 4px 4px 0;margin-bottom:20px;">
                <p style="margin:0 0 4px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Message Preview</p>
                <p style="margin:0;font-size:14px;color:#334155;line-height:1.5;">${escapeHtml(message_preview)}</p>
              </div>
              <!-- CTA Button -->
              <a href="${conversationUrl}" style="display:inline-block;background-color:#3b82f6;color:#ffffff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:14px;font-weight:500;">
                View Conversation
              </a>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                This notification was sent by Unified Communication Portal. Manage your notification settings in the portal.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim()

    await transporter.sendMail({
      from: `"Unified Comms Portal" <${smtpUser}>`,
      to,
      subject: emailSubject,
      html: htmlBody,
    })

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    console.error('Notification send error:', error)
    return NextResponse.json(
      { error: 'Failed to send notification email' },
      { status: 500 }
    )
  }
}

function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'urgent': return '#dc2626'
    case 'high': return '#ea580c'
    case 'medium': return '#2563eb'
    case 'low': return '#16a34a'
    default: return '#2563eb'
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
