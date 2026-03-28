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

// Channel colors
const CHANNEL_COLORS: Record<string, string> = {
  teams: '#6264a7',
  email: '#ea4335',
  whatsapp: '#25d366',
  Teams: '#6264a7',
  Email: '#ea4335',
  WhatsApp: '#25d366',
}

// Rotating colors for categories
const CATEGORY_COLOR_PALETTE = [
  '#3b82f6', '#ef4444', '#f59e0b', '#8b5cf6', '#06b6d4',
  '#10b981', '#f97316', '#ec4899', '#6b7280', '#84cc16',
]

// --- Chart Components (all accept data via props) ---

export function MessageVolumeChart({ data }: { data: { day: string; email: number; teams: number; whatsapp: number }[] }) {
  if (!data || data.length === 0) {
    return <div className="flex items-center justify-center h-[300px] text-gray-400 text-sm">No message volume data available yet.</div>
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="day" fontSize={12} tickLine={false} />
        <YAxis fontSize={12} tickLine={false} />
        <Tooltip />
        <Legend />
        <Line type="monotone" dataKey="email" name="Email" stroke={CHANNEL_COLORS.email} strokeWidth={2} dot={{ r: 4 }} />
        <Line type="monotone" dataKey="teams" name="Teams" stroke={CHANNEL_COLORS.teams} strokeWidth={2} dot={{ r: 4 }} />
        <Line type="monotone" dataKey="whatsapp" name="WhatsApp" stroke={CHANNEL_COLORS.whatsapp} strokeWidth={2} dot={{ r: 4 }} />
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
      <BarChart data={data} onClick={(state: any) => { if (state?.activePayload?.[0]?.payload) handleBarClick(state.activePayload[0].payload) }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="channel" fontSize={12} tickLine={false} />
        <YAxis fontSize={12} tickLine={false} label={{ value: 'Minutes', angle: -90, position: 'insideLeft', fontSize: 12 }} />
        <Tooltip formatter={(value) => [`${value} min`, 'Avg Response Time']} />
        <Bar dataKey="avgMinutes" name="Avg Response Time" radius={[4, 4, 0, 0]} style={{ cursor: onBarClick ? 'pointer' : 'default' }}>
          {data.map((item, i) => (
            <Cell key={i} fill={CHANNEL_COLORS[item.channel] || '#6b7280'} />
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

  return (
    <ResponsiveContainer width="100%" height={350}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          outerRadius={120}
          innerRadius={60}
          paddingAngle={2}
          dataKey="value"
          label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`}
          fontSize={11}
        >
          {data.map((entry, i) => (
            <Cell key={entry.name} fill={CATEGORY_COLOR_PALETTE[i % CATEGORY_COLOR_PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip />
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
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="day" fontSize={12} tickLine={false} />
        <YAxis fontSize={12} tickLine={false} />
        <Tooltip />
        <Legend />
        <Bar dataKey="positive" stackId="a" fill="#22c55e" name="Positive" radius={[0, 0, 0, 0]} />
        <Bar dataKey="neutral" stackId="a" fill="#9ca3af" name="Neutral" />
        <Bar dataKey="negative" stackId="a" fill="#ef4444" name="Negative" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
