import type { FieldView, JobReport, PageRecord } from './types'
import { computeMoneyTotals, type MoneyRecord } from './money'

/**
 * Verification engine — accuracy and data integrity checks over extracted
 * fields. Faithful port of src/lib/report.ts (same thresholds, same summary
 * wording) rewritten as a pure function over the KV-backed arrays.
 */

function normalizeKey(v: string | null): string {
  return (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Mark duplicate flags on the field array (mutates copies, returns new array). */
export function applyDuplicateFlags(fields: FieldView[]): { fields: FieldView[]; duplicateRowIndexes: { pageIndex: number; rowIndex: number }[] } {
  const columns: string[] = []
  for (const f of fields) if (!columns.includes(f.columnName)) columns.push(f.columnName)

  const byRecord = new Map<string, FieldView[]>()
  for (const f of fields) {
    const k = `${f.pageIndex}:${f.rowIndex}`
    const arr = byRecord.get(k) ?? []
    arr.push(f)
    byRecord.set(k, arr)
  }

  const idLikeRe = /(^|\W)(id|no\.?|number|reg(istration)?|receipt|ref(erence)?|transaction|invoice|code)(\W|$)/i
  const idColumns = columns.filter((c) => idLikeRe.test(c))

  const seen = new Map<string, boolean>()
  const duplicateKeys = new Set<string>()
  const duplicateRowIndexes: { pageIndex: number; rowIndex: number }[] = []

  for (const [k, arr] of byRecord) {
    const vals = arr.map((f) => ({ col: f.columnName, v: normalizeKey(f.value) }))
    const key = vals.map((x) => x.v).join('|')
    const idKey = vals.filter((x) => idColumns.includes(x.col)).map((x) => x.v).join('|')
    const [pi, ri] = k.split(':').map(Number)
    const strong = idKey && idColumns.length > 0 ? `id:${idKey}` : null

    if (seen.get(key)) {
      duplicateKeys.add(key)
      duplicateRowIndexes.push({ pageIndex: pi, rowIndex: ri })
    } else {
      seen.set(key, true)
    }
    if (strong) {
      if (seen.get(strong)) {
        duplicateKeys.add(key)
        duplicateRowIndexes.push({ pageIndex: pi, rowIndex: ri })
      } else {
        seen.set(strong, true)
      }
    }
  }

  const dupRowKeys = new Set(duplicateRowIndexes.map((d) => `${d.pageIndex}:${d.rowIndex}`))
  const next = fields.map((f) => ({ ...f, duplicate: dupRowKeys.has(`${f.pageIndex}:${f.rowIndex}`) }))
  return { fields: next, duplicateRowIndexes }
}

export function computeReport(pages: PageRecord[], fields: FieldView[]): JobReport {
  const columns: string[] = []
  for (const f of fields) if (!columns.includes(f.columnName)) columns.push(f.columnName)

  const byRecord = new Map<string, FieldView[]>()
  for (const f of fields) {
    const k = `${f.pageIndex}:${f.rowIndex}`
    const arr = byRecord.get(k) ?? []
    arr.push(f)
    byRecord.set(k, arr)
  }

  const { duplicateRowIndexes } = applyDuplicateFlags(fields)

  const flaggedFields = fields.filter((f) => (f.uncertain || f.confidence < 0.7) && !f.edited).length
  const missingFields = fields.filter((f) => f.missing || f.value === null || f.value === '').length
  const editedFields = fields.filter((f) => f.edited).length
  const avgConfidence = fields.length ? fields.reduce((s, f) => s + f.confidence, 0) / fields.length : 0

  const pagesReport = pages.map((p) => {
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
    const ex = p.extractionMeta ?? {}
    const countMismatch = ex.visibleRecordCount != null && rows > 0 && rows !== ex.visibleRecordCount
    return {
      pageIndex: p.order,
      fileName: p.fileName,
      rows,
      flagged,
      missing,
      visibleRecordCount: ex.visibleRecordCount ?? null,
      countMismatch,
      warnings: ex.warnings ?? [],
      qualityVerdict: p.quality?.verdict ?? 'unknown',
      status: p.status,
    }
  })

  const uniqueRows = byRecord.size - duplicateRowIndexes.length

  // Money totals — detect monetary columns and sum every amount. Totals are
  // reported per column NUMBER and NAME; missing / unreadable values and
  // duplicate-row effects are surfaced in warnings, never silently dropped.
  const dupKeys = new Set(duplicateRowIndexes.map((d) => `${d.pageIndex}:${d.rowIndex}`))
  const moneyRecords: MoneyRecord[] = [...byRecord.entries()].map(([k, arr]) => {
    const values: Record<string, string | null> = {}
    for (const c of columns) {
      const f = arr.find((x) => x.columnName === c)
      values[c] = f ? f.value : null
    }
    return { values, duplicate: dupKeys.has(k) }
  })
  const moneyResult = computeMoneyTotals(columns, moneyRecords)
  const moneyTotals = moneyResult.columns.length > 0 ? moneyResult : null

  const summary: string[] = []
  if (flaggedFields > 0) summary.push(`${flaggedFields} field(s) are flagged as uncertain or low-confidence and need human review.`)
  if (missingFields > 0) summary.push(`${missingFields} field(s) are missing/unreadable — they were left empty, never guessed.`)
  if (duplicateRowIndexes.length > 0)
    summary.push(`${duplicateRowIndexes.length} record(s) appear more than once across pages (marked as duplicates).`)
  for (const pg of pagesReport) {
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
    pagesReport.some((p) => p.countMismatch) ||
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
    pages: pagesReport,
    needsReview,
    summary,
    moneyTotals,
  }
}
