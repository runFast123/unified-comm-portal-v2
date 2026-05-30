import { Reveal } from './reveal'

export type LegalSection = {
  heading: string
  paragraphs?: string[]
  bullets?: string[]
}

/**
 * Renders a legal document (privacy, terms) with consistent typography without
 * depending on the Tailwind typography plugin. Sections animate in on scroll.
 */
export function LegalPage({
  title,
  updated,
  intro,
  sections,
}: {
  title: string
  updated: string
  intro: string
  sections: LegalSection[]
}) {
  return (
    <article className="mx-auto max-w-3xl px-4 pb-24 pt-28 sm:px-6 sm:pt-32 lg:px-8">
      <header>
        <h1 className="text-4xl font-extrabold tracking-tight text-gray-900 sm:text-5xl">{title}</h1>
        <p className="mt-4 text-sm font-medium text-gray-400">Last updated: {updated}</p>
        <p className="mt-6 text-lg leading-relaxed text-gray-600">{intro}</p>
      </header>

      <div className="mt-12 space-y-10">
        {sections.map((s, i) => (
          <Reveal key={s.heading} delay={Math.min(i, 4) * 40}>
            <section>
              <h2 className="text-xl font-bold tracking-tight text-gray-900">
                {i + 1}. {s.heading}
              </h2>
              {s.paragraphs?.map((p, j) => (
                <p key={j} className="mt-3 text-[15px] leading-relaxed text-gray-600">
                  {p}
                </p>
              ))}
              {s.bullets && (
                <ul className="mt-3 space-y-2">
                  {s.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2.5 text-[15px] leading-relaxed text-gray-600">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-500" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </Reveal>
        ))}
      </div>
    </article>
  )
}
