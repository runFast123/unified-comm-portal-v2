// Public CSAT survey landing page.
//
// Reachable WITHOUT auth — middleware whitelists `/csat/*` so customers
// can click the link straight from email. The URL token is the auth:
// `verifySurveyToken` rejects malformed / forged tokens.
//
// Renders in three states:
//   1) Already responded → "Thanks!" + their original rating
//   2) Expired           → "This survey has expired"
//   3) Not yet responded → 5 emoji buttons + feedback textarea
//
// Submit goes to POST /api/csat/[token] (also public, also token-gated).

import { notFound } from 'next/navigation'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { verifySurveyToken } from '@/lib/csat'
import { CSATForm } from './csat-form'

export const dynamic = 'force-dynamic'

interface SurveyRow {
  id: string
  rating: number | null
  responded_at: string | null
  expires_at: string
  account_id: string
}

interface AccountRow {
  id: string
  name: string
  company_id: string | null
}

interface CompanyRow {
  id: string
  name: string
  logo_url: string | null
  accent_color: string | null
}

export default async function CSATPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const surveyId = verifySurveyToken(token)
  if (!surveyId) {
    return <ErrorPanel title="Invalid survey link" message="This link can&apos;t be verified. Please double-check the URL or ask the team that sent it." />
  }

  const admin = await createServiceRoleClient()
  const { data: survey } = await admin
    .from('csat_surveys')
    .select('id, rating, responded_at, expires_at, account_id')
    .eq('id', surveyId)
    .maybeSingle()

  if (!survey) notFound()

  // Branding: pull the company name/logo through the account.
  let company: CompanyRow | null = null
  const { data: account } = await admin
    .from('accounts')
    .select('id, name, company_id')
    .eq('id', (survey as SurveyRow).account_id)
    .maybeSingle()
  if ((account as AccountRow | null)?.company_id) {
    const { data: c } = await admin
      .from('companies')
      .select('id, name, logo_url, accent_color')
      .eq('id', (account as AccountRow).company_id!)
      .maybeSingle()
    company = (c as CompanyRow | null) ?? null
  }

  const expired = new Date((survey as SurveyRow).expires_at).getTime() < Date.now()
  const responded = !!(survey as SurveyRow).responded_at

  return (
    <Shell company={company}>
      {responded ? (
        <ThankYouPanel rating={(survey as SurveyRow).rating} alreadySubmitted />
      ) : expired ? (
        <ErrorPanel title="This survey has expired" message="The window to rate this conversation has closed. Thanks anyway!" />
      ) : (
        <CSATForm token={token} accentColor={company?.accent_color ?? null} />
      )}
    </Shell>
  )
}

function Shell({
  company,
  children,
}: {
  company: CompanyRow | null
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-teal-50 via-white to-blue-50 flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6 sm:p-8">
          <header className="text-center mb-6">
            {company?.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={company.logo_url}
                alt={company.name}
                className="h-12 w-12 mx-auto rounded-lg object-cover bg-gray-100 mb-3"
              />
            ) : (
              <div className="h-12 w-12 mx-auto rounded-lg bg-teal-600 text-white flex items-center justify-center font-bold text-lg mb-3">
                {(company?.name ?? 'C')[0]}
              </div>
            )}
            <h1 className="text-xl font-semibold text-gray-900">
              {company?.name ?? 'How did we do?'}
            </h1>
          </header>
          {children}
        </div>
        <p className="text-center text-xs text-gray-400 mt-4">
          Powered by Unified Comms
        </p>
      </div>
    </div>
  )
}

function ThankYouPanel({
  rating,
  alreadySubmitted = false,
}: {
  rating: number | null
  alreadySubmitted?: boolean
}) {
  const emoji = rating ? ['', '😡', '😕', '😐', '🙂', '😍'][rating] ?? '🙂' : '🙂'
  return (
    <div className="text-center py-4">
      <div className="text-5xl mb-3">{emoji}</div>
      <h2 className="text-lg font-semibold text-gray-900 mb-1">
        {alreadySubmitted ? 'Already submitted' : 'Thanks for your feedback!'}
      </h2>
      <p className="text-sm text-gray-500">
        {alreadySubmitted
          ? `You rated this conversation ${rating ?? '—'} / 5.`
          : 'We appreciate you taking the time to let us know how we did.'}
      </p>
    </div>
  )
}

function ErrorPanel({ title, message }: { title: string; message: string }) {
  return (
    <div className="text-center py-4">
      <div className="text-4xl mb-3">⌛</div>
      <h2 className="text-lg font-semibold text-gray-900 mb-1">{title}</h2>
      <p className="text-sm text-gray-500">{message}</p>
    </div>
  )
}
