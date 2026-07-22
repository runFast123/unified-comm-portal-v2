// Shared catalog of OpenAI-compatible AI providers.
//
// The app's AI calls (src/lib/api-helpers.ts `callAI`) speak the OpenAI
// chat-completions format and only need a `base_url`, `api_key`, and `model`.
// So ANY OpenAI-compatible endpoint works — these presets just prefill the
// base URL and a few suggested models. `custom` lets a user point at any
// other compatible endpoint. Model fields are always free-text editable; the
// `models` here are only suggestions for the dropdown.
//
// Used by both the /api/ai-providers route (preset validation/labels) and the
// AI Providers manager UI, so there's a single source of truth.

export type AiProviderKey =
  | 'nvidia'
  | 'openai'
  | 'gemini'
  | 'groq'
  | 'openrouter'
  | 'together'
  | 'mistral'
  | 'deepseek'
  | 'fireworks'
  | 'custom'

/**
 * Clean a user-entered API key before it's sent, tested, or stored.
 *
 * Two common paste mistakes both produce a rejected key:
 *   - trailing/leading whitespace or a newline from copying a line;
 *   - a leading "Bearer " because the provider's docs show the full
 *     `Authorization: Bearer <key>` header — we add "Bearer" ourselves, so a
 *     pasted one yields `Bearer Bearer <key>` and a 401.
 * Both are silent and confusing (the field is masked), so normalize once at
 * every ingestion point rather than making the user spot it.
 */
export function normalizeApiKey(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/^Bearer\s+/i, '').trim()
}

export interface AiProviderPreset {
  key: AiProviderKey
  label: string
  /** OpenAI-compatible base URL. Empty for `custom`. */
  base_url: string
  /** Suggested models (free-text entry is still allowed). */
  models: string[]
  apiKeyHint?: string
  docsUrl?: string
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    key: 'nvidia',
    label: 'NVIDIA NIM',
    base_url: 'https://integrate.api.nvidia.com/v1',
    models: [
      'meta/llama-3.3-70b-instruct',
      'moonshotai/kimi-k2.6',
      'openai/gpt-oss-120b',
      'deepseek-ai/deepseek-v3.2',
      'qwen/qwen3.5-397b-a17b',
    ],
    apiKeyHint: 'nvapi-…',
    docsUrl: 'https://build.nvidia.com',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
    apiKeyHint: 'sk-…',
    docsUrl: 'https://platform.openai.com',
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    // Gemini's OpenAI-compatibility layer. Google's docs show this URL WITH a
    // trailing slash; we store it WITHOUT one because every call site builds
    // `${base_url}/chat/completions` — a stored trailing slash would produce
    // `…/openai//chat/completions`.
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      // Widest free-tier coverage (standard + batch + flex), so it's the
      // safest pick for someone specifically after a no-cost provider.
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
    ],
    apiKeyHint: 'AIza… (from Google AI Studio)',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    key: 'groq',
    label: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    apiKeyHint: 'gsk_…',
    docsUrl: 'https://console.groq.com',
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-sonnet',
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-flash-1.5',
    ],
    apiKeyHint: 'sk-or-…',
    docsUrl: 'https://openrouter.ai',
  },
  {
    key: 'together',
    label: 'Together AI',
    base_url: 'https://api.together.xyz/v1',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
    ],
    docsUrl: 'https://together.ai',
  },
  {
    key: 'mistral',
    label: 'Mistral AI',
    base_url: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest'],
    docsUrl: 'https://mistral.ai',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    docsUrl: 'https://platform.deepseek.com',
  },
  {
    key: 'fireworks',
    label: 'Fireworks AI',
    base_url: 'https://api.fireworks.ai/inference/v1',
    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
    docsUrl: 'https://fireworks.ai',
  },
  {
    key: 'custom',
    label: 'Custom (OpenAI-compatible)',
    base_url: '',
    models: [],
  },
]

export function getPreset(key: string | null | undefined): AiProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((p) => p.key === key)
}

/** Best-effort match of a saved base_url back to a known preset (for display). */
export function presetByBaseUrl(baseUrl: string | null | undefined): AiProviderPreset | undefined {
  if (!baseUrl) return undefined
  const norm = (u: string) => u.replace(/\/+$/, '').toLowerCase()
  return AI_PROVIDER_PRESETS.find((p) => p.base_url && norm(p.base_url) === norm(baseUrl))
}

export const AI_PROVIDER_KEYS = AI_PROVIDER_PRESETS.map((p) => p.key)
