import type { ChannelType } from '@/types/database'

/**
 * Channel registry — Phase 0 of multi-channel expansion.
 *
 * The single source of truth for channel METADATA. Display touchpoints (icon,
 * inbox filter, label/colour helpers) read from here instead of each carrying
 * its own hardcoded `switch (channel)`, so a new channel's appearance is added
 * in ONE place.
 *
 * This module is intentionally free of React / lucide imports so it stays safe
 * to import from server code and the widely-used `@/lib/utils`. The icon (a
 * React component) is mapped separately in `src/components/ui/channel-icon.tsx`.
 *
 * Later Phase-0 increments extend this into a full adapter (parseInbound / send
 * / configSchema) and switch the `channel` column from a Postgres enum to text
 * so new channels need no migration. The `capabilities` flags below are the
 * forward-looking shape for that — declared now, wired to behaviour later.
 */
export interface ChannelDescriptor {
  /** Stable key — matches the `channel` column value. */
  key: ChannelType
  /** Human label, e.g. "WhatsApp". */
  label: string
  /** Label for the inbox channel filter, e.g. "WhatsApp Only". */
  filterLabel: string
  /** Brand hex (the dot / accent colour). */
  hex: string
  /** Tailwind text-colour class for the brand hex. */
  textClass: string
  /** Tailwind bg-colour class for the brand hex. */
  bgClass: string
  /** Forward-looking adapter capabilities (not yet wired to behaviour). */
  capabilities: {
    inbound: boolean
    outbound: boolean
    attachments: boolean
    threading: boolean
  }
}

// To add a channel: add an entry here + an icon in channel-icon.tsx's ICONS map
// (+ the adapter/DB wiring covered by later Phase-0 increments). Order here is
// the order channels render in the inbox filter.
export const CHANNELS: Record<ChannelType, ChannelDescriptor> = {
  teams: {
    key: 'teams',
    label: 'Teams',
    filterLabel: 'Teams Only',
    hex: '#6264a7',
    textClass: 'text-[#6264a7]',
    bgClass: 'bg-[#6264a7]',
    capabilities: { inbound: true, outbound: true, attachments: true, threading: true },
  },
  email: {
    key: 'email',
    label: 'Email',
    filterLabel: 'Email Only',
    hex: '#ea4335',
    textClass: 'text-[#ea4335]',
    bgClass: 'bg-[#ea4335]',
    capabilities: { inbound: true, outbound: true, attachments: true, threading: true },
  },
  whatsapp: {
    key: 'whatsapp',
    label: 'WhatsApp',
    filterLabel: 'WhatsApp Only',
    hex: '#25d366',
    textClass: 'text-[#25d366]',
    bgClass: 'bg-[#25d366]',
    capabilities: { inbound: true, outbound: true, attachments: true, threading: true },
  },
}

/** All channel keys, in registry (display) order. */
export const CHANNEL_KEYS = Object.keys(CHANNELS) as ChannelType[]

/** All channel descriptors, in registry (display) order. */
export const CHANNEL_LIST: ChannelDescriptor[] = Object.values(CHANNELS)

/** Look up a descriptor by key; tolerant of unknown / legacy values (→ null). */
export function getChannel(key: string | null | undefined): ChannelDescriptor | null {
  if (!key) return null
  return (CHANNELS as Record<string, ChannelDescriptor>)[key] ?? null
}
