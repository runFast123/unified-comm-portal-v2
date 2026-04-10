import { createServiceRoleClient } from '@/lib/supabase-server'

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
 * Structured logger that writes to the audit_log table in Supabase.
 * Uses service role client to bypass RLS.
 * Non-blocking — errors in logging never affect the caller.
 */
export async function log(entry: LogEntry): Promise<void> {
  try {
    const supabase = await createServiceRoleClient()
    await supabase.from('audit_log').insert({
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
    })
  } catch {
    // Never let logging errors affect the main flow
    console.error(`[Logger] Failed to write log: ${entry.category}:${entry.action} - ${entry.message}`)
  }
}

// Convenience helpers
export const logInfo = (category: LogCategory, action: string, message: string, metadata?: Record<string, unknown>) =>
  log({ level: 'info', category, action, message, metadata })

export const logWarn = (category: LogCategory, action: string, message: string, metadata?: Record<string, unknown>) =>
  log({ level: 'warn', category, action, message, metadata })

export const logError = (category: LogCategory, action: string, message: string, metadata?: Record<string, unknown>) =>
  log({ level: 'error', category, action, message, metadata })
