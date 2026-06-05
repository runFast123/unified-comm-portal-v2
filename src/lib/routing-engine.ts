// --- Routing Rules Engine ---
// Evaluates inbound messages against the admin-defined routing_rules table
// and returns a RoutingResult that webhook handlers apply to the
// conversation row (priority, status, tags, assignment).
//
// Conditions DSL shape (stored as jsonb on routing_rules.conditions):
//   [
//     { "field": "channel",       "op": "equals",        "value": "email" },
//     { "field": "subject",       "op": "contains",      "value": "refund" },
//     { "field": "sender_email",  "op": "ends_with",     "value": "@vip.com" },
//     { "field": "category",      "op": "in",            "value": ["Billing Question", "Payment Issue"] },
//     { "field": "body",          "op": "matches_regex", "value": "outage|down|broken" }
//   ]
//
// Match modes:
//   "all" (default): every condition must pass for the rule to match.
//   "any":           at least one condition must pass.
//
// Composition: rules are evaluated in priority ASC order (lower number =
// higher precedence). Tags are accumulated across ALL matching rules
// (set-union). priority/status/assignment are taken from the FIRST matching
// rule that sets them, so admins can layer rules safely.

import { createServiceRoleClient } from '@/lib/supabase-server'
import { pickNextAgent } from '@/lib/agent-assignment'
import type { RoutingRule, RoutingCondition, ChannelType } from '@/types/database'

export type { RoutingRule } from '@/types/database'

export interface RoutingContext {
  channel: ChannelType
  account_id: string
  sender_email: string | null
  sender_phone: string | null
  subject: string | null
  message_text: string
  // Optional — passed in if classification ran first
  sentiment?: 'positive' | 'neutral' | 'negative' | null
  category?: string | null
}

export interface RoutingResult {
  matched_rule_ids: string[]
  set_priority?: string
  set_status?: string
  add_tags?: string[]
  assigned_user_id?: string | null
}

// ─── Field extraction ───────────────────────────────────────────────
function getFieldValue(
  ctx: RoutingContext,
  field: string
): string | null | undefined {
  switch (field) {
    case 'channel':
      return ctx.channel
    case 'account_id':
      return ctx.account_id
    case 'sender_email':
      return ctx.sender_email
    case 'sender_phone':
      return ctx.sender_phone
    case 'subject':
      return ctx.subject
    case 'body':
    case 'message_text':
      return ctx.message_text
    case 'sentiment':
      return ctx.sentiment ?? null
    case 'category':
      return ctx.category ?? null
    default:
      return undefined
  }
}

// ─── Operators ──────────────────────────────────────────────────────
function evalCondition(ctx: RoutingContext, cond: RoutingCondition): boolean {
  const raw = getFieldValue(ctx, cond.field)
  // null/undefined field never matches (except `in` against [null], which is
  // weird and we don't need to support).
  if (raw === undefined || raw === null) return false

  // Lowercase string comparison for everything except `in` (which compares
  // against an array of allowed values element-wise, also lowercased).
  const left = String(raw).toLowerCase()

  switch (cond.op) {
    case 'equals':
      return left === String(cond.value ?? '').toLowerCase()

    case 'contains':
      return left.includes(String(cond.value ?? '').toLowerCase())

    case 'starts_with':
      return left.startsWith(String(cond.value ?? '').toLowerCase())

    case 'ends_with':
      return left.endsWith(String(cond.value ?? '').toLowerCase())

    case 'in': {
      if (!Array.isArray(cond.value)) return false
      return cond.value.some((v) => String(v ?? '').toLowerCase() === left)
    }

    case 'matches_regex': {
      // Bad regex from admin input must NOT crash inbound ingestion.
      try {
        const re = new RegExp(String(cond.value ?? ''), 'i')
        return re.test(String(raw))
      } catch {
        return false
      }
    }

    default:
      return false
  }
}

function evalRule(ctx: RoutingContext, rule: RoutingRule): boolean {
  const conds = Array.isArray(rule.conditions) ? rule.conditions : []
  if (conds.length === 0) {
    // Rule with no conditions = matches everything. Useful as a catch-all.
    return true
  }
  if (rule.match_mode === 'any') {
    return conds.some((c) => evalCondition(ctx, c))
  }
  // Default = 'all'
  return conds.every((c) => evalCondition(ctx, c))
}

// ─── Public entry point ─────────────────────────────────────────────
export async function evaluateRouting(ctx: RoutingContext): Promise<RoutingResult> {
  const result: RoutingResult = { matched_rule_ids: [] }

  let rules: RoutingRule[] = []
  try {
    const supabase = await createServiceRoleClient()
    const { data, error } = await supabase
      .from('routing_rules')
      .select('*')
      .eq('is_active', true)
      .or(`account_id.is.null,account_id.eq.${ctx.account_id}`)
      .order('priority', { ascending: true })
    if (error) {
      // Fail-open: routing is an enrichment, not a gate. Don't block ingest.
      console.error('[routing-engine] failed to fetch rules:', error.message)
      return result
    }
    rules = (data || []) as RoutingRule[]
  } catch (err) {
    console.error('[routing-engine] unexpected fetch error:', err instanceof Error ? err.message : err)
    return result
  }

  if (rules.length === 0) return result

  // Track whether the FIRST-matching rule has already set each field.
  const accTags = new Set<string>()
  let assignmentRule: RoutingRule | null = null

  for (const rule of rules) {
    if (!evalRule(ctx, rule)) continue

    result.matched_rule_ids.push(rule.id)

    // First-rule-wins for priority.
    if (!result.set_priority && rule.set_priority) {
      result.set_priority = rule.set_priority
    }

    // First-rule-wins for status.
    if (!result.set_status && rule.set_status) {
      result.set_status = rule.set_status
    }

    // Tags: union across all matching rules.
    if (Array.isArray(rule.add_tags)) {
      for (const t of rule.add_tags) {
        if (typeof t === 'string' && t.trim().length > 0) {
          accTags.add(t.trim())
        }
      }
    }

    // First-rule-wins for assignment.
    if (
      !assignmentRule &&
      (rule.assign_to_user || rule.assign_to_team || rule.use_round_robin)
    ) {
      assignmentRule = rule
    }
  }

  if (accTags.size > 0) result.add_tags = Array.from(accTags)

  // Resolve assignment from the winning rule.
  if (assignmentRule) {
    if (assignmentRule.assign_to_user) {
      result.assigned_user_id = assignmentRule.assign_to_user
    } else if (assignmentRule.use_round_robin) {
      // Round-robin: prefer team scope when the rule names a team, else fall
      // back to account scope.
      try {
        const picked = await pickNextAgent(
          assignmentRule.assign_to_team
            ? { team: assignmentRule.assign_to_team }
            : { account_id: ctx.account_id }
        )
        if (picked) result.assigned_user_id = picked
      } catch (err) {
        console.error('[routing-engine] round-robin pick failed:', err instanceof Error ? err.message : err)
      }
    }
  }

  return result
}

// ─── Applier ───────────────────────────────────────────────────────
// Given a RoutingResult, patch the `conversations` row. Only writes the
// fields the matched rules actually set — never clobbers existing values
// with nulls. Tags are unioned with whatever is already on the row.
//
// Returns the fields that were actually written, useful for logging.
export async function applyRoutingResult(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  conversationId: string,
  result: RoutingResult
): Promise<Record<string, unknown>> {
  if (result.matched_rule_ids.length === 0) return {}

  const patch: Record<string, unknown> = {}
  if (result.set_priority) patch.priority = result.set_priority
  if (result.set_status) patch.status = result.set_status
  if (result.assigned_user_id) patch.assigned_to = result.assigned_user_id

  // Tag union requires reading current tags first.
  if (result.add_tags && result.add_tags.length > 0) {
    const { data: convRow } = await supabase
      .from('conversations')
      .select('tags')
      .eq('id', conversationId)
      .maybeSingle()
    const existing: string[] = Array.isArray(convRow?.tags) ? (convRow.tags as string[]) : []
    const union = Array.from(new Set([...existing, ...result.add_tags]))
    patch.tags = union
  }

  if (Object.keys(patch).length === 0) return {}

  const { error } = await supabase
    .from('conversations')
    .update(patch)
    .eq('id', conversationId)

  if (error) {
    console.error('[routing-engine] applyRoutingResult update failed:', error.message)
    return {}
  }

  return patch
}
