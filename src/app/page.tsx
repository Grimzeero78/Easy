'use client'

import { useAppStore } from '@/lib/store'
import { AppHeader } from '@/components/app-header'
import { Dashboard } from '@/components/dashboard'
import { NewExtraction } from '@/components/new-extraction'
import { Workspace } from '@/components/workspace'
import { ExportPanel } from '@/components/export-panel'
import { ShieldCheck } from 'lucide-react'

export default function Home() {
  const view = useAppStore((s) => s.view)

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
      <AppHeader />
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {view === 'dashboard' && <Dashboard />}
        {view === 'new' && <NewExtraction />}
        {view === 'workspace' && <Workspace />}
        {view === 'export' && <ExportPanel />}
      </main>
      <footer className="mt-auto border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-teal-600" aria-hidden />
            <span>
              Documents stay on this device unless sent for AI extraction. Delete jobs or exports at any time — nothing is retained or reused.
            </span>
          </div>
          <span className="whitespace-nowrap">DocuExtract — Take a picture → Mark → Extract → Verify → Export</span>
        </div>
      </footer>
    </div>
  )
}
