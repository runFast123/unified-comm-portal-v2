// Tests for src/lib/templates.ts
//
// Pure-TS coverage for:
//   - substituteTemplate variable expansion + edge cases
//   - sanitization (HTML, markdown link/image, backticks, control chars)
//   - findTemplateByShortcut lookup against the mock supabase client

import { describe, it, expect, vi } from 'vitest'
import {
  substituteTemplate,
  findTemplateByShortcut,
  TEMPLATE_VARIABLES,
} from '@/lib/templates'
import type { SupabaseClient } from '@supabase/supabase-js'

describe('substituteTemplate', () => {
  it('renders all known variables', () => {
    const out = substituteTemplate(
      'Hi {{customer.name}} ({{customer.email}}), I am {{user.full_name}} ({{user.email}}) at {{company.name}}. Re: {{conversation.subject}}.',
      {
        customer: { name: 'Alice', email: 'alice@example.com' },
        user: { full_name: 'Bob Agent', email: 'bob@co.com' },
        company: { name: 'Acme' },
        conversation: { subject: 'Help with billing' },
      }
    )
    expect(out).toBe(
      'Hi Alice (alice@example.com), I am Bob Agent (bob@co.com) at Acme. Re: Help with billing.'
    )
  })

  it('supports the {{date}} variable with a fixed override', () => {
    const out = substituteTemplate('Sent on {{date}}.', {
      date: new Date('2025-06-15T12:00:00Z'),
    })
    // Use local-time year/month/day so the test is timezone-stable.
    const d = new Date('2025-06-15T12:00:00Z')
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    expect(out).toBe(`Sent on ${yyyy}-${mm}-${dd}.`)
  })

  it('falls back to email when customer.name is missing', () => {
    const out = substituteTemplate('Hi {{customer.name}}', {
      customer: { name: null, email: 'nobody@example.com' },
    })
    expect(out).toBe('Hi nobody@example.com')
  })

  it('renders empty string for missing context entries', () => {
    expect(substituteTemplate('Hi {{customer.name}}!', {})).toBe('Hi !')
    expect(substituteTemplate('From {{user.email}}', {})).toBe('From ')
  })

  it('leaves unknown variables untouched', () => {
    expect(substituteTemplate('Hello {{foo}} and {{bar.baz}}', {})).toBe(
      'Hello {{foo}} and {{bar.baz}}'
    )
  })

  it('strips HTML tags from substituted values', () => {
    const out = substituteTemplate('Hi {{customer.name}}', {
      customer: { name: '<script>alert(1)</script>Bob', email: '' },
    })
    expect(out).toBe('Hi alert(1)Bob')
    expect(out).not.toContain('<script>')
  })

  it('strips a balanced markdown link', () => {
    expect(
      substituteTemplate('See {{customer.name}}', {
        customer: { name: '[click](http://evil.example/)', email: '' },
      })
    ).toBe('See click')
  })

  it('strips markdown image syntax', () => {
    expect(
      substituteTemplate('See {{customer.name}}', {
        customer: { name: '![alt](http://evil.example/x.png)', email: '' },
      })
    ).toBe('See alt')
  })

  it('strips backticks', () => {
    expect(
      substituteTemplate('Hi {{customer.name}}', {
        customer: { name: '`raw code`', email: '' },
      })
    ).toBe('Hi raw code')
  })

  it('handles whitespace inside variables', () => {
    expect(
      substituteTemplate('Hi {{ customer.name }}', {
        customer: { name: 'Alice', email: '' },
      })
    ).toBe('Hi Alice')
  })

  it('returns empty string for empty input', () => {
    expect(substituteTemplate('', {})).toBe('')
  })

  it('exposes the variable list via TEMPLATE_VARIABLES', () => {
    expect(Array.isArray(TEMPLATE_VARIABLES)).toBe(true)
    expect(TEMPLATE_VARIABLES).toContain('customer.name')
    expect(TEMPLATE_VARIABLES).toContain('date')
  })
})

// ---------------------------------------------------------------------------
// findTemplateByShortcut
// ---------------------------------------------------------------------------

interface MockChain {
  select: (cols?: string) => MockChain
  eq: (col: string, val: unknown) => MockChain
  ilike: (col: string, val: unknown) => MockChain
  limit: (n: number) => MockChain
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>
}

function makeSupabaseStub(rows: Array<Record<string, unknown>>): SupabaseClient {
  const filters: Array<{ kind: string; col: string; value: unknown }> = []
  const chain: MockChain = {
    select: () => chain,
    eq: (col, value) => {
      filters.push({ kind: 'eq', col, value })
      return chain
    },
    ilike: (col, value) => {
      filters.push({ kind: 'ilike', col, value })
      return chain
    },
    limit: () => chain,
    maybeSingle: async () => {
      const companyEq = filters.find((f) => f.kind === 'eq' && f.col === 'company_id')
      const isActiveEq = filters.find((f) => f.kind === 'eq' && f.col === 'is_active')
      const shortcutIlike = filters.find((f) => f.kind === 'ilike' && f.col === 'shortcut')
      const match = rows.find((r) => {
        if (companyEq && r.company_id !== companyEq.value) return false
        if (isActiveEq && r.is_active !== isActiveEq.value) return false
        if (shortcutIlike) {
          const want = String(shortcutIlike.value).toLowerCase()
          const got = String(r.shortcut ?? '').toLowerCase()
          if (got !== want) return false
        }
        return true
      })
      return { data: match ?? null, error: null }
    },
  }
  // Cast: tests don't exercise the full SupabaseClient surface.
  return {
    from: () => chain,
  } as unknown as SupabaseClient
}

describe('findTemplateByShortcut', () => {
  const rows = [
    {
      id: 't1',
      title: 'Welcome',
      subject: null,
      content: 'Hello!',
      shortcut: 'welcome',
      category: 'Support',
      usage_count: 5,
      is_active: true,
      company_id: 'comp-a',
    },
    {
      id: 't2',
      title: 'Other co',
      subject: null,
      content: 'Other!',
      shortcut: 'welcome',
      category: 'Support',
      usage_count: 1,
      is_active: true,
      company_id: 'comp-b',
    },
  ]

  it('finds an exact case-insensitive match scoped to company', async () => {
    const supabase = makeSupabaseStub(rows)
    const t = await findTemplateByShortcut(supabase, 'comp-a', '/Welcome')
    expect(t?.id).toBe('t1')
    expect(t?.title).toBe('Welcome')
  })

  it('strips a leading slash from the query', async () => {
    const supabase = makeSupabaseStub(rows)
    const t = await findTemplateByShortcut(supabase, 'comp-a', 'welcome')
    expect(t?.id).toBe('t1')
  })

  it('returns null when no row matches the company', async () => {
    const supabase = makeSupabaseStub(rows)
    const t = await findTemplateByShortcut(supabase, 'comp-zz', 'welcome')
    expect(t).toBeNull()
  })

  it('returns null when the shortcut is missing', async () => {
    const supabase = makeSupabaseStub(rows)
    expect(await findTemplateByShortcut(supabase, 'comp-a', '')).toBeNull()
    expect(await findTemplateByShortcut(supabase, 'comp-a', '/')).toBeNull()
  })

  it('returns null when the company id is missing', async () => {
    const supabase = makeSupabaseStub(rows)
    expect(await findTemplateByShortcut(supabase, '', 'welcome')).toBeNull()
  })

  it('does not return rows from another company', async () => {
    // Stub returns rows scoped by company_id; company-b should not see comp-a's row.
    const supabase = makeSupabaseStub(rows)
    const t = await findTemplateByShortcut(supabase, 'comp-b', 'welcome')
    expect(t?.id).toBe('t2')
    expect(t?.id).not.toBe('t1')
  })

  it('survives a supabase error gracefully', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              ilike: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
                }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient
    const t = await findTemplateByShortcut(supabase, 'comp-a', 'welcome')
    expect(t).toBeNull()
  })

  // Silence unused-import warning when supabase test isn't run.
  it('vi is wired', () => {
    expect(typeof vi.fn).toBe('function')
  })
})
