import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHANNEL_KEYS } from '@/lib/channels/registry'

/**
 * The channel-visibility/write-isolation RLS depends on the SQL function
 * `user_allowed_channels()`, which hardcodes the channel list as a literal
 * `unnest(ARRAY[...])` rather than deriving it from the registry. When this
 * drifts from CHANNEL_KEYS, a newly-added channel becomes invisible to every
 * non-super-admin through the RLS client (it already happened once — 'livechat'
 * was omitted and had to be patched). This test fails loudly on drift so a new
 * channel ships with the matching migration. (Live DDL still goes through the
 * Supabase MCP; this just guards the source migrations.)
 */
describe('channel RLS resolver stays in sync with the channel registry', () => {
  it('user_allowed_channels() SQL ARRAY matches CHANNEL_KEYS', () => {
    const migrationsDir = join(process.cwd(), 'supabase', 'migrations')
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort() // timestamp-prefixed → lexical sort = chronological

    // Use the LATEST migration that (re)defines the function with an ARRAY literal.
    let latestSql: string | null = null
    for (const f of files) {
      const sql = readFileSync(join(migrationsDir, f), 'utf8')
      if (/function\s+public\.user_allowed_channels/i.test(sql) && /unnest\(ARRAY\[/i.test(sql)) {
        latestSql = sql
      }
    }
    expect(latestSql, 'no migration defines user_allowed_channels() with an ARRAY literal').toBeTruthy()

    const match = latestSql!.match(/unnest\(ARRAY\[([^\]]+)\]\)/i)
    expect(match, 'could not parse the user_allowed_channels() ARRAY literal').toBeTruthy()

    const sqlChannels = match![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
      .sort()

    expect(sqlChannels).toEqual([...CHANNEL_KEYS].sort())
  })
})
