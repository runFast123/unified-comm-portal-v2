// Shared helpers for the token-authed `/api/v1/*` public API.
//
// Centralizes:
//   1. Bearer token parsing + verification (`verifyToken` from api-tokens.ts)
//   2. Scope enforcement
//   3. Standard error responses
//
// Routes import `requireToken(request, scope)` which returns either a
// NextResponse (for the unhappy path) or a TokenInfo (for the happy path).
// This keeps each route's prelude to two lines.

import { NextResponse } from 'next/server'

import {
  parseBearerHeader,
  requireScope,
  ScopeRequiredError,
  verifyToken,
  type TokenInfo,
} from '@/lib/api-tokens'

export type GateResult =
  | { ok: true; token: TokenInfo }
  | { ok: false; response: NextResponse }

/**
 * Look up the bearer token, verify it's active, and (optionally) require
 * a scope. Returns either `{ ok: true, token }` or `{ ok: false, response }`
 * with the appropriate JSON body + status code.
 */
export async function requireToken(
  request: Request,
  scope?: string,
): Promise<GateResult> {
  const headerVal = request.headers.get('authorization') ?? request.headers.get('Authorization')
  const plaintext = parseBearerHeader(headerVal)
  if (!plaintext) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Missing Authorization: Bearer header' },
        { status: 401 },
      ),
    }
  }

  const token = await verifyToken(plaintext)
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Invalid or revoked API token' },
        { status: 401 },
      ),
    }
  }

  if (scope) {
    try {
      requireScope(scope, token)
    } catch (err) {
      const scopeName = err instanceof ScopeRequiredError ? err.scope : scope
      return {
        ok: false,
        response: NextResponse.json(
          { error: `Token missing required scope: ${scopeName}` },
          { status: 403 },
        ),
      }
    }
  }

  return { ok: true, token }
}
