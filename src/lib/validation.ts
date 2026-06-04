import { NextResponse } from 'next/server'
import { z } from 'zod'

/**
 * Parse + validate a JSON request body against a zod schema. Returns a
 * discriminated result so route handlers stay terse:
 *
 *   const parsed = await parseJsonBody(request, MySchema)
 *   if (!parsed.ok) return parsed.response
 *   const { field } = parsed.data   // fully typed
 *
 * Outcomes:
 *   - Malformed JSON            → 400 { error: 'Invalid JSON body' }
 *   - Schema validation failure → 400 { error: '<path>: <message>' } (first issue only)
 *
 * Surfacing only the first issue keeps the response small and avoids echoing the
 * full expected shape back to untrusted callers.
 */
export async function parseJsonBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
    }
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path?.length ? issue.path.join('.') + ': ' : ''
    const message = issue ? `${path}${issue.message}` : 'Invalid request body'
    return {
      ok: false,
      response: NextResponse.json({ error: message }, { status: 400 }),
    }
  }
  return { ok: true, data: result.data as z.infer<T> }
}
