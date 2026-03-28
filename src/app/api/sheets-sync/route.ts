import { NextResponse } from 'next/server'
import { createServiceRoleClient, createServerSupabaseClient } from '@/lib/supabase-server'
import type { GoogleSheetsSync, SyncStatus } from '@/types/database'

/**
 * GET handler: returns current sync status for all sheets.
 */
export async function GET() {
  try {
    // Require authenticated user session
    const authSupabase = await createServerSupabaseClient()
    const { data: { user } } = await authSupabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = await createServiceRoleClient()

    const { data, error } = await supabase
      .from('google_sheets_sync')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Failed to fetch sheet sync statuses:', error)
      return NextResponse.json(
        { error: 'Failed to fetch sync statuses' },
        { status: 500 }
      )
    }

    return NextResponse.json({ sheets: data }, { status: 200 })
  } catch (error) {
    console.error('Sheets sync GET error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST handler: syncs Google Sheets data.
 * Body: { sheet_sync_id? } - if provided, syncs that sheet only; otherwise syncs all active sheets.
 */
export async function POST(request: Request) {
  try {
    // Allow internal calls via webhook secret, or authenticated users
    const webhookSecret = request.headers.get('x-webhook-secret')
    const expectedSecret = process.env.N8N_WEBHOOK_SECRET
    const isInternalCall = webhookSecret === expectedSecret

    if (!isInternalCall) {
      // Check for authenticated user session
      const authSupabase = await createServerSupabaseClient()
      const { data: { user } } = await authSupabase.auth.getUser()
      if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    }

    const body = await request.json().catch(() => ({}))
    const { sheet_sync_id } = body as { sheet_sync_id?: string }

    const supabase = await createServiceRoleClient()

    // Fetch sheet configs to sync
    let query = supabase
      .from('google_sheets_sync')
      .select('*')

    if (sheet_sync_id) {
      query = query.eq('id', sheet_sync_id)
    } else {
      query = query.eq('sync_status', 'active')
    }

    const { data: sheets, error: fetchError } = await query

    if (fetchError || !sheets) {
      console.error('Failed to fetch sheet configs:', fetchError)
      return NextResponse.json(
        { error: 'Failed to fetch sheet configurations' },
        { status: 500 }
      )
    }

    if (sheets.length === 0) {
      return NextResponse.json(
        { message: 'No sheets to sync', synced: [] },
        { status: 200 }
      )
    }

    const syncResults: Array<{
      sheet_id: string
      sheet_name: string
      status: SyncStatus
      rows_synced: number
      error?: string
    }> = []

    for (const sheet of sheets as GoogleSheetsSync[]) {
      try {
        // Update status to syncing
        await supabase
          .from('google_sheets_sync')
          .update({ sync_status: 'syncing' as SyncStatus })
          .eq('id', sheet.id)

        // Support multiple tabs — comma-separated sheet names (e.g., "Sheet1, Sheet2")
        const tabNames = sheet.sheet_name
          .split(',')
          .map((t: string) => t.trim())
          .filter(Boolean)

        const columnMapping = sheet.column_mapping || {}
        const now = new Date().toISOString()
        const allBatchRecords: Array<Record<string, unknown>> = []
        let globalRowIdx = 0

        for (const tabName of tabNames) {
          try {
            const rows = await fetchGoogleSheetData(sheet.sheet_id, tabName)
            if (rows.length < 2) continue // Skip empty tabs (header only)

            const headers = rows[0] || []

            for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
              const row = rows[rowIdx]
              const mappedData: Record<string, unknown> = {}

              for (let i = 0; i < headers.length; i++) {
                const headerName = String(headers[i])
                const mappedName = columnMapping[headerName] || headerName
                mappedData[mappedName] = row[i] || null
              }

              // Add tab name to data for reference
              mappedData['_sheet_tab'] = tabName
              globalRowIdx++

              const externalId =
                (mappedData['external_id'] as string) ||
                (mappedData['id'] as string) ||
                `${sheet.sheet_id}_${tabName}_row_${rowIdx}`

              allBatchRecords.push({
                source_sheet_id: sheet.id,
                account_id: sheet.account_id || null,
                external_id: externalId,
                entity_name: (mappedData['entity_name'] as string) || (mappedData['name'] as string) || null,
                category: (mappedData['category'] as string) || tabName,
                data_json: mappedData,
                imported_at: now,
              })
            }
          } catch (tabError) {
            console.error(`Failed to fetch tab "${tabName}" for sheet ${sheet.sheet_id}:`, tabError)
            // Continue with other tabs
          }
        }

        // Batch upsert in chunks of 100 for performance
        let rowsSynced = 0
        const CHUNK_SIZE = 100
        for (let i = 0; i < allBatchRecords.length; i += CHUNK_SIZE) {
          const chunk = allBatchRecords.slice(i, i + CHUNK_SIZE)
          const { error: upsertError } = await supabase
            .from('imported_records')
            .upsert(chunk, { onConflict: 'source_sheet_id,external_id' })

          if (upsertError) {
            console.error(`Batch upsert error for sheet ${sheet.sheet_name} (chunk ${i}):`, upsertError)
          } else {
            rowsSynced += chunk.length
          }
        }

        // Update sync metadata
        await supabase
          .from('google_sheets_sync')
          .update({
            last_sync_at: new Date().toISOString(),
            row_count: rowsSynced,
            sync_status: 'active' as SyncStatus,
          })
          .eq('id', sheet.id)

        syncResults.push({
          sheet_id: sheet.sheet_id,
          sheet_name: sheet.sheet_name,
          status: 'active',
          rows_synced: rowsSynced,
        })
      } catch (sheetError) {
        console.error(`Failed to sync sheet ${sheet.sheet_name}:`, sheetError)

        // Mark sheet as errored
        await supabase
          .from('google_sheets_sync')
          .update({ sync_status: 'error' as SyncStatus })
          .eq('id', sheet.id)

        syncResults.push({
          sheet_id: sheet.sheet_id,
          sheet_name: sheet.sheet_name,
          status: 'error',
          rows_synced: 0,
          error: sheetError instanceof Error ? sheetError.message : 'Unknown error',
        })
      }
    }

    return NextResponse.json(
      {
        message: 'Sync complete',
        synced: syncResults,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error('Sheets sync POST error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * Fetches data from a public Google Sheet using the CSV export URL.
 * No API key needed — sheet must be set to "Anyone with the link can view".
 */
async function fetchGoogleSheetData(
  spreadsheetId: string,
  sheetName: string
): Promise<string[][]> {
  // Validate spreadsheet ID format to prevent SSRF
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(spreadsheetId)) {
    throw new Error('Invalid spreadsheet ID format')
  }

  // Use public CSV export URL (no auth needed for public sheets)
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`

  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })

  if (!response.ok) {
    const errorBody = await response.text()
    if (response.status === 404) {
      throw new Error(
        `Sheet not found. Make sure the sheet is set to "Anyone with the link can view" and the sheet name "${sheetName}" is correct.`
      )
    }
    throw new Error(
      `Failed to fetch Google Sheet (${response.status}): ${errorBody.substring(0, 200)}`
    )
  }

  const csvText = await response.text()
  return parseCSV(csvText)
}

/**
 * Simple CSV parser that handles quoted fields with commas and newlines.
 */
function parseCSV(csv: string): string[][] {
  const rows: string[][] = []
  let currentRow: string[] = []
  let currentField = ''
  let inQuotes = false

  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]
    const nextChar = csv[i + 1]

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"'
        i++ // skip escaped quote
      } else if (char === '"') {
        inQuotes = false
      } else {
        currentField += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        currentRow.push(currentField.trim())
        currentField = ''
      } else if (char === '\n' || (char === '\r' && nextChar === '\n')) {
        currentRow.push(currentField.trim())
        if (currentRow.some(f => f !== '')) {
          rows.push(currentRow)
        }
        currentRow = []
        currentField = ''
        if (char === '\r') i++ // skip \n in \r\n
      } else {
        currentField += char
      }
    }
  }

  // Push last row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim())
    if (currentRow.some(f => f !== '')) {
      rows.push(currentRow)
    }
  }

  return rows
}
