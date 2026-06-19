import { Skeleton } from '@/components/ui/skeleton'

export default function ConversationLoading() {
  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col animate-in fade-in duration-300">
      {/* Conversation header — flat band mirroring the real 3-tier header
          (title + actions / muted metadata / status strip). */}
      <div className="shrink-0 border-b border-border bg-card px-4 sm:px-6 py-4">
        {/* Row 1: back arrow + channel icon + title | primary actions */}
        <div className="flex items-start gap-4 sm:gap-5">
          <Skeleton className="h-5 w-5 shrink-0 rounded" />
          <Skeleton className="h-6 w-6 shrink-0 rounded" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-6 w-56 rounded" />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Skeleton className="h-7 w-20 rounded-full" />
            <Skeleton className="h-7 w-24 rounded-full" />
            <Skeleton className="h-7 w-24 rounded-full" />
          </div>
        </div>

        {/* Row 2: muted metadata line */}
        <div className="mt-2 ml-[52px] sm:ml-[62px] flex flex-wrap items-center gap-2">
          <Skeleton className="h-3 w-24 rounded" />
          <Skeleton className="h-3 w-16 rounded" />
          <Skeleton className="h-3 w-32 rounded" />
          <Skeleton className="h-3 w-20 rounded" />
        </div>

        {/* Row 3: status strip — status pill + priority chip */}
        <div className="mt-3 ml-[52px] sm:ml-[62px] flex flex-wrap items-center gap-2">
          <Skeleton className="h-6 w-28 rounded-full" />
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      </div>

      {/* Main content area: thread (flex-1) + right rail (~384px) */}
      <div className="flex flex-1 flex-col lg:flex-row overflow-hidden">
        {/* Message thread + pinned bottom action bar */}
        <div className="flex flex-1 flex-col min-h-0 min-w-0">
          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-5">
            {/* Inbound bubble */}
            <div className="flex items-start gap-3">
              <Skeleton className="h-9 w-9 flex-shrink-0 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-32 rounded" />
                <div className="rounded-2xl rounded-tl-sm border border-border bg-card p-4 shadow-sm">
                  <Skeleton className="h-3 w-72 rounded" />
                  <Skeleton className="mt-2 h-3 w-64 rounded" />
                  <Skeleton className="mt-2 h-3 w-56 rounded" />
                </div>
              </div>
            </div>

            {/* Outbound bubble */}
            <div className="flex items-start justify-end gap-3">
              <div className="flex flex-col items-end space-y-2">
                <Skeleton className="h-3 w-28 rounded" />
                <div className="rounded-2xl rounded-tr-sm bg-muted p-4">
                  <Skeleton className="h-3 w-56 rounded" />
                  <Skeleton className="mt-2 h-3 w-48 rounded" />
                </div>
              </div>
              <Skeleton className="h-9 w-9 flex-shrink-0 rounded-full" />
            </div>

            {/* Inbound bubble */}
            <div className="flex items-start gap-3">
              <Skeleton className="h-9 w-9 flex-shrink-0 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-32 rounded" />
                <div className="rounded-2xl rounded-tl-sm border border-border bg-card p-4 shadow-sm">
                  <Skeleton className="h-3 w-64 rounded" />
                  <Skeleton className="mt-2 h-3 w-72 rounded" />
                </div>
              </div>
            </div>
          </div>

          {/* Bottom action bar — pinned, mirrors the real composer band */}
          <div className="shrink-0 border-t border-border bg-card px-4 sm:px-6 py-5">
            <Skeleton className="h-24 w-full rounded-lg" />
            <div className="mt-3 flex items-center justify-between">
              <Skeleton className="h-8 w-28 rounded-lg" />
              <Skeleton className="h-8 w-24 rounded-lg" />
            </div>
          </div>
        </div>

        {/* Right rail — matches the ~384px AI side panel (border-l on desktop) */}
        <aside className="w-full lg:w-96 shrink-0 overflow-hidden border-t lg:border-t-0 lg:border-l border-border bg-card">
          <div className="space-y-4 p-5">
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <Skeleton className="h-4 w-28 rounded" />
              </div>
              <div className="mt-4 space-y-2">
                <Skeleton className="h-3 w-11/12 rounded" />
                <Skeleton className="h-3 w-10/12 rounded" />
                <Skeleton className="h-3 w-8/12 rounded" />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <Skeleton className="h-4 w-32 rounded" />
              <div className="mt-3 space-y-2">
                <Skeleton className="h-10 w-full rounded-lg" />
                <Skeleton className="h-10 w-full rounded-lg" />
                <Skeleton className="h-10 w-full rounded-lg" />
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <Skeleton className="h-4 w-24 rounded" />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Skeleton className="h-14 rounded-lg" />
                <Skeleton className="h-14 rounded-lg" />
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
