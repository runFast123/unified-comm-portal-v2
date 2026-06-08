import { MessageSquare, Mail, Phone, MessageCircle, Send, Facebook, Instagram, MessagesSquare, type LucideIcon } from 'lucide-react'
import type { ChannelType } from '@/types/database'
import { getChannel } from '@/lib/channels/registry'

export interface ChannelIconProps {
  channel: ChannelType
  size?: number
  className?: string
}

// Icon components live here (not in the registry) so the registry stays free of
// React/lucide imports. Add a new channel's icon here alongside its registry
// entry; the colour comes from the registry descriptor.
const ICONS: Record<ChannelType, LucideIcon> = {
  teams: MessageSquare,
  email: Mail,
  whatsapp: Phone,
  sms: MessageCircle,
  telegram: Send,
  messenger: Facebook,
  instagram: Instagram,
  livechat: MessagesSquare,
}

export function ChannelIcon({ channel, size = 18, className }: ChannelIconProps) {
  const Icon = ICONS[channel] ?? MessageSquare
  const textClass = getChannel(channel)?.textClass ?? 'text-gray-500'
  return <Icon size={size} className={className ?? textClass} />
}
