import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

/**
 * GET /api/test-connection
 * Tests connectivity to Supabase and n8n.
 * Returns status of each service.
 */
export async function GET() {
  // Require authenticated user session
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results: {
    supabase: { status: string; details: string; connected: boolean }
    n8n: { status: string; details: string; connected: boolean }
    env_vars: Record<string, boolean>
  } = {
    supabase: { status: 'unchecked', details: '', connected: false },
    n8n: { status: 'unchecked', details: '', connected: false },
    env_vars: {
      NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      N8N_BASE_URL: !!process.env.N8N_BASE_URL,
      N8N_API_KEY: !!process.env.N8N_API_KEY,
      N8N_WEBHOOK_SECRET: !!process.env.N8N_WEBHOOK_SECRET,
      AI_API_KEY: !!process.env.AI_API_KEY,
    },
  }

  // ========== TEST SUPABASE ==========
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseKey) {
      results.supabase = {
        status: 'error',
        details: 'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY',
        connected: false,
      }
    } else {
      // Test by directly querying the accounts table (works with both anon and service role keys)
      const schemaResponse = await fetch(`${supabaseUrl}/rest/v1/accounts?select=id,name,channel_type&limit=5`, {
        method: 'GET',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      })

      if (schemaResponse.ok) {
        const data = await schemaResponse.json()
        // Also get total count
        const countResponse = await fetch(`${supabaseUrl}/rest/v1/accounts?select=id`, {
          method: 'HEAD',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            Prefer: 'count=exact',
          },
        })
        const totalCount = countResponse.headers.get('content-range')?.split('/')?.[1] || String(Array.isArray(data) ? data.length : 0)
        results.supabase = {
          status: 'connected',
          details: `Connected to Supabase. Accounts table exists with ${totalCount} accounts. Service role key: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'configured' : 'not set (optional for basic use)'}.`,
          connected: true,
        }
      } else if (schemaResponse.status === 404 || schemaResponse.status === 400) {
        // Try a basic health check instead
        const healthResponse = await fetch(`${supabaseUrl}/rest/v1/`, {
          method: 'GET',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
        })
        if (healthResponse.ok || healthResponse.status === 200) {
          results.supabase = {
            status: 'partial',
            details: 'Connected to Supabase but the "accounts" table does not exist yet. Run the schema.sql migration.',
            connected: true,
          }
        } else {
          results.supabase = {
            status: 'partial',
            details: 'Connected to Supabase but the "accounts" table may not exist. Run the schema.sql migration.',
            connected: true,
          }
        }
      } else {
        const errorText = await schemaResponse.text()
        results.supabase = {
          status: 'error',
          details: `Supabase connection failed (${schemaResponse.status}): ${errorText.substring(0, 200)}`,
          connected: false,
        }
      }
    }
  } catch (error) {
    results.supabase = {
      status: 'error',
      details: `Supabase connection error: ${error instanceof Error ? error.message : String(error)}`,
      connected: false,
    }
  }

  // ========== TEST N8N ==========
  try {
    const n8nUrlRaw = process.env.N8N_BASE_URL
    const n8nKey = process.env.N8N_API_KEY
    // Normalize: remove trailing slashes
    const n8nUrl = n8nUrlRaw?.replace(/\/+$/, '')

    if (!n8nUrl) {
      results.n8n = {
        status: 'error',
        details: 'Missing N8N_BASE_URL environment variable',
        connected: false,
      }
    } else if (n8nKey) {
      // Best test: try the API directly with the key
      const apiResponse = await fetch(`${n8nUrl}/api/v1/workflows?limit=5`, {
        method: 'GET',
        headers: {
          'X-N8N-API-KEY': n8nKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      }).catch(() => null)

      if (apiResponse && apiResponse.ok) {
        const data = await apiResponse.json()
        const workflowCount = data?.data?.length ?? data?.count ?? '?'
        results.n8n = {
          status: 'connected',
          details: `Connected to n8n at ${n8nUrl}. API key valid. ${workflowCount} workflows found.`,
          connected: true,
        }
      } else if (apiResponse) {
        results.n8n = {
          status: 'partial',
          details: `n8n is reachable at ${n8nUrl} but API key may be invalid (HTTP ${apiResponse.status}). Check N8N_API_KEY.`,
          connected: true,
        }
      } else {
        results.n8n = {
          status: 'error',
          details: `Cannot reach n8n at ${n8nUrl}. Make sure n8n is running and the URL is correct.`,
          connected: false,
        }
      }
    } else {
      // No API key — try health check only
      const healthResponse = await fetch(`${n8nUrl}/healthz`, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      }).catch(() => null)

      if (healthResponse && (healthResponse.ok || healthResponse.status < 500)) {
        results.n8n = {
          status: 'partial',
          details: `n8n is reachable at ${n8nUrl} but N8N_API_KEY is not set. Cannot query workflows.`,
          connected: true,
        }
      } else {
        results.n8n = {
          status: 'error',
          details: `Cannot reach n8n at ${n8nUrl} and N8N_API_KEY is not set.`,
          connected: false,
        }
      }
    }
  } catch (error) {
    results.n8n = {
      status: 'error',
      details: `n8n connection error: ${error instanceof Error ? error.message : String(error)}`,
      connected: false,
    }
  }

  const allConnected = results.supabase.connected && results.n8n.connected
  return NextResponse.json(
    {
      overall: allConnected ? 'all_connected' : 'issues_found',
      timestamp: new Date().toISOString(),
      ...results,
    },
    { status: 200 }
  )
}
