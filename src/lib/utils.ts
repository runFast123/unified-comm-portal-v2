import { clsx, type ClassValue } from 'clsx'
import { formatDistanceToNow } from 'date-fns'
import type { ChannelType, Priority, Sentiment, Urgency } from '@/types/database'

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

export function getChannelColor(channel: ChannelType): string {
  switch (channel) {
    case 'teams': return 'text-[#6264a7]'
    case 'email': return 'text-[#ea4335]'
    case 'whatsapp': return 'text-[#25d366]'
  }
}

export function getChannelBgColor(channel: ChannelType): string {
  switch (channel) {
    case 'teams': return 'bg-[#6264a7]'
    case 'email': return 'bg-[#ea4335]'
    case 'whatsapp': return 'bg-[#25d366]'
  }
}

export function getChannelLabel(channel: ChannelType): string {
  switch (channel) {
    case 'teams': return 'Teams'
    case 'email': return 'Email'
    case 'whatsapp': return 'WhatsApp'
  }
}

export function getPriorityColor(priority: Priority): string {
  switch (priority) {
    case 'low': return 'text-gray-500 bg-gray-100'
    case 'medium': return 'text-blue-700 bg-blue-100'
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
  return formatDistanceToNow(date, { addSuffix: false })
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
