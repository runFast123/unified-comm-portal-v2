/**
 * Shared hero header for the marketing sub-pages (features, pricing, about,
 * contact, legal). Animated aurora + dot grid behind a centered title, matching
 * the landing hero so the whole site feels like one piece.
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
    <section className="relative overflow-hidden border-b border-gray-100 bg-white">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-dot-grid opacity-60" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
        <div className="animate-blob absolute -left-24 -top-24 h-72 w-72 rounded-full bg-teal-200/50 blur-3xl" />
        <div className="animate-blob absolute -top-10 right-0 h-72 w-72 rounded-full bg-emerald-200/50 blur-3xl [animation-delay:3s]" />
      </div>
      <div className="mx-auto max-w-4xl px-4 pb-16 pt-28 text-center sm:px-6 sm:pt-32 lg:px-8">
        <div className="animate-rise">
          {eyebrow && (
            <span className="inline-flex items-center rounded-full border border-teal-200 bg-teal-50/80 px-3.5 py-1.5 text-xs font-semibold uppercase tracking-wider text-teal-700">
              {eyebrow}
            </span>
          )}
          <h1 className="mt-5 text-balance text-4xl font-extrabold tracking-tight text-gray-900 sm:text-5xl">
            {title}
          </h1>
          {subtitle && (
            <p className="mx-auto mt-5 max-w-2xl text-balance text-lg leading-relaxed text-gray-600">
              {subtitle}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
