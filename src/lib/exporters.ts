import fs from 'fs'
import ExcelJS from 'exceljs'
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, HeadingLevel } from 'docx'
import PDFDocument from 'pdfkit'

/**
 * Document generation engine.
 * Excel (with uploaded-template population preserving structure), CSV, PDF,
 * Word, TXT and JSON outputs from verified extracted records.
 */

export interface ExportRecordRow {
  pageIndex: number
  rowIndex: number
  values: Record<string, string> // columnName -> value (empty string if missing)
}

export interface ExportInput {
  title: string
  columns: string[]
  records: ExportRecordRow[]
  reportSummary: string[]
}

const DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const DEJAVU_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

function cellText(v: string | undefined | null): string {
  return v == null ? '' : String(v)
}

/* ---------------- Excel ---------------- */

function normHeader(s: string) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

export async function buildXlsx(input: ExportInput, templateBuffer?: Buffer | null): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'DocuExtract AI'

  if (templateBuffer) {
    const tpl = new ExcelJS.Workbook()
    await tpl.xlsx.load(templateBuffer)
    // Find the sheet + header row: first row (within the first 6 rows) containing >= 2 non-empty text cells
    let sheet: ExcelJS.Worksheet | null = null
    let headerRowNumber = -1
    let headerMap: { col: number; name: string }[] = []
    for (const ws of tpl.worksheets) {
      const limit = Math.min(6, ws.rowCount)
      for (let r = 1; r <= limit; r++) {
        const row = ws.getRow(r)
        const cells: { col: number; name: string }[] = []
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const v = cell.value
          const text = v == null ? '' : typeof v === 'object' && 'text' in (v as object) ? String((v as { text?: unknown }).text ?? '') : String(v)
          if (text.trim()) cells.push({ col: colNumber, name: text.trim() })
        })
        if (cells.length >= 2) {
          sheet = ws
          headerRowNumber = r
          headerMap = cells
          break
        }
      }
      if (sheet) break
    }
    if (sheet && headerRowNumber > 0) {
      const ws = sheet
      // Map extracted columns to template headers (normalized match)
      const colToTemplateCol = new Map<string, number>()
      for (const h of headerMap) {
        const match = input.columns.find((c) => normHeader(c) === normHeader(h.name))
        if (match) colToTemplateCol.set(match, h.col)
      }
      // Extracted columns with no matching template column are appended to the
      // right of the template's used range (template structure preserved, no data lost)
      const extraColumns = input.columns.filter((c) => !colToTemplateCol.has(c))
      const extraStart = Math.max(...headerMap.map((h) => h.col)) + 1
      extraColumns.forEach((c, i) => {
        colToTemplateCol.set(c, extraStart + i)
        const hc = ws.getCell(headerRowNumber, extraStart + i)
        hc.value = c
        hc.font = { bold: true }
      })

      let r = headerRowNumber + 1
      for (const rec of input.records) {
        for (const [colName, targetCol] of colToTemplateCol) {
          const raw = cellText(rec.values[colName])
          const cell = ws.getCell(r, targetCol)
          const numLike = raw === '' ? '' : raw.replace(/[, ]/g, '')
          if (numLike !== '' && /^-?\d+(\.\d+)?$/.test(numLike)) cell.value = Number(numLike)
          else cell.value = raw
        }
        r++
      }
      const out = await tpl.xlsx.writeBuffer()
      return Buffer.from(out)
    }
    // template had no detectable header -> fall through to a fresh sheet, keep template sheets
    const ws = tpl.addWorksheet('Extracted Data')
    fillFreshSheet(ws, input)
    const out = await tpl.xlsx.writeBuffer()
    return Buffer.from(out)
  }

  const ws = wb.addWorksheet('Extracted Data')
  fillFreshSheet(ws, input)
  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out)
}

function fillFreshSheet(ws: ExcelJS.Worksheet, input: ExportInput) {
  const header = ws.getRow(1)
  input.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1)
    cell.value = c
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } }
    cell.alignment = { vertical: 'middle', horizontal: 'left' }
    cell.border = { bottom: { style: 'thin' as unknown as ExcelJS.Border['style'] } }
  })
  header.height = 22
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  input.records.forEach((rec, ri) => {
    input.columns.forEach((c, ci) => {
      const cell = ws.getRow(ri + 2).getCell(ci + 1)
      const raw = cellText(rec.values[c])
      const numLike = raw === '' ? null : raw.replace(/[, ]/g, '')
      if (numLike !== null && /^-?\d+(\.\d+)?$/.test(numLike)) cell.value = Number(numLike)
      else cell.value = raw
      cell.alignment = { vertical: 'top' }
      if (raw === '') {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF2F2' } }
      }
    })
  })
  // approximate auto-fit widths
  input.columns.forEach((c, ci) => {
    let maxLen = c.length
    for (const rec of input.records) maxLen = Math.max(maxLen, cellText(rec.values[c]).length)
    ws.getColumn(ci + 1).width = Math.min(60, Math.max(12, maxLen + 3))
  })
  if (input.records.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: input.columns.length } }
  }
}

/* ---------------- CSV ---------------- */

export function buildCsv(input: ExportInput): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = [input.columns.map(esc).join(',')]
  for (const rec of input.records) lines.push(input.columns.map((c) => esc(cellText(rec.values[c]))).join(','))
  return lines.join('\r\n') + '\r\n'
}

/* ---------------- TXT ---------------- */

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
  return out
}

/* ---------------- JSON ---------------- */

export function buildJson(input: ExportInput, extra: Record<string, unknown>): string {
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
    ...extra,
  }
  return JSON.stringify(payload, null, 2)
}

/* ---------------- PDF ---------------- */

export function buildPdf(input: ExportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const landscape = input.columns.length > 4
    const doc = new PDFDocument({
      margin: 40,
      size: 'A4',
      layout: landscape ? 'landscape' : 'portrait',
      info: { Title: input.title, Creator: 'DocuExtract AI' },
    })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    try {
      doc.font(DEJAVU)
      const boldAvailable = fs.existsSync(DEJAVU_BOLD)
      if (boldAvailable) doc.font(DEJAVU_BOLD)
      doc.fontSize(16)
      doc.text(input.title, { align: 'left' })
      doc.moveDown(0.3)
      if (boldAvailable) doc.font(DEJAVU)
      doc.fontSize(9).fillColor('#555555')
      doc.text(`Extracted ${input.records.length} record(s) — generated by DocuExtract AI. Empty cells were unreadable/missing in the source and were not guessed.`)
      doc.fillColor('#000000')
      doc.moveDown(0.6)

      // column widths proportional to content, bounded
      const pageW = doc.page.width - 80
      const widths = input.columns.map((c) => {
        let w = c.length
        for (const rec of input.records) w = Math.max(w, cellText(rec.values[c]).length)
        return Math.max(6, Math.min(40, w))
      })
      const total = widths.reduce((a, b) => a + b, 0) || 1
      const colW = widths.map((w) => (w / total) * pageW)

      const drawHeader = () => {
        const y = doc.y
        doc.rect(40, y - 4, pageW, 20).fill('#0F766E')
        doc.fillColor('#FFFFFF')
        if (boldAvailable) doc.font(DEJAVU_BOLD)
        doc.fontSize(9)
        input.columns.forEach((c, i) => {
          const x = 40 + colW.slice(0, i).reduce((a, b) => a + b, 0)
          doc.text(c, x + 3, y, { width: colW[i] - 6, lineBreak: false, ellipsis: true })
        })
        if (boldAvailable) doc.font(DEJAVU)
        doc.fillColor('#000000')
        doc.y = y + 22
        doc.x = 40
      }

      drawHeader()
      doc.fontSize(8.5)
      input.records.forEach((rec, ri) => {
        const cellLines = input.columns.map((c, i) => doc.font(DEJAVU).fontSize(8.5).widthOfString(cellText(rec.values[c]).slice(0, 400)) > colW[i] - 6 ? 2 : 1)
        const rowLines = Math.max(1, ...cellLines)
        const rowH = rowLines * 12 + 6
        if (doc.y + rowH > doc.page.height - 40) {
          doc.addPage()
          drawHeader()
          doc.fontSize(8.5)
        }
        const y = doc.y
        if (ri % 2 === 1) {
          doc.rect(40, y - 3, pageW, rowH).fill('#F3F4F6')
          doc.fillColor('#000000')
        }
        input.columns.forEach((c, i) => {
          const x = 40 + colW.slice(0, i).reduce((a, b) => a + b, 0)
          const txt = cellText(rec.values[c])
          doc.fillColor(txt === '' ? '#DC2626' : '#111111')
          doc.text(txt, x + 3, y, { width: colW[i] - 6, lineBreak: txt.length > 0, ellipsis: true })
        })
        doc.fillColor('#000000')
        doc.y = y + rowH
        doc.x = 40
        doc.lineWidth = 0.5
        doc.moveTo(40, doc.y - 4).lineTo(40 + pageW, doc.y - 4).strokeColor('#E5E7EB').stroke()
      })

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

/* ---------------- Word ---------------- */

export async function buildDocx(input: ExportInput): Promise<Buffer> {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' }
  const headerCells = input.columns.map(
    (c) =>
      new TableCell({
        shading: { type: ShadingType.CLEAR, fill: '0F766E' },
        borders: { top: border, bottom: border, left: border, right: border },
        children: [
          new Paragraph({
            children: [new TextRun({ text: c, bold: true, color: 'FFFFFF' })],
          }),
        ],
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
                  children: [new TextRun({ text: cellText(rec.values[c]) || '—', color: cellText(rec.values[c]) ? '111111' : 'DC2626' })],
                }),
              ],
            })
        ),
      })
  )

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
                new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: 'Processing Summary', bold: true })], spacing: { before: 300 } }),
                ...input.reportSummary.map((s) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: s, size: 20 })] })),
              ]
            : []),
        ],
      },
    ],
  })
  const buf = await Packer.toBuffer(doc)
  return Buffer.from(buf)
}
