import { db } from '@/lib/db'
import { computeMoneyTotals, type MoneyRecord } from '@/lib/money'
import type { MoneyTotals } from '@/lib/types'

/**
 * Verification engine — accuracy and data integrity checks over extracted fields.
 * - confidence tracking per field
 * - missing value detection
 * - duplicate record detection (across pages, based on row key or ID-like columns)
 * - record count mismatch detection (visible vs extracted)
 * - per-page statistics -> clear processing report
 */

export interface FieldView {
  id: string
  pageIndex: number
  rowIndex: number
  columnName: string
  value: string | null
  confidence: number
  uncertain: boolean
  missing: boolean
  alternatives: string[]
  bbox: [number, number, number, number] | null
  reason: string | null
  edited: boolean
  duplicate: boolean
}

export interface PageReport {
  pageIndex: number
  fileName: string
  rows: number
  flagged: number
  missing: number
  visibleRecordCount: number | null
  countMismatch: boolean
  warnings: string[]
  qualityVerdict: string
  status: string
}

export interface JobReport {
  totalFields: number
  totalRows: number
  uniqueRows: number
  duplicateRows: number
  flaggedFields: number
  missingFields: number
  editedFields: number
  avgConfidence: number
  columns: string[]
  duplicateRowIndexes: { pageIndex: number; rowIndex: number }[]
  pages: PageReport[]
  needsReview: boolean
  summary: string[]
  /** Auto-detected monetary columns with summed totals (null when no money found). */
  moneyTotals: MoneyTotals | null
}

function normalizeKey(v: string | null) {
  return (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export async function computeJobReport(jobId: string): Promise<JobReport> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { pages: { orderBy: { order: 'asc' } }, fields: true },
  })
  if (!job) throw new Error('Job not found')

  const fields = job.fields
  const columns: string[] = []
  for (const f of fields) {
    if (!columns.includes(f.columnName)) columns.push(f.columnName)
  }

  // Group fields into records
  const byRecord = new Map<string, typeof fields>()
  for (const f of fields) {
    const k = `${f.pageIndex}:${f.rowIndex}`
    const arr = byRecord.get(k) ?? []
    arr.push(f)
    byRecord.set(k, arr)
  }

  // Duplicate detection across ALL records in the job.
  // Primary key = all values concatenated. Also treat an ID-like column
  // (id / reg / receipt / ref / transaction) as a strong duplicate signal.
  const idLikeRe = /(^|\W)(id|no\.?|number|reg(istration)?|receipt|ref(erence)?|transaction|invoice|code)(\W|$)/i
  const idColumns = columns.filter((c) => idLikeRe.test(c))
  const seen = new Map<string, { pageIndex: number; rowIndex: number }>()
  const duplicateKeys = new Set<string>()
  const duplicateRowIndexes: { pageIndex: number; rowIndex: number }[] = []

  const recordKeys: { key: string; pageIndex: number; rowIndex: number; fieldIds: string[] }[] = []
  for (const [k, arr] of byRecord) {
    const vals = arr.map((f) => ({ col: f.columnName, v: normalizeKey(f.value) }))
    const key = vals.map((x) => x.v).join('|')
    const idKey = vals
      .filter((x) => idColumns.includes(x.col))
      .map((x) => x.v)
      .join('|')
    const [pi, ri] = k.split(':').map(Number)
    const strong = idKey && idColumns.length > 0 ? `id:${idKey}` : null
    recordKeys.push({ key, pageIndex: pi, rowIndex: ri, fieldIds: arr.map((f) => f.id) })
    const hit = seen.get(key)
    if (hit) {
      duplicateKeys.add(key)
      duplicateRowIndexes.push({ pageIndex: pi, rowIndex: ri })
    } else {
      seen.set(key, { pageIndex: pi, rowIndex: ri })
    }
    if (strong) {
      const idHit = seen.get(strong)
      if (idHit) {
        duplicateKeys.add(key)
        duplicateRowIndexes.push({ pageIndex: pi, rowIndex: ri })
      } else {
        seen.set(strong, { pageIndex: pi, rowIndex: ri })
      }
    }
  }
  // Mark duplicate flags on fields
  const dupFieldIds = new Set<string>()
  for (const rk of recordKeys) {
    if (duplicateKeys.has(rk.key)) rk.fieldIds.forEach((id) => dupFieldIds.add(id))
  }
  await db.field.updateMany({ where: { jobId, id: { in: [...dupFieldIds] } }, data: { duplicate: true } })
  await db.field.updateMany({
    where: { jobId, id: { notIn: [...dupFieldIds] } },
    data: { duplicate: false },
  })

  // Field-level stats
  const flaggedFields = fields.filter((f) => (f.uncertain || f.confidence < 0.7) && !f.edited).length
  const missingFields = fields.filter((f) => f.missing || f.value === null || f.value === '').length
  const editedFields = fields.filter((f) => f.edited).length
  const avgConfidence = fields.length ? fields.reduce((s, f) => s + f.confidence, 0) / fields.length : 0

  // Per-page breakdown + count mismatch detection
  const extractionByPage = new Map<number, { visibleRecordCount: number | null; warnings: string[] }>()
  for (const p of job.pages) {
    if (p.extraction) {
      try {
        const ex = JSON.parse(p.extraction) as { visibleRecordCount?: number | null; warnings?: string[] }
        extractionByPage.set(p.order, {
          visibleRecordCount: ex.visibleRecordCount ?? null,
          warnings: ex.warnings ?? [],
        })
      } catch {
        /* ignore malformed */
      }
    }
  }

  const pages: PageReport[] = job.pages.map((p) => {
    let rows = 0
    let flagged = 0
    let missing = 0
    for (const [k, arr] of byRecord) {
      const [pi] = k.split(':').map(Number)
      if (pi !== p.order) continue
      rows++
      flagged += arr.filter((f) => (f.uncertain || f.confidence < 0.7) && !f.edited).length
      missing += arr.filter((f) => f.missing || f.value === null || f.value === '').length
    }
    const ex = extractionByPage.get(p.order)
    const countMismatch = ex?.visibleRecordCount != null && rows > 0 && rows !== ex.visibleRecordCount
    return {
      pageIndex: p.order,
      fileName: p.fileName,
      rows,
      flagged,
      missing,
      visibleRecordCount: ex?.visibleRecordCount ?? null,
      countMismatch,
      warnings: ex?.warnings ?? [],
      qualityVerdict: (() => {
        try {
          return (JSON.parse(p.qualityJson) as { verdict?: string }).verdict ?? 'unknown'
        } catch {
          return 'unknown'
        }
      })(),
      status: p.status,
    }
  })

  const uniqueRows = byRecord.size - duplicateRowIndexes.length

  // Money totals — detect monetary columns and sum every amount. Totals are
  // reported per column NUMBER and NAME; missing / unreadable values and
  // duplicate-row effects are surfaced in warnings, never silently dropped.
  const moneyRecords: MoneyRecord[] = [...byRecord.entries()].map(([k, arr]) => {
    const values: Record<string, string | null> = {}
    for (const c of columns) {
      const f = arr.find((x) => x.columnName === c)
      values[c] = f ? f.value : null
    }
    return { values, duplicate: duplicateKeys.has(k) }
  })
  const moneyResult = computeMoneyTotals(columns, moneyRecords)
  const moneyTotals = moneyResult.columns.length > 0 ? moneyResult : null

  const summary: string[] = []
  if (flaggedFields > 0) summary.push(`${flaggedFields} field(s) are flagged as uncertain or low-confidence and need human review.`)
  if (missingFields > 0) summary.push(`${missingFields} field(s) are missing/unreadable — they were left empty, never guessed.`)
  if (duplicateRowIndexes.length > 0)
    summary.push(`${duplicateRowIndexes.length} record(s) appear more than once across pages (marked as duplicates).`)
  for (const pg of pages) {
    if (pg.countMismatch && pg.visibleRecordCount != null)
      summary.push(
        `Page ${pg.pageIndex + 1}: ${pg.rows} record(s) extracted but ${pg.visibleRecordCount} visible in the document — some records may have been missed.`
      )
  }
  if (moneyTotals) {
    for (const c of moneyTotals.columns)
      summary.push(
        `Money total — Column ${c.columnIndex} "${c.columnName}": ${c.formatted} across ${c.countedValues} record(s).`
      )
    if (moneyTotals.grandTotal != null && moneyTotals.formattedGrandTotal)
      summary.push(
        `GRAND TOTAL: ${moneyTotals.formattedGrandTotal} across ${moneyTotals.columns.length} money column(s).`
      )
  }
  summary.push(...moneyResult.warnings)
  if (!summary.length) summary.push('All checks passed: no flagged fields, no missing values, no duplicates, record counts match.')

  const needsReview =
    flaggedFields > 0 ||
    missingFields > 0 ||
    duplicateRowIndexes.length > 0 ||
    pages.some((p) => p.countMismatch) ||
    moneyResult.warnings.some((w) => !w.startsWith('No monetary column'))

  return {
    totalFields: fields.length,
    totalRows: byRecord.size,
    uniqueRows,
    duplicateRows: duplicateRowIndexes.length,
    flaggedFields,
    missingFields,
    editedFields,
    avgConfidence: Math.round(avgConfidence * 1000) / 1000,
    columns,
    duplicateRowIndexes,
    pages,
    needsReview,
    summary,
    moneyTotals,
  }
}
