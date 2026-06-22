/**
 * Landing-hero ambient 3D backdrop — pure CSS (no WebGL dependency, so it can't
 * break the build's type-checking and is reliably visible with no canvas-mount
 * timing). A drifting multi-color gradient mesh + a glowing orb wrapped in two
 * 3D-tilted orbiting rings (CSS `perspective` + rotateX, spinning on Z). All
 * motion is killed by the global prefers-reduced-motion rule. Server-renderable.
 */
export function Hero3D({ className }: { className?: string }) {
  return (
    <div className={className} aria-hidden="true">
      {/* drifting gradient-mesh blobs */}
      <div className="animate-blob absolute -left-24 -top-24 h-96 w-96 rounded-full bg-teal-300/30 blur-3xl" />
      <div className="animate-blob absolute right-0 top-8 h-80 w-80 rounded-full bg-emerald-300/30 blur-3xl [animation-delay:3s]" />
      <div className="animate-blob absolute bottom-0 left-1/3 h-80 w-80 rounded-full bg-cyan-200/30 blur-3xl [animation-delay:6s]" />

      {/* glowing orb + tilted orbiting rings — sits to the right, behind the
          product mockup, giving the hero a 3D centerpiece without a canvas. */}
      <div className="absolute right-[6%] top-1/2 hidden -translate-y-1/2 [perspective:1000px] lg:block">
        <div className="animate-float-slow relative h-80 w-80">
          {/* luminous core */}
          <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_50%_45%,rgba(20,184,166,0.55),rgba(16,185,129,0.22)_45%,transparent_70%)] blur-md" />
          {/* orbiting rings (3D-tilted, counter-spinning) */}
          <div className="animate-ring absolute inset-3 rounded-full border-2 border-teal-400/40" />
          <div className="animate-ring-rev absolute inset-12 rounded-full border border-emerald-400/30" />
          {/* bright nucleus */}
          <div className="absolute left-1/2 top-[45%] h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-br from-teal-300/70 to-emerald-500/60 blur-xl" />
        </div>
      </div>

      {/* base radial glow — also the soft fallback under reduced motion */}
      <div className="absolute inset-0 bg-[radial-gradient(55%_55%_at_70%_42%,rgba(20,184,166,0.12),transparent_72%)]" />
    </div>
  )
}
