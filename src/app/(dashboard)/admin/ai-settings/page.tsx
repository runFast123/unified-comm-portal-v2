'use client'

import { useState, useEffect, useCallback } from 'react'
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

export default function AISettingsPage() {
  const supabase = createClient()
  const [enabledCategories, setEnabledCategories] = useState<Set<Category>>(
    new Set(allCategories)
  )
  const [confidenceThreshold, setConfidenceThreshold] = useState(80)
  const [trustThreshold, setTrustThreshold] = useState(5)
  const [fallbackBehavior, setFallbackBehavior] = useState('escalate')

  const [prompts, setPrompts] = useState({
    email: `You are a professional customer support agent for a telecommunications company. Respond to this email in a formal, courteous tone. Address the customer by name. Include relevant account details and next steps. Sign off with "Best regards, Customer Support Team".`,
    teams: `You are a professional support agent. Respond in a direct, professional tone suitable for Microsoft Teams. Keep the response concise but thorough. Use bullet points for multiple action items. Do not use formal email-style greetings or sign-offs.`,
    whatsapp: `You are a friendly support agent. Keep responses short and conversational, suitable for WhatsApp. Use simple language. Break long responses into short paragraphs. Include emojis sparingly for a friendly tone. Maximum 3 sentences per response when possible.`,
  })

  const [accounts, setAccounts] = useState<Account[]>([])
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<'success' | 'error' | null>(null)
  const [loading, setLoading] = useState(true)

  // AI Provider config state
  const [providerName, setProviderName] = useState('NVIDIA')
  const [baseUrl, setBaseUrl] = useState('https://integrate.api.nvidia.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('moonshot-ai/kimi-k2.5')
  const [maxTokens, setMaxTokens] = useState(4096)
  const [temperature, setTemperature] = useState(1.0)
  const [showApiKey, setShowApiKey] = useState(false)
  const [providerSaving, setProviderSaving] = useState(false)
  const [providerResult, setProviderResult] = useState<'success' | 'error' | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  // Load accounts and AI config
  useEffect(() => {
    async function loadData() {
      setLoading(true)

      // Load AI config
      const { data: aiConfig } = await supabase
        .from('ai_config')
        .select('*')
        .eq('is_active', true)
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
      }

      // Load accounts
      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .order('name', { ascending: true })

      if (error) {
        console.error('Failed to load accounts:', error.message)
        setLoading(false)
        return
      }

      const mapped: Account[] = (data ?? []).map((row: Record<string, unknown>) => ({
        ...row,
        n8n_workflow_id: row.make_scenario_id ?? null,
      })) as Account[]

      setAccounts(mapped)

      setLoading(false)
    }
    loadData()
  }, [])

  const handleSaveProvider = useCallback(async () => {
    setProviderSaving(true)
    setProviderResult(null)

    try {
      // Upsert: deactivate old, insert new with current prompts preserved
      await supabase.from('ai_config').update({ is_active: false }).eq('is_active', true)

      const { error } = await supabase.from('ai_config').insert({
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
  }, [providerName, baseUrl, apiKey, model, maxTokens, temperature, prompts, confidenceThreshold, trustThreshold, fallbackBehavior])

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

      // 1. Save prompts + settings to ai_config (primary storage)
      const { error: configError } = await supabase
        .from('ai_config')
        .update({
          email_prompt: prompts.email,
          teams_prompt: prompts.teams,
          whatsapp_prompt: prompts.whatsapp,
          confidence_threshold: thresholdDecimal,
          trust_threshold: trustThreshold,
          fallback_behavior: fallbackBehavior,
        })
        .eq('is_active', true)

      if (configError) {
        errors.push(`ai_config: ${configError.message}`)
      }

      // 2. Sync prompts to accounts table for API routes to read
      // All email accounts get the email prompt
      const { error: emailErr } = await supabase
        .from('accounts')
        .update({
          ai_confidence_threshold: thresholdDecimal,
          ai_trust_mode: enableTrustMode,
          ai_system_prompt: prompts.email,
        })
        .eq('channel_type', 'email')

      if (emailErr) errors.push(`email accounts: ${emailErr.message}`)

      // Teams accounts get teams prompt
      const { error: teamsErr } = await supabase
        .from('accounts')
        .update({
          ai_confidence_threshold: thresholdDecimal,
          ai_trust_mode: enableTrustMode,
          ai_system_prompt: prompts.teams,
        })
        .eq('channel_type', 'teams')

      if (teamsErr) errors.push(`teams accounts: ${teamsErr.message}`)

      // WhatsApp accounts get whatsapp prompt
      const { error: waErr } = await supabase
        .from('accounts')
        .update({
          ai_confidence_threshold: thresholdDecimal,
          ai_trust_mode: enableTrustMode,
          ai_system_prompt: prompts.whatsapp,
        })
        .eq('channel_type', 'whatsapp')

      if (waErr) errors.push(`whatsapp accounts: ${waErr.message}`)

      if (errors.length > 0) {
        console.error('Save errors:', errors)
        setSaveResult('error')
      } else {
        setSaveResult('success')
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
  }, [confidenceThreshold, trustThreshold, prompts, fallbackBehavior])

  function AIUsageCard() {
    const [usageStats, setUsageStats] = useState({ classifications: 0, replies: 0, sent: 0 })
    useEffect(() => {
      async function fetchUsage() {
        const sb = createClient()
        const monthStart = new Date()
        monthStart.setDate(1)
        monthStart.setHours(0, 0, 0, 0)
        const startISO = monthStart.toISOString()

        const [{ count: classCount }, { count: replyCount }, { count: sentCount }] = await Promise.all([
          sb.from('message_classifications').select('*', { count: 'exact', head: true }).gte('classified_at', startISO),
          sb.from('ai_replies').select('*', { count: 'exact', head: true }).gte('created_at', startISO),
          sb.from('ai_replies').select('*', { count: 'exact', head: true }).eq('status', 'sent').gte('created_at', startISO),
        ])
        setUsageStats({
          classifications: classCount || 0,
          replies: replyCount || 0,
          sent: sentCount || 0,
        })
      }
      fetchUsage()
    }, [])

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
              <label className="mb-1 block text-sm font-medium text-gray-700">Provider Name</label>
              <Input
                value={providerName}
                onChange={(e) => setProviderName(e.target.value)}
                placeholder="e.g., NVIDIA, OpenAI, Local LLM"
                icon={<Cpu className="h-4 w-4" />}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-none"
              >
                <optgroup label="Recommended">
                  <option value="moonshot-ai/kimi-k2.5">Kimi K2.5 — Best quality (1T MoE, 200K context)</option>
                </optgroup>
                <optgroup label="Backup Models">
                  <option value="meta/llama-3.3-70b-instruct">Llama 3.3 70B — Free tier, reliable</option>
                  <option value="openai/gpt-oss-120b">GPT-OSS 120B — Current default</option>
                </optgroup>
                <optgroup label="Other NVIDIA Models">
                  <option value="z-ai/glm5">GLM-5 — Strong reasoning (744B MoE)</option>
                  <option value="minimax/minimax-m2.5">MiniMax M2.5 — Fastest, cheapest</option>
                  <option value="nvidia/nemotron-3-super">Nemotron 3 Super — NVIDIA&apos;s own</option>
                  <option value="meta/llama-3.1-405b-instruct">Llama 3.1 405B — Premium quality</option>
                  <option value="qwen/qwen2.5-72b-instruct">Qwen 2.5 72B — Multilingual</option>
                  <option value="deepseek-ai/deepseek-v3">DeepSeek V3 — Powerful (671B MoE)</option>
                </optgroup>
              </select>
              {/* Model info badge */}
              <div className="mt-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-600">
                {model === 'moonshot-ai/kimi-k2.5' && '1T parameters (32B active) · 200K context · Best for KB-grounded replies · ~$0.05/1M tokens'}
                {model === 'meta/llama-3.3-70b-instruct' && '70B parameters · Free tier available · Good all-rounder · Reliable structured output'}
                {model === 'openai/gpt-oss-120b' && '120B parameters · General purpose · Average quality · Low cost'}
                {model === 'z-ai/glm5' && '744B MoE · Strong reasoning + agentic tasks · ~$0.10/1M tokens'}
                {model === 'minimax/minimax-m2.5' && '230B MoE (10B active) · Fastest inference · ~$0.01/1M tokens · Best for high volume'}
                {model === 'nvidia/nemotron-3-super' && 'NVIDIA optimized · Good for enterprise agents · Free on NVIDIA'}
                {model === 'meta/llama-3.1-405b-instruct' && '405B parameters · Highest quality open source · Premium cost'}
                {model === 'qwen/qwen2.5-72b-instruct' && '72B parameters · Excellent multilingual · Good instruction following'}
                {model === 'deepseek-ai/deepseek-v3' && '671B MoE · Very powerful · Great at coding + reasoning · ~$0.14/1M tokens'}
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
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50"
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
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
              testResult.includes('successful') || testResult.startsWith('OK') || testResult.startsWith('\u2705')
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
              <div className="mt-1 flex justify-between text-xs text-gray-400">
                <span>50%</span>
                <span>75%</span>
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
          <div className="flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 text-yellow-600" />
            <p className="text-sm text-yellow-700">
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

      {/* AI API Usage - Live from database */}
      <AIUsageCard />
    </div>
  )
}
