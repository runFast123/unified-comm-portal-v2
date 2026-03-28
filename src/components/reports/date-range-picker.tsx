'use client'

import { useState } from 'react'
import { Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'

export type DateRange = 'today' | '7d' | '30d' | '90d' | 'custom'

interface DateRangePickerProps {
  activeRange: DateRange
  onChange: (range: DateRange) => void
  customFrom?: string
  customTo?: string
  onCustomChange?: (from: string, to: string) => void
}

const presets: { label: string; value: DateRange }[] = [
  { label: 'Today', value: 'today' },
  { label: '7 Days', value: '7d' },
  { label: '30 Days', value: '30d' },
  { label: '90 Days', value: '90d' },
  { label: 'Custom', value: 'custom' },
]

export function DateRangePicker({ activeRange, onChange, customFrom, customTo, onCustomChange }: DateRangePickerProps) {
  const [showCustom, setShowCustom] = useState(activeRange === 'custom')

  const handlePresetClick = (value: DateRange) => {
    if (value === 'custom') {
      setShowCustom(true)
    } else {
      setShowCustom(false)
    }
    onChange(value)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
        {presets.map((preset) => (
          <button
            key={preset.value}
            onClick={() => handlePresetClick(preset.value)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              activeRange === preset.value
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            {preset.value === 'custom' && <Calendar className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />}
            {preset.label}
          </button>
        ))}
      </div>
      {showCustom && activeRange === 'custom' && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={customFrom || ''}
            onChange={(e) => onCustomChange?.(e.target.value, customTo || '')}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
          />
          <span className="text-sm text-gray-400">to</span>
          <input
            type="date"
            value={customTo || ''}
            onChange={(e) => onCustomChange?.(customFrom || '', e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
          />
        </div>
      )}
    </div>
  )
}
