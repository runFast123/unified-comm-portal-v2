import type { Metadata } from 'next'
import { ToastWrapper } from '@/components/ui/toast-wrapper'
import { SITE_URL, SITE_NAME, SITE_SHORT_NAME, SITE_TAGLINE, SITE_DESCRIPTION } from '@/lib/site'
import './globals.css'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — ${SITE_TAGLINE}`,
    template: `%s · ${SITE_SHORT_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    'shared inbox',
    'omnichannel support',
    'AI customer support',
    'email Teams WhatsApp inbox',
    'helpdesk software',
    'multi-tenant support platform',
    'BPO support software',
    'unified communication',
    'AI reply assistant',
    'customer service platform',
  ],
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  formatDetection: { telephone: false },
}

export const viewport = {
  themeColor: '#0f766e',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      {/*
        suppressHydrationWarning is scoped to this single <body> element.
        It silences only the attribute-mismatch warning caused by browser
        extensions (Grammarly, password managers, etc.) that inject marker
        attributes on <body> before React hydrates. Hydration mismatches
        inside <body> — in any child component — are still reported.
      */}
      <body className="bg-background text-foreground antialiased" suppressHydrationWarning>
        <ToastWrapper>{children}</ToastWrapper>
      </body>
    </html>
  )
}
