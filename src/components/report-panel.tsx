'use client'

import type { JobReport } from '@/lib/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { CircleCheck, AlertTriangle, FileWarning, Copy, Pencil, ScanSearch } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ReportPanel({ report }: { report: JobReport }) {
  const pct = Math.round(report.avgConfidence * 100)
  return (
    <div className="space-y-4">
      <Card className={cn('border-zinc-200 dark:border-zinc-800', report.needsReview ? 'border-amber-300 dark:border-amber-800' : 'border-emerald-200 dark:border-emerald-800')}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            {report.needsReview ? (
              <>
                <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden /> Processing report — human review recommended
              </>
            ) : (
              <>
                <CircleCheck className="h-4 w-4 text-emerald-600" aria-hidden /> Processing report — all checks passed
              </>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-1.5">
            {report.summary.map((s, i) => (
              <li key={i} className="text-sm text-zinc-600 dark:text-zinc-300 flex items-start gap-2">
                <span className={cn('mt-1 h-1.5 w-1.5 rounded-full shrink-0', report.needsReview ? 'bg-amber-500' : 'bg-emerald-500')} aria-hidden />
                {s}
              </li>
            ))}
          </ul>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Metric icon={<Pencil className="h-3.5 w-3.5" />} label="Avg. confidence" value={`${pct}%`} bar={pct} good={pct >= 85} />
            <Metric icon={<AlertTriangle className="h-3.5 w-3.5" />} label="Flagged fields" value={String(report.flaggedFields)} warn={report.flaggedFields > 0} />
            <Metric icon={<FileWarning className="h-3.5 w-3.5" />} label="Missing values" value={String(report.missingFields)} warn={report.missingFields > 0} />
            <Metric icon={<Copy className="h-3.5 w-3.5" />} label="Duplicates" value={String(report.duplicateRows)} warn={report.duplicateRows > 0} />
          </div>

          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {report.totalRows} record(s) · {report.uniqueRows} unique · {report.totalFields} field(s) · {report.editedFields} human-verified
          </div>
        </CardContent>
      </Card>

      <Card className="border-zinc-200 dark:border-zinc-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ScanSearch className="h-4 w-4 text-teal-600" aria-hidden /> Page-by-page
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-left text-xs text-zinc-500 dark:text-zinc-400">
                <th className="px-4 py-2 font-medium">Page</th>
                <th className="px-3 py-2 font-medium">Records</th>
                <th className="px-3 py-2 font-medium">Visible</th>
                <th className="px-3 py-2 font-medium">Flagged</th>
                <th className="px-3 py-2 font-medium">Missing</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {report.pages.map((p) => (
                <tr key={p.pageIndex} className="border-b border-zinc-100 dark:border-zinc-800/60 last:border-0">
                  <td className="px-4 py-2">
                    <span className="font-medium">Page {p.pageIndex + 1}</span>
                    <span className="block text-[11px] text-zinc-400 truncate max-w-52">{p.fileName}</span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{p.rows}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {p.visibleRecordCount ?? '—'}
                    {p.countMismatch && (
                      <Badge variant="outline" className="ml-1.5 bg-red-50 text-red-700 border-red-200 text-[10px] dark:bg-red-950 dark:text-red-300 dark:border-red-800">
                        mismatch
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{p.flagged || '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{p.missing || '—'}</td>
                  <td className="px-4 py-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[10px]',
                        p.status === 'extracted' && 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
                        p.status === 'blocked' && 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800',
                        p.status === 'failed' && 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800',
                        p.status !== 'extracted' && p.status !== 'blocked' && p.status !== 'failed' && 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                      )}
                    >
                      {p.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}

function Metric({
  icon,
  label,
  value,
  bar,
  warn,
  good,
}: {
  icon: React.ReactNode
  label: string
  value: string
  bar?: number
  warn?: boolean
  good?: boolean
}) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
      <div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        {icon}
        {label}
      </div>
      <div className={cn('mt-1 text-lg font-semibold', warn ? 'text-amber-600 dark:text-amber-400' : good === false ? 'text-amber-600 dark:text-amber-400' : '')}>
        {value}
      </div>
      {bar !== undefined && (
        <Progress value={bar} className="mt-1.5 h-1.5" aria-label={`${bar}% average confidence`} />
      )}
    </div>
  )
}
