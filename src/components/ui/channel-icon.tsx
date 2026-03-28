import { MessageSquare, Mail, Phone } from 'lucide-react'
import type { ChannelType } from '@/types/database'

export interface ChannelIconProps {
  channel: ChannelType
  size?: number
  className?: string
}

export function ChannelIcon({ channel, size = 18, className }: ChannelIconProps) {
  switch (channel) {
    case 'teams':
      return <MessageSquare size={size} className={className ?? 'text-[#6264a7]'} />
    case 'email':
      return <Mail size={size} className={className ?? 'text-[#ea4335]'} />
    case 'whatsapp':
      return <Phone size={size} className={className ?? 'text-[#25d366]'} />
  }
}
