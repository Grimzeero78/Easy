'use client'

import { useAppStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { useTheme } from 'next-themes'
import { LayoutDashboard, PlusCircle, Moon, Sun, ScanLine } from 'lucide-react'
import { useEffect, useState } from 'react'

export function AppHeader() {
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // Avoid synchronous setState in the effect body (hydration-safe theme toggle)
    const raf = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-950/90 backdrop-blur">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
        <button
          onClick={() => setView('dashboard', null)}
          className="flex items-center gap-2.5 group"
          aria-label="DocuExtract home"
        >
          <span className="h-8 w-8 rounded-lg bg-teal-600 text-white flex items-center justify-center shadow-sm group-hover:bg-teal-700 transition-colors">
            <ScanLine className="h-4.5 w-4.5" aria-hidden />
          </span>
          <span className="leading-tight text-left">
            <span className="block font-semibold text-sm">DocuExtract</span>
            <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">AI document understanding &amp; data extraction</span>
          </span>
        </button>

        <nav className="flex items-center gap-1.5" aria-label="Main navigation">
          <Button
            variant={view === 'dashboard' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setView('dashboard', null)}
            aria-label="Dashboard"
          >
            <LayoutDashboard className="h-4 w-4 sm:mr-1.5" aria-hidden />
            <span className="hidden sm:inline">Dashboard</span>
          </Button>
          <Button
            variant={view === 'new' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setView('new', null)}
            aria-label="New Extraction"
          >
            <PlusCircle className="h-4 w-4 sm:mr-1.5" aria-hidden />
            <span className="hidden sm:inline">New Extraction</span>
          </Button>
          {mounted && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          )}
        </nav>
      </div>
    </header>
  )
}
