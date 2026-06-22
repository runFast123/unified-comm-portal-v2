/**
 * Shared hero header for the marketing sub-pages (features, pricing, about,
 * contact, legal). Dark Console canvas — a single static hairline dot grid
 * behind the title (no aurora/glow), a monospace eyebrow, matching the landing.
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow?: string
  title: string
  subtitle?: string
}) {
  return (
    <section className="relative overflow-hidden border-b border-zinc-200">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-dot-grid opacity-50" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-zinc-200 to-transparent" aria-hidden="true" />
      <div className="mx-auto max-w-4xl px-4 pb-16 pt-32 text-center sm:px-6 sm:pt-36 lg:px-8">
        <div className="animate-rise">
          {eyebrow && (
            <span className="font-[family-name:var(--font-geist-mono)] text-[12px] tracking-tight text-teal-700">
              {eyebrow}
            </span>
          )}
          <h1 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.025em] text-zinc-900 sm:text-5xl">
            {title}
          </h1>
          {subtitle && (
            <p className="mx-auto mt-5 max-w-2xl text-balance text-lg leading-relaxed text-zinc-600">
              {subtitle}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
