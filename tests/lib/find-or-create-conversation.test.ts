import { findOrCreateConversation } from '@/lib/api-helpers'

// ─── Supabase mock ──────────────────────────────────────────────────
//
// `findOrCreateConversation` builds three kinds of chains:
//   (A) lookup:   from().select().eq().eq().in().eq?().limit().maybeSingle()
//   (B) update:   from().update().eq()
//   (C) insert:   from().insert().select().single()
//   (D) re-lookup (race): from().select().eq().eq().eq().limit().maybeSingle()
//
// The factory returns a mock that routes `.update()` to a resolved promise,
// `.insert()` to either success or a configurable error, and every `.select()`
// chain to a terminal `.maybeSingle()` / `.single()` that resolves with the
// pre-configured lookup result (first call) or raceWinner (second call).

type Lookup = { data: { id: string; status?: string } | null; error?: { message: string } | null }

interface MockOpts {
  /** First lookup via the main query. */
  existingConvo?: { id: string; status?: string } | null
  /** Result of the post-unique-violation race re-lookup (if any). */
  raceWinner?: { id: string } | null
  /** Inject a lookup error on the first select chain. */
  lookupError?: { message: string } | null
  /** If set, the insert call rejects/returns this error. */
  insertError?: { code?: string; message: string } | null
  /** If insert succeeds, what id to return. */
  insertedId?: string
}

interface MockRecorder {
  // Inserts/updates targeting the `conversations` table only. The
  // contact-link side-effect (inserts/updates against the `contacts` table)
  // is intentionally excluded so existing assertions stay focused on
  // conversation behaviour.
  inserts: unknown[]
  updates: unknown[]
  /** Every insert keyed by table — useful when a test wants to assert the
   *  contact-link side-effect explicitly. */
  insertsByTable: Record<string, unknown[]>
}

function mockSupabase(opts: MockOpts = {}) {
  const recorder: MockRecorder = { inserts: [], updates: [], insertsByTable: {} }

  // Terminal resolvers — thenables that mimic Supabase's PostgrestBuilder.
  function makeSelectChain(terminalValue: Lookup) {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      // `.order()` + `.ilike()` are part of the postgrest builder the real
      // helper now uses on the email lookup paths (newest-first legacy fallback
      // + subject-match). They just return the chain in this stub.
      order: () => chain,
      ilike: () => chain,
      limit: () => chain,
      maybeSingle: async () => terminalValue,
      single: async () => terminalValue,
    }
    return chain
  }

  function makeUpdateChain() {
    const chain: any = {
      eq: () => chain,
      // Supabase awaits `.update(...).eq(...)` directly → behave as a thenable
      then: (resolve: any) => resolve({ data: null, error: null }),
    }
    return chain
  }

  function makeInsertChain() {
    // For insert path: .insert(row).select('id').single()
    const errorTerminal: Lookup = opts.insertError
      ? { data: null, error: opts.insertError as any }
      : { data: { id: opts.insertedId ?? 'new-convo-id' }, error: null }
    const chain: any = {
      select: () => chain,
      single: async () => errorTerminal,
    }
    return chain
  }

  // Track call counts so the 2nd `.select()` on conversations (the race re-lookup)
  // returns `raceWinner` instead of `existingConvo`.
  let selectCallCount = 0

  const from = (table: string) => ({
    select: (_cols?: string) => {
      // Contact-table reads always return null so findOrCreateContact takes
      // the insert path (which we then accept silently below).
      if (table === 'contacts') {
        return makeSelectChain({ data: null, error: null }).select()
      }
      selectCallCount += 1
      if (selectCallCount === 1) {
        const terminal: Lookup = opts.lookupError
          ? { data: null, error: opts.lookupError as any }
          : { data: opts.existingConvo ?? null, error: null }
        return makeSelectChain(terminal).select()
      }
      // 2nd select is the race-recovery lookup.
      const raceTerminal: Lookup = { data: opts.raceWinner ?? null, error: null }
      return makeSelectChain(raceTerminal).select()
    },
    update: (patch: unknown) => {
      // Only record updates targeting the `conversations` table — the
      // contact-link write performs an additional update against
      // `conversations` (to set contact_id) which we filter out by checking
      // the patch shape. The contact-link patch only contains `contact_id`.
      if (table === 'conversations') {
        const isContactLinkPatch =
          patch && typeof patch === 'object' && Object.keys(patch as Record<string, unknown>).length === 1 &&
          'contact_id' in (patch as Record<string, unknown>)
        if (!isContactLinkPatch) recorder.updates.push(patch)
      }
      return makeUpdateChain()
    },
    insert: (row: unknown) => {
      if (!recorder.insertsByTable[table]) recorder.insertsByTable[table] = []
      recorder.insertsByTable[table].push(row)
      if (table === 'conversations') recorder.inserts.push(row)
      return makeInsertChain()
    },
  })

  return { supabase: { from } as any, recorder }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('findOrCreateConversation', () => {
  it('returns existing id on lookup hit (active conversation, no status change)', async () => {
    const { supabase, recorder } = mockSupabase({
      existingConvo: { id: 'conv-active', status: 'active' },
    })
    const id = await findOrCreateConversation(supabase, {
      account_id: 'acc-1',
      channel: 'teams',
      teams_chat_id: 'chat-1',
    })
    expect(id).toBe('conv-active')
    expect(recorder.inserts).toHaveLength(0)
    // Update ran but should NOT have set status (only last_message_at)
    expect(recorder.updates).toHaveLength(1)
    expect((recorder.updates[0] as any).status).toBeUndefined()
  })

  it('reactivates a resolved conversation by setting status=active', async () => {
    const { supabase, recorder } = mockSupabase({
      existingConvo: { id: 'conv-resolved', status: 'resolved' },
    })
    const id = await findOrCreateConversation(supabase, {
      account_id: 'acc-1',
      channel: 'teams',
      teams_chat_id: 'chat-resolved',
    })
    expect(id).toBe('conv-resolved')
    expect(recorder.updates).toHaveLength(1)
    expect((recorder.updates[0] as any).status).toBe('active')
  })

  it('reactivates a waiting_on_customer conversation', async () => {
    const { supabase, recorder } = mockSupabase({
      existingConvo: { id: 'conv-waiting', status: 'waiting_on_customer' },
    })
    const id = await findOrCreateConversation(supabase, {
      account_id: 'acc-1',
      channel: 'email',
      participant_email: 'u@x.com',
    })
    expect(id).toBe('conv-waiting')
    expect((recorder.updates[0] as any).status).toBe('active')
  })

  it('lookup miss → insert path returns new id', async () => {
    const { supabase, recorder } = mockSupabase({
      existingConvo: null,
      insertedId: 'conv-new',
    })
    const id = await findOrCreateConversation(supabase, {
      account_id: 'acc-1',
      channel: 'email',
      participant_email: 'u@x.com',
    })
    expect(id).toBe('conv-new')
    expect(recorder.inserts).toHaveLength(1)
  })

  it('insert 23505 on Teams channel → race re-lookup returns winner id', async () => {
    const { supabase } = mockSupabase({
      existingConvo: null,
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
      raceWinner: { id: 'conv-race-winner' },
    })
    const id = await findOrCreateConversation(supabase, {
      account_id: 'acc-1',
      channel: 'teams',
      teams_chat_id: 'chat-race',
    })
    expect(id).toBe('conv-race-winner')
  })

  it('insert 23505 on email WITH an email_thread_id → race re-lookup returns winner id', async () => {
    // After the threading migration, email has a unique partial index on
    // (account_id, email_thread_id). A concurrent insert that loses the race
    // is recovered by re-selecting on the thread root.
    const { supabase } = mockSupabase({
      existingConvo: null,
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint "uniq_conversations_email_thread"' },
      raceWinner: { id: 'conv-email-race-winner' },
    })
    const id = await findOrCreateConversation(supabase, {
      account_id: 'acc-1',
      channel: 'email',
      participant_email: 'x@y.com',
      email_thread_id: 'root-message-id@example.com',
    })
    expect(id).toBe('conv-email-race-winner')
  })

  it('insert 23505 on email with NO email_thread_id → throws (nothing to re-select on)', async () => {
    // With no thread root supplied there is no unique key to recover by, so a
    // 23505 surfaces as a descriptive throw rather than silently swallowing it.
    const { supabase } = mockSupabase({
      existingConvo: null,
      insertError: { code: '23505', message: 'duplicate key on some other index' },
    })
    await expect(
      findOrCreateConversation(supabase, {
        account_id: 'acc-1',
        channel: 'email',
        participant_email: 'x@y.com',
      }),
    ).rejects.toThrow(/Failed to create conversation/)
  })

  it('lookup error propagates as a descriptive throw', async () => {
    const { supabase } = mockSupabase({
      lookupError: { message: 'connection reset' },
    })
    await expect(
      findOrCreateConversation(supabase, {
        account_id: 'acc-1',
        channel: 'teams',
        teams_chat_id: 'chat-err',
      }),
    ).rejects.toThrow(/Failed to look up conversation/)
  })
})
