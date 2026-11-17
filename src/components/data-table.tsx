'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { FieldView } from '@/lib/types'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { Crosshair, ChevronDown, Check, AlertTriangle, FileWarning } from 'lucide-react'

interface Props {
  fields: FieldView[]
  onLocate: (fieldId: string | null) => void
  onChanged: () => void
}

interface RecordGroup {
  key: string
  pageIndex: number
  rowIndex: number
  fields: FieldView[]
  duplicate: boolean
}

export function DataTable({ fields, onLocate, onChanged }: Props) {
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())

  const columns = useMemo(() => {
    const cols: string[] = []
    for (const f of fields) if (!cols.includes(f.columnName)) cols.push(f.columnName)
    return cols
  }, [fields])

  const records = useMemo<RecordGroup[]>(() => {
    const map = new Map<string, FieldView[]>()
    for (const f of fields) {
      const k = `${f.pageIndex}:${f.rowIndex}`
      const arr = map.get(k) ?? []
      arr.push(f)
      map.set(k, arr)
    }
    return [...map.entries()]
      .sort((a, b) => {
        const [pa, ra] = a[0].split(':').map(Number)
        const [pb, rb] = b[0].split(':').map(Number)
        return pa - pb || ra - rb
      })
      .map(([key, arr]) => ({
        key,
        pageIndex: arr[0].pageIndex,
        rowIndex: arr[0].rowIndex,
        fields: columns.map((c) => arr.find((f) => f.columnName === c) ?? ({} as FieldView)),
        duplicate: arr.some((f) => f.duplicate),
      }))
  }, [fields, columns])

  const save = async (f: FieldView, value: string) => {
    if (!f.id) return
    setSavingIds((prev) => new Set(prev).add(f.id))
    try {
      const res = await fetch(`/api/fields/${f.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      })
      if (!res.ok) throw new Error('Save failed')
      toast.success('Value verified and saved.')
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev)
        next.delete(f.id)
        return next
      })
    }
  }

  const acceptAlternative = async (f: FieldView, alt: string) => {
    setSavingIds((prev) => new Set(prev).add(f.id))
    try {
      const res = await fetch(`/api/fields/${f.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptAlternative: alt }),
      })
      if (!res.ok) throw new Error('Save failed')
      toast.success(`Accepted "${alt}".`)
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev)
        next.delete(f.id)
        return next
      })
    }
  }

  const locate = (rec: RecordGroup) => {
    const withBox = rec.fields.find((f) => f.bbox)
    onLocate(withBox?.id ?? rec.fields[0]?.id ?? null)
  }

  if (!fields.length) {
    return (
      <p className="text-sm text-zinc-400 dark:text-zinc-500 py-10 text-center">
        No extracted data yet. Add instructions and run the AI extraction.
      </p>
    )
  }

  return (
    <ScrollArea className="max-h-[560px] overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-sm border-collapse" aria-label="Extracted records with verification status">
        <thead className="sticky top-0 z-10 bg-white dark:bg-zinc-950 shadow-[0_1px_0_0_#e4e4e7] dark:shadow-[0_1px_0_0_#3f3f46]">
          <tr>
            <th className="w-10 px-2 py-2 text-left text-xs font-medium text-zinc-400">#</th>
            {columns.map((c) => (
              <th key={c} className="px-3 py-2 text-left text-xs font-semibold text-zinc-600 dark:text-zinc-300 whitespace-nowrap">
                {c}
              </th>
            ))}
            <th className="w-12 px-2 py-2 text-right text-xs font-medium text-zinc-400">Find</th>
          </tr>
        </thead>
        <tbody>
          {records.map((rec, i) => {
            const flaggedRow = rec.fields.some((f) => f && (f.uncertain || f.missing))
            const lowConf = rec.fields.some((f) => f && f.confidence < 0.7 && !f.edited)
            return (
              <tr
                key={rec.key}
                className={cn(
                  'border-t border-zinc-100 dark:border-zinc-800/60',
                  rec.duplicate && 'bg-red-50/70 dark:bg-red-950/30',
                  rec.duplicate && 'border-l-4 border-l-red-500'
                )}
              >
                <td className="px-2 py-1.5 align-top text-xs text-zinc-400">{i + 1}</td>
                {rec.fields.map((f) => {
                  if (!f || !f.id) {
                    return (
                      <td key={`${rec.key}-empty`} className="px-3 py-1.5 text-zinc-300 dark:text-zinc-600">—</td>
                    )
                  }
                  const display = overrides[f.id] ?? f.value ?? ''
                  const cellFlag =
                    f.missing || display === ''
                      ? 'missing'
                      : f.uncertain && !f.edited
                        ? 'uncertain'
                        : f.confidence < 0.7 && !f.edited
                          ? 'lowconf'
                          : f.edited
                            ? 'edited'
                            : 'ok'
                  return (
                    <td key={f.id} className="px-1.5 py-1.5 align-top">
                      <div className="flex items-center gap-1.5">
                        <Input
                          value={display}
                          aria-label={`${f.columnName} for record ${i + 1}`}
                          onChange={(e) => setOverrides((prev) => ({ ...prev, [f.id]: e.target.value }))}
                          onBlur={(e) => {
                            if (e.target.value !== (f.value ?? '')) save(f, e.target.value)
                          }}
                          className={cn(
                            'h-8 text-sm',
                            cellFlag === 'uncertain' && 'border-amber-400 bg-amber-50 dark:bg-amber-950/40 focus:border-amber-500',
                            cellFlag === 'lowconf' && 'border-amber-200 bg-amber-50/50 dark:bg-amber-950/20',
                            cellFlag === 'missing' && 'border-red-300 bg-red-50 dark:bg-red-950/40 placeholder:text-red-400 focus:border-red-500',
                            cellFlag === 'edited' && 'border-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20'
                          )}
                        />
                        {cellFlag === 'uncertain' && (
                          <span title={`Uncertain: ${f.reason ?? 'ambiguous characters'}`}>
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" aria-label="Uncertain value" />
                          </span>
                        )}
                        {cellFlag === 'missing' && (
                          <span title={`Missing: ${f.reason ?? 'unreadable in source'}`}>
                            <FileWarning className="h-3.5 w-3.5 text-red-500 shrink-0" aria-label="Missing value" />
                          </span>
                        )}
                        {f.alternatives.length > 0 && (
                          <Popover>
                            <PopoverTrigger asChild>
                              <button
                                className="shrink-0 inline-flex items-center gap-0.5 rounded-md bg-amber-100 hover:bg-amber-200 dark:bg-amber-900/50 dark:hover:bg-amber-900 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300"
                                title="The AI found several possible readings — pick the correct one"
                              >
                                {f.alternatives.length} alt.
                                <ChevronDown className="h-3 w-3" aria-hidden />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-56 p-2" align="start">
                              <p className="text-xs font-medium mb-1.5">Possible readings for this value:</p>
                              <ul className="space-y-1">
                                {f.alternatives.map((alt) => (
                                  <li key={alt}>
                                    <button
                                      className="w-full text-left text-sm rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1.5 hover:border-teal-500 hover:bg-teal-50 dark:hover:bg-teal-950/40 font-mono"
                                      onClick={() => acceptAlternative(f, alt)}
                                    >
                                      {alt}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                              <p className="text-[11px] text-zinc-400 mt-2">Compare with the original image before choosing.</p>
                            </PopoverContent>
                          </Popover>
                        )}
                        <span
                          className={cn(
                            'shrink-0 text-[10px] tabular-nums px-1 rounded',
                            f.confidence >= 0.85
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : f.confidence >= 0.7
                                ? 'text-zinc-400'
                                : 'text-amber-600 dark:text-amber-400'
                          )}
                          title={`AI confidence: ${Math.round(f.confidence * 100)}%${f.edited ? ' (human-verified)' : ''}`}
                        >
                          {Math.round(f.confidence * 100)}%
                          {f.edited && <Check className="h-2.5 w-2.5 inline ml-0.5 text-emerald-600" aria-label="Human verified" />}
                        </span>
                      </div>
                    </td>
                  )
                })}
                <td className="px-2 py-1.5 text-right align-top">
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Show on page image" onClick={() => locate(rec)} title="Locate this record on the page">
                    <Crosshair className="h-4 w-4 text-zinc-400 hover:text-teal-600" />
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {(records.some((r) => r.duplicate) || records.some((r) => r.fields.some((f) => f && (f.uncertain || f.missing) && !f.edited))) && (
        <div className="px-3 py-2.5 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 text-[11px] text-zinc-500 dark:text-zinc-400 flex flex-wrap gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="h-3 w-3 text-amber-500" /> Amber = uncertain / low confidence — verify against the image
          </span>
          <span className="inline-flex items-center gap-1">
            <Badge variant="outline" className="h-4 px-1 text-[9px] bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800">
              red row
            </Badge>
            = duplicate of another record
          </span>
        </div>
      )}
    </ScrollArea>
  )
}
