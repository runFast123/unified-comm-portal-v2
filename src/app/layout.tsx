import type { Metadata } from 'next'
import { ToastWrapper } from '@/components/ui/toast-wrapper'
import './globals.css'

export const metadata: Metadata = {
  title: 'Unified Communication Portal',
  description: 'Manage 10 company email accounts with AI-powered monitoring and auto-reply',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">
        <ToastWrapper>{children}</ToastWrapper>
      </body>
    </html>
  )
}
