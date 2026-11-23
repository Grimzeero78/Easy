import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/exports — recent exports (dashboard)
export async function GET() {
  const exports = await db.exportRecord.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
    include: { job: { select: { title: true, mode: true } } },
  })
  return NextResponse.json({
    exports: exports.map((e) => ({
      id: e.id,
      format: e.format,
      fileName: e.fileName,
      rows: e.rows,
      jobTitle: e.job.title,
      createdAt: e.createdAt,
    })),
  })
}
