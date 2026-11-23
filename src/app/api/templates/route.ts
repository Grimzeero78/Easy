import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import ExcelJS from 'exceljs'

export const dynamic = 'force-dynamic'

// GET /api/templates — saved templates (dashboard + export view)
export async function GET() {
  const templates = await db.template.findMany({ orderBy: { createdAt: 'desc' } })
  return NextResponse.json({
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      fileName: t.fileName,
      columns: t.columnsJson ? JSON.parse(t.columnsJson) : null,
      headers: t.headersJson ? JSON.parse(t.headersJson) : null,
      createdAt: t.createdAt,
    })),
  })
}

// POST /api/templates — create a template
// FormData: type = "xlsx" (file) | "columns" (name, columns JSON array)
export async function POST(req: NextRequest) {
  const form = await req.formData()
  const type = String(form.get('type') || 'columns')

  if (type === 'xlsx') {
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'Missing .xlsx file' }, { status: 400 })
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      return NextResponse.json({ error: 'Template must be an .xlsx file' }, { status: 400 })
    }
    try {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await file.arrayBuffer())
      // Detect header row in the first sheet
      let headers: string[] = []
      for (const ws of wb.worksheets) {
        const limit = Math.min(6, ws.rowCount)
        for (let r = 1; r <= limit; r++) {
          const cells: string[] = []
          ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
            const v = cell.value
            const text = v == null ? '' : typeof v === 'object' && 'text' in (v as object) ? String((v as { text?: unknown }).text ?? '') : String(v)
            if (text.trim()) cells.push(text.trim())
          })
          if (cells.length >= 2) {
            headers = cells
            break
          }
        }
        if (headers.length) break
      }
      if (!headers.length) {
        return NextResponse.json({ error: 'No header row detected in the template (need a row with at least 2 named columns).' }, { status: 400 })
      }
      const tpl = await db.template.create({
        data: {
          name: String(form.get('name') || file.name.replace(/\.xlsx$/i, '')),
          type: 'xlsx',
          fileName: file.name,
          headersJson: JSON.stringify(headers),
          fileData: Buffer.from(await file.arrayBuffer()),
        },
      })
      return NextResponse.json({ template: { id: tpl.id, name: tpl.name, type: tpl.type, headers } })
    } catch (err) {
      return NextResponse.json({ error: `Could not read template: ${(err as Error).message}` }, { status: 400 })
    }
  }

  if (type === 'columns') {
    const name = String(form.get('name') || '').trim()
    let columns: string[] = []
    try {
      const raw = form.get('columns')
      columns = JSON.parse(String(raw ?? '[]'))
      columns = columns.map((c) => String(c).trim()).filter(Boolean)
    } catch {
      return NextResponse.json({ error: 'columns must be a JSON array of strings' }, { status: 400 })
    }
    if (!name) return NextResponse.json({ error: 'Template name is required' }, { status: 400 })
    if (columns.length < 1) return NextResponse.json({ error: 'At least one column is required' }, { status: 400 })
    const tpl = await db.template.create({
      data: { name, type: 'columns', columnsJson: JSON.stringify(columns) },
    })
    return NextResponse.json({ template: { id: tpl.id, name: tpl.name, type: tpl.type, columns } })
  }

  return NextResponse.json({ error: 'Unknown template type' }, { status: 400 })
}
