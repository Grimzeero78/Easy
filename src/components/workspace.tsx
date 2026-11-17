'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/lib/store'
import type { JobDetail, PageMeta } from '@/lib/types'
import { Annotator } from '@/components/annotator'
import { DataTable } from '@/components/data-table'
import { ReportPanel } from '@/components/report-panel'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { CF_MODE, cropRegionsClient } from '@/lib/client-image'
import {
  Sparkles,
  Loader2,
  ArrowRight,
  CircleCheck,
  AlertTriangle,
  XCircle,
  Trash2,
  Save,
  ReceiptText,
  FileText,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'

const EXAMPLE_INSTRUCTIONS = [
  'Extract all student names and registration numbers.',
  'Give me all the transaction IDs.',
  'Record the amount received and the transaction date.',
  'Extract product names, quantities and buying prices.',
  'Get all phone numbers from this page.',
  'Extract only the marked regions. Ignore the other columns.',
  'Extract only the unique transaction IDs as a single column.',
  'Find duplicate registration numbers.',
]

interface PageRunState {
  status: 'idle' | 'running' | 'done' | 'error'
  message?: string
}

export function Workspace() {
  const jobId = useAppStore((s) => s.jobId)
  const setView = useAppStore((s) => s.setView)
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeIndex, setActiveIndex] = useState(0)
  const [highlightFieldId, setHighlightFieldId] = useState<string | null>(null)
  const [instructions, setInstructions] = useState('')
  const [instrDirty, setInstrDirty] = useState(false)
  const [runState, setRunState] = useState<Record<string, PageRunState>>({})
  const [running, setRunning] = useState(false)
  const [progressLabel, setProgressLabel] = useState('')
  const [progressPct, setProgressPct] = useState(0)
  const instructionsRef = useRef('')

  const refresh = useCallback(async () => {
    if (!jobId) return
    try {
      const res = await fetch(`/api/jobs/${jobId}`)
      if (!res.ok) throw new Error('Document not found')
      const data: JobDetail = await res.json()
      setDetail(data)
      if (!instrDirty) {
        setInstructions(data.job.instructions ?? '')
        instructionsRef.current = data.job.instructions ?? ''
      }
    } catch (err) {
      toast.error((err as Error).message)
      setView('dashboard', null)
    } finally {
      setLoading(false)
    }
  }, [jobId, instrDirty, setView])

  useEffect(() => {
    refresh()
  }, [refresh])

  const saveInstructions = useCallback(
    async (text?: string) => {
      if (!jobId) return
      const value = text ?? instructions
      try {
        await fetch(`/api/jobs/${jobId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instructions: value }),
        })
        instructionsRef.current = value
        setInstrDirty(false)
      } catch {
        toast.error('Could not save instructions')
      }
    },
    [jobId, instructions]
  )

  const changeMode = async (mode: 'general' | 'cashier') => {
    if (!jobId) return
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      refresh()
    } catch {
      toast.error('Could not change mode')
    }
  }

  const removePage = async (pageId: string) => {
    try {
      await fetch(`/api/pages/${pageId}`, { method: 'DELETE' })
      toast.success('Page removed.')
      setActiveIndex(0)
      refresh()
    } catch {
      toast.error('Could not remove page')
    }
  }

  /** Sequential batch extraction with live progress (page order preserved). */
  const runExtraction = useCallback(
    async (target: 'all' | 'page', pageId?: string) => {
      if (!detail || running) return
      await saveInstructions()
      const pages =
        target === 'all'
          ? detail.pages.filter((p) => p.quality.verdict !== 'fail' && p.status !== 'blocked')
          : detail.pages.filter((p) => p.id === pageId)
      if (pages.length === 0) {
        toast.error('No pages available for extraction.')
        return
      }
      const blockedCount = detail.pages.filter((p) => p.quality.verdict === 'fail' || p.status === 'blocked').length
      if (target === 'all' && blockedCount > 0) {
        toast.message(`${blockedCount} blocked page(s) will be skipped`, {
          description: 'Pages that failed the quality check are never sent for AI extraction.',
        })
      }
      setRunning(true)
      setProgressPct(0)
      let failed = 0
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i]
        setProgressLabel(`AI is reading page ${i + 1} of ${pages.length}: ${page.fileName}`)
        setRunState((prev) => ({ ...prev, [page.id]: { status: 'running' } }))
        try {
          // CF mode: the browser sends zoomed crops of the marked regions so the
          // Worker can give the vision model close-ups (no server-side cropping).
          const body = CF_MODE
            ? JSON.stringify({
                crops: await cropRegionsClient(`/api/pages/${page.id}/image`, page.annotations),
              })
            : undefined
          const res = await fetch(`/api/pages/${page.id}/extract`, {
            method: 'POST',
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body,
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? 'Extraction failed')
          setRunState((prev) => ({ ...prev, [page.id]: { status: 'done' } }))
          const vc = data.visibleRecordCount as number | null
          const rows = data.rows as number
          if (vc != null && rows !== vc) {
            toast.warning(`Page ${page.order + 1}: extracted ${rows} record(s) but ${vc} are visible in the document.`, {
              description: 'Some records may have been missed — check the processing report.',
            })
          } else {
            toast.success(`Page ${page.order + 1}: ${rows} record(s) extracted.`)
          }
          if (Array.isArray(data.warnings) && data.warnings.length) {
            data.warnings.slice(0, 2).forEach((w: string) => toast.message('AI note', { description: w }))
          }
        } catch (err) {
          failed++
          setRunState((prev) => ({ ...prev, [page.id]: { status: 'error', message: (err as Error).message } }))
          toast.error(`Page ${page.order + 1} failed: ${(err as Error).message}`)
        }
        setProgressPct(Math.round(((i + 1) / pages.length) * 100))
        await refresh()
      }
      setRunning(false)
      setProgressLabel('')
      if (failed === 0) toast.success('Extraction complete — review flagged values before exporting.')
      else toast.error(`${failed} page(s) failed extraction.`)
    },
    [detail, running, saveInstructions, refresh]
  )

  const onLocate = useCallback(
    (fieldId: string | null) => {
      if (!fieldId || !detail) {
        setHighlightFieldId(null)
        return
      }
      const f = detail.fields.find((x) => x.id === fieldId)
      if (f) {
        setActiveIndex(f.pageIndex)
        setHighlightFieldId(fieldId)
      }
    },
    [detail]
  )

  const pageFields = useMemo(
    () => (detail ? detail.fields.filter((f) => f.pageIndex === activeIndex) : []),
    [detail, activeIndex]
  )
  const activePage: PageMeta | null = detail?.pages[activeIndex] ?? null
  const blockedPages = detail?.pages.filter((p) => p.quality.verdict === 'fail' || p.status === 'blocked') ?? []
  const hasResults = (detail?.fields.length ?? 0) > 0

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-teal-600" aria-label="Loading document" />
      </div>
    )
  }
  if (!detail) return null

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{detail.job.title}</h1>
          <Select value={detail.job.mode} onValueChange={(v) => changeMode(v as 'general' | 'cashier')}>
            <SelectTrigger className="w-56 h-8 text-xs" aria-label="Extraction mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="general">
                <span className="inline-flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" /> General documents</span>
              </SelectItem>
              <SelectItem value="cashier">
                <span className="inline-flex items-center gap-1.5"><ReceiptText className="h-3.5 w-3.5" /> Cashier &amp; financial documents</span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setView('export', jobId)} disabled={!hasResults}>
          Continue to Export <ArrowRight className="h-4 w-4 ml-1.5" aria-hidden />
        </Button>
      </div>

      {blockedPages.length > 0 && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <XCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
          <span>
            <strong>{blockedPages.length} page(s) blocked by the quality check</strong> and excluded from AI extraction —{' '}
            {blockedPages.map((p) => `Page ${p.order + 1}`).join(', ')}. Remove them and retake the picture: brighter,
            steadier, whole document in frame.
          </span>
        </div>
      )}

      <div className="grid lg:grid-cols-[1.35fr_1fr] gap-4 items-start">
        {/* LEFT: document + annotations */}
        <div className="space-y-3">
          <Card className="border-zinc-200 dark:border-zinc-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center justify-between gap-2">
                <span>
                  Document — page {activeIndex + 1} of {detail.pages.length}
                  {activePage ? ` · ${activePage.fileName}` : ''}
                </span>
                <span className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    disabled={activeIndex === 0}
                    onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    disabled={activeIndex >= detail.pages.length - 1}
                    onClick={() => setActiveIndex((i) => Math.min(detail.pages.length - 1, i + 1))}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* page strip */}
              <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Pages">
                {detail.pages.map((p, i) => (
                  <button
                    key={p.id}
                    role="tab"
                    aria-selected={i === activeIndex}
                    onClick={() => setActiveIndex(i)}
                    className={cn(
                      'shrink-0 rounded-lg border px-3 py-2 text-xs flex items-center gap-2 transition-colors',
                      i === activeIndex
                        ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300'
                        : 'border-zinc-200 dark:border-zinc-700 hover:border-teal-400'
                    )}
                  >
                    <span className="font-semibold">P{i + 1}</span>
                    {p.quality.verdict === 'pass' ? (
                      <CircleCheck className="h-3.5 w-3.5 text-emerald-600" aria-label="quality good" />
                    ) : p.quality.verdict === 'warn' ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label="quality warning" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-red-600" aria-label="quality blocked" />
                    )}
                    {p.status === 'extracted' && <span className="text-[10px] text-zinc-400">read</span>}
                    {p.status === 'extracting' && <Loader2 className="h-3 w-3 animate-spin" />}
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Remove page ${i + 1}`}
                      className="text-zinc-300 hover:text-red-500"
                      onClick={(e) => {
                        e.stopPropagation()
                        removePage(p.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation()
                          removePage(p.id)
                        }
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </span>
                  </button>
                ))}
              </div>

              {activePage && (
                <Annotator
                  page={activePage}
                  fields={pageFields}
                  highlightFieldId={highlightFieldId}
                  onSaved={() => {
                    /* annotations persisted server-side; no refetch needed */
                  }}
                />
              )}
            </CardContent>
          </Card>
        </div>

        {/* RIGHT: instructions + extraction + results */}
        <div className="space-y-4">
          <Card className="border-zinc-200 dark:border-zinc-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">AI extraction instructions</CardTitle>
              <CardDescription className="text-xs">
                Tell the AI what to extract in plain language — combined with your markings on the page.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={instructions}
                onChange={(e) => {
                  setInstructions(e.target.value)
                  setInstrDirty(true)
                }}
                placeholder="e.g. Extract all student names and registration numbers, then arrange them alphabetically."
                className="min-h-24 text-sm"
                aria-label="Natural language extraction instructions"
              />
              <div className="flex flex-wrap gap-1.5" aria-label="Example instructions">
                {EXAMPLE_INSTRUCTIONS.map((ex) => (
                  <button
                    key={ex}
                    className="rounded-full border border-zinc-200 dark:border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-500 dark:text-zinc-400 hover:border-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors"
                    onClick={() => {
                      setInstructions((prev) => (prev.trim() ? prev.trim() + ' ' : '') + ex)
                      setInstrDirty(true)
                    }}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="border-zinc-200 dark:border-zinc-800">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Button
                  className="flex-1"
                  onClick={() => runExtraction('all')}
                  disabled={running || detail.pages.filter((p) => p.quality.verdict !== 'fail' && p.status !== 'blocked').length === 0}
                >
                  {running ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4 mr-2" aria-hidden />}
                  Run AI extraction — all pages
                </Button>
                <Button
                  variant="outline"
                  onClick={() => runExtraction('page', activePage?.id)}
                  disabled={running || !activePage || activePage.quality.verdict === 'fail' || activePage.status === 'blocked'}
                >
                  This page only
                </Button>
              </div>
              {running && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-600" aria-hidden />
                    {progressLabel}
                  </div>
                  <Progress value={progressPct} aria-label="Extraction progress" />
                </div>
              )}
              <ul className="space-y-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                <li>Unreadable values are left empty and flagged — never guessed.</li>
                <li>Ambiguous characters (O vs 0, 5 vs S) are listed as alternatives for you to confirm.</li>
                <li>Record counts are compared against what is visible on each page.</li>
              </ul>
              {Object.entries(runState).some(([, s]) => s.status === 'error') && (
                <ul className="space-y-1">
                  {Object.entries(runState)
                    .filter(([, s]) => s.status === 'error')
                    .map(([pid, s]) => {
                      const pg = detail.pages.find((p) => p.id === pid)
                      return (
                        <li key={pid} className="text-[11px] text-red-600 dark:text-red-400">
                          Page {pg ? pg.order + 1 : ''}: {s.message}
                        </li>
                      )
                    })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* FULL WIDTH: extracted data — verification & editing */}
      <Card className="border-zinc-200 dark:border-zinc-800">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm flex items-center justify-between">
            <span>Extracted data — verification &amp; editing</span>
            {detail.report.needsReview && (
              <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[10px] dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800">
                {detail.report.flaggedFields + detail.report.missingFields} field(s) to verify
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <Tabs defaultValue="records">
            <TabsList className="mb-3">
              <TabsTrigger value="records">Records ({detail.report.totalRows})</TabsTrigger>
              <TabsTrigger value="report">Report</TabsTrigger>
            </TabsList>
            <TabsContent value="records">
              <DataTable fields={detail.fields} onLocate={onLocate} onChanged={refresh} />
            </TabsContent>
            <TabsContent value="report">
              <ReportPanel report={detail.report} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
