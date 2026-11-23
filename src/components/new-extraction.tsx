'use client'

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/lib/store'
import type { ImageQuality } from '@/lib/types'
import { CF_MODE, assessQualityBlob, enhanceToBlob, normalizeToBlob } from '@/lib/client-image'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import {
  Camera,
  UploadCloud,
  ReceiptText,
  Trash2,
  CircleCheck,
  AlertTriangle,
  XCircle,
  ArrowRight,
  Loader2,
  FileImage,
  Info,
} from 'lucide-react'

interface UploadedPage {
  id: string
  order: number
  fileName: string
  width: number
  height: number
  status: string
  quality: ImageQuality
}

export function NewExtraction() {
  const setView = useAppStore((s) => s.setView)
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<'general' | 'cashier'>('general')
  const [jobId, setJobId] = useState<string | null>(null)
  const [pages, setPages] = useState<UploadedPage[]>([])
  const [busy, setBusy] = useState(false)
  const [progressText, setProgressText] = useState('')
  const [progressPct, setProgressPct] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const ensureJob = useCallback(async (): Promise<string | null> => {
    if (jobId) return jobId
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() || 'Untitled extraction', mode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create job')
      setJobId(data.job.id)
      return data.job.id as string
    } catch (err) {
      toast.error((err as Error).message)
      return null
    }
  }, [jobId, title, mode])

  const uploadPage = useCallback(
    async (id: string, blob: Blob, fileName: string) => {
      const form = new FormData()
      if (CF_MODE) {
        // Cloudflare Workers cannot run sharp: the browser runs the quality gate
        // (same metrics/thresholds as the server engine) and prepares the
        // enhanced reading copy before upload.
        const norm = await normalizeToBlob(blob)
        const [enhanced, quality] = await Promise.all([
          enhanceToBlob(norm.blob),
          assessQualityBlob(norm.blob),
        ])
        form.append('file', norm.blob, 'page.jpg')
        form.append('enhanced', enhanced, 'enhanced.jpg')
        form.append('fileName', fileName)
        form.append('quality', JSON.stringify(quality))
        form.append('width', String(quality.width))
        form.append('height', String(quality.height))
      } else {
        form.append('file', blob, 'page.jpg')
        form.append('fileName', fileName)
      }
      const res = await fetch(`/api/jobs/${id}/pages`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      const page = data.page as UploadedPage
      setPages((prev) => [...prev, page])
      if (page.quality.verdict === 'fail') {
        toast.warning(`"${fileName}" failed the quality check — retake this picture.`, {
          description: page.quality.issues.map((i) => i.message).join(' '),
        })
      } else if (page.quality.verdict === 'warn') {
        toast.message(`"${fileName}" has quality warnings`, {
          description: page.quality.issues.map((i) => i.message).join(' '),
        })
      }
      return page
    },
    []
  )

  /** Downscale large photos client-side to keep uploads fast (server re-checks quality). */
  const normalizeImageFile = useCallback(async (file: File): Promise<Blob> => {
    if (!file.type.startsWith('image/')) return file
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
      const max = 2400
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
      if (scale < 1 || file.size > 3_000_000) {
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(bmp.width * scale))
        canvas.height = Math.max(1, Math.round(bmp.height * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) return file
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.92))
        if (blob) return blob
      }
      return file
    } catch {
      return file
    }
  }, [])

  /** Render PDF pages to images client-side (multipage PDFs become ordered pages). */
  const pdfToPageBlobs = useCallback(async (file: File): Promise<{ blob: Blob; name: string }[]> => {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
    const data = await file.arrayBuffer()
    const loadingTask = pdfjs.getDocument({ data })
    const doc = await loadingTask.promise
    const out: { blob: Blob; name: string }[] = []
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(3, 2000 / Math.max(base.width, base.height))
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)
        const ctx = canvas.getContext('2d')
        if (!ctx) continue
        await page.render({ canvas, canvasContext: ctx, viewport } as never).promise
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.92))
        if (blob) {
          out.push({ blob, name: `${file.name.replace(/\.pdf$/i, '')} — page ${i} of ${doc.numPages}` })
        }
      }
    } finally {
      try {
        await loadingTask.destroy()
      } catch {
        /* non-fatal */
      }
    }
    return out
  }, [])

  const handleFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return
      setBusy(true)
      setProgressPct(0)
      try {
        const id = await ensureJob()
        if (!id) return
        const files = Array.from(fileList)
        // Upload order preserved: files in selection order, PDF pages in page order
        let done = 0
        const totalUnits = files.length
        for (const file of files) {
          setProgressText(`Processing ${file.name}…`)
          if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
            const pageBlobs = await pdfToPageBlobs(file)
            for (const pb of pageBlobs) {
              setProgressText(`Uploading ${pb.name}…`)
              await uploadPage(id, pb.blob, pb.name)
            }
          } else if (file.type.startsWith('image/')) {
            const blob = await normalizeImageFile(file)
            await uploadPage(id, blob, file.name)
          } else {
            toast.error(`Unsupported file type: ${file.name}`, {
              description: 'Upload photos (JPG/PNG/WebP), screenshots, scans or PDF documents.',
            })
          }
          done++
          setProgressPct(Math.round((done / totalUnits) * 100))
        }
        toast.success('Upload complete — quality check finished for every page.')
      } catch (err) {
        toast.error((err as Error).message)
      } finally {
        setBusy(false)
        setProgressText('')
        if (fileInputRef.current) fileInputRef.current.value = ''
        if (cameraInputRef.current) cameraInputRef.current.value = ''
      }
    },
    [ensureJob, uploadPage, normalizeImageFile, pdfToPageBlobs]
  )

  const removePage = async (pid: string) => {
    try {
      await fetch(`/api/pages/${pid}`, { method: 'DELETE' })
      setPages((prev) => prev.filter((p) => p.id !== pid))
    } catch {
      toast.error('Could not remove page')
    }
  }

  const blocked = pages.filter((p) => p.quality.verdict === 'fail').length
  const proceed = () => {
    if (!jobId || pages.length === 0) return
    setView('workspace', jobId)
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New extraction</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Capture or upload documents. Every page passes an automatic quality check before AI processing — blurry,
          dark or unreadable pictures are rejected so nothing is ever misread silently.
        </p>
      </div>

      <Card className="border-zinc-200 dark:border-zinc-800">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">1. Document details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="job-title">Document batch name</Label>
              <Input
                id="job-title"
                placeholder="e.g. ACS 101 class register — Week 6"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={!!jobId}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Extraction mode</Label>
              <RadioGroup
                value={mode}
                onValueChange={(v) => setMode(v as 'general' | 'cashier')}
                className="flex gap-4"
                disabled={!!jobId}
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="general" id="mode-general" />
                  <Label htmlFor="mode-general" className="font-normal text-sm cursor-pointer">
                    General documents
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="cashier" id="mode-cashier" />
                  <Label htmlFor="mode-cashier" className="font-normal text-sm cursor-pointer">
                    <span className="inline-flex items-center gap-1">
                      <ReceiptText className="h-3 w-3 text-teal-600" aria-hidden /> Cashier &amp; financial
                    </span>
                  </Label>
                </div>
              </RadioGroup>
            </div>
          </div>
          {jobId && (
            <p className="text-xs text-zinc-400 dark:text-zinc-500 inline-flex items-center gap-1">
              <Info className="h-3 w-3" /> Batch created. You can add more pages to this job.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="border-zinc-200 dark:border-zinc-800">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">2. Capture or upload</CardTitle>
          <CardDescription>
            Phone camera pictures, existing photos, scans, screenshots and PDF files. Multipage documents are supported.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            role="button"
            tabIndex={0}
            aria-label="Upload documents"
            className={cn(
              'border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer',
              dragOver ? 'border-teal-500 bg-teal-50/50 dark:bg-teal-950/30' : 'border-zinc-300 dark:border-zinc-700 hover:border-teal-500/60'
            )}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (!busy) handleFiles(e.dataTransfer.files)
            }}
          >
            <UploadCloud className="h-10 w-10 mx-auto text-teal-600" aria-hidden />
            <p className="mt-3 text-sm font-medium">Drop images or PDFs here, or click to browse</p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              JPG · PNG · WebP · PDF — multiple files welcome
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              className="sr-only"
              onChange={(e) => handleFiles(e.target.files)}
              disabled={busy}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => cameraInputRef.current?.click()} disabled={busy}>
              <Camera className="h-4 w-4 mr-2" aria-hidden /> Take a picture
            </Button>
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(e) => handleFiles(e.target.files)}
              disabled={busy}
              aria-label="Camera capture"
            />
            {busy && (
              <div className="flex-1 min-w-48 flex items-center gap-3">
                <Loader2 className="h-4 w-4 animate-spin text-teal-600" aria-hidden />
                <span className="text-sm text-zinc-500 dark:text-zinc-400 truncate flex-1">{progressText}</span>
                <Progress value={progressPct} className="w-28" />
              </div>
            )}
          </div>

          {pages.length > 0 && (
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">
                  Pages ({pages.length}) {blocked > 0 && <span className="text-red-600">· {blocked} blocked by quality check</span>}
                </h3>
                <Button size="sm" onClick={proceed}>
                  Continue to workspace <ArrowRight className="h-4 w-4 ml-1.5" aria-hidden />
                </Button>
              </div>
              <ul className="space-y-2">
                {pages.map((p) => (
                  <li key={p.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0">
                        {p.quality.verdict === 'pass' ? (
                          <CircleCheck className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" aria-label="Quality passed" />
                        ) : p.quality.verdict === 'warn' ? (
                          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" aria-label="Quality warning" />
                        ) : (
                          <XCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" aria-label="Quality failed" />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium truncate flex items-center gap-1.5">
                              <FileImage className="h-3.5 w-3.5 text-zinc-400" /> {p.fileName}
                            </span>
                            <Badge variant="outline" className="text-[10px]">
                              {p.width}×{p.height}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[10px]',
                                p.quality.verdict === 'pass' && 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
                                p.quality.verdict === 'warn' && 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
                                p.quality.verdict === 'fail' && 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800'
                              )}
                            >
                              {p.quality.verdict === 'pass' ? 'Quality: good' : p.quality.verdict === 'warn' ? 'Quality: usable with care' : 'Quality: retake needed'}
                            </Badge>
                          </div>
                          {(p.quality.issues.length > 0 || p.quality.verdict === 'pass') && (
                            <ul className="mt-1.5 space-y-1">
                              {p.quality.issues.map((iss) => (
                                <li
                                  key={iss.code}
                                  className={cn('text-xs', iss.severity === 'fail' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400')}
                                >
                                  {iss.message}
                                </li>
                              ))}
                              {p.quality.verdict === 'fail' && (
                                <li className="text-xs font-medium text-red-700 dark:text-red-400 mt-1">
                                  This page is blocked from AI extraction. Delete it and retake the picture — sharper,
                                  in better light, with the whole document visible.
                                </li>
                              )}
                            </ul>
                          )}
                        </div>
                      </div>
                      <Button size="icon" variant="ghost" aria-label="Remove page" onClick={() => removePage(p.id)}>
                        <Trash2 className="h-4 w-4 text-zinc-400 hover:text-red-600" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}


