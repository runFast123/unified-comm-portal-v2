'use client'

import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import { CHANNEL_LIST } from '@/lib/channels/registry'

// ─── Shared palette (Linear / Vercel / Stripe inspired) ──────────────────────
export const CHART_COLORS = {
  primary: '#0d9488',   // teal-600
  positive: '#10b981',  // emerald-500
  neutral: '#6b7280',   // gray-500
  negative: '#ef4444',  // red-500
  email: '#3b82f6',     // blue-500
  teams: '#8b5cf6',     // violet-500
  whatsapp: '#10b981',  // emerald-500
} as const

// Channel colors (lowercase + capitalised keys for Recharts legend convenience)
export const CHANNEL_COLORS: Record<string, string> = {
  teams: CHART_COLORS.teams,
  email: CHART_COLORS.email,
  whatsapp: CHART_COLORS.whatsapp,
  sms: '#f22f46',
  telegram: '#0088cc',
  messenger: '#0084ff',
  instagram: '#e4405f',
  Teams: CHART_COLORS.teams,
  Email: CHART_COLORS.email,
  WhatsApp: CHART_COLORS.whatsapp,
  SMS: '#f22f46',
  Telegram: '#0088cc',
  Messenger: '#0084ff',
  Instagram: '#e4405f',
}

// Rotating colors for categories (soft, saturation-balanced)
export const CATEGORY_COLOR_PALETTE = [
  '#3b82f6', '#ef4444', '#f59e0b', '#8b5cf6', '#06b6d4',
  '#10b981', '#f97316', '#ec4899', '#6b7280', '#84cc16',
]

// ─── Shared axis + tooltip styling ───────────────────────────────────────────
const AXIS_TICK = { fontSize: 11, fill: '#6b7280' }

const TOOLTIP_STYLE: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: '0.5rem',
  boxShadow: '0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)',
  fontSize: '12px',
  padding: '8px 10px',
}

const TOOLTIP_LABEL_STYLE: React.CSSProperties = {
  color: '#111827',
  fontWeight: 600,
  marginBottom: 4,
}

const TOOLTIP_ITEM_STYLE: React.CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  color: '#374151',
}

const LEGEND_STYLE: React.CSSProperties = {
  fontSize: '11px',
  color: '#6b7280',
}

// --- Chart Components (all accept data via props) ---

export function MessageVolumeChart({ data }: { data: Array<{ day: string } & Record<string, number>> }) {
  if (!data || data.length === 0) {
    return <div className="flex items-center justify-center h-[300px] text-gray-400 text-sm">No message volume data available yet.</div>
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="day" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          cursor={{ stroke: '#e5e7eb', strokeWidth: 1 }}
        />
        <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={8} />
        {/* One line per registered channel (registry order + brand colour). */}
        {CHANNEL_LIST.map((c) => (
          <Line key={c.key} type="monotone" dataKey={c.key} name={c.label} stroke={c.hex} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

export function ResponseTimeChart({ data, onBarClick }: { data: { channel: string; avgMinutes: number }[]; onBarClick?: (channel: string) => void }) {
  if (!data || data.length === 0) {
    return <div className="flex items-center justify-center h-[300px] text-gray-400 text-sm">No response time data available yet.</div>
  }

  const handleBarClick = (entry: any) => {
    if (onBarClick && entry?.channel) {
      onBarClick(entry.channel)
    }
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} onClick={(state: any) => { if (state?.activePayload?.[0]?.payload) handleBarClick(state.activePayload[0].payload) }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="channel" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} label={{ value: 'Minutes', angle: -90, position: 'insideLeft', fontSize: 11, fill: '#6b7280' }} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          cursor={{ fill: '#f9fafb' }}
          formatter={(value) => [`${value} min`, 'Avg Response Time']}
        />
        <Bar dataKey="avgMinutes" name="Avg Response Time" radius={[6, 6, 0, 0]} style={{ cursor: onBarClick ? 'pointer' : 'default' }}>
          {data.map((item, i) => (
            <Cell key={i} fill={CHANNEL_COLORS[item.channel] || CHART_COLORS.neutral} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export function CategoryPieChart({ data }: { data: { name: string; value: number }[] }) {
  if (!data || data.length === 0) {
    return <div className="flex items-center justify-center h-[350px] text-gray-400 text-sm">No classification data available yet. Enable Phase 1 AI to see categories.</div>
  }

  // Compute totals so the legend can show counts alongside category names —
  // more useful at a glance than a percent suffix.
  const total = data.reduce((sum, d) => sum + d.value, 0)

  return (
    <ResponsiveContainer width="100%" height={350}>
      <PieChart>
        <Pie
          data={data}
          // Donut shifted left so the side-legend has room. Inline labels
          // with leader lines overlapped horribly when many small slices
          // were present (the audit caught this on a 7-category breakdown).
          cx="40%"
          cy="50%"
          outerRadius={118}
          innerRadius={64}
          paddingAngle={2}
          dataKey="value"
          // No inline labels — the legend on the right reads more cleanly.
          // Inline `label` + `labelLine` were producing crossing leader lines
          // on dense breakdowns. The Tooltip on hover still surfaces values.
          stroke="#ffffff"
          strokeWidth={2}
        >
          {data.map((entry, i) => (
            <Cell key={entry.name} fill={CATEGORY_COLOR_PALETTE[i % CATEGORY_COLOR_PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
        />
        <Legend
          layout="vertical"
          align="right"
          verticalAlign="middle"
          iconType="circle"
          iconSize={9}
          wrapperStyle={{ ...LEGEND_STYLE, fontSize: 12, lineHeight: '20px', paddingLeft: 16 }}
          formatter={(value: string) => {
            const slice = data.find((d) => d.name === value)
            if (!slice) return value
            const pct = total > 0 ? ((slice.value / total) * 100).toFixed(0) : '0'
            return `${value} · ${pct}%`
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}

export function SentimentChart({ data }: { data: { day: string; positive: number; neutral: number; negative: number }[] }) {
  if (!data || data.length === 0) {
    return <div className="flex items-center justify-center h-[300px] text-gray-400 text-sm">No sentiment data available yet. Enable Phase 1 AI to see sentiments.</div>
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="day" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          cursor={{ fill: '#f9fafb' }}
        />
        <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={8} />
        <Bar dataKey="positive" stackId="a" fill={CHART_COLORS.positive} name="Positive" />
        <Bar dataKey="neutral" stackId="a" fill={CHART_COLORS.neutral} name="Neutral" />
        <Bar dataKey="negative" stackId="a" fill={CHART_COLORS.negative} name="Negative" radius={[6, 6, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
