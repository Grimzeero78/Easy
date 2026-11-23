import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { computeJobReport } from '@/lib/report'
import { buildXlsx, buildCsv, buildPdf, buildDocx, buildTxt, buildJson, type ExportRecordRow, type ExportInput } from '@/lib/exporters'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

type Params = { params: Promise<{ id: string }> }

const FORMATS = ['xlsx', 'csv', 'pdf', 'docx', 'txt', 'json'] as const

// POST /api/jobs/[id]/export — generate the final document
// body: { format, templateId?, columns? }
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const format = String(body.format || 'xlsx')
  if (!FORMATS.includes(format as (typeof FORMATS)[number])) {
    return NextResponse.json({ error: `Unsupported format: ${format}` }, { status: 400 })
  }

  const job = await db.job.findUnique({ where: { id }, include: { fields: true } })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (!job.fields.length) return NextResponse.json({ error: 'Nothing to export yet — run extraction first.' }, { status: 400 })

  // Assemble records: page order preserved, then row order
  const byRecord = new Map<string, typeof job.fields>()
  for (const f of job.fields) {
    const k = `${f.pageIndex}:${f.rowIndex}`
    const arr = byRecord.get(k) ?? []
    arr.push(f)
    byRecord.set(k, arr)
  }
  const sortedKeys = [...byRecord.keys()].sort((a, b) => {
    const [pa, ra] = a.split(':').map(Number)
    const [pb, rb] = b.split(':').map(Number)
    return pa - pb || ra - rb
  })

  // Column selection: explicit list > template columns > first-appearance order
  let columns: string[] = []
  let templateBuffer: Buffer | null = null
  if (body.templateId) {
    const tpl = await db.template.findUnique({ where: { id: String(body.templateId) } })
    if (!tpl) return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    if (tpl.type === 'columns' && tpl.columnsJson) {
      const tplCols = JSON.parse(tpl.columnsJson) as string[]
      const extra = job.fields.map((f) => f.columnName).filter((c, i, arr) => arr.indexOf(c) === i && !tplCols.some((t) => t.toLowerCase() === c.toLowerCase()))
      columns = [...tplCols, ...extra]
    } else if (tpl.type === 'xlsx' && tpl.fileData) {
      templateBuffer = Buffer.from(tpl.fileData)
      if (tpl.headersJson) {
        const tplCols = JSON.parse(tpl.headersJson) as string[]
        const extra = job.fields.map((f) => f.columnName).filter((c, i, arr) => arr.indexOf(c) === i && !tplCols.some((t) => t.toLowerCase() === c.toLowerCase()))
        columns = [...tplCols, ...extra]
      }
    }
  }
  if (Array.isArray(body.columns) && body.columns.length) {
    const chosen = body.columns.map(String)
    const extra = job.fields.map((f) => f.columnName).filter((c, i, arr) => arr.indexOf(c) === i && !chosen.includes(c))
    columns = [...chosen, ...extra]
  }
  if (!columns.length) {
    columns = []
    for (const f of job.fields) if (!columns.includes(f.columnName)) columns.push(f.columnName)
  }

  const records: ExportRecordRow[] = sortedKeys.map((k) => {
    const arr = byRecord.get(k)!
    const [pi, ri] = k.split(':').map(Number)
    const values: Record<string, string> = {}
    for (const c of columns) {
      const f = arr.find((x) => x.columnName === c)
      values[c] = f ? (f.value ?? '') : ''
    }
    return { pageIndex: pi, rowIndex: ri, values }
  })

  const report = await computeJobReport(id)
  const input: ExportInput = {
    title: job.title,
    columns,
    records,
    reportSummary: report.summary,
    moneyTotals: report.moneyTotals,
  }

  try {
    let data: Buffer
    let mime: string
    let ext: string
    switch (format) {
      case 'xlsx':
        data = await buildXlsx(input, templateBuffer)
        mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ext = 'xlsx'
        break
      case 'csv':
        data = Buffer.from(buildCsv(input), 'utf-8')
        mime = 'text/csv'
        ext = 'csv'
        break
      case 'pdf':
        data = await buildPdf(input)
        mime = 'application/pdf'
        ext = 'pdf'
        break
      case 'docx':
        data = await buildDocx(input)
        mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ext = 'docx'
        break
      case 'txt':
        data = Buffer.from(buildTxt(input), 'utf-8')
        mime = 'text/plain'
        ext = 'txt'
        break
      case 'json':
        data = Buffer.from(
          buildJson(input, {
            mode: job.mode,
            instructions: job.instructions,
            pages: report.pages,
            duplicates: report.duplicateRowIndexes,
          }),
          'utf-8'
        )
        mime = 'application/json'
        ext = 'json'
        break
      default:
        throw new Error('unreachable')
    }

    const safeTitle = job.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'extraction'
    const fileName = `${safeTitle}.${ext}`
    const rec = await db.exportRecord.create({
      data: { jobId: id, format, fileName, rows: records.length, data },
    })
    await db.job.update({ where: { id }, data: { status: 'exported' } })

    return NextResponse.json({
      export: { id: rec.id, format, fileName, rows: records.length, createdAt: rec.createdAt },
      columnsUsed: columns,
    })
  } catch (err) {
    return NextResponse.json({ error: `Export generation failed: ${(err as Error).message}` }, { status: 500 })
  }
}
