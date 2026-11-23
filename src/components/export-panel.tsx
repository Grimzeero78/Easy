'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/lib/store'
import type { ExportListItem, JobDetail, TemplateItem } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  FileSpreadsheet,
  FileText,
  FileJson,
  FileType,
  AlignLeft,
  Download,
  Loader2,
  ArrowUp,
  ArrowDown,
  Save,
  UploadCloud,
  CircleCheck,
  AlertTriangle,
} from 'lucide-react'

const FORMATS = [
  { id: 'xlsx', label: 'Excel', icon: FileSpreadsheet, desc: '.xlsx workbook, template support' },
  { id: 'csv', label: 'CSV', icon: FileText, desc: '.csv, universal spreadsheet format' },
  { id: 'pdf', label: 'PDF', icon: FileText, desc: '.pdf formatted table' },
  { id: 'docx', label: 'Word', icon: FileType, desc: '.docx document table' },
  { id: 'txt', label: 'Plain text', icon: AlignLeft, desc: '.txt aligned columns' },
  { id: 'json', label: 'JSON', icon: FileJson, desc: '.json structured data' },
]

export function ExportPanel() {
  const jobId = useAppStore((s) => s.jobId)
  const setView = useAppStore((s) => s.setView)
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [format, setFormat] = useState('xlsx')
  const [tplChoice, setTplChoice] = useState<'none' | 'saved' | 'upload'>('none')
  const [selectedTplId, setSelectedTplId] = useState<string>('')
  const [uploadingTpl, setUploadingTpl] = useState(false)
  const [tplFile, setTplFile] = useState<File | null>(null)
  const [selectedCols, setSelectedCols] = useState<Set<string>>(new Set())
  const [colOrder, setColOrder] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  const [lastExport, setLastExport] = useState<ExportListItem | null>(null)
  const [jobExports, setJobExports] = useState<ExportListItem[]>([])
  const [tplName, setTplName] = useState('')
  const tplInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    if (!jobId) return
    try {
      const [detailRes, tplRes, exportsRes] = await Promise.all([
        fetch(`/api/jobs/${jobId}`),
        fetch('/api/templates'),
        fetch('/api/exports'),
      ])
      if (!detailRes.ok) throw new Error('Document not found')
      const d: JobDetail = await detailRes.json()
      setDetail(d)
      const t: { templates: TemplateItem[] } = await tplRes.json()
      setTemplates(t.templates ?? [])
      const e: { exports: ExportListItem[] } = await exportsRes.json()
      setJobExports((e.exports ?? []).filter((x) => x.jobTitle === d.job.title))
      setSelectedCols(new Set(d.report.columns))
      setColOrder(d.report.columns)
    } catch (err) {
      toast.error((err as Error).message)
      setView('dashboard', null)
    } finally {
      setLoading(false)
    }
  }, [jobId, setView])

  useEffect(() => {
    refresh()
  }, [refresh])

  const columns = useMemo(() => colOrder.filter((c) => selectedCols.has(c)), [colOrder, selectedCols])

  const previewRecords = useMemo(() => {
    if (!detail) return []
    const map = new Map<string, typeof detail.fields>()
    for (const f of detail.fields) {
      const k = `${f.pageIndex}:${f.rowIndex}`
      const arr = map.get(k) ?? []
      arr.push(f)
      map.set(k, arr)
    }
    const keys = [...map.keys()].sort((a, b) => {
      const [pa, ra] = a.split(':').map(Number)
      const [pb, rb] = b.split(':').map(Number)
      return pa - pb || ra - rb
    })
    return keys.slice(0, 8).map((k) => {
      const arr = map.get(k)!
      const values: Record<string, string> = {}
      for (const c of columns) {
        const f = arr.find((x) => x.columnName === c)
        values[c] = f ? (f.value ?? '') : ''
      }
      return values
    })
  }, [detail, columns])

  const moveCol = (c: string, dir: -1 | 1) => {
    setColOrder((prev) => {
      const arr = [...prev]
      const i = arr.indexOf(c)
      const j = i + dir
      if (i === -1 || j < 0 || j >= arr.length) return prev
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
      return arr
    })
  }

  const uploadTemplate = async () => {
    if (!tplFile) {
      toast.error('Choose an .xlsx template file first')
      return
    }
    setUploadingTpl(true)
    try {
      const form = new FormData()
      form.append('type', 'xlsx')
      form.append('file', tplFile)
      form.append('name', tplFile.name.replace(/\.xlsx$/i, ''))
      const res = await fetch('/api/templates', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      toast.success(`Template saved: columns ${data.template.headers.join(', ')}`)
      setSelectedTplId(data.template.id)
      setTplChoice('saved')
      refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setUploadingTpl(false)
    }
  }

  const saveColumnTemplate = async () => {
    if (columns.length === 0) {
      toast.error('Select at least one column')
      return
    }
    try {
      const form = new FormData()
      form.append('type', 'columns')
      form.append('name', tplName.trim() || detail?.job.title || 'Custom columns')
      form.append('columns', JSON.stringify(columns))
      const res = await fetch('/api/templates', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      toast.success('Column set saved as a template.')
      refresh()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const runExport = async () => {
    if (!detail || !jobId) return
    if (detail.report.needsReview) {
      toast.message('Heads up: some fields still need review', {
        description: `${detail.report.flaggedFields} flagged and ${detail.report.missingFields} missing value(s) will be exported empty — they were never guessed.`,
      })
    }
    setExporting(true)
    try {
      const body: Record<string, unknown> = { format }
      if (format === 'xlsx' && tplChoice === 'saved' && selectedTplId) body.templateId = selectedTplId
      if (columns.length) body.columns = columns
      const res = await fetch(`/api/jobs/${jobId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Export failed')
      setLastExport(data.export)
      toast.success(`${data.export.fileName} generated with ${data.export.rows} record(s).`)
      refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setExporting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-teal-600" aria-label="Loading" />
      </div>
    )
  }
  if (!detail) return null

  const xlsxTemplates = templates.filter((t) => t.type === 'xlsx')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Export — {detail.job.title}</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            {detail.report.totalRows} record(s) ready. Empty cells stay empty — nothing was invented.
          </p>
        </div>
        <Button variant="outline" onClick={() => setView('workspace', jobId)}>
          Back to workspace
        </Button>
      </div>

      {detail.report.needsReview && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-800 dark:text-amber-300 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
          <span>
            <strong>{detail.report.flaggedFields + detail.report.missingFields} field(s) still flagged for review.</strong> You
            can export now, but the processing report will travel with the file. Verify uncertain values in the workspace
            for maximum accuracy.
          </span>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        {/* Options */}
        <div className="space-y-4">
          <Card className="border-zinc-200 dark:border-zinc-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">1. Output format</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  aria-pressed={format === f.id}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors',
                    format === f.id
                      ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/40'
                      : 'border-zinc-200 dark:border-zinc-700 hover:border-teal-400'
                  )}
                >
                  <f.icon className={cn('h-5 w-5', format === f.id ? 'text-teal-600' : 'text-zinc-400')} aria-hidden />
                  <span className="mt-1.5 block text-sm font-medium">{f.label}</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{f.desc}</span>
                </button>
              ))}
            </CardContent>
          </Card>

          {format === 'xlsx' && (
            <Card className="border-zinc-200 dark:border-zinc-800">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">2. Excel template (optional)</CardTitle>
                <CardDescription className="text-xs">
                  Populate an existing Excel file while preserving its structure and formatting. Uploaded template columns are
                  matched by name; extracted columns not present in the template are appended on the right.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <RadioGroup value={tplChoice} onValueChange={(v) => setTplChoice(v as 'none' | 'saved' | 'upload')} className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="none" id="tpl-none" />
                    <Label htmlFor="tpl-none" className="font-normal text-sm cursor-pointer">
                      No template — generate a styled workbook
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="saved" id="tpl-saved" />
                    <Label htmlFor="tpl-saved" className="font-normal text-sm cursor-pointer">
                      Use a saved template
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="upload" id="tpl-upload" />
                    <Label htmlFor="tpl-upload" className="font-normal text-sm cursor-pointer">
                      Upload an Excel template now
                    </Label>
                  </div>
                </RadioGroup>

                {tplChoice === 'saved' && (
                  <Select value={selectedTplId} onValueChange={setSelectedTplId}>
                    <SelectTrigger aria-label="Saved Excel templates">
                      <SelectValue placeholder="Choose a template" />
                    </SelectTrigger>
                    <SelectContent>
                      {xlsxTemplates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name} — {(t.headers ?? []).join(', ')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                {tplChoice === 'upload' && (
                  <div className="space-y-2 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-3">
                    <input
                      ref={tplInputRef}
                      type="file"
                      accept=".xlsx"
                      className="sr-only"
                      onChange={(e) => setTplFile(e.target.files?.[0] ?? null)}
                      aria-label="Excel template file"
                    />
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => tplInputRef.current?.click()}>
                        <UploadCloud className="h-4 w-4 mr-1.5" aria-hidden /> Choose .xlsx file
                      </Button>
                      <span className="text-xs text-zinc-500 truncate">{tplFile?.name ?? 'No file chosen'}</span>
                    </div>
                    <Button size="sm" onClick={uploadTemplate} disabled={!tplFile || uploadingTpl}>
                      {uploadingTpl ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden /> : null}
                      Upload &amp; detect columns
                    </Button>
                    <p className="text-[11px] text-zinc-400">
                      Word and PDF template population is planned for the next milestone — Word/PDF exports are generated as
                      clean formatted documents.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="border-zinc-200 dark:border-zinc-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">{format === 'xlsx' ? '3' : '2'}. Columns to include</CardTitle>
              <CardDescription className="text-xs">Uncheck columns you do not need, reorder them, or save the set as a reusable template.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <ul className="space-y-1.5">
                {colOrder.map((c) => (
                  <li key={c} className="flex items-center gap-2 rounded-md border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5">
                    <Checkbox
                      id={`col-${c}`}
                      checked={selectedCols.has(c)}
                      onCheckedChange={(v) =>
                        setSelectedCols((prev) => {
                          const next = new Set(prev)
                          if (v) next.add(c)
                          else next.delete(c)
                          return next
                        })
                      }
                      aria-label={`Include column ${c}`}
                    />
                    <Label htmlFor={`col-${c}`} className="text-sm font-normal cursor-pointer flex-1">
                      {c}
                    </Label>
                    <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => moveCol(c, -1)} aria-label={`Move ${c} up`}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => moveCol(c, 1)} aria-label={`Move ${c} down`}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2 pt-1">
                <Input
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  placeholder="Save this column set as…"
                  className="h-8 text-xs"
                  aria-label="Column template name"
                />
                <Button size="sm" variant="outline" onClick={saveColumnTemplate}>
                  <Save className="h-3.5 w-3.5 mr-1" aria-hidden /> Save
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Preview + action */}
        <div className="space-y-4">
          <Card className="border-zinc-200 dark:border-zinc-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Preview (first {Math.min(8, previewRecords.length)} of {detail.report.totalRows} records)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-white dark:bg-zinc-950 shadow-[0_1px_0_0_#e4e4e7] dark:shadow-[0_1px_0_0_#3f3f46]">
                    <tr>
                      {columns.map((c) => (
                        <th key={c} className="px-3 py-2 text-left font-semibold text-zinc-600 dark:text-zinc-300 whitespace-nowrap">
                          {c}
                        </th>
                      ))}
                      {columns.length === 0 && <th className="px-3 py-2 text-left text-zinc-400">No columns selected</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRecords.map((vals, i) => (
                      <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800/60">
                        {columns.map((c) => (
                          <td key={c} className={cn('px-3 py-1.5 font-mono', vals[c] === '' && 'text-red-400')}>
                            {vals[c] === '' ? '(empty)' : vals[c]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="border-zinc-200 dark:border-zinc-800">
            <CardContent className="p-4 space-y-3">
              <Button className="w-full" size="lg" onClick={runExport} disabled={exporting || columns.length === 0 || detail.report.totalRows === 0}>
                {exporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : <Download className="h-4 w-4 mr-2" aria-hidden />}
                Generate {FORMATS.find((f) => f.id === format)?.label} file
              </Button>
              {lastExport && (
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm text-emerald-800 dark:text-emerald-300">
                    <CircleCheck className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="font-medium">{lastExport.fileName}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {lastExport.rows} records
                    </Badge>
                  </div>
                  <Button size="sm" asChild>
                    <a href={`/api/exports/${lastExport.id}/download`} download>
                      <Download className="h-3.5 w-3.5 mr-1" aria-hidden /> Download
                    </a>
                  </Button>
                </div>
              )}
              {jobExports.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">Earlier exports for this document</p>
                  <ul className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                    {jobExports.map((e) => (
                      <li key={e.id} className="flex items-center justify-between text-xs rounded-md border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5">
                        <span className="truncate">{e.fileName}</span>
                        <a href={`/api/exports/${e.id}/download`} download className="text-teal-600 hover:underline shrink-0 ml-2 inline-flex items-center gap-1">
                          <Download className="h-3 w-3" aria-hidden /> Download
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-[11px] text-zinc-400">
                Every export includes the processing report — flagged, missing and duplicate values are documented, never hidden.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
