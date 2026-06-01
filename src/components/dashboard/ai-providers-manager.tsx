'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Cpu,
  Plus,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  Zap,
  Save,
  Loader2,
  Check,
  AlertCircle,
  X,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  AI_PROVIDER_PRESETS,
  getPreset,
  presetByBaseUrl,
  type AiProviderKey,
} from '@/lib/ai-providers'

/**
 * Shape of a saved provider as returned by GET /api/ai-providers.
 * `has_api_key` tells us whether a key is stored server-side (so we can show a
 * "saved — leave blank to keep" affordance); `api_key_masked` is a display-only
 * masked string (e.g. "nvapi-…f3a2"). The raw key is never returned.
 */
export interface AiProviderRow {
  id: string
  name: string
  provider_key: string
  base_url: string
  model: string
  max_tokens: number
  temperature: number
  is_active: boolean
  has_api_key: boolean
  api_key_masked: string | null
}

interface AIProvidersManagerProps {
  /**
   * Company scope. When non-null every request gets `?company_id=<companyId>`
   * appended so a super_admin can manage a specific tenant's providers. When
   * null the server falls back to the caller's own company.
   */
  companyId: string | null
}

type FormMode = { type: 'create' } | { type: 'edit'; row: AiProviderRow }

interface ProviderForm {
  providerKey: AiProviderKey
  name: string
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: string
  temperature: string
}

/**
 * Display fallback for a provider's stored key. Prefer the server-provided
 * `api_key_masked`; if it's absent but a key exists, show a generic masked
 * placeholder; if no key is stored, say so. Pure + exported for unit testing.
 */
export function formatMaskedKey(
  hasApiKey: boolean,
  masked: string | null | undefined
): string {
  if (masked && masked.trim()) return masked.trim()
  if (hasApiKey) return '••••••••'
  return 'No API key'
}

const EMPTY_FORM: ProviderForm = {
  providerKey: 'nvidia',
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  maxTokens: '4096',
  temperature: '1.0',
}

function formToCreateForm(): ProviderForm {
  const preset = AI_PROVIDER_PRESETS[0]
  return {
    ...EMPTY_FORM,
    providerKey: preset.key,
    name: preset.label,
    baseUrl: preset.base_url,
  }
}

function rowToForm(row: AiProviderRow): ProviderForm {
  // Resolve the preset from the stored key, falling back to a base_url match
  // (older rows may not have a clean provider_key), else treat it as custom.
  const preset =
    getPreset(row.provider_key) ?? presetByBaseUrl(row.base_url)
  return {
    providerKey: (preset?.key ?? 'custom') as AiProviderKey,
    name: row.name ?? '',
    baseUrl: row.base_url ?? '',
    apiKey: '',
    model: row.model ?? '',
    maxTokens: String(row.max_tokens ?? 4096),
    temperature: String(row.temperature ?? 1.0),
  }
}

export function AIProvidersManager({ companyId }: AIProvidersManagerProps) {
  const [providers, setProviders] = useState<AiProviderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [mode, setMode] = useState<FormMode | null>(null)
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM)
  const [showApiKey, setShowApiKey] = useState(false)

  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<
    { ok: boolean; message: string } | null
  >(null)

  // Live model list fetched from the provider's GET /models endpoint (so the
  // admin can pick from a real dropdown instead of typing the model name).
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [customModel, setCustomModel] = useState(false)

  // Per-row pending state for "set active" / delete so spinners are scoped.
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [banner, setBanner] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null)

  // Append the tenant scope to every request when present.
  const withScope = useCallback(
    (path: string) => {
      if (!companyId) return path
      const sep = path.includes('?') ? '&' : '?'
      return `${path}${sep}company_id=${encodeURIComponent(companyId)}`
    },
    [companyId]
  )

  const flashBanner = useCallback(
    (kind: 'success' | 'error', text: string) => {
      setBanner({ kind, text })
      window.setTimeout(() => setBanner(null), 4000)
    },
    []
  )

  const fetchProviders = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(withScope('/api/ai-providers'), {
        cache: 'no-store',
      })
      if (!res.ok) {
        let msg = `Failed to load providers (${res.status})`
        try {
          const j = await res.json()
          if (j?.error) msg = j.error
        } catch {
          /* non-JSON */
        }
        throw new Error(msg)
      }
      const json = await res.json()
      setProviders(Array.isArray(json.providers) ? json.providers : [])
    } catch (err) {
      setProviders([])
      setLoadError(err instanceof Error ? err.message : 'Failed to load providers')
    } finally {
      setLoading(false)
    }
  }, [withScope])

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  const activePreset = useMemo(
    () => getPreset(form.providerKey),
    [form.providerKey]
  )
  // Models for the chosen preset feed a free-text <datalist>; entering any
  // other model name is still allowed.
  const modelSuggestions = activePreset?.models ?? []

  const resetModelLoader = useCallback(() => {
    setFetchedModels(null)
    setCustomModel(false)
    setModelsError(null)
  }, [])

  const openCreate = useCallback(() => {
    setMode({ type: 'create' })
    setForm(formToCreateForm())
    setShowApiKey(false)
    setFormError(null)
    setTestResult(null)
    resetModelLoader()
  }, [resetModelLoader])

  const openEdit = useCallback((row: AiProviderRow) => {
    setMode({ type: 'edit', row })
    setForm(rowToForm(row))
    setShowApiKey(false)
    setFormError(null)
    setTestResult(null)
    resetModelLoader()
  }, [resetModelLoader])

  const closeForm = useCallback(() => {
    setMode(null)
    setFormError(null)
    setTestResult(null)
  }, [])

  // Choosing a preset prefills base_url and the datalist; "Custom" clears the
  // base URL so the user types their own. Name follows the preset label only
  // while it still matches the previous preset's label (don't clobber a name
  // the user typed by hand).
  const onPresetChange = useCallback(
    (key: AiProviderKey) => {
      // A different provider means a different model catalogue — clear any
      // models loaded for the previous one.
      setFetchedModels(null)
      setCustomModel(false)
      setModelsError(null)
      const next = getPreset(key)
      setForm((prev) => {
        const prevPreset = getPreset(prev.providerKey)
        const nameWasDefault =
          !prev.name.trim() || prev.name === prevPreset?.label
        return {
          ...prev,
          providerKey: key,
          baseUrl: next ? next.base_url : '',
          name: nameWasDefault && next ? next.label : prev.name,
        }
      })
    },
    []
  )

  const editingRow = mode?.type === 'edit' ? mode.row : null
  const keepExistingKey = Boolean(
    editingRow?.has_api_key && !form.apiKey.trim()
  )

  const handleTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // When editing and leaving the key blank to keep the saved one, we can't
      // re-test with the stored key (it never leaves the server). Ask the user
      // to enter it for the test.
      if (!form.apiKey.trim()) {
        setTestResult({
          ok: false,
          message:
            'Enter the API key above to test the connection (the saved key is never exposed to the browser).',
        })
        return
      }
      const res = await fetch('/api/test-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: form.baseUrl,
          api_key: form.apiKey,
          model: form.model,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setTestResult({
          ok: false,
          message: data?.error || `Test failed (${res.status})`,
        })
        return
      }
      setTestResult({
        ok: true,
        message: data?.message || 'Connection successful',
      })
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Connection failed',
      })
    } finally {
      setTesting(false)
    }
  }, [form.baseUrl, form.apiKey, form.model])

  // Pull the provider's live model list (GET /models) so the user picks from a
  // dropdown instead of typing. Uses the key in the form, or the saved key
  // (by id) when editing without re-entering it.
  const handleLoadModels = useCallback(async () => {
    setLoadingModels(true)
    setModelsError(null)
    try {
      const reqBody: Record<string, unknown> = {}
      if (form.apiKey.trim()) {
        reqBody.base_url = form.baseUrl
        reqBody.api_key = form.apiKey.trim()
      } else if (editingRow?.has_api_key) {
        reqBody.id = editingRow.id
        reqBody.base_url = form.baseUrl
      } else {
        setModelsError("Enter the API key first to load this provider's models.")
        return
      }
      const res = await fetch(withScope('/api/ai-providers/models'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setModelsError(data?.error || `Could not load models (${res.status})`)
        return
      }
      const models: string[] = Array.isArray(data.models) ? data.models : []
      if (models.length === 0) {
        setModelsError('Provider returned no models — you can still type a model name.')
        return
      }
      setFetchedModels(models)
      setCustomModel(false)
      // Only auto-fill when empty; never overwrite a model the user already set.
      setForm((p) => ({ ...p, model: p.model.trim() ? p.model : models[0] }))
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : 'Could not load models')
    } finally {
      setLoadingModels(false)
    }
  }, [form.apiKey, form.baseUrl, editingRow, withScope])

  const handleSave = useCallback(async () => {
    setFormError(null)

    const name = form.name.trim()
    const baseUrl = form.baseUrl.trim()
    const model = form.model.trim()
    const maxTokens = Number(form.maxTokens)
    const temperature = Number(form.temperature)

    // Client-side validation mirrors the contract's required fields.
    if (!name) return setFormError('Name is required.')
    if (!baseUrl) return setFormError('Base URL is required.')
    if (!model) return setFormError('Model is required.')
    if (!Number.isFinite(maxTokens) || maxTokens <= 0)
      return setFormError('Max tokens must be a positive number.')
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
      return setFormError('Temperature must be between 0 and 2.')
    if (mode?.type === 'create' && !form.apiKey.trim())
      return setFormError('API key is required for a new provider.')

    setSaving(true)
    try {
      let res: Response
      if (mode?.type === 'edit') {
        // PATCH: omit api_key entirely when blank so the saved key is kept.
        const body: Record<string, unknown> = {
          name,
          provider_key: form.providerKey,
          base_url: baseUrl,
          model,
          max_tokens: maxTokens,
          temperature,
        }
        if (form.apiKey.trim()) body.api_key = form.apiKey.trim()
        res = await fetch(withScope(`/api/ai-providers/${mode.row.id}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        // POST: a brand-new provider. `activate: true` only when it's the very
        // first one, so adding a second provider doesn't silently steal the
        // active slot.
        res = await fetch(withScope('/api/ai-providers'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            provider_key: form.providerKey,
            base_url: baseUrl,
            api_key: form.apiKey.trim(),
            model,
            max_tokens: maxTokens,
            temperature,
            activate: providers.length === 0,
          }),
        })
      }

      if (!res.ok) {
        let msg = `Save failed (${res.status})`
        try {
          const j = await res.json()
          if (j?.error) msg = j.error
        } catch {
          /* non-JSON */
        }
        setFormError(msg)
        return
      }

      flashBanner(
        'success',
        mode?.type === 'edit' ? 'Provider updated' : 'Provider added'
      )
      closeForm()
      await fetchProviders()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [form, mode, providers.length, withScope, flashBanner, closeForm, fetchProviders])

  const handleSetActive = useCallback(
    async (row: AiProviderRow) => {
      setRowBusy(row.id)
      try {
        const res = await fetch(withScope(`/api/ai-providers/${row.id}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: true }),
        })
        if (!res.ok) {
          let msg = `Failed to set active (${res.status})`
          try {
            const j = await res.json()
            if (j?.error) msg = j.error
          } catch {
            /* non-JSON */
          }
          throw new Error(msg)
        }
        flashBanner('success', `"${row.name}" is now active`)
        await fetchProviders()
      } catch (err) {
        flashBanner(
          'error',
          err instanceof Error ? err.message : 'Failed to set active'
        )
      } finally {
        setRowBusy(null)
      }
    },
    [withScope, flashBanner, fetchProviders]
  )

  const handleDelete = useCallback(
    async (row: AiProviderRow) => {
      if (
        !window.confirm(
          `Delete the "${row.name}" provider? This cannot be undone.`
        )
      ) {
        return
      }
      setRowBusy(row.id)
      try {
        const res = await fetch(withScope(`/api/ai-providers/${row.id}`), {
          method: 'DELETE',
        })
        if (!res.ok) {
          let msg = `Delete failed (${res.status})`
          try {
            const j = await res.json()
            if (j?.error) msg = j.error
          } catch {
            /* non-JSON */
          }
          throw new Error(msg)
        }
        // If the form was open for this row, close it.
        if (mode?.type === 'edit' && mode.row.id === row.id) closeForm()
        flashBanner('success', `"${row.name}" deleted`)
        await fetchProviders()
      } catch (err) {
        flashBanner('error', err instanceof Error ? err.message : 'Delete failed')
      } finally {
        setRowBusy(null)
      }
    },
    [withScope, mode, closeForm, flashBanner, fetchProviders]
  )

  return (
    <Card
      title="AI Providers"
      description="Connect one or more OpenAI-compatible AI providers. The active provider is used for classification and reply generation."
    >
      <div className="space-y-4">
        {/* Top-of-card status banner */}
        {banner && (
          <div
            role="status"
            className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${
              banner.kind === 'success'
                ? 'border-green-200 bg-green-50 text-green-700'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {banner.kind === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 shrink-0" />
            )}
            <span>{banner.text}</span>
          </div>
        )}

        {/* List header + add button */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            {loading
              ? 'Loading providers…'
              : `${providers.length} provider${providers.length === 1 ? '' : 's'} configured`}
          </p>
          {mode === null && (
            <Button size="sm" onClick={openCreate} disabled={loading}>
              <Plus className="h-4 w-4" />
              Add provider
            </Button>
          )}
        </div>

        {/* Load error */}
        {loadError && !loading && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <span className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {loadError}
            </span>
            <button
              type="button"
              onClick={fetchProviders}
              className="font-medium underline underline-offset-2 hover:text-red-800"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-4 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading providers…
          </div>
        )}

        {/* Empty state */}
        {!loading && !loadError && providers.length === 0 && mode === null && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50/60 px-6 py-10 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-teal-50 text-teal-600 ring-1 ring-teal-200">
              <Cpu className="h-6 w-6" />
            </div>
            <h4 className="text-sm font-semibold text-gray-800">
              Add your first AI provider
            </h4>
            <p className="mt-1 max-w-sm text-sm text-gray-500">
              Connect NVIDIA NIM, OpenAI, Groq, OpenRouter, or any
              OpenAI-compatible endpoint to power AI classification and replies.
            </p>
            <Button className="mt-4" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Add provider
            </Button>
          </div>
        )}

        {/* Provider list */}
        {!loading && providers.length > 0 && (
          <ul className="space-y-2">
            {providers.map((p) => {
              const preset =
                getPreset(p.provider_key) ?? presetByBaseUrl(p.base_url)
              const presetLabel = preset?.label ?? 'Custom (OpenAI-compatible)'
              const isBusy = rowBusy === p.id
              const isEditingThis =
                mode?.type === 'edit' && mode.row.id === p.id
              return (
                <li
                  key={p.id}
                  className={`rounded-lg border p-4 transition-colors ${
                    p.is_active
                      ? 'border-teal-300 bg-teal-50/40'
                      : 'border-gray-200 bg-white hover:bg-gray-50'
                  } ${isEditingThis ? 'ring-2 ring-teal-500/30' : ''}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Cpu className="h-4 w-4 shrink-0 text-gray-400" />
                        <span className="truncate text-sm font-semibold text-gray-900">
                          {p.name}
                        </span>
                        <Badge variant="default" size="sm">
                          {presetLabel}
                        </Badge>
                        {p.is_active ? (
                          <Badge variant="success" size="sm">
                            Active
                          </Badge>
                        ) : null}
                      </div>
                      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-gray-600 sm:grid-cols-2">
                        <div className="flex gap-1.5">
                          <dt className="font-medium text-gray-500">Model:</dt>
                          <dd className="truncate font-mono">{p.model || '—'}</dd>
                        </div>
                        <div className="flex gap-1.5">
                          <dt className="font-medium text-gray-500">API key:</dt>
                          <dd className="truncate font-mono">
                            {formatMaskedKey(p.has_api_key, p.api_key_masked)}
                          </dd>
                        </div>
                        <div className="flex min-w-0 gap-1.5 sm:col-span-2">
                          <dt className="font-medium text-gray-500">
                            Base URL:
                          </dt>
                          <dd className="truncate font-mono">
                            {p.base_url || '—'}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!p.is_active && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleSetActive(p)}
                          disabled={isBusy}
                          title="Make this the active provider"
                        >
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )}
                          Set active
                        </Button>
                      )}
                      <button
                        type="button"
                        onClick={() => openEdit(p)}
                        disabled={isBusy}
                        aria-label={`Edit ${p.name}`}
                        title="Edit"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 ring-1 ring-gray-200 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(p)}
                        disabled={isBusy}
                        aria-label={`Delete ${p.name}`}
                        title="Delete"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 ring-1 ring-gray-200 transition-colors hover:bg-red-50 hover:text-red-600 hover:ring-red-200 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {/* Add / edit form */}
        {mode !== null && (
          <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-4">
            <div className="mb-4 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-gray-800">
                {mode.type === 'edit'
                  ? `Edit "${mode.row.name}"`
                  : 'Add AI provider'}
              </h4>
              <button
                type="button"
                onClick={closeForm}
                aria-label="Close form"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {/* Provider preset select */}
                <div>
                  <label
                    htmlFor="ai-provider-preset"
                    className="mb-1.5 block text-sm font-medium text-gray-700"
                  >
                    Provider
                  </label>
                  <select
                    id="ai-provider-preset"
                    value={form.providerKey}
                    onChange={(e) =>
                      onPresetChange(e.target.value as AiProviderKey)
                    }
                    className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 transition-colors focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                  >
                    {AI_PROVIDER_PRESETS.map((preset) => (
                      <option key={preset.key} value={preset.key}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  {activePreset?.docsUrl && (
                    <a
                      href={activePreset.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1.5 inline-flex items-center gap-1 text-xs text-teal-700 hover:underline"
                    >
                      {activePreset.label} docs
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>

                {/* Display name */}
                <div>
                  <Input
                    label="Name"
                    value={form.name}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, name: e.target.value }))
                    }
                    placeholder="e.g., NVIDIA NIM"
                  />
                </div>
              </div>

              {/* Base URL */}
              <div>
                <Input
                  label="Base URL"
                  value={form.baseUrl}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, baseUrl: e.target.value }))
                  }
                  placeholder="https://integrate.api.nvidia.com/v1"
                />
              </div>

              {/* API key with show/hide */}
              <div>
                <label
                  htmlFor="ai-provider-api-key"
                  className="mb-1.5 block text-sm font-medium text-gray-700"
                >
                  API Key
                </label>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Input
                      id="ai-provider-api-key"
                      type={showApiKey ? 'text' : 'password'}
                      value={form.apiKey}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, apiKey: e.target.value }))
                      }
                      placeholder={
                        keepExistingKey
                          ? '•••• saved — leave blank to keep'
                          : activePreset?.apiKeyHint || 'Enter your API key'
                      }
                      autoComplete="off"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowApiKey((v) => !v)}
                    className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-gray-300 text-gray-500 transition-colors hover:bg-gray-100"
                    aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                    aria-pressed={showApiKey}
                  >
                    {showApiKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                {keepExistingKey && (
                  <p className="mt-1.5 text-xs text-gray-500">
                    A key is already saved. Leave this blank to keep it, or enter
                    a new key to replace it.
                  </p>
                )}
              </div>

              {/* Model — load the live list from the provider, or type a custom name */}
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <label
                    htmlFor="ai-provider-model"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Model
                  </label>
                  <button
                    type="button"
                    onClick={handleLoadModels}
                    disabled={
                      loadingModels ||
                      !form.baseUrl.trim() ||
                      (!form.apiKey.trim() && !editingRow?.has_api_key)
                    }
                    title="Fetch the available models from this provider using your API key"
                    className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 transition-colors hover:underline disabled:cursor-not-allowed disabled:text-gray-400 disabled:no-underline"
                  >
                    {loadingModels ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    {loadingModels ? 'Loading…' : 'Load models'}
                  </button>
                </div>

                {fetchedModels && fetchedModels.length > 0 && !customModel ? (
                  <>
                    <select
                      id="ai-provider-model"
                      value={form.model}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, model: e.target.value }))
                      }
                      className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 transition-colors focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                    >
                      {/* Preserve a current value that isn't in the fetched list. */}
                      {form.model && !fetchedModels.includes(form.model) && (
                        <option value={form.model}>{form.model} (current)</option>
                      )}
                      {fetchedModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <p className="text-xs text-gray-500">
                        {fetchedModels.length} model{fetchedModels.length === 1 ? '' : 's'} loaded from this provider.
                      </p>
                      <button
                        type="button"
                        onClick={() => setCustomModel(true)}
                        className="text-xs font-medium text-teal-700 hover:underline"
                      >
                        Enter a custom model
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      id="ai-provider-model"
                      list="ai-provider-model-options"
                      value={form.model}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, model: e.target.value }))
                      }
                      placeholder="Type a model name, or click “Load models”"
                      autoComplete="off"
                      className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 transition-colors focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                    />
                    <datalist id="ai-provider-model-options">
                      {(fetchedModels ?? modelSuggestions).map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <p className="text-xs text-gray-500">
                        Click <span className="font-medium">Load models</span> to pick from your provider&apos;s list — or type any model name.
                      </p>
                      {fetchedModels && fetchedModels.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setCustomModel(false)}
                          className="text-xs font-medium text-teal-700 hover:underline"
                        >
                          Back to model list
                        </button>
                      )}
                    </div>
                  </>
                )}

                {modelsError && (
                  <p className="mt-1.5 text-xs text-amber-700">{modelsError}</p>
                )}
              </div>

              {/* Max tokens + temperature */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Input
                    label="Max tokens"
                    type="number"
                    min={1}
                    max={200000}
                    value={form.maxTokens}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, maxTokens: e.target.value }))
                    }
                  />
                </div>
                <div>
                  <Input
                    label="Temperature (0–2)"
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={form.temperature}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, temperature: e.target.value }))
                    }
                  />
                </div>
              </div>

              {/* Test result */}
              {testResult && (
                <div
                  role="status"
                  className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
                    testResult.ok
                      ? 'border-green-200 bg-green-50 text-green-700'
                      : 'border-red-200 bg-red-50 text-red-700'
                  }`}
                >
                  {testResult.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <span className="break-words">{testResult.message}</span>
                </div>
              )}

              {/* Form error */}
              {formError && (
                <div
                  role="alert"
                  className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              {/* Form actions */}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button
                  variant="secondary"
                  onClick={handleTest}
                  disabled={testing || !form.baseUrl.trim() || !form.model.trim()}
                >
                  {testing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Zap className="h-4 w-4" />
                  )}
                  {testing ? 'Testing…' : 'Test connection'}
                </Button>
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {saving
                    ? 'Saving…'
                    : mode.type === 'edit'
                      ? 'Save changes'
                      : 'Add provider'}
                </Button>
                <Button variant="ghost" onClick={closeForm} disabled={saving}>
                  Cancel
                </Button>
                {mode.type === 'create' && providers.length === 0 && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                    <Check className="h-3.5 w-3.5 text-teal-600" />
                    This first provider will be set active automatically.
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
