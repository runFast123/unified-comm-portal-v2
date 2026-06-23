import { clsx, type ClassValue } from 'clsx'
import { formatDistanceToNow } from 'date-fns'
import type { ChannelType, Priority, Sentiment, Urgency } from '@/types/database'
import { getChannel } from '@/lib/channels/registry'

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

// Channel display helpers now delegate to the single channel registry
// (src/lib/channels/registry.ts) so label/colours live in ONE place. The `??`
// fallbacks keep them total for any future/unknown channel value.
export function getChannelColor(channel: ChannelType): string {
  return getChannel(channel)?.textClass ?? 'text-gray-500'
}

export function getChannelBgColor(channel: ChannelType): string {
  return getChannel(channel)?.bgClass ?? 'bg-gray-500'
}

export function getChannelLabel(channel: ChannelType): string {
  return getChannel(channel)?.label ?? channel
}

export function getPriorityColor(priority: Priority): string {
  switch (priority) {
    case 'low': return 'text-gray-500 bg-gray-100'
    case 'medium': return 'text-amber-800 bg-amber-100'
    case 'high': return 'text-orange-700 bg-orange-100'
    case 'urgent': return 'text-red-700 bg-red-100'
  }
}

export function getSentimentColor(sentiment: Sentiment): string {
  switch (sentiment) {
    case 'positive': return 'text-green-700 bg-green-100'
    case 'neutral': return 'text-gray-700 bg-gray-100'
    case 'negative': return 'text-red-700 bg-red-100'
  }
}

export function getUrgencyColor(urgency: Urgency): string {
  switch (urgency) {
    case 'low': return 'text-gray-600 bg-gray-100'
    case 'medium': return 'text-yellow-700 bg-yellow-100'
    case 'high': return 'text-orange-700 bg-orange-100'
    case 'urgent': return 'text-red-700 bg-red-100'
  }
}

export function getPhaseStatusColor(phase1: boolean, phase2: boolean): string {
  if (phase1 && phase2) return 'bg-green-500'
  if (phase1) return 'bg-yellow-500'
  return 'bg-gray-400'
}

export function getPhaseStatusLabel(phase1: boolean, phase2: boolean): string {
  if (phase1 && phase2) return 'Full System'
  if (phase1) return 'Monitor Only'
  return 'Idle'
}

export function timeAgo(timestamp: string | null | undefined): string {
  if (!timestamp) return 'N/A'
  const date = new Date(timestamp)
  if (isNaN(date.getTime())) return 'N/A'
  // date-fns produces verbose forms like "about 18 hours" / "almost 2 years"
  // / "less than a minute". The "about" / "almost" / "over" prefixes are
  // pure noise for narrow table columns — strip them so the output fits in
  // tight cells (e.g. contacts "Last Seen" was clipping "ag" off
  // "about 18 hours ago" because of the verbose prefix).
  const raw = formatDistanceToNow(date, { addSuffix: false })
  return raw.replace(/^(?:about|almost|over)\s+/i, '')
}

export function formatResponseTime(minutes: number): string {
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str
  return str.slice(0, length) + '...'
}

/**
 * Decode HTML entities for plain-text display (inbox previews, subjects, board
 * cards, etc.). Handles named entities (&nbsp; &amp; &lt; &gt; &quot; &apos;)
 * AND numeric (&#160;) and hex (&#x27;) entities, which newsletter / marketing
 * HTML emails use heavily. Without this, raw `&#160;` / `&#x27;` strings leak
 * straight into the UI and look broken.
 *
 * Numeric/hex are decoded first so a literal `&amp;#160;` doesn't double-decode,
 * and NBSP (U+00A0) is normalised to a regular space so previews collapse
 * cleanly. Safe on null/undefined (returns '').
 */
export function decodeHtmlEntities(input: string | null | undefined): string {
  if (!input) return ''
  const fromCodePoint = (cp: number): string => {
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return ''
    try {
      return String.fromCodePoint(cp)
    } catch {
      return ''
    }
  }
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => fromCodePoint(parseInt(dec, 10)))
    // Soft hyphen (named form): an invisible line-break hint with no display
    // value here. Some senders (e.g. Framer) stuff hundreds into the hidden
    // email preheader; strip them rather than leaving literal "&shy;" on screen.
    .replace(/&shy;/gi, '')
    .replace(/&nbsp;/gi, ' ')
    // Common typographic named entities that would otherwise render literally.
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rsquo;/gi, '’')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&trade;/gi, '™')
    .replace(/&copy;/gi, '©')
    .replace(/&reg;/gi, '®')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    // Strip any actual soft-hyphen chars (incl. those decoded from &#173;/&#xAD;
    // above) plus zero-width chars — invisible clutter common in HTML emails.
    .replace(/­/g, '')
    .replace(/[​‌‍﻿]/g, '')
    .replace(/ /g, ' ')
}
