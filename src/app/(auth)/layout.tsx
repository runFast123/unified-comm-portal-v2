export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0a0a0b] text-zinc-100 antialiased font-[family-name:var(--font-geist-sans)]">
      {/* Dark Console canvas — a single static hairline grid, no glow/gradient. */}
      <div className="pointer-events-none absolute inset-0 bg-grid-dark opacity-50" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" aria-hidden="true" />

      <div className="relative w-full max-w-md px-4 animate-fade-in">
        {/* Focused light card on the dark canvas — keeps the auth forms (styled
            for a light surface) fully legible. */}
        <div className="rounded-2xl border border-white/10 bg-white p-8 shadow-2xl shadow-black/40">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--brand-accent)]">
              <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-gray-900">
              Unified Communication Portal
            </h1>
            <p className="mt-2 text-sm text-gray-500">
              Manage all your communication channels in one place
            </p>
          </div>
          {children}
        </div>

        <p className="mt-6 text-center text-xs text-zinc-500 font-[family-name:var(--font-geist-mono)]">
          Powered by AI · Teams · Email · WhatsApp
        </p>
      </div>
    </div>
  )
}
