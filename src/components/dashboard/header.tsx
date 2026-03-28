'use client'

import { Menu, Bell } from 'lucide-react'

interface HeaderProps {
  title: string
  onMenuToggle: () => void
}

export function Header({ title, onMenuToggle }: HeaderProps) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-gray-200 bg-white px-4 lg:hidden">
      <button
        onClick={onMenuToggle}
        className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        aria-label="Toggle menu"
      >
        <Menu className="h-6 w-6" />
      </button>

      <h1 className="flex-1 text-lg font-semibold text-gray-900">{title}</h1>

      <button
        className="relative flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
      </button>
    </header>
  )
}
