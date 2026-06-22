import Link from 'next/link'
import { Logo } from './logo'

const COLUMNS: { title: string; links: [string, string][] }[] = [
  {
    title: 'Product',
    links: [
      ['Features', '/features'],
      ['Pricing', '/pricing'],
      ['Sign in', '/login'],
      ['Request a demo', '/contact'],
    ],
  },
  {
    title: 'Company',
    links: [
      ['About', '/about'],
      ['Contact', '/contact'],
    ],
  },
  {
    title: 'Legal',
    links: [
      ['Privacy', '/privacy'],
      ['Terms', '/terms'],
    ],
  },
]

export function MarketingFooter() {
  const year = new Date().getFullYear()
  return (
    <footer className="border-t border-white/10 bg-[#0a0a0b]">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-5">
          <div className="col-span-2 md:col-span-2">
            <Logo textClassName="text-zinc-100" />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-zinc-400">
              One AI-powered inbox for email, Teams, WhatsApp, SMS, Telegram, social DMs
              &amp; website live chat — so your team answers every customer faster, together.
            </p>
            <div className="mt-5 flex max-w-xs flex-wrap items-center gap-1.5">
              {[
                { label: 'Email', cls: 'bg-[#ea4335]' },
                { label: 'Teams', cls: 'bg-[#6264a7]' },
                { label: 'WhatsApp', cls: 'bg-[#25d366]' },
                { label: 'SMS', cls: 'bg-[#ec4899]' },
                { label: 'Telegram', cls: 'bg-[#0088cc]' },
                { label: 'Messenger', cls: 'bg-[#0084ff]' },
                { label: 'Instagram', cls: 'bg-[#e4405f]' },
                { label: 'Live Chat', cls: 'bg-[#16a34a]' },
              ].map((c) => (
                <span
                  key={c.label}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-white ${c.cls}`}
                >
                  {c.label}
                </span>
              ))}
            </div>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                {col.title}
              </h3>
              <ul className="mt-4 space-y-3">
                {col.links.map(([label, href]) => (
                  <li key={label}>
                    <Link
                      href={href}
                      className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 sm:flex-row">
          <p className="text-sm text-zinc-500">
            &copy; {year} Unified Communication Portal. All rights reserved.
          </p>
          <p className="text-xs text-zinc-600">
            Built for support teams, BPOs &amp; multi-brand operations.
          </p>
        </div>
      </div>
    </footer>
  )
}
