// Guards the agent tools' SQL column references against the real schema.
//
// WHY THIS EXISTS
// The copilot's tools were written with assumed column names and shipped three
// wrong ones — `conversations.subject` (doesn't exist; a subject lives on
// `messages.email_subject`), `messages.body_text` (it's `message_text`) and
// `messages.created_at` (it's `timestamp`). Every tool call failed at runtime
// with "column conversations.subject does not exist", which the unit tests could
// never catch because they mock the database.
//
// So this is a SOURCE-level check, in the spirit of channel-rls-sync.test.ts:
// pull the literal `.select(...)` column lists out of src/lib/ai/tools.ts and
// assert each column exists in that table's CREATE TABLE in src/lib/schema.sql.
// It fails loudly the moment someone references a column that isn't real.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const toolsSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'ai', 'tools.ts'), 'utf8')
const schemaSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'schema.sql'), 'utf8')

/** schema.sql + every migration — a column may be added by a later ALTER. */
const migrationsDir = join(process.cwd(), 'supabase', 'migrations')
const allSql =
  schemaSrc +
  '\n' +
  readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
    .join('\n')

/**
 * Columns that exist in the LIVE database but appear in no repo SQL, because
 * the migration that created them was applied via the Supabase MCP and never
 * written to a file. This is a known, repo-wide drift (the whole
 * `tier5_seven_features` migration is file-less — it also created routing_rules,
 * contacts, saved_views and ai_usage). Verified present live before allowlisting;
 * without this the guard would false-fail on real columns.
 */
const KNOWN_LIVE_ONLY = new Set(['conversations.contact_id'])

/** Column names declared in a table's CREATE TABLE block in schema.sql. */
function columnsOf(table: string): Set<string> {
  const re = new RegExp(`CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+(?:public\\.)?${table}\\s*\\(`, 'i')
  const start = schemaSrc.search(re)
  if (start === -1) return new Set()
  // Walk from the opening paren to its matching close, tracking depth so nested
  // parens (types, defaults, constraints) don't end the block early.
  const open = schemaSrc.indexOf('(', start)
  let depth = 0
  let end = open
  for (let i = open; i < schemaSrc.length; i++) {
    if (schemaSrc[i] === '(') depth++
    else if (schemaSrc[i] === ')') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = schemaSrc.slice(open + 1, end)
  const cols = new Set<string>()
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('--')) continue
    // Skip table-level constraint clauses — they aren't columns.
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE)\b/i.test(line)) continue
    const m = line.match(/^([a-z_][a-z0-9_]*)/i)
    if (m) cols.add(m[1].toLowerCase())
  }

  // Union in anything a later migration ALTERed onto the table, e.g.
  // `ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS ai_summary text`.
  const alterRe = new RegExp(
    `ALTER TABLE\\s+(?:public\\.)?${table}\\b([\\s\\S]*?);`,
    'gi'
  )
  let a: RegExpExecArray | null
  while ((a = alterRe.exec(allSql)) !== null) {
    const addRe = /ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi
    let c: RegExpExecArray | null
    while ((c = addRe.exec(a[1])) !== null) cols.add(c[1].toLowerCase())
  }
  return cols
}

/** Literal `.from('table')` … `.select('a, b')` pairs found in tools.ts. */
function literalSelects(): { table: string; columns: string[] }[] {
  const out: { table: string; columns: string[] }[] = []
  const re = /\.from\(\s*'([a-z_]+)'\s*\)[\s\S]{0,200}?\.select\(\s*'([^']*)'\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(toolsSrc)) !== null) {
    const table = m[1]
    const columns = m[2]
      // Drop PostgREST embedded resources like `accounts!inner(company_id)` —
      // those name a JOINED table, not a column of `table`.
      .replace(/[a-z_]+!\w+\([^)]*\)/gi, '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
    if (columns.length) out.push({ table, columns })
  }
  return out
}

describe('agent tool column references match the real schema', () => {
  const selects = literalSelects()

  it('finds the tool selects to check (guards the parser itself)', () => {
    // If this drops to 0 the regex silently stopped matching and every
    // assertion below would vacuously pass.
    expect(selects.length).toBeGreaterThanOrEqual(3)
    expect(selects.map((s) => s.table)).toContain('conversations')
    expect(selects.map((s) => s.table)).toContain('messages')
  })

  it('every selected column exists in schema.sql', () => {
    const problems: string[] = []
    for (const { table, columns } of selects) {
      const known = columnsOf(table)
      // Only check tables schema.sql actually defines; others are out of scope.
      if (known.size === 0) continue
      for (const col of columns) {
        const qualified = `${table}.${col}`
        if (KNOWN_LIVE_ONLY.has(qualified)) continue
        if (!known.has(col.toLowerCase())) problems.push(qualified)
      }
    }
    expect(
      problems,
      `Agent tools reference column(s) that do not exist:\n  ${problems.join('\n  ')}\n\n` +
        `These fail only at RUNTIME (the unit tests mock the DB), so every agent ` +
        `tool call breaks in production. Check the real column names.`
    ).toEqual([])
  })

  it('does not reference the three columns that previously broke every tool call', () => {
    // Regression pins for the exact names that shipped broken.
    expect(toolsSrc).not.toMatch(/\.select\('[^']*\bsubject\b[^']*'\)[\s\S]{0,80}?from\('conversations'/)
    expect(toolsSrc).not.toContain('body_text')
    // `created_at` is legitimate on conversations; it's messages that uses
    // `timestamp`. Assert the messages select specifically.
    const messagesSelect = selects.find((s) => s.table === 'messages')
    expect(messagesSelect).toBeTruthy()
    expect(messagesSelect!.columns).not.toContain('created_at')
    expect(messagesSelect!.columns).toContain('message_text')
    expect(messagesSelect!.columns).toContain('timestamp')
  })
})
