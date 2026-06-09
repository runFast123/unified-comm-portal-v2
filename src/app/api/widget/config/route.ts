// GET /api/widget/config?key=<widget_key>
// Public — the embedded widget loads its appearance (title/color/welcome) on init.
import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase-server'
import { resolveWidget, isWidgetOnline, WIDGET_CORS } from '@/lib/livechat'

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
  const online = isWidgetOnline(widget.business_hours_enabled, widget.business_hours)
  return NextResponse.json(
    {
      title: widget.title,
      color: widget.color,
      welcome_message: widget.welcome_message,
      subtitle: widget.subtitle,
      launcher_text: widget.launcher_text,
      position: widget.position,
      prechat_enabled: widget.prechat_enabled,
      business_hours_enabled: widget.business_hours_enabled,
      online,
      offline_message: widget.offline_message,
      proactive_delay: widget.proactive_delay,
    },
    { headers: WIDGET_CORS }
  )
}
