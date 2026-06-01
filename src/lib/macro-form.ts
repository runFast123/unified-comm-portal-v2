// ─── Macro form ↔ actions mapping ────────────────────────────────────
//
// Pure, UI-free helpers shared by the admin Macros management page
// (`src/app/(dashboard)/admin/macros/page.tsx`). Kept out of the
// 'use client' page so they can be unit-tested in isolation
// (`tests/lib/macro-form.test.ts`) and so the form ↔ payload contract
// lives in exactly one place.
//
// The on-the-wire contract is `MacroActions` from `@/lib/macros` (the same
// shape the POST/PATCH routes validate via `validateActions`):
//   { set_status?, add_tags?, assign_to?, set_priority?, reply_template_id? }
//
// Every action is optional and a macro applies only the ones present. The
// tricky field is `assign_to`, which is THREE-valued:
//   • absent          → leave the conversation's assignment unchanged
//   • null            → unassign
//   • a user id (uuid)→ assign to that user
// A plain <select> can't carry "absent vs null vs value" on its own, so the
// form models the choice as a string with the `UNASSIGN_VALUE` sentinel for
// the null case and '' for "no change".

import { VALID_PRIORITIES, type MacroActions } from '@/lib/macros'

/**
 * Sentinel `assign_to` select value meaning "set the assignee to null
 * (unassign)" — deliberately distinct from '' which means "leave the
 * conversation's assignment unchanged". Not a valid uuid so it can never
 * collide with a real user id.
 */
export const UNASSIGN_VALUE = '__unassign__'

/** Flat, controlled-input-friendly view of a macro for the edit form. The
 *  name / description / is_active fields are top-level `macros` columns; the
 *  rest map into the `actions` JSON via `buildMacroActions`. */
export interface MacroFormState {
  name: string
  description: string
  /** Disabled macros are stored but hidden from the <MacroRunner> dropdown. */
  is_active: boolean
  /** A `company_statuses.name`, or '' for no status action. */
  set_status: string
  /** One of VALID_PRIORITIES, or '' for no priority action. */
  set_priority: string
  /** '' = no change · UNASSIGN_VALUE = unassign · else a user id. */
  assign_to: string
  /** Selected `company_tags.name` strings to merge onto the conversation. */
  add_tags: string[]
  /** A `reply_templates.id`, or '' for none. */
  reply_template_id: string
}

/** A blank form for the "New macro" flow (active by default). */
export function emptyMacroForm(): MacroFormState {
  return {
    name: '',
    description: '',
    is_active: true,
    set_status: '',
    set_priority: '',
    assign_to: '',
    add_tags: [],
    reply_template_id: '',
  }
}

/**
 * Collapse the flat form state into the `MacroActions` JSON the API stores.
 * Mirrors `validateActions` semantics: empty / unchanged fields are OMITTED
 * (never sent as empty strings) so the saved `actions` object only carries
 * the steps the admin actually configured. An invalid priority is dropped
 * rather than emitted (the API would 400 on it anyway).
 */
export function buildMacroActions(form: MacroFormState): MacroActions {
  const actions: MacroActions = {}

  const status = form.set_status.trim()
  if (status) actions.set_status = status

  if (
    form.set_priority &&
    (VALID_PRIORITIES as readonly string[]).includes(form.set_priority)
  ) {
    actions.set_priority = form.set_priority
  }

  const tags = form.add_tags.map((t) => t.trim()).filter((t) => t.length > 0)
  if (tags.length > 0) actions.add_tags = tags

  // Three-valued: sentinel → null (unassign), real id → assign, '' → omit.
  if (form.assign_to === UNASSIGN_VALUE) {
    actions.assign_to = null
  } else if (form.assign_to.trim()) {
    actions.assign_to = form.assign_to.trim()
  }

  const template = form.reply_template_id.trim()
  if (template) actions.reply_template_id = template

  return actions
}

/**
 * Inverse of `buildMacroActions` — hydrate the edit form from a stored macro.
 * The `assign_to: null` (unassign) case maps back to the UNASSIGN_VALUE
 * sentinel so the select shows "Unassign" rather than "No change".
 */
export function actionsToForm(
  actions: MacroActions | null | undefined,
  name: string,
  description: string | null,
  isActive: boolean,
): MacroFormState {
  const a = actions ?? {}
  let assignTo = ''
  if ('assign_to' in a) {
    assignTo = a.assign_to === null ? UNASSIGN_VALUE : a.assign_to ?? ''
  }
  return {
    name,
    description: description ?? '',
    is_active: isActive,
    set_status: a.set_status ?? '',
    set_priority: a.set_priority ?? '',
    assign_to: assignTo,
    add_tags: Array.isArray(a.add_tags) ? [...a.add_tags] : [],
    reply_template_id: a.reply_template_id ?? '',
  }
}

/** Optional name resolvers so the summary can show people/template names
 *  instead of bare uuids. Both fall back gracefully when a lookup misses
 *  (e.g. the assignee was deactivated or the template deleted). */
export interface MacroSummaryLabels {
  assigneeName?: (id: string) => string | undefined
  templateName?: (id: string) => string | undefined
}

/**
 * Build a compact, human-readable one-liner describing what a macro does —
 * used in the management list. Returns 'no actions' for an empty macro.
 */
export function summarizeMacroActions(
  actions: MacroActions | null | undefined,
  labels: MacroSummaryLabels = {},
): string {
  const a = actions ?? {}
  const parts: string[] = []

  if (a.set_status) parts.push(`status → ${a.set_status}`)
  if (a.set_priority) parts.push(`priority → ${a.set_priority}`)

  if (Array.isArray(a.add_tags) && a.add_tags.length > 0) {
    const plural = a.add_tags.length === 1 ? 'tag' : 'tags'
    parts.push(`+${a.add_tags.length} ${plural}: ${a.add_tags.join(', ')}`)
  }

  if ('assign_to' in a) {
    if (a.assign_to === null) {
      parts.push('unassign')
    } else if (a.assign_to) {
      const name = labels.assigneeName?.(a.assign_to)
      parts.push(`assign → ${name || 'agent'}`)
    }
  }

  if (a.reply_template_id) {
    const title = labels.templateName?.(a.reply_template_id)
    parts.push(title ? `insert template “${title}”` : 'insert reply template')
  }

  return parts.length > 0 ? parts.join(' • ') : 'no actions'
}
