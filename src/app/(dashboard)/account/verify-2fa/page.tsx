import Verify2faClient from './verify-2fa-client'

// The challenge runs on the client (it promotes the live session to aal2).
// Render dynamically — never cache.
export const dynamic = 'force-dynamic'

export default async function Verify2faPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>
}) {
  const sp = await searchParams
  const rawNext = Array.isArray(sp.next) ? sp.next[0] : sp.next
  return <Verify2faClient next={rawNext ?? null} />
}
