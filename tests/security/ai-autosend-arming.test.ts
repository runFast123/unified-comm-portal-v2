import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * `accounts.ai_trust_mode` is the sole gate on delivering an AI-generated reply
 * straight to a customer with no human ever seeing it (src/app/api/ai-reply/route.ts
 * — auto-send also requires phase2_enabled, an internal webhook call, and a
 * confidence score at or above the account's threshold).
 *
 * The AI Settings admin page used to arm it as a SIDE EFFECT of saving. It held a
 * numeric `trustThreshold`, labelled "consecutive approved replies required before
 * auto-send is enabled" and defaulted to 5, then on save coerced it via
 * `enableTrustMode = trustThreshold > 0` and bulk-wrote the result to
 * `ai_trust_mode` on every email/Teams/WhatsApp account in the company. Nothing
 * anywhere counted approvals — the ramp that label promised did not exist. So
 * editing a prompt and pressing Save silently armed autonomous customer-facing
 * sending company-wide, and silently re-armed it over the deliberate per-account
 * toggle in Admin → Accounts. It never actually fired only because phase2_enabled
 * happened to be off on every account.
 *
 * Arming auto-send must stay an explicit, per-account act. These tests fail if a
 * bulk writer reappears on a settings surface.
 */

/** The object-literal shape of a supabase `.update()` / `.insert()` payload. */
const WRITE_SHAPE = /ai_trust_mode\s*:/

/**
 * Files allowed to contain that shape:
 *   - admin/accounts/page.tsx — THE explicit per-account toggle (intended writer)
 *   - types/database.ts       — the column's type declaration
 *
 * Reading the column (`account.ai_trust_mode`) is unrestricted and expected; only
 * the write shape is gated.
 */
const ALLOWED_WRITERS = new Set([
  join('src', 'app', '(dashboard)', 'admin', 'accounts', 'page.tsx'),
  join('src', 'types', 'database.ts'),
])

/** Strip block + line comments so prose about the bug can't trip the matchers. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function readSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), 'utf8')
}

describe('auto-send (ai_trust_mode) can only be armed explicitly, per account', () => {
  it('is written from no surface other than the per-account toggle', () => {
    const srcRoot = join(process.cwd(), 'src')
    const writers = walk(srcRoot)
      .filter((file) => WRITE_SHAPE.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(process.cwd(), file))
      .sort()

    const unexpected = writers.filter((file) => !ALLOWED_WRITERS.has(file))

    expect(
      unexpected,
      `Unexpected writer(s) of ai_trust_mode.\n\n` +
        `That column auto-sends AI replies to real customers with no human review. ` +
        `It must only ever be set by the deliberate per-account toggle, never in bulk ` +
        `and never as a side effect of saving unrelated settings.\n\n` +
        `If this file is a legitimate new per-account control, add it to ALLOWED_WRITERS. ` +
        `If it bulk-writes across accounts, it is the bug this test exists to catch.`
    ).toEqual([])
  })

  it('the AI Settings page never writes ai_trust_mode', () => {
    const src = stripComments(
      readSource('src', 'app', '(dashboard)', 'admin', 'ai-settings', 'ai-settings-client.tsx')
    )
    expect(src).not.toMatch(WRITE_SHAPE)
  })

  it('the AI Settings page does not persist the phantom trust_threshold / fallback_behavior columns', () => {
    const src = stripComments(
      readSource('src', 'app', '(dashboard)', 'admin', 'ai-settings', 'ai-settings-client.tsx')
    )
    // No server code has ever read either column. Persisting them re-creates a
    // control surface that looks meaningful but changes nothing.
    expect(src).not.toMatch(/trust_threshold\s*:/)
    expect(src).not.toMatch(/fallback_behavior\s*:/)
  })

  it('ai-reply still gates auto-send on ai_trust_mode AND the confidence threshold', () => {
    // Guards the other direction: the checks above are only meaningful while
    // this remains the gate they are protecting.
    const src = readSource('src', 'app', 'api', 'ai-reply', 'route.ts')
    expect(src).toMatch(/account\.ai_trust_mode/)
    expect(src).toMatch(/account\.ai_confidence_threshold/)
  })
})
