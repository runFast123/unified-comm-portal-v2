export type LogLevel = 'info' | 'warn' | 'error' | 'debug'
export type LogCategory = 'webhook' | 'ai' | 'auth' | 'system' | 'n8n' | 'notification' | 'export'

interface LogEntry {
  level: LogLevel
  category: LogCategory
  action: string
  message: string
  metadata?: Record<string, unknown>
  user_id?: string | null
  account_id?: string | null
}

/**
 * Structured logger that writes to the audit_log table via direct REST API.
 * Uses service role key to bypass RLS. Non-blocking — errors never affect the caller.
 */
export async function log(entry: LogEntry): Promise<void> {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceKey) return

    await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        action: `[${entry.level.toUpperCase()}] ${entry.category}:${entry.action}`,
        details: JSON.stringify({
          message: entry.message,
          level: entry.level,
          category: entry.category,
          ...entry.metadata,
        }),
        user_id: entry.user_id || null,
        account_id: entry.account_id || null,
        created_at: new Date().toISOString(),
      }),
    })
  } catch {
    // Never let logging errors affect the main flow
  }
}

// Convenience helpers
export const logInfo = (category: LogCategory, action: string, message: string, metadata?: Record<string, unknown>) =>
  log({ level: 'info', category, action, message, metadata })

export const logWarn = (category: LogCategory, action: string, message: string, metadata?: Record<string, unknown>) =>
  log({ level: 'warn', category, action, message, metadata })

export const logError = (category: LogCategory, action: string, message: string, metadata?: Record<string, unknown>) =>
  log({ level: 'error', category, action, message, metadata })
