import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// DELETE /api/exports/[id] — user-controlled deletion of generated files
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params
  await db.exportRecord.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
