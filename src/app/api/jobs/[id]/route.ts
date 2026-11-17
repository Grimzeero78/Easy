import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { computeJobReport } from '@/lib/report'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// GET /api/jobs/[id] — full job detail: pages (meta only), fields, report
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const job = await db.job.findUnique({
    where: { id },
    include: {
      pages: {
        orderBy: { order: 'asc' },
        select: {
          id: true,
          order: true,
          fileName: true,
          width: true,
          height: true,
          qualityJson: true,
          annotations: true,
          status: true,
          extraction: true,
          errorMessage: true,
          createdAt: true,
        },
      },
      fields: { orderBy: [{ pageIndex: 'asc' }, { rowIndex: 'asc' }] },
    },
  })
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const report = await computeJobReport(id)
  const pages = job.pages.map((p) => {
    let quality: { verdict?: string; issues?: { code: string; severity: string; message: string }[] } = {}
    try {
      quality = JSON.parse(p.qualityJson)
    } catch {}
    let extractionMeta: { documentType?: string; columns?: string[]; visibleRecordCount?: number | null; warnings?: string[] } = {}
    try {
      const ex = p.extraction ? JSON.parse(p.extraction) : null
      if (ex) extractionMeta = { documentType: ex.documentType, columns: ex.columns, visibleRecordCount: ex.visibleRecordCount, warnings: ex.warnings }
    } catch {}
    return {
      id: p.id,
      order: p.order,
      fileName: p.fileName,
      width: p.width,
      height: p.height,
      quality,
      annotations: JSON.parse(p.annotations || '[]'),
      status: p.status,
      errorMessage: p.errorMessage,
      hasExtraction: !!p.extraction,
      extractionMeta,
    }
  })

  const fields = job.fields.map((f) => ({
    id: f.id,
    pageIndex: f.pageIndex,
    rowIndex: f.rowIndex,
    columnName: f.columnName,
    value: f.value,
    confidence: f.confidence,
    uncertain: f.uncertain,
    missing: f.missing || f.value === '' || f.value === null,
    alternatives: JSON.parse(f.alternatives || '[]') as string[],
    bbox: f.bbox ? (JSON.parse(f.bbox) as [number, number, number, number]) : null,
    reason: f.reason,
    edited: f.edited,
    duplicate: f.duplicate,
  }))

  return NextResponse.json({
    job: {
      id: job.id,
      title: job.title,
      mode: job.mode,
      status: job.status,
      instructions: job.instructions,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
    pages,
    fields,
    report,
  })
}

// PATCH /api/jobs/[id] — update title / instructions / mode / status
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const data: { title?: string; instructions?: string; mode?: string; status?: string } = {}
  if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim()
  if (typeof body.instructions === 'string') data.instructions = body.instructions
  if (body.mode === 'general' || body.mode === 'cashier') data.mode = body.mode
  if (typeof body.status === 'string') data.status = body.status
  const job = await db.job.update({ where: { id }, data })
  return NextResponse.json({ job: { id: job.id, status: job.status } })
}

// DELETE /api/jobs/[id] — user-controlled deletion (cascades pages, fields, exports)
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params
  await db.job.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
