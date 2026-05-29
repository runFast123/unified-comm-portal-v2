'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase-client'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import type { Account, Category, ChannelType } from '@/types/database'
import {
  Brain,
  Sliders,
  FileText,
  Shield,
  AlertCircle,
  DollarSign,
  Save,
  MessageSquare,
  Mail,
  Phone,
  Loader2,
  Check,
  Cpu,
  Eye,
  EyeOff,
  Zap,
  Info,
  ChevronDown,
} from 'lucide-react'

const allCategories: Category[] = [
  'Sales Inquiry',
  'Trouble Ticket',
  'Payment Issue',
  'Service Problem',
  'Technical Issue',
  'Billing Question',
  'Connection Issue',
  'Rate Issue',
  'General Inquiry',
  'Newsletter/Marketing',
]

interface AISettingsClientProps {
  /**
   * Account IDs the caller is allowed to mutate. Resolved server-side from
   * the caller's company. `null` = super_admin (no scope; allow all). An
   * empty array = caller has a company but no accounts yet (updates are
   * skipped to avoid the "no .in() filter = update everything" footgun).
   */
  companyAccountIds: string[] | null
  /**
   * Company ID used to scope every `ai_config` read/write to a single tenant
   * row. Resolved server-side from the caller's profile.
   *
   * `null` indicates the caller is a super_admin or otherwise has no
   * company_id on file — in that case we skip ai_config writes entirely
   * to avoid mutating the legacy global row by accident. Super-admins can
   * use SQL or a future tenant picker for cross-tenant edits.
   */
  companyId: string | null
}

export default function AISettingsClient({ companyAccountIds, companyId }: AISettingsClientProps) {
  const supabase = createClient()
  const [enabledCategories, setEnabledCategories] = useState<Set<Category>>(
    new Set(allCategories)
  )
  const [confidenceThreshold, setConfidenceThreshold] = useState(80)
  const [trustThreshold, setTrustThreshold] = useState(5)
  const [fallbackBehavior, setFallbackBehavior] = useState('escalate')
  // Default to false to mirror the DB column default. The active row may be
  // overridden via the toggle below; loadData will hydrate the actual value.
  const [autoResolveMarketing, setAutoResolveMarketing] = useState(false)

  const [prompts, setPrompts] = useState({
    email: `You are a professional customer support agent for a telecommunications company. Respond to this email in a formal, courteous tone. Address the customer by name. Include relevant account details and next steps. Sign off with "Best regards, Customer Support Team".`,
    teams: `You are a professional support agent. Respond in a direct, professional tone suitable for Microsoft Teams. Keep the response concise but thorough. Use bullet points for multiple action items. Do not use formal email-style greetings or sign-offs.`,
    whatsapp: `You are a friendly support agent. Keep responses short and conversational, suitable for WhatsApp. Use simple language. Break long responses into short paragraphs. Include emojis sparingly for a friendly tone. Maximum 3 sentences per response when possible.`,
  })

  const [accounts, setAccounts] = useState<Account[]>([])
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<'success' | 'error' | null>(null)
  const [loading, setLoading] = useState(true)
  // Tracks whether the user has changed anything since the last successful
  // save (or since initial load). Drives the sticky-bottom save bar so users
  // never have to scroll back to the top to commit their edits.
  const [dirty, setDirty] = useState(false)

  // AI Provider config state
  const [providerName, setProviderName] = useState('NVIDIA')
  const [baseUrl, setBaseUrl] = useState('https://integrate.api.nvidia.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('meta/llama-3.3-70b-instruct')
  const [maxTokens, setMaxTokens] = useState(4096)
  const [temperature, setTemperature] = useState(1.0)
  const [showApiKey, setShowApiKey] = useState(false)
  const [providerSaving, setProviderSaving] = useState(false)
  const [providerResult, setProviderResult] = useState<'success' | 'error' | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  // After the initial load completes, any change to watched form state flips
  // `dirty=true`. We use a ref + skip-first-after-load pattern so the
  // initial hydration from supabase doesn't itself mark the form dirty.
  const skipNextDirtyRef = useRef(true)
  useEffect(() => {
    if (loading) return
    // First run after loading completes is the post-hydration tick; skip it.
    if (skipNextDirtyRef.current) {
      skipNextDirtyRef.current = false
      return
    }
    setDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loading,
    confidenceThreshold,
    trustThreshold,
    fallbackBehavior,
    autoResolveMarketing,
    prompts.email,
    prompts.teams,
    prompts.whatsapp,
    providerName,
    baseUrl,
    apiKey,
    model,
    maxTokens,
    temperature,
    enabledCategories.size,
  ])

  // Load accounts and AI config
  useEffect(() => {
    async function loadData() {
      setLoading(true)

      // Load AI config scoped to the caller's company. Without a company_id
      // we fall back to the legacy global row (company_id IS NULL) so the
      // form still hydrates for super_admins / misconfigured users.
      let aiConfigQuery = supabase
        .from('ai_config')
        .select('*')
        .eq('is_active', true)
      if (companyId) {
        aiConfigQuery = aiConfigQuery.eq('company_id', companyId)
      } else {
        aiConfigQuery = aiConfigQuery.is('company_id', null)
      }
      const { data: aiConfig } = await aiConfigQuery
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (aiConfig) {
        setProviderName(aiConfig.provider_name || 'NVIDIA')
        setBaseUrl(aiConfig.base_url || '')
        setApiKey(aiConfig.api_key || '')
        setModel(aiConfig.model || '')
        setMaxTokens(aiConfig.max_tokens || 4096)
        setTemperature(Number(aiConfig.temperature) || 1.0)

        // Load prompts from ai_config (persisted properly)
        if (aiConfig.email_prompt) {
          setPrompts(prev => ({
            email: aiConfig.email_prompt || prev.email,
            teams: aiConfig.teams_prompt || prev.teams,
            whatsapp: aiConfig.whatsapp_prompt || prev.whatsapp,
          }))
        }
        if (aiConfig.confidence_threshold) {
          setConfidenceThreshold(Math.round(Number(aiConfig.confidence_threshold) * 100))
        }
        if (aiConfig.trust_threshold !== undefined && aiConfig.trust_threshold !== null) {
          setTrustThreshold(aiConfig.trust_threshold)
        }
        if (aiConfig.fallback_behavior) {
          setFallbackBehavior(aiConfig.fallback_behavior)
        }
        if (aiConfig.auto_resolve_marketing !== undefined && aiConfig.auto_resolve_marketing !== null) {
          setAutoResolveMarketing(aiConfig.auto_resolve_marketing)
        }
      }

      // Load accounts, scoped to the caller's company. `companyAccountIds`
      // is the same sentinel the save path uses: `null` = super_admin (no
      // scope, show every account); an empty array = a real tenant with zero
      // accounts (the `.in('id', [])` returns no rows, which is correct).
      let accountsQuery = supabase
        .from('accounts')
        .select('*')
        .order('name', { ascending: true })
      if (companyAccountIds !== null) {
        accountsQuery = accountsQuery.in('id', companyAccountIds)
      }
      const { data, error } = await accountsQuery

      if (error) {
        console.error('Failed to load accounts:', error.message)
        setLoading(false)
        return
      }

      const mapped: Account[] = (data ?? []) as Account[]

      setAccounts(mapped)

      setLoading(false)
    }
    loadData()
    // companyId / companyAccountIds are server-resolved and stable for the
    // lifetime of the page, but we list them as deps so a future tenant-picker
    // would re-fetch with the new tenant's scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, companyAccountIds])

  const handleSaveProvider = useCallback(async () => {
    setProviderSaving(true)
    setProviderResult(null)

    try {
      // Refuse to write without a company_id — would otherwise create
      // either an orphan row or mutate the legacy global fallback, both
      // of which were the source of the cross-tenant leak this scoping
      // closes.
      if (!companyId) {
        console.error('Cannot save AI provider without a company_id')
        setProviderResult('error')
        return
      }

      // Upsert: deactivate this company's old active row, then insert a
      // fresh active row. Scoping the deactivate by company_id is critical
      // — without it, saving here would deactivate every tenant's row.
      await supabase
        .from('ai_config')
        .update({ is_active: false })
        .eq('is_active', true)
        .eq('company_id', companyId)

      const { error } = await supabase.from('ai_config').insert({
        company_id: companyId,
        provider_name: providerName,
        base_url: baseUrl,
        api_key: apiKey,
        model,
        max_tokens: maxTokens,
        temperature,
        is_active: true,
        email_prompt: prompts.email,
        teams_prompt: prompts.teams,
        whatsapp_prompt: prompts.whatsapp,
        confidence_threshold: confidenceThreshold / 100,
        trust_threshold: trustThreshold,
        fallback_behavior: fallbackBehavior,
        auto_resolve_marketing: autoResolveMarketing,
      })

      if (error) {
        console.error('Failed to save AI provider:', error.message)
        setProviderResult('error')
      } else {
        setProviderResult('success')
      }
    } catch (err) {
      console.error('Provider save error:', err)
      setProviderResult('error')
    } finally {
      setProviderSaving(false)
      setTimeout(() => setProviderResult(null), 4000)
    }
  }, [companyId, providerName, baseUrl, apiKey, model, maxTokens, temperature, prompts, confidenceThreshold, trustThreshold, fallbackBehavior, autoResolveMarketing])

  const handleTestConnection = useCallback(async () => {
    setTesting(true)
    setTestResult(null)

    try {
      // Call our server-side proxy to avoid CORS issues
      const response = await fetch('/api/test-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: baseUrl,
          api_key: apiKey,
          model,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        setTestResult(`Error: ${data.error || 'Unknown error'}`)
        return
      }

      setTestResult(`✅ Connection successful: ${data.message}`)
    } catch (err) {
      setTestResult(`Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setTesting(false)
    }
  }, [baseUrl, apiKey, model])

  const toggleCategory = (cat: Category) => {
    setEnabledCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveResult(null)

    try {
      const thresholdDecimal = confidenceThreshold / 100
      const enableTrustMode = trustThreshold > 0
      const errors: string[] = []

      // 1. Save ALL settings to ai_config (provider + prompts + thresholds)
      //
      // SECURITY: scope the update by company_id to avoid mutating every
      // tenant's row. When no company_id is available (super_admin without
      // a company), skip the ai_config write entirely — they can use a
      // future tenant picker / SQL for cross-tenant edits.
      if (!companyId) {
        errors.push('ai_config: no company_id resolved for caller; ai_config write skipped')
      } else {
        const { error: configError } = await supabase
          .from('ai_config')
          .update({
            provider_name: providerName,
            base_url: baseUrl,
            api_key: apiKey,
            model,
            max_tokens: maxTokens,
            temperature,
            email_prompt: prompts.email,
            teams_prompt: prompts.teams,
            whatsapp_prompt: prompts.whatsapp,
            confidence_threshold: thresholdDecimal,
            trust_threshold: trustThreshold,
            fallback_behavior: fallbackBehavior,
            auto_resolve_marketing: autoResolveMarketing,
          })
          .eq('is_active', true)
          .eq('company_id', companyId)

        if (configError) {
          errors.push(`ai_config: ${configError.message}`)
        }
      }

      // 2. Sync prompts to accounts table for API routes to read.
      //
      // SECURITY: scope every account update to the caller's company by
      // chaining `.in('id', companyAccountIds)`. `companyAccountIds === null`
      // is the super_admin sentinel (no scope; allow all). An empty array
      // means the caller has a company but zero accounts — skip the writes
      // entirely so we don't run an unscoped `.update()` (which would
      // otherwise mutate every tenant's accounts).
      const skipAccountWrites = companyAccountIds !== null && companyAccountIds.length === 0

      if (!skipAccountWrites) {
        // All email accounts get the email prompt
        let emailQ = supabase
          .from('accounts')
          .update({
            ai_confidence_threshold: thresholdDecimal,
            ai_trust_mode: enableTrustMode,
            ai_system_prompt: prompts.email,
          })
          .eq('channel_type', 'email')
        if (companyAccountIds !== null) emailQ = emailQ.in('id', companyAccountIds)
        const { error: emailErr } = await emailQ
        if (emailErr) errors.push(`email accounts: ${emailErr.message}`)

        // Teams accounts get teams prompt
        let teamsQ = supabase
          .from('accounts')
          .update({
            ai_confidence_threshold: thresholdDecimal,
            ai_trust_mode: enableTrustMode,
            ai_system_prompt: prompts.teams,
          })
          .eq('channel_type', 'teams')
        if (companyAccountIds !== null) teamsQ = teamsQ.in('id', companyAccountIds)
        const { error: teamsErr } = await teamsQ
        if (teamsErr) errors.push(`teams accounts: ${teamsErr.message}`)

        // WhatsApp accounts get whatsapp prompt
        let waQ = supabase
          .from('accounts')
          .update({
            ai_confidence_threshold: thresholdDecimal,
            ai_trust_mode: enableTrustMode,
            ai_system_prompt: prompts.whatsapp,
          })
          .eq('channel_type', 'whatsapp')
        if (companyAccountIds !== null) waQ = waQ.in('id', companyAccountIds)
        const { error: waErr } = await waQ
        if (waErr) errors.push(`whatsapp accounts: ${waErr.message}`)
      }

      if (errors.length > 0) {
        console.error('Save errors:', errors)
        setSaveResult('error')
      } else {
        setSaveResult('success')
        setDirty(false)
        setAccounts((prev) =>
          prev.map((a) => ({
            ...a,
            ai_confidence_threshold: thresholdDecimal,
            ai_trust_mode: enableTrustMode,
            ai_system_prompt: prompts[a.channel_type] ?? a.ai_system_prompt,
          }))
        )
      }
    } catch (err) {
      console.error('Unexpected save error:', err)
      setSaveResult('error')
    } finally {
      setSaving(false)
      setTimeout(() => setSaveResult(null), 4000)
    }
  }, [confidenceThreshold, trustThreshold, prompts, fallbackBehavior, providerName, baseUrl, apiKey, model, maxTokens, temperature, autoResolveMarketing, companyAccountIds, companyId])

  // Discard reverts in-memory state by re-pulling the persisted ai_config row.
  // We re-set every field the load effect originally set so the form snaps
  // back to the last-saved state without a full page reload.
  const handleDiscard = useCallback(async () => {
    // Tell the watched-state effect to ignore the cascade of setters below —
    // we want the form to snap back to clean state, not re-flag as dirty.
    skipNextDirtyRef.current = true
    // Mirror the load path: scope by company_id when available, else use the
    // legacy global fallback row.
    let q = supabase
      .from('ai_config')
      .select('*')
      .eq('is_active', true)
    if (companyId) {
      q = q.eq('company_id', companyId)
    } else {
      q = q.is('company_id', null)
    }
    const { data: aiConfig } = await q
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (aiConfig) {
      setProviderName(aiConfig.provider_name || 'NVIDIA')
      setBaseUrl(aiConfig.base_url || '')
      setApiKey(aiConfig.api_key || '')
      setModel(aiConfig.model || '')
      setMaxTokens(aiConfig.max_tokens || 4096)
      setTemperature(Number(aiConfig.temperature) || 1.0)
      setPrompts((prev) => ({
        email: aiConfig.email_prompt || prev.email,
        teams: aiConfig.teams_prompt || prev.teams,
        whatsapp: aiConfig.whatsapp_prompt || prev.whatsapp,
      }))
      if (aiConfig.confidence_threshold) {
        setConfidenceThreshold(Math.round(Number(aiConfig.confidence_threshold) * 100))
      }
      if (aiConfig.trust_threshold !== undefined && aiConfig.trust_threshold !== null) {
        setTrustThreshold(aiConfig.trust_threshold)
      }
      if (aiConfig.fallback_behavior) setFallbackBehavior(aiConfig.fallback_behavior)
      if (aiConfig.auto_resolve_marketing !== undefined && aiConfig.auto_resolve_marketing !== null) {
        setAutoResolveMarketing(aiConfig.auto_resolve_marketing)
      }
    }
    setDirty(false)
  }, [supabase, companyId])

  // `scopeIds` is the same scope sentinel the rest of this client uses (the
  // `companyAccountIds` prop): `null` = super_admin combined view (no scope);
  // an empty array = a real tenant with zero accounts (queries must return
  // zero rows). message_classifications has no account_id column, so we scope
  // it through the messages!inner(account_id) join — matching the established
  // pattern in company-stats-table.tsx / dashboard/page.tsx. ai_replies is
  // scoped directly via account_id.
  function AIUsageCard({ scopeIds }: { scopeIds: string[] | null }) {
    const [usageStats, setUsageStats] = useState({ classifications: 0, replies: 0, sent: 0 })
    useEffect(() => {
      async function fetchUsage() {
        const sb = createClient()
        const monthStart = new Date()
        monthStart.setDate(1)
        monthStart.setHours(0, 0, 0, 0)
        const startISO = monthStart.toISOString()

        let classQ = sb
          .from('message_classifications')
          .select('*, messages!inner(account_id)', { count: 'exact', head: true })
          .gte('classified_at', startISO)
        if (scopeIds !== null) classQ = classQ.in('messages.account_id', scopeIds)

        let replyQ = sb
          .from('ai_replies')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', startISO)
        if (scopeIds !== null) replyQ = replyQ.in('account_id', scopeIds)

        let sentQ = sb
          .from('ai_replies')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'sent')
          .gte('created_at', startISO)
        if (scopeIds !== null) sentQ = sentQ.in('account_id', scopeIds)

        const [{ count: classCount }, { count: replyCount }, { count: sentCount }] = await Promise.all([
          classQ,
          replyQ,
          sentQ,
        ])
        setUsageStats({
          classifications: classCount || 0,
          replies: replyCount || 0,
          sent: sentCount || 0,
        })
      }
      fetchUsage()
    }, [scopeIds])

    const accuracy = usageStats.classifications > 0
      ? Math.round((usageStats.sent / Math.max(usageStats.replies, 1)) * 100)
      : 0

    return (
      <Card title="AI API Usage" description="Current month usage statistics (live)">
        <div className="grid grid-cols-4 gap-6">
          <div className="rounded-lg border border-gray-200 p-4 text-center">
            <Brain className="mx-auto mb-2 h-6 w-6 text-teal-600" />
            <p className="text-2xl font-bold text-gray-900">{usageStats.classifications}</p>
            <p className="text-xs text-gray-500">Classifications (this month)</p>
          </div>
          <div className="rounded-lg border border-gray-200 p-4 text-center">
            <FileText className="mx-auto mb-2 h-6 w-6 text-blue-600" />
            <p className="text-2xl font-bold text-gray-900">{usageStats.replies}</p>
            <p className="text-xs text-gray-500">Replies Generated</p>
          </div>
          <div className="rounded-lg border border-gray-200 p-4 text-center">
            <DollarSign className="mx-auto mb-2 h-6 w-6 text-green-600" />
            <p className="text-2xl font-bold text-gray-900">{usageStats.sent}</p>
            <p className="text-xs text-gray-500">Replies Sent</p>
          </div>
          <div className="rounded-lg border border-gray-200 p-4 text-center">
            <Sliders className="mx-auto mb-2 h-6 w-6 text-purple-600" />
            <p className="text-2xl font-bold text-gray-900">{accuracy}%</p>
            <p className="text-xs text-gray-500">Send Rate</p>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI Settings</h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure AI classification, reply generation, and trust mode settings
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saveResult === 'success' && (
            <span className="flex items-center gap-1.5 text-sm font-medium text-green-600">
              <Check className="h-4 w-4" /> Settings saved
            </span>
          )}
          {saveResult === 'error' && (
            <span className="flex items-center gap-1.5 text-sm font-medium text-red-600">
              <AlertCircle className="h-4 w-4" /> Failed to save
            </span>
          )}
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? 'Saving...' : 'Save All Settings'}
          </Button>
        </div>
      </div>

      {/* AI Provider Configuration */}
      <Card
        title="AI Provider Configuration"
        description="Configure which AI model and API endpoint to use for classification and reply generation"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Provider</label>
              {/* Currently only NVIDIA is wired up. Render as a readonly
                  field styled like a disabled select (chevron, muted bg) so
                  users see it's a single fixed value rather than something
                  they can edit. Additional providers will become a real
                  dropdown when they're supported. */}
              <div className="relative">
                <input
                  type="text"
                  value={providerName}
                  readOnly
                  aria-readonly="true"
                  className="block w-full cursor-not-allowed rounded-lg border border-gray-300 bg-gray-50 py-2 pl-10 pr-10 text-sm text-gray-700"
                />
                <Cpu className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Additional providers coming soon.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
              >
                <optgroup label="Recommended">
                  <option value="meta/llama-3.3-70b-instruct">Llama 3.3 70B — Fast &amp; reliable (default)</option>
                </optgroup>
                <optgroup label="Backup Models">
                  <option value="moonshotai/kimi-k2.6">Kimi K2.6 — Highest quality (1T MoE, slower)</option>
                  <option value="openai/gpt-oss-120b">GPT-OSS 120B — General purpose</option>
                </optgroup>
                <optgroup label="Other NVIDIA Models">
                  <option value="z-ai/glm5">GLM-5 — Strong reasoning (744B MoE)</option>
                  <option value="z-ai/glm4.7">GLM-4.7 — Fast reasoning</option>
                  <option value="minimaxai/minimax-m2.5">MiniMax M2.5 — Fastest, cheapest</option>
                  <option value="nvidia/nemotron-3-super-120b-a12b">Nemotron 3 Super 120B — NVIDIA&apos;s own</option>
                  <option value="meta/llama-3.1-405b-instruct">Llama 3.1 405B — Premium quality</option>
                  <option value="qwen/qwen3.5-397b-a17b">Qwen 3.5 397B — Latest, multilingual</option>
                  <option value="deepseek-ai/deepseek-v3.2">DeepSeek V3.2 — Powerful reasoning</option>
                  <option value="moonshotai/kimi-k2-thinking">Kimi K2 Thinking — Deep reasoning</option>
                  <option value="mistralai/mistral-large-3-675b-instruct-2512">Mistral Large 3 675B — Premium European</option>
                </optgroup>
              </select>
              {/* Model info badge */}
              <div className="mt-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-600">
                {model === 'moonshotai/kimi-k2.6' && '1T parameters (32B active) · Highest quality · Slower cold-start (can exceed the 30s timeout under low traffic)'}
                {model === 'meta/llama-3.3-70b-instruct' && '70B parameters · Free tier available · Good all-rounder · Reliable structured output'}
                {model === 'openai/gpt-oss-120b' && '120B parameters · General purpose · Average quality · Low cost'}
                {model === 'z-ai/glm5' && '744B MoE · Strong reasoning + agentic tasks'}
                {model === 'z-ai/glm4.7' && 'Fast reasoning model · Good for classification + replies'}
                {model === 'minimaxai/minimax-m2.5' && '230B MoE (10B active) · Fastest inference · Best for high volume'}
                {model === 'nvidia/nemotron-3-super-120b-a12b' && 'NVIDIA optimized 120B · 12B active · Good for enterprise agents'}
                {model === 'meta/llama-3.1-405b-instruct' && '405B parameters · Highest quality open source · Premium cost'}
                {model === 'qwen/qwen3.5-397b-a17b' && '397B MoE (17B active) · Latest Qwen · Excellent multilingual'}
                {model === 'deepseek-ai/deepseek-v3.2' && 'DeepSeek latest · Very powerful · Great at coding + reasoning'}
                {model === 'moonshotai/kimi-k2-thinking' && '1T MoE · Deep chain-of-thought reasoning · Best for complex tasks'}
                {model === 'mistralai/mistral-large-3-675b-instruct-2512' && '675B parameters · Premium European model · Excellent instruction following'}
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Base URL</label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="e.g., https://integrate.api.nvidia.com/v1"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">API Key</label>
            <div className="flex gap-2">
              <div className="flex-1">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter your API key"
                />
              </div>
              {/* Eye toggle is only meaningful when there's something to mask
                  in the first place. Hiding it on empty input avoids the
                  "what does this do?" UX paper-cut. */}
              {apiKey && (
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50"
                  aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Max Tokens
              </label>
              <Input
                type="number"
                value={maxTokens.toString()}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                min={100}
                max={32000}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Temperature ({temperature.toFixed(1)})
              </label>
              <input
                type="range"
                min={0}
                max={200}
                value={Math.round(temperature * 100)}
                onChange={(e) => setTemperature(Number(e.target.value) / 100)}
                className="mt-2 w-full accent-teal-600"
              />
              <div className="mt-1 flex justify-between text-xs text-gray-400">
                <span>0 (Precise)</span>
                <span>1.0</span>
                <span>2.0 (Creative)</span>
              </div>
            </div>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`rounded-lg border p-3 text-sm ${
              testResult.includes('successful') || testResult.startsWith('OK') || testResult.startsWith('✅')
                ? 'border-green-200 bg-green-50 text-green-700'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}>
              {testResult}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={handleTestConnection}
              disabled={testing || !apiKey || !baseUrl || !model}
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
              {testing ? 'Testing...' : 'Test Connection'}
            </Button>
            <Button onClick={handleSaveProvider} disabled={providerSaving || !apiKey}>
              {providerSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {providerSaving ? 'Saving...' : 'Save Provider'}
            </Button>
            {providerResult === 'success' && (
              <span className="flex items-center gap-1.5 text-sm font-medium text-green-600">
                <Check className="h-4 w-4" /> Provider saved
              </span>
            )}
            {providerResult === 'error' && (
              <span className="flex items-center gap-1.5 text-sm font-medium text-red-600">
                <AlertCircle className="h-4 w-4" /> Failed to save
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* Global Classification Settings */}
      <Card
        title="Classification Categories"
        description="Select which categories the AI should classify incoming messages into"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {allCategories.map((cat) => (
              <label
                key={cat}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 p-3 transition-colors hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={enabledCategories.has(cat)}
                  onChange={() => toggleCategory(cat)}
                  className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                />
                <span className="text-sm font-medium text-gray-700">{cat}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            {enabledCategories.size} of {allCategories.length} categories enabled
          </p>

          {/* Auto-resolve Newsletter/Marketing toggle */}
          <div className="mt-4 border-t border-gray-200 pt-4">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 bg-amber-50/40 p-3 hover:bg-amber-50 transition-colors">
              <input
                type="checkbox"
                checked={autoResolveMarketing}
                onChange={(e) => setAutoResolveMarketing(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-800">Auto-resolve Newsletter / Marketing</span>
                  <span className="rounded-full bg-amber-100 border border-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                    Recommended
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-600 leading-relaxed">
                  When the AI classifies an inbound message as <strong>Newsletter/Marketing</strong> with &gt;70% confidence, the conversation is automatically marked as <strong>resolved</strong> so it drops out of the active inbox. You can still find it in the Newsletter view.
                </p>
              </div>
            </label>
          </div>
        </div>
      </Card>

      {/* Confidence Threshold */}
      <Card
        title="Confidence Threshold"
        description="Minimum confidence score required for AI to classify and generate replies"
      >
        <div className="space-y-4">
          <div className="flex items-center gap-6">
            <Sliders className="h-5 w-5 text-gray-400" />
            <div className="flex-1">
              <input
                type="range"
                min={50}
                max={99}
                value={confidenceThreshold}
                onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
                className="w-full accent-teal-600"
              />
              {/* Evenly-spaced ticks every 10% so the displayed value (e.g. 80%)
                  always lines up with a label, instead of falling between the
                  old 50/75/99 ticks. */}
              <div className="mt-1 flex justify-between text-xs text-gray-400">
                <span>50%</span>
                <span>60%</span>
                <span>70%</span>
                <span>80%</span>
                <span>90%</span>
                <span>99%</span>
              </div>
            </div>
            <div className="w-20">
              <Input
                value={confidenceThreshold.toString()}
                onChange={(e) => {
                  const val = parseInt(e.target.value)
                  if (!isNaN(val) && val >= 50 && val <= 99) setConfidenceThreshold(val)
                }}
                className="text-center"
              />
            </div>
            <span className="text-sm text-gray-500">%</span>
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
            <Info className="mt-0.5 h-4 w-4 text-blue-600" />
            <p className="text-sm text-blue-900">
              Messages below this threshold will be classified but marked for human review.
              Current setting: AI will handle ~{Math.round((confidenceThreshold - 50) * 2)}% of messages automatically.
            </p>
          </div>
        </div>
      </Card>

      {/* Per-Account Prompt Templates */}
      <Card
        title="AI Prompt Templates"
        description="Customize the AI system prompt per channel type for reply generation"
      >
        <div className="space-y-6">
          {/* Email prompt */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-[#ea4335]" />
              <h4 className="text-sm font-semibold text-gray-700">Email - Formal Tone</h4>
            </div>
            <textarea
              value={prompts.email}
              onChange={(e) => setPrompts({ ...prompts, email: e.target.value })}
              rows={4}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            />
          </div>

          {/* Teams prompt */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-[#6264a7]" />
              <h4 className="text-sm font-semibold text-gray-700">Teams - Professional Tone</h4>
            </div>
            <textarea
              value={prompts.teams}
              onChange={(e) => setPrompts({ ...prompts, teams: e.target.value })}
              rows={4}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            />
          </div>

          {/* WhatsApp prompt */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-[#25d366]" />
              <h4 className="text-sm font-semibold text-gray-700">WhatsApp - Concise Tone</h4>
            </div>
            <textarea
              value={prompts.whatsapp}
              onChange={(e) => setPrompts({ ...prompts, whatsapp: e.target.value })}
              rows={4}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            />
          </div>
        </div>
      </Card>

      {/* Trust Mode Settings */}
      <Card
        title="Trust Mode Settings"
        description="Configure when AI can auto-send replies without human approval"
      >
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Shield className="h-5 w-5 text-gray-400" />
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Auto-send threshold (approved replies before trust)
              </label>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={trustThreshold.toString()}
                  onChange={(e) => setTrustThreshold(Number(e.target.value))}
                  className="w-24"
                />
                <span className="text-sm text-gray-500">
                  consecutive approved replies required before auto-send is enabled
                </span>
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-500">
            After {trustThreshold} consecutive replies are approved by a human reviewer without edits,
            the AI will begin auto-sending for that account/category combination.
          </p>
        </div>
      </Card>

      {/* Fallback Behavior */}
      <Card
        title="Fallback Behavior"
        description="What happens when AI confidence is below the threshold or an error occurs"
      >
        <div className="space-y-4">
          <Select
            label="When AI cannot generate a confident reply"
            value={fallbackBehavior}
            onChange={(e) => setFallbackBehavior(e.target.value)}
            options={[
              { value: 'escalate', label: 'Escalate to human reviewer' },
              { value: 'generic', label: 'Send generic acknowledgment response' },
              { value: 'none', label: 'No response (silent)' },
            ]}
          />
          {fallbackBehavior === 'escalate' && (
            <p className="text-sm text-gray-500">
              Messages will appear in the inbox with a &quot;Needs Review&quot; badge for manual handling.
            </p>
          )}
          {fallbackBehavior === 'generic' && (
            <p className="text-sm text-gray-500">
              A standard acknowledgment will be sent: &quot;Thank you for reaching out. A team member will review your message shortly.&quot;
            </p>
          )}
          {fallbackBehavior === 'none' && (
            <p className="text-sm text-gray-500">
              No response will be sent. The message will be logged but the customer receives no reply.
            </p>
          )}
        </div>
      </Card>

      {/* AI API Usage - Live from database (scoped to the caller's company) */}
      <AIUsageCard scopeIds={companyAccountIds} />

      {/* Sticky save bar — only renders when there are unsaved changes. Anchors
          to the viewport bottom so users on long forms can save without
          scrolling back to the page header. */}
      {dirty && (
        <div className="sticky bottom-0 left-0 right-0 z-30 -mx-6 mt-4 flex items-center justify-between gap-3 border-t border-gray-200 bg-white px-6 py-3 shadow-lg">
          <span className="text-sm text-gray-600">You have unsaved changes</span>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={handleDiscard} disabled={saving}>
              Discard
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
