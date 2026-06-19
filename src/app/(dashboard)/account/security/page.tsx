import SecurityClient from './security-client'

// MFA state is per-session and read on the client (the TOTP secret must never
// touch the server). Render dynamically so the page isn't statically cached.
export const dynamic = 'force-dynamic'

export default function SecurityPage() {
  return <SecurityClient />
}
