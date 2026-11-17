import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// GET /api/exports/[id]/download — download the generated file
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const rec = await db.exportRecord.findUnique({ where: { id } })
  if (!rec) return NextResponse.json({ error: 'Export not found' }, { status: 404 })

  const mimes: Record<string, string> = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    json: 'application/json',
  }

  return new NextResponse(new Uint8Array(rec.data), {
    headers: {
      'Content-Type': mimes[rec.format] ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${rec.fileName}"`,
      'Content-Length': String(rec.data.length),
    },
  })
}
