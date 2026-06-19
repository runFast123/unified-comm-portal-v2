// POST /api/csp-report — Content-Security-Policy violation sink.
//
// This is the `report-uri` / `report-to` target for the
// `Content-Security-Policy-Report-Only` header set in next.config.ts. The
// policy is OBSERVE-ONLY: browsers report violations here but nothing is
// blocked. We log a concise line for visibility (so we can tighten the policy
// later from real data) and return 204. No DB writes — this endpoint must stay
// cheap and must never throw (a malformed body should not produce a 500).
//
// Browsers post violations in one of two shapes depending on age:
//   1. Legacy  (Content-Type: application/csp-report)
//        { "csp-report": { "blocked-uri": …, "violated-directive": …, … } }
//   2. Reporting API (Content-Type: application/reports+json)
//        [ { "type": "csp-violation",
//            "body": { "blockedURL": …, "effectiveDirective": …, … } }, … ]
import { logInfo } from '@/lib/logger'

// Public (browsers post here with no session/credentials) and frequently hit,
// so keep it on the Edge-friendly node runtime default and never block.
export const dynamic = 'force-dynamic'

interface NormalizedViolation {
  blockedUri: string
  violatedDirective: string
  documentUri: string
}

/** Pull the three fields we care about out of either report shape. */
function normalizeLegacy(report: Record<string, unknown>): NormalizedViolation {
  return {
    blockedUri: String(report['blocked-uri'] ?? report['blockedURI'] ?? 'unknown'),
    violatedDirective: String(
      report['violated-directive'] ?? report['effective-directive'] ?? 'unknown'
    ),
    documentUri: String(report['document-uri'] ?? report['documentURL'] ?? 'unknown'),
  }
}

/** Reporting-API body (camelCase keys). */
function normalizeReportingApi(body: Record<string, unknown>): NormalizedViolation {
  return {
    blockedUri: String(body['blockedURL'] ?? body['blocked-uri'] ?? 'unknown'),
    violatedDirective: String(
      body['effectiveDirective'] ?? body['violatedDirective'] ?? body['violated-directive'] ?? 'unknown'
    ),
    documentUri: String(body['documentURL'] ?? body['document-uri'] ?? 'unknown'),
  }
}

export async function POST(request: Request): Promise<Response> {
  // Wrap EVERYTHING in try/catch — a malformed body, wrong content-type, or
  // unexpected shape must still yield a clean 204, never a 500.
  try {
    const raw = await request.text()
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      const violations: NormalizedViolation[] = []

      if (Array.isArray(parsed)) {
        // Reporting API: array of { type, body }. Keep only CSP reports.
        for (const item of parsed) {
          if (item && typeof item === 'object') {
            const rec = item as Record<string, unknown>
            const type = String(rec['type'] ?? '')
            if (type && type !== 'csp-violation') continue
            const body = rec['body']
            if (body && typeof body === 'object') {
              violations.push(normalizeReportingApi(body as Record<string, unknown>))
            }
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        const rec = parsed as Record<string, unknown>
        const legacy = rec['csp-report']
        if (legacy && typeof legacy === 'object') {
          // Legacy { "csp-report": { … } }
          violations.push(normalizeLegacy(legacy as Record<string, unknown>))
        } else {
          // Some agents post a bare report object — handle both key styles.
          violations.push(normalizeLegacy(rec))
        }
      }

      for (const v of violations) {
        logInfo('system', 'csp_violation', 'CSP report-only violation', {
          blocked_uri: v.blockedUri,
          violated_directive: v.violatedDirective,
          document_uri: v.documentUri,
        })
      }
    }
  } catch {
    // Never surface parse/log errors to the browser. Swallow and 204.
  }

  return new Response(null, { status: 204 })
}
