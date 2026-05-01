// ─── Company-defined statuses & tags helpers ─────────────────────────
//
// Companies can extend the built-in conversation lifecycle with their own
// labels:
//   * company_statuses → drives the "secondary status" dropdown
//   * company_tags     → drives autocomplete + colors for the existing
//                        free-form `conversations.tags text[]` column
//
// All helpers use the service-role client so they can be called from
// server components and route handlers without RLS in the way; callers
// are responsible for having authenticated the user first.

import type { SupabaseClient } from '@supabase/supabase-js'

import { createServiceRoleClient } from '@/lib/supabase-server'

// ── Types ───────────────────────────────────────────────────────────
export interface CompanyStatus {
  id: string
  company_id: string
  name: string
  color: string
  description: string | null
  sort_order: number
  is_active: boolean
  created_at: string
}

export interface CompanyTag {
  id: string
  company_id: string
  name: string
  color: string
  description: string | null
  created_by: string | null
  created_at: string
}

// Hex (#RGB / #RRGGBB) or a small allowlist of named CSS colors. Restrictive
// on purpose — the picker emits #RRGGBB; named colors are accepted so
// admins can paste e.g. "tomato" if they want to.
const NAMED_COLORS = new Set([
  'black', 'white', 'gray', 'grey', 'silver',
  'red', 'maroon', 'tomato', 'crimson',
  'orange', 'gold', 'yellow', 'amber',
  'green', 'lime', 'olive', 'teal',
  'blue', 'navy', 'royalblue', 'skyblue', 'cyan',
  'purple', 'magenta', 'violet', 'indigo', 'pink',
  'brown', 'tan',
])

/**
 * Returns true when `value` is a #RGB / #RRGGBB hex code or one of the
 * allowed named CSS colors (case-insensitive). Used to validate POST/PATCH
 * bodies before they reach the database.
 */
export function isValidColor(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const s = value.trim().toLowerCase()
  if (!s) return false
  if (/^#[0-9a-f]{3}$/.test(s)) return true
  if (/^#[0-9a-f]{6}$/.test(s)) return true
  return NAMED_COLORS.has(s)
}

type ServiceRoleClient = Awaited<ReturnType<typeof createServiceRoleClient>>

// ── Read helpers ────────────────────────────────────────────────────

/**
 * Returns the company's active custom statuses, ordered by sort_order then name.
 * Inactive rows are excluded — soft-deletes are handled via `is_active=false`.
 */
export async function getCompanyStatuses(
  client: SupabaseClient | ServiceRoleClient,
  companyId: string,
): Promise<CompanyStatus[]> {
  if (!companyId) return []
  const { data, error } = await client
    .from('company_statuses')
    .select('id, company_id, name, color, description, sort_order, is_active, created_at')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw new Error(`Failed to fetch company statuses: ${error.message}`)
  return (data ?? []) as CompanyStatus[]
}

/**
 * Returns the company's tag catalog, ordered by name.
 */
export async function getCompanyTags(
  client: SupabaseClient | ServiceRoleClient,
  companyId: string,
): Promise<CompanyTag[]> {
  if (!companyId) return []
  const { data, error } = await client
    .from('company_tags')
    .select('id, company_id, name, color, description, created_by, created_at')
    .eq('company_id', companyId)
    .order('name', { ascending: true })
  if (error) throw new Error(`Failed to fetch company tags: ${error.message}`)
  return (data ?? []) as CompanyTag[]
}

// ── Validation ──────────────────────────────────────────────────────

/**
 * Throws if `secondaryStatus` is non-empty and not in the company's catalog.
 * Used by conversation-update endpoints to keep `conversations.secondary_status`
 * free of orphan values. Pass `null` or empty string to clear — no validation.
 */
export async function validateSecondaryStatus(
  client: SupabaseClient | ServiceRoleClient,
  companyId: string,
  secondaryStatus: string | null | undefined,
): Promise<void> {
  if (secondaryStatus == null) return
  const trimmed = secondaryStatus.trim()
  if (trimmed.length === 0) return
  if (!companyId) {
    throw new Error('Cannot set secondary_status without a company scope')
  }
  const { data, error } = await client
    .from('company_statuses')
    .select('id')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .ilike('name', trimmed)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to validate secondary_status: ${error.message}`)
  if (!data) {
    throw new Error(
      `Secondary status "${trimmed}" is not in this company's catalog`,
    )
  }
}

// ── Constants for callers ───────────────────────────────────────────

/** Default chip color when a company hasn't set one explicitly. */
export const DEFAULT_TAXONOMY_COLOR = '#6b7280'
