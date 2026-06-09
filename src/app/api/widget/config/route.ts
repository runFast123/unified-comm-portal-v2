// GET /api/widget/config?key=<widget_key>
// Public — the embedded widget loads its appearance (title/color/welcome) on init.
import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { resolveWidget, WIDGET_CORS } from '@/lib/livechat'

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: WIDGET_CORS })
}

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get('key')?.trim() ?? ''
  if (!key) {
    return NextResponse.json({ error: 'key required' }, { status: 400, headers: WIDGET_CORS })
  }
  const supabase = await createServiceRoleClient()
  const widget = await resolveWidget(supabase, key)
  if (!widget) {
    return NextResponse.json({ error: 'Widget not found' }, { status: 404, headers: WIDGET_CORS })
  }
  return NextResponse.json(
    {
      title: widget.title,
      color: widget.color,
      welcome_message: widget.welcome_message,
      subtitle: widget.subtitle,
      launcher_text: widget.launcher_text,
      position: widget.position,
    },
    { headers: WIDGET_CORS }
  )
}
