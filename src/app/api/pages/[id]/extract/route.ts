import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { extractPage } from '@/lib/vision'
import type { AnnotationShape } from '@/lib/quality'
import { computeJobReport } from '@/lib/report'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

type Params = { params: Promise<{ id: string }> }

// POST /api/pages/[id]/extract — run AI extraction on ONE page of the job.
// The client loops over pages to give live progress (batch processing = one
// consolidated dataset across pages, page order preserved).
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const page = await db.page.findUnique({ where: { id }, include: { job: true } })
  if (!page) return NextResponse.json({ error: 'Page not found' }, { status: 404 })
  if (!page.enhancedData) return NextResponse.json({ error: 'Page image missing' }, { status: 400 })

  // HARD QUALITY GATE — never silently process images below threshold
  let quality: { verdict?: string } = {}
  try {
    quality = JSON.parse(page.qualityJson)
  } catch {}
  if (quality.verdict === 'fail' || page.status === 'blocked') {
    return NextResponse.json(
      { error: 'This page failed the quality check and is blocked from AI extraction. Retake or replace the picture.' },
      { status: 403 }
    )
  }

  await db.page.update({ where: { id }, data: { status: 'extracting' } })
  await db.job.update({ where: { id: page.jobId }, data: { status: 'extracting' } })

  try {
    const annotations = JSON.parse(page.annotations || '[]') as AnnotationShape[]
    const pageInfo = `page ${page.order + 1}${annotations.length ? ' with ' + annotations.length + ' user-marked region(s)' : ''}`
    const result = await extractPage({
      jobTitle: page.job.title,
      mode: page.job.mode === 'cashier' ? 'cashier' : 'general',
      instructions: page.job.instructions,
      annotations,
      enhancedImage: Buffer.from(page.enhancedData),
      pageInfo,
    })

    // Persist page extraction (traceable, keeps visibleRecordCount + warnings)
    await db.page.update({
      where: { id },
      data: {
        status: 'extracted',
        extraction: JSON.stringify(result),
        errorMessage: null,
      },
    })

    // Replace stored fields for this page (re-extraction = fresh, verified state)
    await db.field.deleteMany({ where: { jobId: page.jobId, pageIndex: page.order } })
    const fieldRows: {
      jobId: string
      pageIndex: number
      rowIndex: number
      columnName: string
      value: string
      confidence: number
      uncertain: boolean
      missing: boolean
      alternatives: string
      bbox: string | null
      reason: string | null
    }[] = []
    result.rows.forEach((row, ri) => {
      for (const cell of row.cells) {
        const missing = cell.value === null || cell.value === ''
        fieldRows.push({
          jobId: page.jobId,
          pageIndex: page.order,
          rowIndex: ri,
          columnName: cell.column,
          value: cell.value ?? '',
          confidence: cell.confidence,
          uncertain: cell.uncertain || missing,
          missing,
          alternatives: JSON.stringify(cell.alternatives ?? []),
          bbox: cell.bbox ? JSON.stringify(cell.bbox) : null,
          reason: missing ? cell.reason ?? 'unreadable or missing' : cell.reason ?? null,
        })
      }
    })
    if (fieldRows.length) await db.field.createMany({ data: fieldRows })

    // Recompute cross-page verification (duplicates etc.) after each page
    const report = await computeJobReport(page.jobId)
    const allExtracted = (await db.page.count({ where: { jobId: page.jobId, status: { in: ['extracted'] } } })) === (await db.page.count({ where: { jobId: page.jobId } }))
    await db.job.update({
      where: { id: page.jobId },
      data: { status: allExtracted ? 'review' : 'extracting' },
    })

    return NextResponse.json({
      pageId: id,
      rows: result.rows.length,
      columns: result.columns,
      documentType: result.documentType,
      visibleRecordCount: result.visibleRecordCount,
      warnings: result.warnings,
      reportSummary: report.summary,
    })
  } catch (err) {
    await db.page.update({ where: { id }, data: { status: 'failed', errorMessage: (err as Error).message } })
    return NextResponse.json({ error: `Extraction failed: ${(err as Error).message}` }, { status: 500 })
  }
}
