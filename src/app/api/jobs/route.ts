import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/jobs — list all extraction jobs (dashboard)
export async function GET() {
  const jobs = await db.job.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      pages: { select: { id: true, status: true } },
      fields: { select: { id: true, pageIndex: true, rowIndex: true, uncertain: true, missing: true, duplicate: true, confidence: true, edited: true } },
      exports: { select: { id: true, format: true, createdAt: true } },
    },
  })
  const list = jobs.map((j) => ({
    id: j.id,
    title: j.title,
    mode: j.mode,
    status: j.status,
    pageCount: j.pages.length,
    extractedPages: j.pages.filter((p) => p.status === 'extracted').length,
    recordCount: new Set(j.fields.map((f) => `${f.pageIndex}:${f.rowIndex}`)).size,
    flaggedCount: j.fields.filter((f) => (f.uncertain || f.missing || f.duplicate) && !f.edited).length,
    exportCount: j.exports.length,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  }))
  return NextResponse.json({ jobs: list })
}

// POST /api/jobs — create a new extraction job
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled extraction'
  const mode = body.mode === 'cashier' ? 'cashier' : 'general'
  const job = await db.job.create({ data: { title, mode } })
  return NextResponse.json({ job: { id: job.id, title: job.title, mode: job.mode, status: job.status } })
}
