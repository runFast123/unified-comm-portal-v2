// ─── Workflow macro apply logic ──────────────────────────────────────
//
// A macro is a saved bundle of one-click conversation actions: set status,
// add tags, assign to a user, set priority. Macros NEVER send a message —
// in this app sending always requires explicit human approval. A macro may
// carry a `reply_template_id`; that is returned to the caller so the COMPOSER
// can insert the template text for the agent to review. The server never
// auto-sends it.
//
// This module is the unit-testable core. The route
// (`/api/conversations/[id]/apply-macro`) stays thin: it authenticates, loads
// the conversation + macro via the service-role client, enforces that the
// macro and conversation belong to the same company, then hands both to
// `applyMacro` here. All cross-tenant / validation guards that don't depend on
// the HTTP request live here so they're covered by `tests/lib/macros.test.ts`.
//
// IMPORTANT: callers pass the SERVICE-ROLE client (RLS is off). Every lookup
// below is therefore explicitly company-scoped in TypeScript — do not relax a
// guard assuming RLS will catch it.

import type { SupabaseClient } from '@supabase/supabase-js'

// Conversation lifecycle priorities (the `priority_type` enum). A macro's
// `set_priority` must be one of these.
export const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
export type Priority = (typeof VALID_PRIORITIES)[number]

// Write-time limits for macro action fields (shared by the POST/PATCH routes).
export const MAX_MACRO_TAGS = 25
export const MAX_MACRO_TAG_LEN = 48

/**
 * The JSON contract stored in `macros.actions`. Every field is optional; a
 * macro applies only the actions that are present. Mirrors the column comment
 * in `20260601140000_macros.sql`.
 */
export interface MacroActions {
  /** A `company_statuses.name` for the macro's company (secondary status). */
  set_status?: string
  /** Tag strings to merge into `conversations.tags` (deduped, order-preserving). */
  add_tags?: string[]
  /** A `users.id` in the SAME company, or null to unassign. */
  assign_to?: string | null
  /** One of VALID_PRIORITIES. */
  set_priority?: string
  /** Composer INSERTs this template's text for review. NEVER auto-sent. */
  reply_template_id?: string
}

/** Minimal macro shape `applyMacro` needs. */
export interface MacroRecord {
  id: string
  company_id: string
  name: string
  is_active?: boolean | null
  actions: MacroActions | null
}

/** Minimal conversation shape `applyMacro` needs. */
export interface ConversationRecord {
  id: string
  account_id: string
  status?: string | null
  secondary_status?: string | null
  priority?: string | null
  tags?: string[] | null
  assigned_to?: string | null
}

/** Outcome of applying a macro — what changed + the post-update conversation. */
export interface ApplyMacroResult {
  /** Human-readable list of the actions that were actually applied. */
  applied: string[]
  /** The patch written to `conversations` (empty if nothing changed). */
  update: Record<string, unknown>
  /**
   * If the macro referenced a reply template that the composer should INSERT.
   * The text is NEVER sent server-side — this is purely a UI hint relayed to
   * the client so `onInsertTemplate(id)` can run.
   */
  insertTemplateId: string | null
}

/** Thrown by `applyMacro` when an action fails validation (caller → 422). */
export class MacroValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MacroValidationError'
  }
}

type AnyClient = SupabaseClient | { from: (table: string) => any }

/**
 * Normalize whatever is in `macros.actions` (jsonb — could be null, a string,
 * or already-parsed object) into a typed MacroActions. Unknown keys are
 * dropped; malformed values for known keys are ignored so a bad row can't
 * crash the apply path.
 */
export function normalizeMacroActions(raw: unknown): MacroActions {
  let obj: Record<string, unknown> | null = null
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>
      }
    } catch {
      /* leave obj null */
    }
  }
  if (!obj) return {}

  const out: MacroActions = {}

  if (typeof obj.set_status === 'string' && obj.set_status.trim()) {
    out.set_status = obj.set_status.trim()
  }
  if (Array.isArray(obj.add_tags)) {
    const tags = obj.add_tags
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    if (tags.length > 0) out.add_tags = tags
  }
  if ('assign_to' in obj) {
    if (obj.assign_to === null) out.assign_to = null
    else if (typeof obj.assign_to === 'string' && obj.assign_to.trim()) {
      out.assign_to = obj.assign_to.trim()
    }
  }
  if (typeof obj.set_priority === 'string' && obj.set_priority.trim()) {
    out.set_priority = obj.set_priority.trim()
  }
  if (typeof obj.reply_template_id === 'string' && obj.reply_template_id.trim()) {
    out.reply_template_id = obj.reply_template_id.trim()
  }

  return out
}

/**
 * Validate + normalize an incoming `actions` object for WRITE (POST/PATCH).
 * Returns the cleaned object on success or an error string on failure. Stricter
 * than `normalizeMacroActions` (which is lenient for the apply path): here a
 * malformed value is a 400, not silently dropped. Shared by both macro routes
 * so the contract is enforced in exactly one place.
 */
export function validateActions(
  raw: unknown,
): { ok: true; value: MacroActions } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'actions must be an object' }
  }
  const obj = raw as Record<string, unknown>
  const out: MacroActions = {}

  if (obj.set_status !== undefined && obj.set_status !== null) {
    if (typeof obj.set_status !== 'string' || !obj.set_status.trim()) {
      return { ok: false, error: 'actions.set_status must be a non-empty string' }
    }
    out.set_status = obj.set_status.trim()
  }

  if (obj.add_tags !== undefined && obj.add_tags !== null) {
    if (!Array.isArray(obj.add_tags)) {
      return { ok: false, error: 'actions.add_tags must be an array of strings' }
    }
    const tags: string[] = []
    for (const t of obj.add_tags) {
      if (typeof t !== 'string') {
        return { ok: false, error: 'actions.add_tags must contain only strings' }
      }
      const trimmed = t.trim()
      if (!trimmed) continue
      if (trimmed.length > MAX_MACRO_TAG_LEN) {
        return { ok: false, error: `each tag must be <= ${MAX_MACRO_TAG_LEN} chars` }
      }
      tags.push(trimmed)
    }
    if (tags.length > MAX_MACRO_TAGS) {
      return { ok: false, error: `actions.add_tags supports at most ${MAX_MACRO_TAGS} tags` }
    }
    if (tags.length > 0) out.add_tags = tags
  }

  if ('assign_to' in obj && obj.assign_to !== undefined) {
    if (obj.assign_to === null) {
      out.assign_to = null
    } else if (typeof obj.assign_to === 'string' && obj.assign_to.trim()) {
      out.assign_to = obj.assign_to.trim()
    } else {
      return { ok: false, error: 'actions.assign_to must be a user id string or null' }
    }
  }

  if (obj.set_priority !== undefined && obj.set_priority !== null) {
    if (
      typeof obj.set_priority !== 'string' ||
      !(VALID_PRIORITIES as readonly string[]).includes(obj.set_priority)
    ) {
      return {
        ok: false,
        error: `actions.set_priority must be one of: ${VALID_PRIORITIES.join(', ')}`,
      }
    }
    out.set_priority = obj.set_priority
  }

  if (obj.reply_template_id !== undefined && obj.reply_template_id !== null) {
    if (typeof obj.reply_template_id !== 'string' || !obj.reply_template_id.trim()) {
      return { ok: false, error: 'actions.reply_template_id must be a uuid string' }
    }
    out.reply_template_id = obj.reply_template_id.trim()
  }

  return { ok: true, value: out }
}

/**
 * Merge new tags into an existing tag array, case-insensitively de-duplicated
 * while preserving the existing order then appending genuinely-new tags.
 */
export function mergeTags(existing: string[] | null | undefined, toAdd: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const t of existing ?? []) {
    if (typeof t !== 'string') continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(t)
  }
  for (const t of toAdd) {
    const trimmed = t.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

/**
 * Resolve a conversation's owning company via its account. Returns null when
 * the account row is missing or has no company_id.
 */
export async function resolveConversationCompanyId(
  client: AnyClient,
  accountId: string,
): Promise<string | null> {
  const { data } = await client
    .from('accounts')
    .select('company_id')
    .eq('id', accountId)
    .maybeSingle()
  return (data as { company_id: string | null } | null)?.company_id ?? null
}

/**
 * Apply `macro` to `conversation`, writing the resulting patch to the
 * `conversations` row. Validates every action server-side:
 *
 *   - set_status   → must exist (active) in `company_statuses` for `companyId`.
 *                    Written to `conversations.secondary_status` (the
 *                    company-defined status column; the built-in lifecycle
 *                    `status` enum is left untouched).
 *   - add_tags     → merged into `conversations.tags` (deduped).
 *   - assign_to    → must be a user in the SAME company (or null = unassign).
 *   - set_priority → must be one of VALID_PRIORITIES.
 *
 * NEVER sends a message. If the macro carries `reply_template_id` it is
 * returned via `insertTemplateId` for the composer to insert — nothing is
 * sent here.
 *
 * @param client     service-role Supabase client (RLS off — guards are here).
 * @param macro      the macro to apply (already confirmed same-company by caller).
 * @param conversation the target conversation.
 * @param companyId  the conversation's resolved company id (from accounts).
 *
 * @throws MacroValidationError on any invalid action (caller maps to 422).
 */
export async function applyMacro(
  client: AnyClient,
  macro: MacroRecord,
  conversation: ConversationRecord,
  companyId: string,
): Promise<ApplyMacroResult> {
  const actions = normalizeMacroActions(macro.actions)
  const update: Record<string, unknown> = {}
  const applied: string[] = []

  // ── set_priority ──────────────────────────────────────────────────
  if (actions.set_priority !== undefined) {
    if (!(VALID_PRIORITIES as readonly string[]).includes(actions.set_priority)) {
      throw new MacroValidationError(
        `Invalid priority "${actions.set_priority}". Must be one of: ${VALID_PRIORITIES.join(', ')}`,
      )
    }
    if (actions.set_priority !== conversation.priority) {
      update.priority = actions.set_priority
      applied.push(`priority → ${actions.set_priority}`)
    }
  }

  // ── set_status (company-defined secondary status) ─────────────────
  // Validate the name exists (active) in this company's company_statuses
  // catalog, mirroring validateSecondaryStatus. Written to secondary_status
  // so we never have to touch the built-in lifecycle enum.
  if (actions.set_status !== undefined) {
    if (!companyId) {
      throw new MacroValidationError('Cannot set status without a company scope')
    }
    const { data: statusRow, error } = await client
      .from('company_statuses')
      .select('id, name')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .ilike('name', actions.set_status)
      .limit(1)
      .maybeSingle()
    if (error) {
      throw new MacroValidationError(`Failed to validate status: ${error.message}`)
    }
    if (!statusRow) {
      throw new MacroValidationError(
        `Status "${actions.set_status}" is not in this company's status catalog`,
      )
    }
    if (actions.set_status !== conversation.secondary_status) {
      update.secondary_status = actions.set_status
      applied.push(`status → ${actions.set_status}`)
    }
  }

  // ── assign_to ─────────────────────────────────────────────────────
  if (actions.assign_to !== undefined) {
    if (actions.assign_to === null) {
      if (conversation.assigned_to !== null && conversation.assigned_to !== undefined) {
        update.assigned_to = null
        applied.push('unassigned')
      }
    } else {
      // Validate the assignee belongs to the SAME company as the conversation.
      const { data: assignee, error } = await client
        .from('users')
        .select('id, company_id, full_name, email')
        .eq('id', actions.assign_to)
        .maybeSingle()
      if (error) {
        throw new MacroValidationError(`Failed to validate assignee: ${error.message}`)
      }
      if (!assignee) {
        throw new MacroValidationError('Assignee user not found')
      }
      const assigneeCompanyId = (assignee as { company_id: string | null }).company_id
      if (assigneeCompanyId == null || companyId == null) {
        throw new MacroValidationError('Cannot assign: missing company linkage')
      }
      if (assigneeCompanyId !== companyId) {
        throw new MacroValidationError(
          'Assignee must belong to the same company as the conversation',
        )
      }
      if (actions.assign_to !== conversation.assigned_to) {
        update.assigned_to = actions.assign_to
        const name =
          (assignee as { full_name: string | null }).full_name ||
          (assignee as { email: string | null }).email ||
          actions.assign_to
        applied.push(`assigned → ${name}`)
      }
    }
  }

  // ── add_tags ──────────────────────────────────────────────────────
  if (actions.add_tags !== undefined && actions.add_tags.length > 0) {
    const merged = mergeTags(conversation.tags, actions.add_tags)
    const before = conversation.tags ?? []
    if (merged.length !== before.length) {
      update.tags = merged
      const added = merged.filter(
        (t) => !before.some((e) => e.toLowerCase() === t.toLowerCase()),
      )
      if (added.length > 0) applied.push(`tags +${added.join(', +')}`)
    }
  }

  // ── reply_template_id (composer-only hint; never sent) ────────────
  const insertTemplateId =
    actions.reply_template_id !== undefined ? actions.reply_template_id : null
  if (insertTemplateId) {
    applied.push('reply template ready to insert')
  }

  // Persist the patch (if any). The caller writes the audit row.
  if (Object.keys(update).length > 0) {
    const { error } = await client
      .from('conversations')
      .update(update)
      .eq('id', conversation.id)
    if (error) {
      throw new MacroValidationError(`Failed to apply macro: ${error.message}`)
    }
  }

  return { applied, update, insertTemplateId }
}
