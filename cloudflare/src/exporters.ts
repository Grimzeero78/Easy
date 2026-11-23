import * as XLSX from 'xlsx'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { MoneyTotals, ColumnMoneyTotal } from './types'
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  HeadingLevel,
} from 'docx'

/**
 * Document generation engine (Cloudflare version) — pure-JS libraries only:
 *   xlsx  (SheetJS)   -> Excel, including filling uploaded templates
 *   pdf-lib           -> PDF (standard fonts, WinAnsi-safe text)
 *   docx              -> Word
 * Same ExportInput shapes and column semantics as src/lib/exporters.ts.
 */

export interface ExportRecordRow {
  pageIndex: number
  rowIndex: number
  values: Record<string, string>
}

export interface ExportInput {
  title: string
  columns: string[]
  records: ExportRecordRow[]
  reportSummary: string[]
  /** Auto-detected money totals — renders a TOTAL row under each money column. */
  moneyTotals?: MoneyTotals | null
}

/** Money totals keyed by column name (stable across column selection/reorder). */
function totalsByName(input: ExportInput): Map<string, ColumnMoneyTotal> {
  const m = new Map<string, ColumnMoneyTotal>()
  for (const t of input.moneyTotals?.columns ?? []) m.set(t.columnName, t)
  return m
}

function totalValue(input: ExportInput, col: string): number | null {
  const t = totalsByName(input).get(col)
  return t ? t.total : null
}

function totalDisplay(input: ExportInput, col: string): string | null {
  const t = totalsByName(input).get(col)
  return t ? t.formatted : null
}

const TOTAL_LABEL = 'TOTAL'

const TEAL = rgb(0.059, 0.463, 0.431) // #0F766E
const ZEBRA = rgb(0.953, 0.957, 0.965) // #F3F4F6
const RED = rgb(0.862, 0.149, 0.149) // #DC2626
const GRAY_LINE = rgb(0.898, 0.906, 0.922) // #E5E7EB

function cellText(v: string | undefined | null): string {
  return v == null ? '' : String(v)
}

function numLike(raw: string): number | null {
  const s = raw === '' ? '' : raw.replace(/[, ]/g, '')
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return null
}

function normHeader(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

/* ---------------- Excel (SheetJS) ---------------- */

export function buildXlsx(input: ExportInput, templateBytes?: ArrayBuffer | null): ArrayBuffer {
  if (templateBytes) {
    const wb = XLSX.read(templateBytes, { type: 'array' })
    // Find the sheet + header row: first row (within the first 6 rows) with >= 2 non-empty cells
    let sheetName: string | null = null
    let headerRowNumber = -1
    let headerMap: { col: number; name: string }[] = []
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name]
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, blankrows: true, defval: '' })
      const limit = Math.min(6, rows.length)
      for (let r = 0; r < limit; r++) {
        const row = rows[r] ?? []
        const cells: { col: number; name: string }[] = []
        row.forEach((v, col) => {
          const text = v == null ? '' : String(v).trim()
          if (text) cells.push({ col, name: text })
        })
        if (cells.length >= 2) {
          sheetName = name
          headerRowNumber = r
          headerMap = cells
          break
        }
      }
      if (sheetName) break
    }

    if (sheetName && headerRowNumber >= 0) {
      const ws = wb.Sheets[sheetName]
      const colToTemplateCol = new Map<string, number>()
      for (const h of headerMap) {
        const match = input.columns.find((c) => normHeader(c) === normHeader(h.name))
        if (match) colToTemplateCol.set(match, h.col)
      }
      const extraColumns = input.columns.filter((c) => !colToTemplateCol.has(c))
      const extraStart = Math.max(...headerMap.map((h) => h.col)) + 1
      extraColumns.forEach((c, i) => colToTemplateCol.set(c, extraStart + i))

      const width = Math.max(...[...colToTemplateCol.values()], headerMap.at(-1)?.col ?? 0) + 1
      const rowsAoa: unknown[][] = input.records.map((rec) => {
        const row: unknown[] = new Array(width).fill('')
        for (const [colName, targetCol] of colToTemplateCol) {
          const raw = cellText(rec.values[colName])
          row[targetCol] = numLike(raw) ?? raw
        }
        return row
      })
      // TOTAL row under the data (money columns only)
      if (input.moneyTotals?.columns.length) {
        const totalRow: unknown[] = new Array(width).fill('')
        const firstCol = Math.min(...colToTemplateCol.values())
        totalRow[firstCol] = TOTAL_LABEL
        for (const [colName, targetCol] of colToTemplateCol) {
          const tv = totalValue(input, colName)
          if (tv == null) continue
          totalRow[targetCol] = tv
        }
        rowsAoa.push(totalRow)
      }
      // header labels for appended columns
      const headerRowAoa: unknown[] = new Array(width).fill(null)
      for (const c of extraColumns) headerRowAoa[colToTemplateCol.get(c)!] = c
      XLSX.utils.sheet_add_aoa(ws, [headerRowAoa], { origin: { r: headerRowNumber, c: 0 } })
      XLSX.utils.sheet_add_aoa(ws, rowsAoa, { origin: { r: headerRowNumber + 1, c: 0 } })
      const range = XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: headerRowNumber + rowsAoa.length, c: Math.max(width - 1, (ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).e.c : 0)) },
      })
      ws['!ref'] = range
      return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    }
    // no detectable header -> fresh sheet, keep template sheets
    const ws = XLSX.utils.aoa_to_sheet(freshAoa(input))
    ws['!cols'] = colWidths(input)
    XLSX.utils.book_append_sheet(wb, ws, 'Extracted Data')
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  }

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(freshAoa(input))
  ws['!cols'] = colWidths(input)
  if (input.records.length > 0) {
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: input.columns.length - 1 } }) }
  }
  XLSX.utils.book_append_sheet(wb, ws, 'Extracted Data')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

function freshAoa(input: ExportInput): unknown[][] {
  const rows: unknown[][] = [input.columns]
  for (const rec of input.records) {
    rows.push(input.columns.map((c) => numLike(cellText(rec.values[c])) ?? cellText(rec.values[c])))
  }
  if (input.moneyTotals?.columns.length) {
    rows.push(
      input.columns.map((c, i) => {
        if (i === 0) return TOTAL_LABEL
        const tv = totalValue(input, c)
        return tv == null ? '' : tv
      })
    )
  }
  return rows
}

function colWidths(input: ExportInput): { wch: number }[] {
  return input.columns.map((c) => {
    let maxLen = c.length
    for (const rec of input.records) maxLen = Math.max(maxLen, cellText(rec.values[c]).length)
    return { wch: Math.min(60, Math.max(12, maxLen + 3)) }
  })
}

/* ---------------- CSV / TXT / JSON ---------------- */

export function buildCsv(input: ExportInput): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = [input.columns.map(esc).join(',')]
  for (const rec of input.records) lines.push(input.columns.map((c) => esc(cellText(rec.values[c]))).join(','))
  if (input.moneyTotals?.columns.length) {
    lines.push(
      input.columns
        .map((c, i) => {
          if (i === 0) return TOTAL_LABEL
          const tv = totalValue(input, c)
          return tv == null ? '' : tv.toFixed(2)
        })
        .map(esc)
        .join(',')
    )
  }
  return lines.join('\r\n') + '\r\n'
}

export function buildTxt(input: ExportInput): string {
  const widths = input.columns.map((c) => {
    let w = c.length
    for (const rec of input.records) w = Math.max(w, cellText(rec.values[c]).length)
    return Math.min(48, Math.max(8, w + 2))
  })
  const sep = widths.map((w) => '-'.repeat(w)).join('+') + '\n'
  let out = input.columns.map((c, i) => c.slice(0, widths[i]).padEnd(widths[i])).join('|') + '\n'
  out += sep
  for (const rec of input.records) {
    out += input.columns.map((c, i) => cellText(rec.values[c]).slice(0, widths[i]).padEnd(widths[i])).join('|') + '\n'
  }
  out += sep
  if (input.moneyTotals?.columns.length) {
    out +=
      input.columns
        .map((c, i) => {
          if (i === 0) return TOTAL_LABEL.padEnd(widths[i])
          const tv = totalValue(input, c)
          if (tv == null) return ''.padEnd(widths[i])
          const disp = totalDisplay(input, c) ?? tv.toFixed(2)
          return disp.slice(0, widths[i]).padStart(widths[i] - 1) + ' '
        })
        .join('|') + '\n'
    out += sep
  }
  return out
}

export function buildJson(
  input: ExportInput,
  extra: Record<string, unknown>
): string {
  const payload = {
    document: input.title,
    columns: input.columns,
    recordCount: input.records.length,
    records: input.records.map((r, i) => ({
      index: i + 1,
      sourcePage: r.pageIndex + 1,
      sourceRow: r.rowIndex + 1,
      fields: Object.fromEntries(input.columns.map((c) => [c, cellText(r.values[c])])),
    })),
    processingSummary: input.reportSummary,
    moneyTotals: input.moneyTotals ?? null,
    ...extra,
  }
  return JSON.stringify(payload, null, 2)
}

/* ---------------- PDF (pdf-lib) ---------------- */

/** Standard-font (WinAnsi) safe text: map common unicode, drop the rest. */
function sanitizePdfText(s: string): string {
  const replacements: Record<string, string> = {
    '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"',
    '\u2013': '-', '\u2014': '-', '\u2018\u2018': "''",
    '\u00A0': ' ', '\u2026': '...', '\u2022': '-', '\u00D7': 'x', '\u00F7': '/',
    '\u00A9': '(c)', '\u00AE': '(r)', '\u2122': '(tm)', '\u2264': '<=', '\u2265': '>=',
    '\u2192': '->', '\u00B0': 'deg', '\u20AC': 'EUR', '\u00A3': 'GBP', '\u00A5': 'JPY',
  }
  let out = ''
  for (const ch of s) {
    if (replacements[ch] !== undefined) out += replacements[ch]
    else if (ch.charCodeAt(0) <= 0xff) out += ch
    else out += '?'
  }
  return out
}

function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= maxChars) {
      lines.push(paragraph)
      continue
    }
    let current = ''
    for (const word of paragraph.split(/(\s+)/)) {
      if (current.length + word.length > maxChars && current.trim()) {
        lines.push(current.trimEnd())
        current = word.trimStart()
      } else {
        current += word
      }
      while (current.length > maxChars) {
        lines.push(current.slice(0, maxChars))
        current = current.slice(maxChars)
      }
    }
    lines.push(current.trimEnd())
  }
  return lines.length ? lines : ['']
}

export async function buildPdf(input: ExportInput): Promise<Uint8Array> {
  const landscape = input.columns.length > 4
  const doc = await PDFDocument.create()
  doc.setTitle(input.title)
  doc.setCreator('DocuExtract AI')

  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const margin = 40
  const pageW = (landscape ? 842 : 595) - margin * 2
  const pageH = landscape ? 595 : 842

  // column widths proportional to content, bounded (same rule as Next version)
  const widths = input.columns.map((c) => {
    let w = c.length
    for (const rec of input.records) w = Math.max(w, cellText(rec.values[c]).length)
    return Math.max(6, Math.min(40, w))
  })
  const total = widths.reduce((a, b) => a + b, 0) || 1
  const colW = widths.map((w) => (w / total) * pageW)

  let page = doc.addPage([landscape ? 842 : 595, pageH])
  let y = pageH - margin

  const drawTitle = () => {
    page.drawText(sanitizePdfText(input.title).slice(0, 120), { x: margin, y: y - 14, size: 16, font: bold })
    y -= 26
    page.drawText(
      sanitizePdfText(
        `Extracted ${input.records.length} record(s) — generated by DocuExtract AI. Empty cells were unreadable/missing in the source and were not guessed.`
      ).slice(0, 200),
      { x: margin, y: y - 9, size: 8, font, color: rgb(0.33, 0.33, 0.33) }
    )
    y -= 24
  }

  const drawHeader = () => {
    const bandY = y - 18
    page.drawRectangle({ x: margin, y: bandY, width: pageW, height: 20, color: TEAL })
    input.columns.forEach((c, i) => {
      const label = sanitizePdfText(c)
      const maxChars = Math.floor((colW[i] - 8) / (bold.widthOfTextAtSize('A', 8.5) * 0.62))
      page.drawText(label.slice(0, Math.max(3, maxChars)), {
        x: margin + colW.slice(0, i).reduce((a, b) => a + b, 0) + 3,
        y: bandY + 6,
        size: 8.5,
        font: bold,
        color: rgb(1, 1, 1),
      })
    })
    y = bandY - 4
  }

  drawTitle()
  drawHeader()

  input.records.forEach((rec, ri) => {
    const texts = input.columns.map((c) => sanitizePdfText(cellText(rec.values[c])))
    const maxCharsPerCol = input.columns.map((_, i) => Math.max(4, Math.floor((colW[i] - 6) / (font.widthOfTextAtSize('A', 8) * 0.6))))
    const wrapped = texts.map((t, i) => (t ? wrapText(t, maxCharsPerCol[i]) : ['']))
    const rowLines = Math.max(1, ...wrapped.map((l) => l.length))
    const rowH = rowLines * 10 + 6
    if (y - rowH < margin) {
      page = doc.addPage([landscape ? 842 : 595, pageH])
      y = pageH - margin
      drawHeader()
    }
    if (ri % 2 === 1) {
      page.drawRectangle({ x: margin, y: y - rowH + 3, width: pageW, height: rowH, color: ZEBRA })
    }
    input.columns.forEach((c, i) => {
      const x = margin + colW.slice(0, i).reduce((a, b) => a + b, 0) + 3
      const lines = wrapped[i].slice(0, 3)
      lines.forEach((line, li) => {
        page.drawText(line, {
          x,
          y: y - 9 - li * 10,
          size: 8,
          font,
          color: texts[i] === '' ? RED : rgb(0.067, 0.067, 0.067),
        })
      })
    })
    y -= rowH
    page.drawLine({
      start: { x: margin, y: y + 2 },
      end: { x: margin + pageW, y: y + 2 },
      thickness: 0.5,
      color: GRAY_LINE,
    })
  })

  // TOTAL row (bold, money columns only)
  if (input.moneyTotals?.columns.length) {
    const rowH = 20
    if (y - rowH < margin) {
      page = doc.addPage([landscape ? 842 : 595, pageH])
      y = pageH - margin
      drawHeader()
    }
    page.drawRectangle({ x: margin, y: y - rowH + 3, width: pageW, height: rowH, color: rgb(0.902, 0.961, 0.949) })
    input.columns.forEach((c, i) => {
      const txt = i === 0 ? TOTAL_LABEL : totalDisplay(input, c) ?? ''
      if (!txt) return
      page.drawText(sanitizePdfText(txt).slice(0, 60), {
        x: margin + colW.slice(0, i).reduce((a, b) => a + b, 0) + 3,
        y: y - 9,
        size: 8.5,
        font: bold,
        color: TEAL,
      })
    })
    y -= rowH
  }

  return await doc.save()
}

/* ---------------- Word (docx) ---------------- */

export async function buildDocx(input: ExportInput): Promise<Uint8Array> {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' }
  const headerCells = input.columns.map(
    (c) =>
      new TableCell({
        shading: { type: ShadingType.CLEAR, fill: '0F766E' },
        borders: { top: border, bottom: border, left: border, right: border },
        children: [new Paragraph({ children: [new TextRun({ text: c, bold: true, color: 'FFFFFF' })] })],
      })
  )
  const rows = input.records.map(
    (rec) =>
      new TableRow({
        children: input.columns.map(
          (c) =>
            new TableCell({
              borders: { top: border, bottom: border, left: border, right: border },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: cellText(rec.values[c]) || '—', color: cellText(rec.values[c]) ? '111111' : 'DC2626' }),
                  ],
                }),
              ],
            })
        ),
      })
  )

  // TOTAL row (bold, money columns only)
  if (input.moneyTotals?.columns.length) {
    rows.push(
      new TableRow({
        children: input.columns.map(
          (c, i) =>
            new TableCell({
              shading: { type: ShadingType.CLEAR, fill: 'E6F5F2' },
              borders: { top: border, bottom: border, left: border, right: border },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: i === 0 ? TOTAL_LABEL : totalDisplay(input, c) ?? '—',
                      bold: true,
                      color: '0F766E',
                    }),
                  ],
                }),
              ],
            })
        ),
      })
    )
  }

  const doc = new Document({
    creator: 'DocuExtract AI',
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: input.title, bold: true })] }),
          new Paragraph({
            spacing: { after: 200 },
            children: [
              new TextRun({
                text: `Extracted ${input.records.length} record(s) from uploaded document(s). Flagged or empty cells were left for human verification — nothing was guessed.`,
                italics: true,
                color: '666666',
                size: 18,
              }),
            ],
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [new TableRow({ tableHeader: true, children: headerCells }), ...rows],
          }),
          ...(input.reportSummary.length
            ? [
                new Paragraph({
                  heading: HeadingLevel.HEADING_2,
                  children: [new TextRun({ text: 'Processing Summary', bold: true })],
                  spacing: { before: 300 },
                }),
                ...input.reportSummary.map((s) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: s, size: 20 })] })),
              ]
            : []),
        ],
      },
    ],
  })
  return await Packer.toBuffer(doc)
}
