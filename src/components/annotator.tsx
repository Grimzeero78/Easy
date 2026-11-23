'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { AnnotationShape, FieldView, PageMeta } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { MousePointer2, Square, Circle, PenLine, Trash2, Eye, EyeOff, Loader2, ScanSearch, Tag } from 'lucide-react'

type Tool = 'pointer' | 'rect' | 'ellipse' | 'pen'

const TEAL = '#0d9488'
const AMBER = '#d97706'
const RED = '#dc2626'

interface Props {
  page: PageMeta
  fields: FieldView[] // fields belonging to this page
  highlightFieldId: string | null
  onSaved: (annotations: AnnotationShape[]) => void
}

/** Coordinates normalized 0..1 relative to the displayed (enhanced) image. */
export function Annotator({ page, fields, highlightFieldId, onSaved }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [tool, setTool] = useState<Tool>('pointer')
  const [annotations, setAnnotations] = useState<AnnotationShape[]>(page.annotations)
  const [draft, setDraft] = useState<AnnotationShape | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showBoxes, setShowBoxes] = useState(true)
  const [variant, setVariant] = useState<'enhanced' | 'original'>('enhanced')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number } | null>(null)

  useEffect(() => {
    setAnnotations(page.annotations)
  }, [page.id, page.annotations])

  const persist = useCallback(
    async (next: AnnotationShape[]) => {
      setSaving(true)
      try {
        const res = await fetch(`/api/pages/${page.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ annotations: next }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Save failed')
        onSaved(data.annotations ?? next)
      } catch (err) {
        toast.error((err as Error).message)
      } finally {
        setSaving(false)
      }
    },
    [page.id, onSaved]
  )

  const normPos = useCallback((e: React.PointerEvent): { x: number; y: number } => {
    const rect = imgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if (variant !== 'enhanced' || tool === 'pointer') return
    e.preventDefault()
    const p = normPos(e)
    dragRef.current = { startX: p.x, startY: p.y }
    const id = crypto.randomUUID()
    if (tool === 'pen') {
      setDraft({ id, type: 'freehand', x: p.x, y: p.y, w: 0, h: 0, points: [p.x, p.y], label: '' })
    } else {
      setDraft({ id, type: tool, x: p.x, y: p.y, w: 0, h: 0, label: '' })
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current || !draft) return
    const p = normPos(e)
    const { startX, startY } = dragRef.current
    setDraft((prev) => {
      if (!prev) return prev
      if (prev.type === 'freehand') {
        return { ...prev, points: [...(prev.points ?? []), p.x, p.y] }
      }
      return {
        ...prev,
        x: Math.min(startX, p.x),
        y: Math.min(startY, p.y),
        w: Math.abs(p.x - startX),
        h: Math.abs(p.y - startY),
      }
    })
  }

  const onPointerUp = () => {
    if (!draft) {
      dragRef.current = null
      return
    }
    dragRef.current = null
    let final: AnnotationShape | null = null
    if (draft.type === 'freehand') {
      const pts = draft.points ?? []
      if (pts.length >= 6) {
        const xs: number[] = []
        const ys: number[] = []
        for (let i = 0; i < pts.length; i += 2) {
          xs.push(pts[i])
          ys.push(pts[i + 1])
        }
        const x = Math.min(...xs)
        const y = Math.min(...ys)
        final = { ...draft, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
      }
    } else if (draft.w > 0.015 && draft.h > 0.015) {
      final = draft
    }
    if (final) {
      const next = [...annotations, final]
      setAnnotations(next)
      setSelectedId(final.id)
      setTool('pointer')
      persist(next)
    }
    setDraft(null)
  }

  const removeAnnotation = (id: string) => {
    const next = annotations.filter((a) => a.id !== id)
    setAnnotations(next)
    if (selectedId === id) setSelectedId(null)
    persist(next)
  }

  const clearAll = () => {
    setAnnotations([])
    setSelectedId(null)
    persist([])
  }

  const relabel = (id: string, label: string) => {
    const next = annotations.map((a) => (a.id === id ? { ...a, label } : a))
    setAnnotations(next)
  }

  const relabelCommit = () => persist(annotations)

  /* ---------- rendering ---------- */

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img || !img.naturalWidth) return
    const rect = img.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const W = Math.max(1, Math.round(rect.width))
    const H = Math.max(1, Math.round(rect.height))
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr
      canvas.height = H * dpr
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const drawShape = (a: AnnotationShape, color: string, dash: number[] = [], lineWidth = 2.5, fill?: string) => {
      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth = lineWidth
      ctx.setLineDash(dash)
      const x = a.x * W
      const y = a.y * H
      const w = a.w * W
      const h = a.h * H
      if (a.type === 'ellipse') {
        if (fill) {
          ctx.fillStyle = fill
          ctx.beginPath()
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.beginPath()
        ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2)
        ctx.stroke()
      } else if (a.type === 'freehand' && a.points && a.points.length >= 4) {
        ctx.beginPath()
        ctx.moveTo(a.points[0] * W, a.points[1] * H)
        for (let i = 2; i < a.points.length; i += 2) ctx.lineTo(a.points[i] * W, a.points[i + 1] * H)
        ctx.stroke()
      } else {
        if (fill) {
          ctx.fillStyle = fill
          ctx.fillRect(x, y, w, h)
        }
        ctx.strokeRect(x, y, w, h)
      }
      if (a.label && a.label.trim()) {
        ctx.setLineDash([])
        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'
        const text = a.label.trim().slice(0, 26)
        const tw = ctx.measureText(text).width + 8
        ctx.fillStyle = color
        ctx.fillRect(x, Math.max(0, y - 16), tw, 15)
        ctx.fillStyle = '#ffffff'
        ctx.fillText(text, x + 4, Math.max(11, y - 4.5))
      }
      ctx.restore()
    }

    // user annotations
    for (const a of annotations) {
      drawShape(a, selectedId === a.id ? RED : TEAL, selectedId === a.id ? [6, 4] : [], 2.5, 'rgba(13,148,136,0.08)')
    }
    if (draft) drawShape(draft, TEAL, [4, 3], 2)

    // extracted-field traceability boxes
    if (variant === 'enhanced' && showBoxes) {
      for (const f of fields) {
        if (!f.bbox) continue
        const highlighted = f.id === highlightFieldId
        drawShape(
          { id: f.id, type: 'rect', x: f.bbox[0], y: f.bbox[1], w: f.bbox[2], h: f.bbox[3], label: highlighted ? `${f.columnName}: ${f.value ?? '?'}` : f.columnName },
          highlighted ? RED : AMBER,
          [],
          highlighted ? 3 : 1.5,
          highlighted ? 'rgba(220,38,38,0.12)' : undefined
        )
      }
    }
  }, [annotations, draft, selectedId, fields, showBoxes, highlightFieldId, variant])

  useEffect(() => {
    draw()
    const img = imgRef.current
    if (!img) return
    const onResize = () => draw()
    const ro = new ResizeObserver(onResize)
    if (wrapRef.current) ro.observe(wrapRef.current)
    window.addEventListener('resize', onResize)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [draw])

  // Redraw once the image finishes loading (natural size available)
  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    if (img.complete && img.naturalWidth) setLoaded(true)
  }, [page.id])

  useEffect(() => {
    if (loaded) draw()
  }, [loaded, draw])

  const editable = variant === 'enhanced'
  const selected = annotations.find((a) => a.id === selectedId)

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={tool === 'pointer' ? 'default' : 'outline'}
          aria-pressed={tool === 'pointer'}
          onClick={() => setTool('pointer')}
          disabled={!editable}
          title="Select / pan"
        >
          <MousePointer2 className="h-4 w-4" aria-hidden />
        </Button>
        <Button size="sm" variant={tool === 'rect' ? 'default' : 'outline'} onClick={() => setTool('rect')} disabled={!editable} title="Draw a rectangle around a column, row or section">
          <Square className="h-4 w-4" aria-hidden />
        </Button>
        <Button size="sm" variant={tool === 'ellipse' ? 'default' : 'outline'} onClick={() => setTool('ellipse')} disabled={!editable} title="Circle a column, number or section">
          <Circle className="h-4 w-4" aria-hidden />
        </Button>
        <Button size="sm" variant={tool === 'pen' ? 'default' : 'outline'} onClick={() => setTool('pen')} disabled={!editable} title="Freehand marking">
          <PenLine className="h-4 w-4" aria-hidden />
        </Button>
        <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden />
        <Button
          size="sm"
          variant={showBoxes ? 'default' : 'outline'}
          onClick={() => setShowBoxes((s) => !s)}
          title="Show where each extracted value was found on the page"
        >
          <ScanSearch className="h-4 w-4 mr-1.5" aria-hidden />
          Field locations
        </Button>
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-700 overflow-hidden ml-1" role="group" aria-label="Image version">
          <button
            className={cn('px-2.5 py-1.5 text-xs font-medium', variant === 'enhanced' ? 'bg-teal-600 text-white' : 'bg-white dark:bg-zinc-900')}
            onClick={() => setVariant('enhanced')}
          >
            Enhanced
          </button>
          <button
            className={cn('px-2.5 py-1.5 text-xs font-medium', variant === 'original' ? 'bg-teal-600 text-white' : 'bg-white dark:bg-zinc-900')}
            onClick={() => setVariant('original')}
          >
            Original
          </button>
        </div>
        <span className="flex-1" />
        {saving && <Loader2 className="h-4 w-4 animate-spin text-teal-600" aria-label="Saving markings" />}
        {annotations.length > 0 && editable && (
          <Button size="sm" variant="ghost" onClick={clearAll}>
            <Trash2 className="h-4 w-4 mr-1" aria-hidden /> Clear markings
          </Button>
        )}
      </div>

      {/* Image + canvas overlay */}
      <div ref={wrapRef} className="relative rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden bg-white dark:bg-zinc-950">
        <img
          key={variant}
          ref={imgRef}
          src={`/api/pages/${page.id}/image${variant === 'original' ? '?variant=original' : ''}`}
          alt={`Page ${page.order + 1}: ${page.fileName}`}
          className="block w-full select-none"
          draggable={false}
          onLoad={() => setLoaded(true)}
        />
        <canvas
          ref={canvasRef}
          className={cn(
            'absolute inset-0 w-full h-full',
            editable && tool !== 'pointer' ? 'cursor-crosshair' : 'cursor-default'
          )}
          style={{ touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />
        {tool !== 'pointer' && editable && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-teal-600 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg pointer-events-none">
            {tool === 'rect' && 'Drag to draw a rectangle around the area you want extracted'}
            {tool === 'ellipse' && 'Drag to circle a column, value or section'}
            {tool === 'pen' && 'Draw freely around the region of interest'}
          </div>
        )}
        {variant === 'original' && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-zinc-900/80 text-white text-xs px-3 py-1.5 rounded-full shadow pointer-events-none">
            Viewing original capture — switch to Enhanced to annotate and see field locations
          </div>
        )}
      </div>

      {/* Annotation list */}
      {annotations.length > 0 && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
            <Tag className="h-3.5 w-3.5" aria-hidden /> Marked regions ({annotations.length}) — these tell the AI what to extract. Optional labels help it understand each region.
          </p>
          <ul className="space-y-1.5">
            {annotations.map((a, i) => (
              <li key={a.id} className={cn('flex items-center gap-2 rounded-md px-2 py-1.5', selectedId === a.id ? 'bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900' : 'bg-zinc-50 dark:bg-zinc-900')}>
                <span className="text-xs text-zinc-400 w-14 shrink-0">
                  {i + 1}. {a.type === 'rect' ? 'Rectangle' : a.type === 'ellipse' ? 'Circle' : 'Freehand'}
                </span>
                <Input
                  value={a.label ?? ''}
                  placeholder="e.g. registration number column"
                  className="h-7 text-xs"
                  onChange={(e) => relabel(a.id, e.target.value)}
                  onBlur={relabelCommit}
                  aria-label={`Label for region ${i + 1}`}
                />
                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={`Delete region ${i + 1}`} onClick={() => removeAnnotation(a.id)}>
                  <Trash2 className="h-3.5 w-3.5 text-zinc-400 hover:text-red-600" />
                </Button>
              </li>
            ))}
          </ul>
          {selected && (
            <p className="text-[11px] text-red-600 dark:text-red-400">Region highlighted in red on the image.</p>
          )}
        </div>
      )}

      {tool === 'pointer' && editable && annotations.length === 0 && (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 flex items-center gap-1.5">
          <Eye className="h-3.5 w-3.5" aria-hidden />
          Tip: pick the rectangle, circle or pen tool to mark exactly which columns or values the AI should extract. Natural-language instructions below work with or without markings.
        </p>
      )}
    </div>
  )
}
