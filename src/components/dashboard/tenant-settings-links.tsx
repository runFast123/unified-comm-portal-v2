'use client'

import Link from 'next/link'
import {
  Bot,
  MessageSquare,
  FileText,
  Tags,
  ArrowRightLeft,
  Bell,
  PenLine,
  ChevronRight,
} from 'lucide-react'

interface TenantSettingsLinksProps {
  companyId: string
}

interface LinkDef {
  href: string
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
}

/**
 * One-click launchpad for per-tenant configuration pages. Used on the
 * company-detail Overview tab so super-admins (and company admins) don't
 * have to hunt for these settings in the global admin nav.
 *
 * Each link includes `?company_id=...` as a hint for the target page —
 * the page may or may not honor it yet, but threading it through avoids
 * a refactor later when those pages become tenant-aware.
 */
export function TenantSettingsLinks({ companyId }: TenantSettingsLinksProps) {
  const links: LinkDef[] = [
    {
      href: '/admin/ai-settings',
      label: 'AI Settings',
      description: 'Configure provider, model, prompts, budget for this company',
      icon: Bot,
    },
    {
      href: `/admin/channels?company_id=${companyId}`,
      label: 'Channels',
      description: 'Email, Teams, WhatsApp accounts for this tenant',
      icon: MessageSquare,
    },
    {
      href: `/admin/templates?company_id=${companyId}`,
      label: 'Templates',
      description: 'Reply templates',
      icon: FileText,
    },
    {
      href: `/admin/taxonomy?company_id=${companyId}`,
      label: 'Statuses & Tags',
      description: 'Custom conversation statuses and tags',
      icon: Tags,
    },
    {
      href: `/admin/routing?company_id=${companyId}`,
      label: 'Routing Rules',
      description: 'Auto-assignment rules',
      icon: ArrowRightLeft,
    },
    {
      href: `/admin/notifications?company_id=${companyId}`,
      label: 'Notifications',
      description: 'Slack + email alert rules per account',
      icon: Bell,
    },
    {
      href: `/admin/company-signatures?company_id=${companyId}`,
      label: 'Email Signatures',
      description: 'Default signatures',
      icon: PenLine,
    },
  ]

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-6 py-4">
        <h3 className="text-lg font-semibold text-foreground">Tenant Settings</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-company configuration. Each link opens the relevant settings page scoped to this tenant.
        </p>
      </div>
      <ul className="divide-y divide-gray-100">
        {links.map((l) => {
          const Icon = l.icon
          return (
            <li key={l.label}>
              <Link
                href={l.href}
                className="group flex items-center gap-4 px-6 py-3 transition-colors hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 ring-1 ring-teal-100">
                  <Icon className="h-4 w-4 text-teal-700" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 group-hover:text-teal-700">
                    {l.label}
                  </p>
                  <p className="truncate text-xs text-gray-500">{l.description}</p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 group-hover:text-teal-700" />
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
