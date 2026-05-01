// CSAT (customer satisfaction) helpers.
//
// Token format: `<surveyId>.<base64url(hmacSha256)>` — keeps the URL short
// and self-verifying. The signing key is `WEBHOOK_SECRET` (already required
// for the webhook ingest path), so any deployment that can receive webhooks
// can also mint and verify survey tokens. Tokens are stored on the row so
// we never re-derive them from a possibly-rotated secret on read.
//
// API surface:
//   - mintSurveyToken(surveyId)         → string
//   - verifySurveyToken(token)          → surveyId | null
//   - createSurvey(client, params)      → { id, public_url, token }
//   - recordResponse(client, ...)       → { ok, conflict?, expired? }
//   - companyCSATAggregate(client, ...) → CSATAggregate
//   - agentCSATAggregate(client, ...)   → CSATAggregate
//   - publicSurveyUrl(token)            → string  (callers use this to email)

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Token mint / verify
// ---------------------------------------------------------------------------

function getSigningKey(): string {
  const k = process.env.WEBHOOK_SECRET
  if (!k) {
    throw new Error(
      'WEBHOOK_SECRET is not configured. CSAT tokens cannot be minted/verified without it.'
    )
  }
  return k
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function hmac(surveyId: string, key: string): string {
  return base64url(crypto.createHmac('sha256', key).update(surveyId).digest())
}

/**
 * Returns a signed token of the form `<surveyId>.<sig>`.
 * The signature is HMAC-SHA256 of the surveyId, base64url-encoded.
 */
export function mintSurveyToken(surveyId: string): string {
  if (!surveyId) throw new Error('surveyId is required')
  const sig = hmac(surveyId, getSigningKey())
  return `${surveyId}.${sig}`
}

/**
 * Returns the embedded surveyId on success, or null when the token is
 * malformed / signature mismatch / signing key missing.
 *
 * Uses timingSafeEqual on the signature bytes so a constant-time check
 * is preserved even if the embedded id is wrong length.
 */
export function verifySurveyToken(token: string | null | undefined): string | null {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const surveyId = token.slice(0, dot)
  const presented = token.slice(dot + 1)

  let key: string
  try {
    key = getSigningKey()
  } catch {
    return null
  }
  const expected = hmac(surveyId, key)

  // Constant-time compare. Length mismatch ⇒ fail.
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  try {
    if (!crypto.timingSafeEqual(a, b)) return null
  } catch {
    return null
  }
  return surveyId
}

// ---------------------------------------------------------------------------
// Public URL
// ---------------------------------------------------------------------------

/**
 * Returns the absolute URL the customer follows to rate the conversation.
 * Falls back to NEXT_PUBLIC_APP_URL → APP_URL → http://localhost:3000.
 */
export function publicSurveyUrl(token: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    'http://localhost:3000'
  return `${base.replace(/\/+$/, '')}/csat/${encodeURIComponent(token)}`
}

// ---------------------------------------------------------------------------
// Survey lifecycle
// ---------------------------------------------------------------------------

export interface CreateSurveyParams {
  /** Conversation that's being rated. */
  conversationId: string
  /** Account for the conversation (denormalized so RLS reads stay cheap). */
  accountId: string
  /** Agent who handled the conversation; null if unassigned. */
  agentUserId?: string | null
  /** Customer's email; stored for filtering in the dashboard. */
  customerEmail?: string | null
}

export interface CreatedSurvey {
  id: string
  token: string
  public_url: string
}

/**
 * Inserts a fresh survey row + returns the public URL the email should
 * link to. Uses a two-step insert/update so the row's UUID can be folded
 * into the HMAC signature — this means a leaked token can never be
 * forged for a different surveyId.
 */
export async function createSurvey(
  client: SupabaseClient,
  params: CreateSurveyParams
): Promise<CreatedSurvey> {
  if (!params.conversationId || !params.accountId) {
    throw new Error('conversationId and accountId are required')
  }
  // Insert a placeholder token (never returned to the user) so the row
  // exists with the right UUID. Then mint the real token from the row's
  // id and update.
  const placeholder = `pending-${crypto.randomBytes(12).toString('hex')}`
  const { data: inserted, error: insertErr } = await client
    .from('csat_surveys')
    .insert({
      conversation_id: params.conversationId,
      account_id: params.accountId,
      agent_user_id: params.agentUserId ?? null,
      customer_email: params.customerEmail ?? null,
      token: placeholder,
    })
    .select('id')
    .single()

  if (insertErr || !inserted) {
    throw new Error(`Failed to create CSAT survey: ${insertErr?.message ?? 'unknown'}`)
  }

  const id = inserted.id as string
  const token = mintSurveyToken(id)

  const { error: updateErr } = await client
    .from('csat_surveys')
    .update({ token })
    .eq('id', id)
  if (updateErr) {
    throw new Error(`Failed to finalize CSAT token: ${updateErr.message}`)
  }

  return { id, token, public_url: publicSurveyUrl(token) }
}

export type RecordResponseResult =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 410 | 400; error: string }

/**
 * Persists a customer rating. Returns one-time semantics:
 *   - 404 when the survey id doesn't exist
 *   - 410 when expired
 *   - 409 when already responded
 *   - 400 when rating is out of range
 *   - { ok: true } on success
 *
 * Conditional UPDATE (`.is('responded_at', null)`) makes this race-safe
 * across two parallel submits — only the first one flips responded_at.
 */
export async function recordResponse(
  client: SupabaseClient,
  surveyId: string,
  rating: number,
  feedback?: string | null
): Promise<RecordResponseResult> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, status: 400, error: 'rating must be an integer 1..5' }
  }
  const { data: survey, error: lookupErr } = await client
    .from('csat_surveys')
    .select('id, responded_at, expires_at')
    .eq('id', surveyId)
    .maybeSingle()

  if (lookupErr || !survey) {
    return { ok: false, status: 404, error: 'Survey not found' }
  }
  if (survey.responded_at) {
    return { ok: false, status: 409, error: 'Already submitted' }
  }
  if (survey.expires_at && new Date(survey.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 410, error: 'Survey has expired' }
  }

  const trimmed = (feedback ?? '').toString().slice(0, 4000) || null

  const { data: updated, error: updateErr } = await client
    .from('csat_surveys')
    .update({
      rating,
      feedback: trimmed,
      responded_at: new Date().toISOString(),
    })
    .eq('id', surveyId)
    .is('responded_at', null)
    .select('id')
  if (updateErr) {
    return { ok: false, status: 400, error: updateErr.message }
  }
  if (!updated || updated.length === 0) {
    // Lost the race — somebody else flipped responded_at.
    return { ok: false, status: 409, error: 'Already submitted' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface CSATAggregate {
  avg_rating: number
  total_responded: number
  total_sent: number
  /** total_responded / total_sent (0..1). 0 when total_sent === 0. */
  response_rate: number
  /** Histogram of rating counts; keys 1..5. Always defined for each key. */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>
}

interface SurveyRow {
  rating: number | null
  responded_at: string | null
}

function emptyAggregate(): CSATAggregate {
  return {
    avg_rating: 0,
    total_responded: 0,
    total_sent: 0,
    response_rate: 0,
    distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  }
}

function rollup(rows: SurveyRow[]): CSATAggregate {
  const out = emptyAggregate()
  let ratingSum = 0
  for (const r of rows) {
    out.total_sent += 1
    if (r.responded_at && typeof r.rating === 'number') {
      out.total_responded += 1
      ratingSum += r.rating
      const k = r.rating as 1 | 2 | 3 | 4 | 5
      if (k in out.distribution) out.distribution[k] += 1
    }
  }
  out.avg_rating = out.total_responded > 0 ? ratingSum / out.total_responded : 0
  out.response_rate = out.total_sent > 0 ? out.total_responded / out.total_sent : 0
  return out
}

/**
 * Company-wide CSAT rollup. `dateFrom` filters by `sent_at >= dateFrom`.
 * Joins through `accounts` to scope by company_id (no FK from
 * csat_surveys to companies on purpose — accounts already pin it).
 */
export async function companyCSATAggregate(
  client: SupabaseClient,
  companyId: string,
  dateFrom?: Date
): Promise<CSATAggregate> {
  if (!companyId) return emptyAggregate()

  const { data: accounts } = await client
    .from('accounts')
    .select('id')
    .eq('company_id', companyId)
  const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
  if (accountIds.length === 0) return emptyAggregate()

  let q = client
    .from('csat_surveys')
    .select('rating, responded_at')
    .in('account_id', accountIds)
  if (dateFrom) q = q.gte('sent_at', dateFrom.toISOString())

  const { data, error } = await q
  if (error || !data) return emptyAggregate()
  return rollup(data as SurveyRow[])
}

/**
 * Per-agent CSAT rollup, restricted to a single agent_user_id.
 */
export async function agentCSATAggregate(
  client: SupabaseClient,
  agentUserId: string,
  dateFrom?: Date
): Promise<CSATAggregate> {
  if (!agentUserId) return emptyAggregate()

  let q = client
    .from('csat_surveys')
    .select('rating, responded_at')
    .eq('agent_user_id', agentUserId)
  if (dateFrom) q = q.gte('sent_at', dateFrom.toISOString())

  const { data, error } = await q
  if (error || !data) return emptyAggregate()
  return rollup(data as SurveyRow[])
}

// Exported for tests so the rollup math can be verified without DB.
export const __test = { rollup, emptyAggregate }
