// Unit tests for `src/lib/macro-form.ts` — the form ↔ MacroActions mapping
// used by the admin Macros management page. Pure functions, no DB / mocks.
//
// The interesting edge is `assign_to`'s three-valued nature: '' (no change)
// vs the UNASSIGN_VALUE sentinel (→ null / unassign) vs a real user id.

import { describe, it, expect } from 'vitest'

import {
  UNASSIGN_VALUE,
  emptyMacroForm,
  buildMacroActions,
  actionsToForm,
  summarizeMacroActions,
  type MacroFormState,
} from '@/lib/macro-form'

describe('buildMacroActions', () => {
  it('omits every field for a blank form', () => {
    expect(buildMacroActions(emptyMacroForm())).toEqual({})
  })

  it('collapses a fully-configured form into the actions payload', () => {
    const form: MacroFormState = {
      name: 'Escalate',
      description: 'desc',
      is_active: true,
      set_status: 'awaiting_legal',
      set_priority: 'high',
      assign_to: 'user-9',
      add_tags: ['vip', 'urgent'],
      reply_template_id: 'tmpl-1',
    }
    expect(buildMacroActions(form)).toEqual({
      set_status: 'awaiting_legal',
      set_priority: 'high',
      assign_to: 'user-9',
      add_tags: ['vip', 'urgent'],
      reply_template_id: 'tmpl-1',
    })
  })

  it('maps the unassign sentinel to assign_to: null', () => {
    const form = { ...emptyMacroForm(), assign_to: UNASSIGN_VALUE }
    const actions = buildMacroActions(form)
    expect(actions).toEqual({ assign_to: null })
    expect('assign_to' in actions).toBe(true)
  })

  it('omits assign_to entirely when "no change" is selected', () => {
    const actions = buildMacroActions({ ...emptyMacroForm(), assign_to: '' })
    expect('assign_to' in actions).toBe(false)
  })

  it('drops an invalid priority rather than emitting it', () => {
    const actions = buildMacroActions({ ...emptyMacroForm(), set_priority: 'wat' })
    expect(actions.set_priority).toBeUndefined()
  })

  it('trims tags, drops empties, and omits the key when none remain', () => {
    expect(buildMacroActions({ ...emptyMacroForm(), add_tags: ['  vip ', '', '  '] }))
      .toEqual({ add_tags: ['vip'] })
    expect('add_tags' in buildMacroActions({ ...emptyMacroForm(), add_tags: ['   '] }))
      .toBe(false)
  })

  it('omits a whitespace-only status', () => {
    expect('set_status' in buildMacroActions({ ...emptyMacroForm(), set_status: '   ' }))
      .toBe(false)
  })
})

describe('actionsToForm', () => {
  it('round-trips actions → form → actions (including unassign)', () => {
    const original = {
      set_status: 'awaiting_legal',
      set_priority: 'high',
      assign_to: null,
      add_tags: ['vip'],
      reply_template_id: 'tmpl-1',
    }
    const form = actionsToForm(original, 'Name', 'Desc', true)
    expect(form.assign_to).toBe(UNASSIGN_VALUE)
    expect(form.is_active).toBe(true)
    expect(buildMacroActions(form)).toEqual(original)
  })

  it('hydrates a real assignee id back into the select value', () => {
    const form = actionsToForm({ assign_to: 'user-7' }, 'N', null, false)
    expect(form.assign_to).toBe('user-7')
    expect(form.description).toBe('')
    expect(form.is_active).toBe(false)
  })

  it('leaves assign_to empty when the macro has no assignment action', () => {
    const form = actionsToForm({ set_priority: 'low' }, 'N', null, true)
    expect(form.assign_to).toBe('')
  })
})

describe('summarizeMacroActions', () => {
  it('returns "no actions" for empty / null', () => {
    expect(summarizeMacroActions(null)).toBe('no actions')
    expect(summarizeMacroActions({})).toBe('no actions')
  })

  it('formats status, priority, and tag count', () => {
    const s = summarizeMacroActions({
      set_status: 'awaiting_legal',
      set_priority: 'high',
      add_tags: ['vip', 'urgent'],
    })
    expect(s).toContain('status → awaiting_legal')
    expect(s).toContain('priority → high')
    expect(s).toContain('+2 tags: vip, urgent')
  })

  it('uses singular "tag" for a single tag', () => {
    expect(summarizeMacroActions({ add_tags: ['vip'] })).toContain('+1 tag: vip')
  })

  it('renders unassign and resolves assignee / template names via labels', () => {
    expect(summarizeMacroActions({ assign_to: null })).toContain('unassign')

    const labelled = summarizeMacroActions(
      { assign_to: 'user-9', reply_template_id: 'tmpl-1' },
      {
        assigneeName: (id) => (id === 'user-9' ? 'Aman' : undefined),
        templateName: (id) => (id === 'tmpl-1' ? 'Welcome' : undefined),
      },
    )
    expect(labelled).toContain('assign → Aman')
    expect(labelled).toContain('insert template')
    expect(labelled).toContain('Welcome')
  })

  it('falls back gracefully when names are unknown', () => {
    const s = summarizeMacroActions({ assign_to: 'ghost', reply_template_id: 'gone' })
    expect(s).toContain('assign → agent')
    expect(s).toContain('insert reply template')
  })
})
