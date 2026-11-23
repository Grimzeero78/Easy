'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/lib/store'
import type { ExportListItem, JobListItem, TemplateItem } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Layers,
  Download,
  Trash2,
  PlusCircle,
  Camera,
  CircleCheck,
  AlertTriangle,
  FileSpreadsheet,
  History,
  ChevronRight,
  ReceiptText,
} from 'lucide-react'

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  'quality-review': 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  extracting: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  review: 'bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300',
  exported: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
}

const FORMAT_ICONS: Record<string, string> = {
  xlsx: 'XLSX',
  csv: 'CSV',
  pdf: 'PDF',
  docx: 'DOCX',
  txt: 'TXT',
  json: 'JSON',
}

export function Dashboard() {
  const setView = useAppStore((s) => s.setView)
  const [jobs, setJobs] = useState<JobListItem[]>([])
  const [exports, setExports] = useState<ExportListItem[]>([])
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteJobId, setDeleteJobId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [jobsRes, exportsRes, templatesRes] = await Promise.all([
        fetch('/api/jobs'),
        fetch('/api/exports'),
        fetch('/api/templates'),
      ])
      setJobs((await jobsRes.json()).jobs ?? [])
      setExports((await exportsRes.json()).exports ?? [])
      setTemplates((await templatesRes.json()).templates ?? [])
    } catch {
      toast.error('Could not load dashboard data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const totalRecords = jobs.reduce((s, j) => s + j.recordCount, 0)
  const totalFlagged = jobs.reduce((s, j) => s + j.flaggedCount, 0)

  const deleteJob = async () => {
    if (!deleteJobId) return
    try {
      await fetch(`/api/jobs/${deleteJobId}`, { method: 'DELETE' })
      toast.success('Document deleted — all pages, extracted data and exports removed.')
      refresh()
    } catch {
      toast.error('Delete failed')
    } finally {
      setDeleteJobId(null)
    }
  }

  const deleteExport = async (id: string) => {
    try {
      await fetch(`/api/exports/${id}`, { method: 'DELETE' })
      refresh()
    } catch {
      toast.error('Delete failed')
    }
  }

  const deleteTemplate = async (id: string) => {
    try {
      await fetch(`/api/templates/${id}`, { method: 'DELETE' })
      refresh()
    } catch {
      toast.error('Delete failed')
    }
  }

  return (
    <div className="space-y-6">
      {/* Hero + CTA */}
      <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 sm:p-8 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center gap-6 justify-between">
          <div className="max-w-2xl">
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
              Turn photos of documents into clean, structured data.
            </h1>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Student lists, cash receipts, stock registers, invoices, handwritten records. Take a picture, mark what you
              need, let the AI extract it — then verify every uncertain value against the original before export.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="inline-flex items-center gap-1.5"><Camera className="h-3.5 w-3.5 text-teal-600" /> 1. Capture or upload</span>
              <ChevronRight className="h-3 w-3" aria-hidden />
              <span className="inline-flex items-center gap-1.5"><CircleCheck className="h-3.5 w-3.5 text-teal-600" /> 2. Mark &amp; instruct</span>
              <ChevronRight className="h-3 w-3" aria-hidden />
              <span className="inline-flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 text-teal-600" /> 3. Verify flagged values</span>
              <ChevronRight className="h-3 w-3" aria-hidden />
              <span className="inline-flex items-center gap-1.5"><Download className="h-3.5 w-3.5 text-teal-600" /> 4. Export</span>
            </div>
          </div>
          <Button size="lg" className="shrink-0" onClick={() => setView('new', null)}>
            <PlusCircle className="h-5 w-5 mr-2" aria-hidden />
            Start a new extraction
          </Button>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4" aria-label="Statistics">
        <StatCard icon={<Layers className="h-4 w-4" />} label="Documents" value={jobs.length} sub="extraction jobs" />
        <StatCard icon={<ReceiptText className="h-4 w-4" />} label="Records extracted" value={totalRecords} sub="across all jobs" />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Awaiting verification"
          value={totalFlagged}
          sub="flagged fields"
          accent={totalFlagged > 0 ? 'amber' : undefined}
        />
        <StatCard icon={<Download className="h-4 w-4" />} label="Exports generated" value={exports.length} sub="files ready" />
      </section>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Recent documents */}
        <Card className="border-zinc-200 dark:border-zinc-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <History className="h-4 w-4 text-teal-600" aria-hidden /> Recent documents &amp; processing history
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-2">
            <ScrollArea className="max-h-96 overflow-y-auto px-6 pb-2">
              {loading ? (
                <SkeletonList />
              ) : jobs.length === 0 ? (
                <EmptyHint text="No documents yet. Start by photographing a student list, receipt or register." />
              ) : (
                <ul className="space-y-2">
                  {jobs.map((j) => (
                    <li
                      key={j.id}
                      className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 hover:border-teal-500/60 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 cursor-pointer" onClick={() => setView('workspace', j.id)}>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm truncate">{j.title}</span>
                            <Badge variant="outline" className={STATUS_STYLES[j.status] ?? ''}>
                              {j.status}
                            </Badge>
                            {j.mode === 'cashier' && (
                              <Badge variant="outline" className="bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                                Cashier mode
                              </Badge>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            {j.pageCount} page(s) · {j.extractedPages} extracted · {j.recordCount} records
                            {j.flaggedCount > 0 && (
                              <span className="text-amber-600 dark:text-amber-400"> · {j.flaggedCount} flagged</span>
                            )}
                            {j.exportCount > 0 && <span> · {j.exportCount} export(s)</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button size="sm" variant="ghost" onClick={() => setView('workspace', j.id)}>
                            Open
                          </Button>
                          <Button size="icon" variant="ghost" aria-label="Delete document" onClick={() => setDeleteJobId(j.id)}>
                            <Trash2 className="h-4 w-4 text-zinc-400 hover:text-red-600" />
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Recent exports */}
        <Card className="border-zinc-200 dark:border-zinc-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Download className="h-4 w-4 text-teal-600" aria-hidden /> Recent exports
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-2">
            <ScrollArea className="max-h-96 overflow-y-auto px-6 pb-2">
              {loading ? (
                <SkeletonList />
              ) : exports.length === 0 ? (
                <EmptyHint text="No exports yet. Extracted data can be exported as Excel, CSV, PDF, Word, TXT or JSON." />
              ) : (
                <ul className="space-y-2">
                  {exports.map((e) => (
                    <li
                      key={e.id}
                      className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-800">
                            {FORMAT_ICONS[e.format] ?? e.format}
                          </Badge>
                          <span className="text-sm font-medium truncate">{e.fileName}</span>
                        </div>
                        <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                          {e.jobTitle ? `${e.jobTitle} · ` : ''}
                          {e.rows} record(s)
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button size="sm" variant="outline" asChild>
                          <a href={`/api/exports/${e.id}/download`} download>
                            <Download className="h-3.5 w-3.5 mr-1" aria-hidden /> Download
                          </a>
                        </Button>
                        <Button size="icon" variant="ghost" aria-label="Delete export" onClick={() => deleteExport(e.id)}>
                          <Trash2 className="h-4 w-4 text-zinc-400 hover:text-red-600" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Templates */}
      <Card className="border-zinc-200 dark:border-zinc-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-teal-600" aria-hidden /> Saved templates
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-2">
          {loading ? (
            <SkeletonList />
          ) : templates.length === 0 ? (
            <EmptyHint text="No templates saved. Upload an Excel template or define custom columns in the Export step to reuse formats." />
          ) : (
            <ul className="grid sm:grid-cols-2 gap-2">
              {templates.map((t) => (
                <li key={t.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{t.name}</span>
                      <Badge variant="outline">{t.type === 'xlsx' ? 'Excel template' : 'Custom columns'}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {(t.headers ?? t.columns ?? []).join(' · ') || '—'}
                    </div>
                  </div>
                  <Button size="icon" variant="ghost" aria-label="Delete template" onClick={() => deleteTemplate(t.id)}>
                    <Trash2 className="h-4 w-4 text-zinc-400 hover:text-red-600" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!deleteJobId} onOpenChange={(open) => !open && setDeleteJobId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the uploaded pages, all extracted data and every generated export for this job.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={deleteJob}>
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: number
  sub: string
  accent?: 'amber'
}) {
  return (
    <Card className={`border-zinc-200 dark:border-zinc-800 ${accent === 'amber' && value > 0 ? 'border-amber-300 dark:border-amber-800' : ''}`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {icon}
          {label}
        </div>
        <div className={`mt-1.5 text-2xl font-semibold ${accent === 'amber' && value > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{value}</div>
        <div className="text-xs text-zinc-400 dark:text-zinc-500">{sub}</div>
      </CardContent>
    </Card>
  )
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-sm text-zinc-400 dark:text-zinc-500 py-8 text-center px-4">{text}</p>
}

function SkeletonList() {
  return (
    <div className="space-y-2 py-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 rounded-lg bg-zinc-100 dark:bg-zinc-800/60 animate-pulse" />
      ))}
    </div>
  )
}
