export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-teal-800 via-teal-600 to-emerald-700 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-teal-500/20 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-96 w-96 rounded-full bg-teal-400/10 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md px-4 animate-fade-in">
        <div className="rounded-2xl bg-white/95 backdrop-blur-sm p-8 shadow-2xl border border-white/20">
          {/* Logo */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-600 to-teal-700 shadow-lg shadow-teal-600/30">
              <svg className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">
              Unified Communication Portal
            </h1>
            <p className="mt-2 text-sm text-gray-500">
              Manage all your communication channels in one place
            </p>
          </div>
          {children}
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-xs text-teal-200/60">
          Powered by AI &middot; Teams &middot; Email &middot; WhatsApp
        </p>
      </div>
    </div>
  )
}
